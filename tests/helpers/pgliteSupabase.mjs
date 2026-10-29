// Bộ dựng truy vấn kiểu supabase-js chạy thẳng trên PGlite (Postgres thật trong bộ nhớ),
// đủ cho các route / lib voucher: select / insert / update / upsert / rpc với các bộ lọc hay dùng.
// Mục đích: chạy trọn quy trình với đúng SQL, trigger và hàm của quán thay vì DB giả bằng mảng.
const ident = s => `"${String(s).replace(/"/g, '""')}"`;

function columns(sel) {
  const s = String(sel || '*').trim();
  if (s === '*') return '*';
  return s.split(',').map(c => c.trim()).filter(Boolean).map(ident).join(', ');
}

export function pgSupabase(db) {
  return {
    async rpc(name, args = {}) {
      const keys = Object.keys(args);
      const sql = `SELECT ${ident(name)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')}) AS r`;
      try {
        const { rows } = await db.query(sql, keys.map(k => args[k]));
        return { data: rows[0]?.r ?? null, error: null };
      } catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
    },
    from(table) {
      let op = 'select', cols = '*', values = null, returning = null, maybe = false, single = false, limit = null, conflict = 'id';
      const where = [], params = [], orders = [];
      const p = v => { params.push(v); return `$${params.length}`; };
      const q = {
        select(c = '*') { if (op === 'select') cols = c; else returning = c; return q; },
        eq(k, v) { where.push(`${ident(k)} = ${p(v)}`); return q; },
        neq(k, v) { where.push(`${ident(k)} IS DISTINCT FROM ${p(v)}`); return q; },
        gt(k, v) { where.push(`${ident(k)} > ${p(v)}`); return q; },
        gte(k, v) { where.push(`${ident(k)} >= ${p(v)}`); return q; },
        lt(k, v) { where.push(`${ident(k)} < ${p(v)}`); return q; },
        lte(k, v) { where.push(`${ident(k)} <= ${p(v)}`); return q; },
        in(k, vs) { where.push(vs.length ? `${ident(k)}::text = ANY(${p(vs.map(String))}::text[])` : 'false'); return q; },
        is(k, v) { where.push(v === null ? `${ident(k)} IS NULL` : `${ident(k)} IS ${v ? 'TRUE' : 'FALSE'}`); return q; },
        not(k, opName, v) { if (opName === 'is' && v === null) where.push(`${ident(k)} IS NOT NULL`); return q; },
        contains(k, vs) { where.push(`${ident(k)} @> ${p(vs)}`); return q; },
        // "a.eq.x,b.eq.y" (chỉ dạng eq, như các route đang dùng)
        or(expr) {
          const parts = expr.split(',').map(e => { const [k, , ...rest] = e.split('.'); return `${ident(k)}::text = ${p(rest.join('.'))}`; });
          where.push(`(${parts.join(' OR ')})`); return q;
        },
        order(k, o) { orders.push(`${ident(k)} ${o?.ascending === false ? 'DESC' : 'ASC'}`); return q; },
        limit(n) { limit = n; return q; },
        maybeSingle() { maybe = true; return q; },
        single() { single = true; return q; },
        insert(v) { op = 'insert'; values = v; return q; },
        update(v) { op = 'update'; values = v; return q; },
        upsert(v, o) { op = 'upsert'; values = v; conflict = o?.onConflict || 'id'; return q; },
        delete() { op = 'delete'; return q; },
        then(ok, ko) { return run().then(ok, ko); },
      };
      async function run() {
        const W = where.length ? ` WHERE ${where.join(' AND ')}` : '';
        let sql;
        try {
          if (op === 'select') {
            sql = `SELECT ${columns(cols)} FROM ${ident(table)}${W}${orders.length ? ` ORDER BY ${orders.join(', ')}` : ''}${limit ? ` LIMIT ${Number(limit)}` : ''}`;
          } else if (op === 'insert' || op === 'upsert') {
            const list = Array.isArray(values) ? values : [values];
            const keys = [...new Set(list.flatMap(Object.keys))];
            const rowsSql = list.map(v => `(${keys.map(k => (k in v ? p(v[k]) : 'DEFAULT')).join(', ')})`).join(', ');
            sql = `INSERT INTO ${ident(table)} (${keys.map(ident).join(', ')}) VALUES ${rowsSql}`;
            if (op === 'upsert') sql += ` ON CONFLICT (${conflict.split(',').map(s => ident(s.trim())).join(', ')}) DO UPDATE SET ${keys.map(k => `${ident(k)} = EXCLUDED.${ident(k)}`).join(', ')}`;
            sql += ` RETURNING ${columns(returning || '*')}`;
          } else if (op === 'update') {
            const keys = Object.keys(values);
            sql = `UPDATE ${ident(table)} SET ${keys.map(k => `${ident(k)} = ${p(values[k])}`).join(', ')}${W} RETURNING ${columns(returning || '*')}`;
          } else {
            sql = `DELETE FROM ${ident(table)}${W} RETURNING *`;
          }
          const { rows } = await db.query(sql, params);
          if (single && rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'not exactly one row' } };
          return { data: maybe || single ? rows[0] ?? null : rows, error: null };
        } catch (e) {
          return { data: null, error: { code: e.code, message: e.message } };
        }
      }
      return q;
    },
  };
}
