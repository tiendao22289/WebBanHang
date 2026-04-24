import { createClient } from '@supabase/supabase-js';
const supabase = createClient('https://wglhqlrumieujmugpxel.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnbGhxbHJ1bWlldWptdWdweGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3NjE0MzMsImV4cCI6MjA4OTMzNzQzM30.mE5UgQAVM1Egifh2hcyYVXx2SIWC_21Xpg0MjsqTEHE');

async function test() {
  const accountId = '5887039f-6c1d-4db7-8399-3a455503c93e'; // Agribank
  const today = '2026-04-24';
  const { data, error } = await supabase
    .from('bank_daily_totals')
    .insert({ account_id: accountId, date: today, total_amount: 100 })
    .select();
  console.log('Result:', data, error);
  if (!error && data) {
     // delete it
     await supabase.from('bank_daily_totals').delete().eq('id', data[0].id);
  }
}
test();
