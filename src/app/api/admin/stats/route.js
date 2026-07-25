import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  startOfDay,
  endOfDay,
  subDays,
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  format,
} from 'date-fns';

export const dynamic = 'force-dynamic';

const VAT_RATE = 0.08;
const ORDERS_PAGE_SIZE = 1000;

function formatDateInput(date) {
  return format(date, 'dd/MM/yyyy');
}

function parseDateInput(value) {
  const [day, month, year] = value.split('/').map(Number);
  if (!day || !month || !year) return new Date(NaN);
  return new Date(year, month - 1, day);
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
    const orderDate = new Date(order.created_at);
    const key = format(orderDate, 'yyyy-MM-dd');
    if (revenueMap[key] === undefined) {
      revenueMap[key] = {
        date: format(orderDate, 'dd/MM'),
        sortTime: startOfDay(orderDate).getTime(),
        revenue: 0,
      };
    }
    revenueMap[key].revenue += order.total_amount || 0;
  });

  const revenueByDay = Object.values(revenueMap)
    .sort((a, b) => a.sortTime - b.sortTime)
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
  const now = new Date();

  switch (period) {
    case 'yesterday':
      return { startDate: startOfDay(subDays(now, 1)), endDate: endOfDay(subDays(now, 1)) };
    case '7days':
      return { startDate: startOfDay(subDays(now, 6)), endDate: endOfDay(now) };
    case 'month':
      return { startDate: startOfMonth(now), endDate: endOfMonth(now) };
    case 'quarter':
      return { startDate: startOfQuarter(now), endDate: endOfQuarter(now) };
    case 'custom': {
      const startDate = startOfDay(parseDateInput(customStart));
      const endDate = endOfDay(parseDateInput(customEnd));
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        throw new Error('Vui lòng nhập ngày theo định dạng dd/mm/yyyy');
      }
      return { startDate, endDate };
    }
    case 'today':
    default:
      return { startDate: startOfDay(now), endDate: endOfDay(now) };
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || 'today';
    const customStart = searchParams.get('customStart') || formatDateInput(new Date());
    const customEnd = searchParams.get('customEnd') || formatDateInput(new Date());

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
