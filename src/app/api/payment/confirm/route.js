import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase'; // Using the public client since admin operations don't strictly require service role here, but depending on RLS it might fail.
import { transactionMatchesOpenBill } from '@/lib/paymentTransactionGuard';

export async function POST(req) {
  try {
    const body = await req.json();
    const { transactionCode } = body;

    if (!transactionCode) {
      return NextResponse.json({ error: 'Missing transactionCode' }, { status: 400 });
    }

    // A QR can become stale when staff add items or merge another table after
    // it was displayed. Never mark the old amount as full payment.
    const { data: pendingTx, error: pendingError } = await supabase.from('payment_transactions')
      .select('order_ids, total_amount, status').eq('transaction_code', transactionCode).maybeSingle();
    if (pendingError || !pendingTx) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    if (pendingTx.status === 'completed') return NextResponse.json({ message: 'Transaction already completed' });
    if (pendingTx.status !== 'pending') return NextResponse.json({ error: 'Transaction is not pending' }, { status: 409 });
    let groupIds = [];
    if (pendingTx.order_ids !== 'shadow_qr') {
      const txIds = String(pendingTx.order_ids || '').split(',').filter(Boolean);
      if (!txIds.length) return NextResponse.json({ error: 'Transaction has no orders' }, { status: 409 });
      const { data: sampleOrder, error: sampleError } = await supabase.from('orders')
        .select('table_id').eq('id', txIds[0]).maybeSingle();
      if (sampleError || !sampleOrder) return NextResponse.json({ error: 'Bill unavailable' }, { status: 409 });
      const { data: allTables, error: tablesError } = await supabase.from('tables').select('id, merged_with');
      if (tablesError || !allTables) return NextResponse.json({ error: 'Table group unavailable' }, { status: 503 });
      const table = allTables.find(t => t.id === sampleOrder.table_id);
      if (!table) return NextResponse.json({ error: 'Table unavailable' }, { status: 409 });
      const hostId = table.merged_with || table.id;
      groupIds = [hostId, ...allTables.filter(t => t.merged_with === hostId && t.id !== hostId).map(t => t.id)];
      const { data: openOrders, error: ordersError } = await supabase.from('orders')
        .select('id, order_items(unit_price, quantity)')
        .in('table_id', groupIds).in('status', ['pending', 'preparing', 'completed']);
      if (ordersError || !transactionMatchesOpenBill(pendingTx, openOrders)) {
        return NextResponse.json({ error: 'Bill changed; reconcile the payment with staff' }, { status: 409 });
      }
    }

    // 1. Chốt giao dịch TRƯỚC khi cộng tiền — chặn webhook gọi trùng (khá phổ
    // biến với webhook ngân hàng/trung gian) cộng tiền 2 lần cho cùng 1 giao
    // dịch. Trước đây đọc status rồi mới xử lý, để hở khoảng giữa: 2 lượt gọi
    // gần nhau cùng đọc thấy "chưa completed" → cả 2 đều cộng bank_daily_totals.
    // Giờ CHỈ lượt gọi đầu tiên khớp được dòng (status khác 'completed'); lượt
    // gọi trùng sau đó khớp 0 dòng → biết ngay đã xử lý, không cộng tiền lại.
    const { data: claimed, error: claimError } = await supabase
      .from('payment_transactions')
      .update({ status: 'completed' })
      .eq('transaction_code', transactionCode)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (claimError) {
      console.error('Webhook claim error:', claimError);
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }

    if (!claimed) {
      // Không giành được dòng nào: hoặc mã không tồn tại, hoặc đã completed
      // từ trước (webhook gọi trùng) — không cộng tiền lại trong cả 2 trường hợp.
      const { data: existingTx } = await supabase
        .from('payment_transactions').select('status').eq('transaction_code', transactionCode).maybeSingle();
      if (!existingTx) {
        return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
      }
      return NextResponse.json({ message: 'Transaction already completed' }, { status: 200 });
    }

    const tx = claimed;
    const { order_ids, account_id, total_amount } = tx;
    if (!order_ids) {
      return NextResponse.json({ error: 'No orders associated' }, { status: 400 });
    }

    const orderIdList = order_ids.split(',');

    if (order_ids !== 'shadow_qr' && orderIdList.length > 0) {
        // Hoàn tất các đơn hàng (chuyển sang paid)
        const { data: paidOrders, error: paidError } = await supabase
          .from('orders')
          .update({ 
            status: 'paid', 
            payment_method: 'transfer',
            created_at: new Date().toISOString()
          })
          .in('id', orderIdList)
          .in('status', ['pending', 'preparing', 'completed'])
          .select('id');
        if (paidError || paidOrders?.length !== orderIdList.length) {
          console.error('Payment order update incomplete:', paidError);
          return NextResponse.json({ error: 'Payment requires reconciliation' }, { status: 500 });
        }
        
        // Reset bàn và tất cả bàn gộp chung (host_id)
        const { error: releaseError } = await supabase
          .from('tables')
          .update({ status: 'available', occupied_at: null, merged_with: null })
          .in('id', groupIds);
        if (releaseError) {
          console.error('Payment table release failed:', releaseError);
          return NextResponse.json({ error: 'Payment requires reconciliation' }, { status: 500 });
        }
    }

    // Ghi nhận doanh thu ngân hàng
    if (account_id && total_amount) {
      const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
      const { data: existing } = await supabase
        .from('bank_daily_totals')
        .select('id, total_amount')
        .eq('account_id', account_id)
        .eq('date', today)
        .maybeSingle();

      if (existing) {
        await supabase
          .from('bank_daily_totals')
          .update({ total_amount: existing.total_amount + Number(total_amount) })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('bank_daily_totals')
          .insert({ account_id: account_id, date: today, total_amount: Number(total_amount) });
      }
    }

    // Transaction đã được chốt 'completed' ngay từ bước giành ở trên.

    return NextResponse.json({ success: true, message: 'Payment confirmed successfully' }, { status: 200 });

  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
