// Bộ dựng truy vấn giả kiểu supabase-js (đủ cho các route nhân viên / Sổ tay).
export function fakeDb(state) {
  // Bộ đếm mã dòng nằm trong state: route tạo client mới mỗi request.
  state.__seq ||= 0;
  return {
  // Giống hàm staff_notes_commit trong DB: kiểm tra updated_at của mọi phiếu trước, rồi ghi hết.
  async rpc(name, { p }) {
    if (name !== 'staff_notes_commit') return { data: null, error: { message: `unknown rpc ${name}` } };
    await Promise.resolve();
    state.staff_notes ||= []; state.staff_note_payments ||= [];
    const find = id => state.staff_notes.find(n => n.id === id);
    const stale = x => { const n = find(x.id); return !n || (n.updated_at ?? null) !== (x.expect ?? null); };
    if ((p.updates || []).some(stale) || (p.delete && stale(p.delete))) return { data: null, error: { message: 'note_changed' } };
    const now = () => new Date(Date.now() + ++state.__seq).toISOString();
    for (const u of p.updates || []) {
      const n = find(u.id);
      for (const k of ['content', 'note_type', 'amount', 'debt', 'paid_debt']) if (u[k] !== undefined && u[k] !== null) n[k] = u[k];
      n.updated_at = now();
    }
    if (p.delete) state.staff_notes = state.staff_notes.filter(n => n.id !== p.delete.id);
    const gone = new Set(p.delete_payments || []);
    state.staff_note_payments = state.staff_note_payments.filter(x => !gone.has(x.id));
    let created = null;
    if (p.insert) {
      const at = now();
      created = { status: 'approved', created_at: at, updated_at: at, paid_debt: 0, ...p.insert };
      state.staff_notes.push(created);
    }
    for (const x of p.payments || []) state.staff_note_payments.push({ id: `10000000-0000-4000-8000-${String(++state.__seq).padStart(12, '0')}`, paid_at: now(), ...x });
    return { data: structuredClone(created), error: null };
  },
  from(table) {
    let op = 'read', values, single = false, maybe = false, max = Infinity;
    const conditions = [], orders = [];
    const q = {
      select() { return q; },
      eq(k, v) { conditions.push(r => r[k] === v); return q; },
      neq(k, v) { conditions.push(r => r[k] !== v); return q; },
      in(k, vs) { conditions.push(r => vs.includes(r[k])); return q; },
      // "a.eq.x,b.eq.y" (chỉ dạng eq).
      or(expr) { const parts = expr.split(',').map(e => e.split('.')); conditions.push(r => parts.some(([k, , v]) => String(r[k]) === v)); return q; },
      gte(k, v) { conditions.push(r => r[k] >= v); return q; },
      lt(k, v) { conditions.push(r => r[k] < v); return q; },
      is(k, v) { conditions.push(r => (r[k] ?? null) === v); return q; },
      order(k, o) { orders.push([k, o?.ascending !== false]); return q; },
      limit(n) { max = n; return q; },
      maybeSingle() { maybe = true; return q; },
      single() { single = true; return q; },
      insert(v) { op = 'insert'; values = v; return q; },
      update(v) { op = 'update'; values = v; return q; },
      delete() { op = 'delete'; return q; },
      then(ok, bad) { return new Promise(run).then(ok, bad); },
    };
    function run(resolve) {
      state[table] ||= [];
      let rows = state[table].filter(r => conditions.every(c => c(r)));
      if (op === 'insert') {
        const added = (Array.isArray(values) ? values : [values]).map(v => {
          const n = ++state.__seq;
          const at = new Date(Date.now() + n).toISOString();
          const row = { id: v.id || `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, created_at: at, updated_at: at, ...v };
          state[table].push(row);
          return row;
        });
        return resolve({ data: structuredClone(single ? added[0] : added), error: null });
      }
      if (op === 'update') {
        rows.forEach(r => Object.assign(r, values));
        return resolve({ data: structuredClone(single ? rows[0] ?? null : rows), error: null });
      }
      if (op === 'delete') {
        state[table] = state[table].filter(r => !rows.includes(r));
        return resolve({ data: structuredClone(rows), error: null });
      }
      for (const [k, asc] of [...orders].reverse()) rows = [...rows].sort((a, b) => (asc ? 1 : -1) * String(a[k]).localeCompare(String(b[k])));
      rows = rows.slice(0, max);
      resolve({ data: structuredClone(single || maybe ? rows[0] ?? null : rows), error: null });
    }
    return q;
  } };
}
