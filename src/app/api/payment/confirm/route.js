import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase'; // Using the public client since admin operations don't strictly require service role here, but depending on RLS it might fail.

export async function POST(req) {
  try {
    const body = await req.json();
    const { transactionCode } = body;

    if (!transactionCode) {
      return NextResponse.json({ error: 'Missing transactionCode' }, { status: 400 });
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
      .neq('status', 'completed')
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

    if (orderIdList.length > 0) {
      // Xác định table_id từ một trong các order
      const { data: sampleOrder } = await supabase
        .from('orders')
        .select('table_id')
        .eq('id', orderIdList[0])
        .maybeSingle();

      if (sampleOrder && sampleOrder.table_id) {
        const hostId = sampleOrder.table_id;
        
        // Hoàn tất các đơn hàng (chuyển sang paid)
        await supabase
          .from('orders')
          .update({ 
            status: 'paid', 
            payment_method: 'transfer',
            created_at: new Date().toISOString()
          })
          .in('id', orderIdList)
          .in('status', ['pending', 'preparing', 'completed']);
        
        // Reset bàn và tất cả bàn gộp chung (host_id)
        await supabase
          .from('tables')
          .update({ status: 'available', occupied_at: null, merged_with: null })
          .or(`id.eq.${hostId},merged_with.eq.${hostId}`);
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
