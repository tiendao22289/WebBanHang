// Bộ dựng truy vấn giả kiểu supabase-js (đủ cho các route nhân viên / Sổ tay).
export function fakeDb(state) {
  // Bộ đếm mã dòng nằm trong state: route tạo client mới mỗi request.
  state.__seq ||= 0;
  return { from(table) {
    let op = 'read', values, single = false, maybe = false, max = Infinity;
    const conditions = [], orders = [];
    const q = {
      select() { return q; },
      eq(k, v) { conditions.push(r => r[k] === v); return q; },
      neq(k, v) { conditions.push(r => r[k] !== v); return q; },
      in(k, vs) { conditions.push(r => vs.includes(r[k])); return q; },
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
          const row = { id: v.id || `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, created_at: new Date(Date.now() + n).toISOString(), ...v };
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
