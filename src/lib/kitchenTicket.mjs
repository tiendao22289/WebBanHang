// Món nào phải báo bếp và món nào CHƯA báo — cùng cách chọn máy với
// kitchen_tickets.sql (máy chủ) và print.jsx / PrintAgent: category theo LOẠI đã
// chọn (choiceCategories), máy đang bật đầu tiên (sort_order) nhận category đó,
// không có thì máy mặc định. Máy in hoá đơn ở quầy (nước, bia, khăn) không tính là bếp.

// Đơn khách quét QR: điện thoại tạo phiếu in ngay sau khi lưu đơn → chờ chút rồi
// mới báo "chưa báo bếp", tránh dấu nháy lên trong 1-2 giây đó.
export const KITCHEN_GRACE_MS = 20000;

export function resolvePrintCategory(item, menuOptions = []) {
  let cat = item.menu_item?.category_id ?? null;
  if (Array.isArray(item.item_options)) {
    for (const opt of item.item_options) {
      const mo = (menuOptions || []).find(o => o.name === opt.name);
      if (mo && Array.isArray(mo.choiceCategories) && Array.isArray(mo.choices)) {
        const idx = mo.choices.indexOf(opt.choice);
        if (idx >= 0 && mo.choiceCategories[idx]) cat = mo.choiceCategories[idx];
      }
    }
  }
  return cat;
}

// Máy đang bật nhận category này (máy bếp hoặc máy hoá đơn ở quầy), không có thì máy mặc định.
export function printerForCategory(categoryId, printers) {
  const active = (printers || []).filter(p => p.is_active)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return (categoryId && active.find(p => (p.printer_categories || []).some(pc => pc.category_id === categoryId)))
    || active.find(p => p.is_default) || null;
}

// Máy bếp nhận category này, hoặc null nếu món đi máy in hoá đơn / không có máy.
export function kitchenPrinterFor(categoryId, printers) {
  const routed = printerForCategory(categoryId, printers);
  return routed && !routed.is_bill_printer ? routed : null;
}

// Nút "In món" (nhân viên tự chọn món cần in): gom các dòng đã chọn theo máy in của từng
// món — món bếp ra máy bếp, nước / bia / khăn ra máy quầy. Mỗi máy 1 phiếu chỉ in đúng
// các dòng đó (only_item_ids). Dòng giảm giá (giá âm, không có món) không in.
export function manualPrintJobs(orderId, items, printers, menuOptionsOf) {
  const byPrinter = new Map();
  const sorted = [...(items || [])].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  for (const item of sorted) {
    if (!item.menu_item_id && (Number(item.unit_price) || 0) < 0) continue;
    const printer = printerForCategory(resolvePrintCategory(item, menuOptionsOf(item)), printers);
    if (!printer) continue;
    if (!byPrinter.has(printer.id)) byPrinter.set(printer.id, []);
    byPrinter.get(printer.id).push(item.id);
  }
  return [...byPrinter].map(([printerId, ids]) => ({ order_id: orderId, printer_id: printerId, only_item_ids: ids, status: 'pending' }));
}

export function isKitchenItem(item, printers, menuOptions) {
  return !!item.menu_item_id && !!kitchenPrinterFor(resolvePrintCategory(item, menuOptions), printers);
}

// Món bếp chưa có phiếu bếp nào. Trả [] khi DB chưa có cột kitchen_sent_at
// (trang đã lên bản mới nhưng chưa chạy migration kitchen_tickets.sql).
export function unsentKitchenItems(items, printers, menuOptionsOf, now = Date.now()) {
  return (items || []).filter(item =>
    'kitchen_sent_at' in item && !item.kitchen_sent_at
    && !(item.created_at && now - Date.parse(item.created_at) < KITCHEN_GRACE_MS)
    && isKitchenItem(item, printers, menuOptionsOf(item)));
}

// Bao lâu nữa thì món mới nhất (chưa có phiếu) hết thời gian chờ — để vẽ lại dấu đúng lúc.
export function nextKitchenCheckIn(items, now = Date.now()) {
  const waits = (items || [])
    .filter(item => 'kitchen_sent_at' in item && !item.kitchen_sent_at && item.created_at)
    .map(item => Date.parse(item.created_at) + KITCHEN_GRACE_MS - now)
    .filter(ms => ms > 0);
  return waits.length ? Math.min(...waits) + 50 : null;
}
