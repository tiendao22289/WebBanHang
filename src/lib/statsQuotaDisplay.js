export function statsQuotaProgress(account, summary, day = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)) {
  const combined = summary?.enabled === true && summary.date === day && summary.account_id === account.id;
  return {
    combined,
    receivedToday: combined
      ? Number(summary.cash_amount || 0) + Number(summary.transfer_amount || 0)
      : Number(account.bank_daily_totals?.find(row => row.date === day)?.total_amount || 0),
    limit: Number(combined ? summary.target_amount : account.daily_limit),
  };
}
