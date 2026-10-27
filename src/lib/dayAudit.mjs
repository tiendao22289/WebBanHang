/**
 * Kiểm tra tổng thể một ngày (chỉ đọc) cho workflow "Finance Day Audit" chạy trên máy quán: tiền, bill thiếu /
 * bàn còn mở, ảnh CK, đóng bàn không ảnh, huỷ / bớt món / giảm giá / món tặng, chấm công, Sổ tay.
 * Kho mã công khai nên nhật ký workflow ai cũng xem được: KHÔNG có tên / SĐT khách, KHÔNG có tên nhân viên —
 * nhân viên ghi bằng mã ngắn "NV-xxxx" (4 ký tự đầu mã nhân viên), chủ quán tra tên ở trang Tính lương.
 */
const hm = iso => (iso ? new Date(Date.parse(iso) + 7 * 3600000).toISOString().slice(11, 16) : null);
export const staffTag = id => (id ? `NV-${String(id).replace(/-/g, '').slice(0, 4)}` : 'NV-?');
const sum = rows => rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
const clip = (text, n = 60) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * check: dayCheck() của ngày (bill thiếu, ảnh CK, không ảnh, huỷ, bớt món, Sổ tay); ledger / paper: bill sổ / bill giấy;
 * openOrders: bill tạo trong ngày còn chưa thu / chưa huỷ; staff: staffData({ date }); notes: noteView() của ngày;
 * deletedNotes: số phiếu Sổ tay bị xoá trong ngày; loss: lossData() (giảm giá, món tặng).
 */
export function dayAudit({ date, check = null, ledger = [], paper = [], openOrders = [], staff = null, notes = [], deletedNotes = 0, loss = null }) {
  const rows = (key, map) => (check?.issues?.find(i => i.key === key)?.rows || []).map(map);
  const byMethod = (list, method) => { const m = list.filter(r => r.payment_method === method); return { count: m.length, amount: sum(m) }; };
  const people = (staff?.people || []).map(p => ({
    staff: staffTag(p.id),
    spans: p.spans.map(s => `${hm(s.in)}–${s.out ? hm(s.out) : 'chưa ra ca'}`),
    hours: p.hours,
    late: p.flags?.late || 0, leftEarly: p.flags?.leftEarly || 0,
    open: !!p.open, forgot: !!p.forgot, waitMinutes: p.waitMinutes || 0,
  }));
  const audit = {
    date,
    money: {
      bills: ledger.length, amount: sum(ledger), cash: byMethod(ledger, 'cash'), transfer: byMethod(ledger, 'transfer'),
      paper: { count: paper.length, amount: sum(paper) },
    },
    bills: {
      unrecorded: rows('unrecorded', r => ({ table: r.table, at: hm(r.at), amount: r.amount, method: r.method })),
      recovered: rows('recovered', r => ({ table: r.table, at: hm(r.at), amount: r.amount })),
      leftOpen: openOrders.map(o => ({ table: o.table ?? null, since: hm(o.created_at), amount: Number(o.total_amount) || 0, status: o.status })),
    },
    photos: {
      transferNoPhoto: rows('ck_no_photo', r => ({ table: r.table, at: hm(r.at), amount: r.amount })),
      closedWithoutPhoto: rows('no_photo', r => ({ table: r.table, at: hm(r.at), amount: r.amount, method: r.method, reason: clip(r.reason) })),
    },
    loss: {
      cancelled: rows('cancelled', r => ({ table: r.table, at: hm(r.at), amount: r.amount, printed: r.printed || 0 })),
      removed: rows('removed', r => ({ table: r.table, at: hm(r.at), item: clip(r.name, 40), qty: r.qty, value: r.amount })),
      discounts: loss ? { count: loss.discounts.count, amount: loss.discounts.amount } : null,
      gifts: loss ? { qty: loss.gifts.qty, value: loss.gifts.value } : null,
    },
    staff: staff && {
      people,
      scanAlerts: staff.alerts.map(a => ({ staff: staffTag(a.id), items: a.items })),
      requestsWaiting: staff.pending.length, fixesWaiting: staff.fixes.length,
      outsideHoursWaiting: staff.outside.map(o => ({ staff: staffTag(o.id), minutes: o.minutes })),
    },
    notes: {
      count: notes.length, amount: notes.reduce((s, n) => s + (Number(n.cost) || 0), 0), deleted: deletedNotes,
      problems: rows('notes', r => ({ at: hm(r.at), cost: r.amount, problems: r.problems.map(p => clip(p, 80)) })),
    },
  };
  // Tóm tắt: việc cần xem, theo thứ tự quan trọng.
  const todo = [];
  const n = (count, text) => { if (count) todo.push(`${text}: ${count}`); };
  n(audit.bills.unrecorded.length, 'Bill đã thu mà sổ chưa có');
  n(audit.bills.leftOpen.length, 'Bill trong ngày còn mở (chưa thu / chưa huỷ)');
  n(audit.photos.transferNoPhoto.length, 'Bill chuyển khoản chưa có ảnh');
  n(audit.photos.closedWithoutPhoto.length, 'Đóng bàn không ảnh (có lý do)');
  n(audit.loss.cancelled.length, 'Bill bị huỷ');
  n(audit.loss.removed.length, 'Món bị bớt sau khi in bếp');
  n(people.filter(p => p.open).length, 'Nhân viên chưa ra ca');
  n(people.filter(p => p.forgot).length, 'Nhân viên quên ra ca (máy tự đóng)');
  n(people.filter(p => p.late).length, 'Nhân viên đi trễ');
  n(people.filter(p => p.leftEarly).length, 'Nhân viên về sớm');
  n(audit.staff?.scanAlerts.length || 0, 'Nhân viên có lần quét bị cảnh báo / chặn');
  n(audit.notes.problems.length, 'Phiếu Sổ tay lệch / giá đáng ngờ');
  n(deletedNotes, 'Phiếu Sổ tay bị xoá');
  audit.todo = todo;
  return audit;
}
