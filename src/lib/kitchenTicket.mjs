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

// Máy bếp nhận category này, hoặc null nếu món đi máy in hoá đơn / không có máy.
export function kitchenPrinterFor(categoryId, printers) {
  const active = (printers || []).filter(p => p.is_active)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const routed = (categoryId && active.find(p => (p.printer_categories || []).some(pc => pc.category_id === categoryId)))
    || active.find(p => p.is_default) || null;
  return routed && !routed.is_bill_printer ? routed : null;
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
