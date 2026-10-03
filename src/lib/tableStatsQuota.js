import { supabase } from './supabase';
import { getActiveAccount } from './bankAccount';

export async function prepareTableStatsPayment(snapshot) {
  const { data, error } = await supabase.rpc('prepare_stats_payment', {
    p_table_id: snapshot.hostId,
    p_expected_order_ids: snapshot.bills.map(order => order.id),
    p_expected_amount: snapshot.total,
    p_payment_method: 'transfer',
  });

  // Support deploying the POS before the migration. Other RPC errors must stop
  // QR creation, since falling back could show A for an excluded receipt.
  if (error && error.code !== 'PGRST202' && error.code !== '42883') throw error;
  if (error || data?.enabled === false) return getActiveAccount(snapshot.total);
  if (!data?.success || !data.account_id) {
    throw new Error('Bill da thay doi. Vui long dong bo lai truoc khi tao QR.');
  }

  const { data: account, error: accountError } = await supabase
    .from('bank_accounts').select('*').eq('id', data.account_id).single();
  if (accountError) throw accountError;
  if (!account?.is_active) throw new Error('Tai khoan QR khong con hoat dong. Vui long kiem tra lai.');
  return {
    account,
    overLimit: !data.selected,
    shouldHideStats: !data.selected,
  };
}
