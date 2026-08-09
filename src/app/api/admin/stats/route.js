import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const VAT_RATE = 0.08;
const ORDERS_PAGE_SIZE = 1000;

// =============================================================================
// MÚI GIỜ VIỆT NAM (UTC+7)
//
// Server (Vercel) chạy UTC, nên KHÔNG được dùng startOfDay/format của date-fns
// — chúng tính theo timezone của tiến trình. Nếu dùng, khung "Hôm nay" sẽ thành
// 07:00 hôm qua → 07:00 hôm nay theo giờ VN, kéo bill của ngày hôm trước vào.
// Mọi mốc ngày ở đây đều quy đổi tường minh sang giờ VN.
//
// Quy ước: "dayKey" là chuỗi 'YYYY-MM-DD' của ngày theo lịch Việt Nam.
// =============================================================================
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

function vnDayKey(date = new Date()) {
  return new Date(date.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDayKey(dayKey, days) {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Mốc UTC thật ứng với 00:00:00.000 và 23:59:59.999 giờ VN của ngày đó
function vnStartOfDay(dayKey) {
  return new Date(`${dayKey}T00:00:00.000+07:00`);
}

function vnEndOfDay(dayKey) {
  return new Date(`${dayKey}T23:59:59.999+07:00`);
}

function vnStartOfMonth(dayKey) {
  return `${dayKey.slice(0, 7)}-01`;
}

function vnEndOfMonth(dayKey) {
  const [year, month] = dayKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${dayKey.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
}

function vnStartOfQuarter(dayKey) {
  const [year, month] = dayKey.split('-').map(Number);
  const first = Math.floor((month - 1) / 3) * 3 + 1;
  return `${year}-${String(first).padStart(2, '0')}-01`;
}

function vnEndOfQuarter(dayKey) {
  const [year, month] = dayKey.split('-').map(Number);
  const last = Math.floor((month - 1) / 3) * 3 + 3;
  return vnEndOfMonth(`${year}-${String(last).padStart(2, '0')}-01`);
}

function formatDateInput(dayKey) {
  const [year, month, day] = dayKey.split('-');
  return `${day}/${month}/${year}`;
}

function parseDateInput(value) {
  const [day, month, year] = String(value).split('/').map(Number);
  if (!day || !month || !year) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase configuration');
  }

  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

async function fetchAllOrdersInRange(supabase, startDate, endDate) {
  const allOrders = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        id, created_at, total_amount, payment_method, status,
        order_items (
          quantity, unit_price,
          menu_item:menu_items(name, category:categories(name))
        )
      `)
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString())
      .or('is_hidden_from_stats.is.null,is_hidden_from_stats.eq.false')
      .order('created_at', { ascending: true })
      .range(from, from + ORDERS_PAGE_SIZE - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    allOrders.push(...data);

    if (data.length < ORDERS_PAGE_SIZE) break;
    from += ORDERS_PAGE_SIZE;
  }

  return allOrders;
}

function buildStats(ordersData) {
  const validOrders = ordersData.filter(o =>
    (o.status === 'completed' || o.status === 'paid') &&
    (o.payment_method === 'cash' || o.payment_method === 'transfer')
  );

  let cashRevenue = 0;
  let transferRevenue = 0;

  validOrders.forEach(o => {
    const amount = o.total_amount || 0;
    if (o.payment_method === 'cash') cashRevenue += amount;
    if (o.payment_method === 'transfer') transferRevenue += amount;
  });

  const totalRevenue = cashRevenue + transferRevenue;
  const netRevenue = Math.round(totalRevenue / (1 + VAT_RATE));
  const vatAmount = totalRevenue - netRevenue;
  const totalOrders = validOrders.length;
  const totalItemsSold = validOrders.reduce((sum, o) =>
    sum + (o.order_items?.reduce((subSum, item) => subSum + item.quantity, 0) || 0), 0
  );
  const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

  const itemMap = {};
  validOrders.forEach(order => {
    order.order_items?.forEach(oi => {
      const name = oi.menu_item?.name || 'Deleted item';
      if (!itemMap[name]) itemMap[name] = { name, quantity: 0, revenue: 0, price: oi.unit_price };
      itemMap[name].quantity += oi.quantity;
      itemMap[name].revenue += oi.unit_price * oi.quantity;
    });
  });

  const allRawItems = Object.values(itemMap).sort((a, b) => b.quantity - a.quantity);
  const topItems = allRawItems.slice(0, 8);

  const revenueMap = {};
  validOrders.forEach(order => {
    const key = vnDayKey(new Date(order.created_at)); // gom nhóm theo ngày VN
    if (revenueMap[key] === undefined) {
      const [, month, day] = key.split('-');
      revenueMap[key] = {
        date: `${day}/${month}`,
        sortKey: key,
        revenue: 0,
      };
    }
    revenueMap[key].revenue += order.total_amount || 0;
  });

  const revenueByDay = Object.values(revenueMap)
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ date, revenue }) => ({ date, revenue }));

  const catMap = {};
  validOrders.forEach(order => {
    order.order_items?.forEach(oi => {
      const catName = oi.menu_item?.category?.name || 'Other';
      if (!catMap[catName]) catMap[catName] = 0;
      catMap[catName] += oi.unit_price * oi.quantity;
    });
  });
  const categoryBreakdown = Object.entries(catMap).map(([name, value]) => ({ name, value }));

  const paymentBreakdown = [
    { name: 'Transfer', value: transferRevenue },
    { name: 'Cash', value: cashRevenue },
  ].filter(item => item.value > 0);

  return {
    totalRevenue,
    netRevenue,
    vatAmount,
    cashRevenue,
    transferRevenue,
    totalOrders,
    totalItemsSold,
    avgOrderValue,
    revenueByDay,
    topItems,
    categoryBreakdown,
    paymentBreakdown,
    allRawItems,
    validOrders,
  };
}

function resolveRange(period, customStart, customEnd) {
  const today = vnDayKey();

  switch (period) {
    case 'yesterday': {
      const yesterday = shiftDayKey(today, -1);
      return { startDate: vnStartOfDay(yesterday), endDate: vnEndOfDay(yesterday) };
    }
    case '7days':
      return { startDate: vnStartOfDay(shiftDayKey(today, -6)), endDate: vnEndOfDay(today) };
    case 'month':
      return { startDate: vnStartOfDay(vnStartOfMonth(today)), endDate: vnEndOfDay(vnEndOfMonth(today)) };
    case 'quarter':
      return { startDate: vnStartOfDay(vnStartOfQuarter(today)), endDate: vnEndOfDay(vnEndOfQuarter(today)) };
    case 'custom': {
      const start = parseDateInput(customStart);
      const end = parseDateInput(customEnd);
      if (!start || !end) {
        throw new Error('Vui lòng nhập ngày theo định dạng dd/mm/yyyy');
      }
      return { startDate: vnStartOfDay(start), endDate: vnEndOfDay(end) };
    }
    case 'today':
    default:
      return { startDate: vnStartOfDay(today), endDate: vnEndOfDay(today) };
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || 'today';
    const customStart = searchParams.get('customStart') || formatDateInput(vnDayKey());
    const customEnd = searchParams.get('customEnd') || formatDateInput(vnDayKey());

    const { startDate, endDate } = resolveRange(period, customStart, customEnd);
    const supabase = getSupabaseClient();
    const ordersData = await fetchAllOrdersInRange(supabase, startDate, endDate);
    const stats = buildStats(ordersData);

    return NextResponse.json({ stats });
  } catch (error) {
    console.error('[Admin Stats API] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Could not load stats' },
      { status: 500 }
    );
  }
}
