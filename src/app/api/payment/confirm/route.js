import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase'; // Using the public client since admin operations don't strictly require service role here, but depending on RLS it might fail.

export async function POST(req) {
  try {
    const body = await req.json();
    const { transactionCode } = body;

    if (!transactionCode) {
      return NextResponse.json({ error: 'Missing transactionCode' }, { status: 400 });
    }

    // 1. Lấy thông tin giao dịch từ database
    const { data: tx, error: txError } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('transaction_code', transactionCode)
      .maybeSingle();

    if (txError || !tx) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    if (tx.status === 'completed') {
      return NextResponse.json({ message: 'Transaction already completed' }, { status: 200 });
    }

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
          .update({ status: 'paid', payment_method: 'transfer' })
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

    // Cập nhật trạng thái transaction thành completed
    await supabase
      .from('payment_transactions')
      .update({ status: 'completed' })
      .eq('transaction_code', transactionCode);

    return NextResponse.json({ success: true, message: 'Payment confirmed successfully' }, { status: 200 });

  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
