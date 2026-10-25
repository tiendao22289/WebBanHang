/**
 * Máy tự kiểm tra một ngày của Sổ thu chi (chạy mỗi sáng cho ngày hôm qua, hoặc khi chủ bấm "Kiểm tra
 * ngay") — thay cho việc chủ quán phải tự chốt sổ. Chỉ báo những gì cần xem:
 *   unrecorded  bill đã thu mà sổ chưa có (máy không tự bổ sung được)
 *   recovered   bill bị sót máy vừa tự bổ sung vào sổ (để biết, không phải lỗi)
 *   ck_no_photo bill chuyển khoản chưa có ảnh
 *   no_photo    đóng bàn không chụp ảnh (ghi lý do)
 *   cancelled   bill bị huỷ · removed: món bị bớt sau khi in bếp
 *   notes       phiếu Sổ tay lệch tiền / giá đáng ngờ
 * Không đếm tiền két (máy không biết tiền thật) — chủ vẫn tự chốt sổ được nếu muốn.
 */
export const AUTO_CHECK_BY = 'Máy tự kiểm tra';
// Kiểm tra lúc 5 giờ sáng hôm sau: quán đã đóng, dọn xong, phiếu Sổ tay sau nửa đêm đã ghi.
export const AUTO_CHECK_HOUR = 5;

const vnd = n => `${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
const sumOf = rows => rows.reduce((a, r) => a + (Number(r.amount) || 0), 0);

/**
 * ledger: bill trong sổ của ngày (finance_revenue_ledger *); paper: bill giấy (finance_manual_receipts *);
 * unrecorded / recovered: bill đã thu chưa vào sổ / vừa tự bổ sung { tableNumber, paidAt, amount, paymentMethod };
 * loss: lossData() của ngày; notes: phiếu Sổ tay của ngày (noteView: mismatch, lineWarnings, suspicious);
 * keepPhotosFrom: ảnh CK cũ hơn ngày này đã tự xoá — không báo thiếu ảnh.
 */
export function dayCheck({ date, ledger = [], paper = [], unrecorded = [], recovered = [], loss = null, notes = [], keepPhotosFrom = '0000-00-00', checkedAt, by = AUTO_CHECK_BY }) {
  const issues = [];
  const add = (key, title, rows, extra = {}) => { if (rows.length) issues.push({ key, title, count: rows.length, amount: sumOf(rows), rows, ...extra }); };
  const bill = r => ({ table: r.table_number ?? null, at: r.paid_at || r.received_at || null, amount: Number(r.amount) || 0 });

  add('unrecorded', 'Bill đã thu nhưng sổ chưa có', unrecorded.map(b => ({ table: b.tableNumber ?? null, at: b.paidAt, amount: Number(b.amount) || 0, method: b.paymentMethod || null })));
  add('recovered', 'Máy đã tự bổ sung bill bị sót', recovered.map(b => ({ table: b.tableNumber ?? null, at: b.paidAt, amount: Number(b.amount) || 0, method: b.paymentMethod || null })), { level: 'info' });
  if (date >= keepPhotosFrom) {
    add('ck_no_photo', 'Bill chuyển khoản chưa có ảnh', [
      ...ledger.filter(r => r.payment_method === 'transfer' && !r.transfer_image_path && !r.photo_skip_reason).map(bill),
      ...paper.filter(r => r.payment_method === 'transfer' && !r.transfer_image_path && !r.images_purged_at).map(r => ({ ...bill(r), table: r.table_label || 'Bill giấy' })),
    ]);
  }
  add('no_photo', 'Đóng bàn không chụp ảnh', ledger.filter(r => r.photo_skip_reason)
    .map(r => ({ ...bill(r), method: r.payment_method, reason: r.photo_skip_reason, by: r.photo_by || null })));
  if (loss) {
    add('cancelled', 'Bill bị huỷ', loss.cancelled.rows.map(r => ({ table: r.table, at: r.at, amount: r.printedValue || r.amount, by: r.by, printed: r.printedCount })));
    if (loss.removed.rows.length) {
      issues.push({ key: 'removed', title: 'Món bị bớt sau khi in bếp', count: loss.removed.qty, amount: loss.removed.value,
        rows: loss.removed.rows.map(r => ({ table: r.table, at: r.paidAt, name: r.name, qty: r.qty, amount: r.value })) });
    }
  }
  add('notes', 'Phiếu Sổ tay lệch tiền / giá đáng ngờ', notes.filter(n => (n.mismatch && n.mismatch !== 0) || n.lineWarnings?.length || n.suspicious?.length).map(n => ({
    at: n.createdAt, who: n.staffName || null, amount: n.cost,
    problems: [n.mismatch ? `lệch ${vnd(Math.abs(n.mismatch))} so với các dòng hàng` : null, ...(n.lineWarnings || []), ...(n.suspicious || []).map(s => `giá đáng ngờ ${s}`)].filter(Boolean),
  })));

  const problems = issues.filter(i => i.level !== 'info');
  return {
    date, checkedAt: checkedAt || new Date().toISOString(), by,
    bills: { count: ledger.length + paper.length, amount: sumOf(ledger) + sumOf(paper) },
    ok: problems.length === 0, problems: problems.length, issues,
  };
}

/** Các dòng báo cáo Zalo: "🤖 Máy tự kiểm tra: ✓ không có gì bất thường" hoặc từng việc cần xem. */
export function dayCheckLines(check) {
  if (!check) return [];
  const lines = [check.ok ? '🤖 Máy tự kiểm tra: ✓ không có gì bất thường' : `🤖 Máy tự kiểm tra: ${check.problems} việc cần xem`];
  for (const i of check.issues) {
    const money = i.amount ? ` (${vnd(i.amount)})` : '';
    lines.push(`• ${i.title}: ${i.count}${i.key === 'removed' ? ' món' : ''}${money}`);
  }
  return lines;
}
