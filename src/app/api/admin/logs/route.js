import { NextResponse } from 'next/server';
import { requireStatusAdmin, statusDatabase } from '@/lib/statusAuth';
import { billLog, mergeLogPage, LOG_PAGE_SIZE, LOG_SOURCES } from '@/lib/tableLogs.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const missingArchive = error => ['PGRST205', '42P01'].includes(error?.code);

export async function GET(request) {
  try {
    const code = await requireStatusAdmin(request);
    if (code !== 200) return NextResponse.json({ error: code === 503 ? 'Không kiểm tra được quyền admin.' : 'Chỉ admin được xem lịch sử bàn.' }, { status: code, headers });
    const params = new URL(request.url).searchParams;
    const tableId = params.get('table');
    let cursor = { paid: 0, cancelled: 0, opened: 0, asOf: new Date().toISOString() };
    try {
      if (tableId && !uuid.test(tableId)) throw new Error();
      if (params.has('cursor')) {
        const encoded = params.get('cursor');
        if (encoded.length > 1000) throw new Error();
        cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString());
        if (cursor.table !== (tableId || null)) throw new Error();
        if (!LOG_SOURCES.every(source => Number.isSafeInteger(cursor[source]) && cursor[source] >= 0)) throw new Error();
        if (!Number.isFinite(Date.parse(cursor.asOf)) || Date.parse(cursor.asOf) > Date.now()) throw new Error();
      }
    } catch { return NextResponse.json({ error: 'Bộ lọc lịch sử không hợp lệ.' }, { status: 400, headers }); }

    const db = statusDatabase();
    const tablesResult = await db.from('tables').select('id,table_number,merged_with');
    if (tablesResult.error) throw tablesResult.error;
    const tables = new Map((tablesResult.data || []).map(table => [table.id, table]));
    const selected = tables.get(tableId);
    const hostId = selected?.merged_with || tableId;
    const now = Date.now();
    const since = hours => new Date(now - hours * 3600000).toISOString();
    const range = (query, source, column) => query.order(column, { ascending: false }).order(source === 'paid' ? 'order_id' : 'id', { ascending: false })
      .range(cursor[source], cursor[source] + LOG_PAGE_SIZE - 1);
    let paid = db.from('table_bill_history').select('order_id,table_id,table_ids,paid_at,snapshot')
      .gt('expires_at', new Date(now).toISOString()).lte('paid_at', cursor.asOf)
      .or('snapshot->>customer_phone.is.null,snapshot->>customer_phone.neq.BAO_BEP');
    let cancelled = db.from('orders').select('*,order_items(*,menu_item:menu_items(name))')
      .eq('status', 'cancelled').gte('cancelled_at', since(8)).lte('cancelled_at', cursor.asOf)
      .or('customer_phone.is.null,customer_phone.neq.BAO_BEP');
    let opened = db.from('table_open_log').select('id,table_id,table_number,staff_name,opened_at')
      .gte('opened_at', since(6)).lte('opened_at', cursor.asOf);
    if (tableId) {
      paid = paid.contains('table_ids', [tableId]);
      cancelled = cancelled.eq('table_id', hostId);
      opened = opened.eq('table_id', tableId);
    }
    let [paidResult, cancelledResult, openedResult] = await Promise.all([
      range(paid, 'paid', 'paid_at'), range(cancelled, 'cancelled', 'cancelled_at'), range(opened, 'opened', 'opened_at'),
    ]);
    const legacy = missingArchive(paidResult.error);
    if (legacy) {
      let query = db.from('orders').select('*,order_items(*,menu_item:menu_items(name))')
        .eq('status', 'paid').gte('created_at', since(8)).lte('paid_at', cursor.asOf)
        .or('customer_phone.is.null,customer_phone.neq.BAO_BEP');
      if (tableId) query = query.eq('table_id', hostId);
      paidResult = await query.order('paid_at', { ascending: false }).order('id', { ascending: false })
        .range(cursor.paid, cursor.paid + LOG_PAGE_SIZE - 1);
    }
    if (paidResult.error || cancelledResult.error || openedResult.error) throw new Error('Query failed');
    const streams = {
      paid: (paidResult.data || []).map(row => {
        const order = legacy ? row : { ...row.snapshot, id: row.order_id, table_id: row.table_id, paid_at: row.paid_at };
        return billLog(order, tables.get(order.table_id), 'paid', row.table_ids || [order.table_id]);
      }),
      cancelled: (cancelledResult.data || []).map(order => billLog(order, tables.get(order.table_id), 'cancelled', [order.table_id])),
      opened: (openedResult.data || []).map(log => ({
        id: `opened:${log.id}`, tableId: log.table_id,
        tableNumber: log.table_number || tables.get(log.table_id)?.table_number || '?',
        at: log.opened_at, actor: log.staff_name || '',
      })),
    };
    const { entries, nextOffsets, hasMore } = mergeLogPage(streams, cursor);
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ ...nextOffsets, table: tableId || null })).toString('base64url') : null;
    return NextResponse.json({ entries, nextCursor, checkedAt: new Date(now).toISOString() }, { headers });
  } catch {
    return NextResponse.json({ error: 'Chưa tải được lịch sử bàn. Vui lòng thử lại.' }, { status: 503, headers });
  }
}
