/**
 * print.jsx — Tiện ích gửi lệnh in chung cho toàn bộ app
 *
 * Hỗ trợ 2 chế độ:
 *  - sendSmartPrintJobs: routing thông minh theo category của từng máy in (KHUYẾN NGHỊ)
 *  - sendPrintJob / sendPrintJobs: legacy, tạo 1 job không routing (fallback)
 *
 * Cách dùng:
 *   import { sendSmartPrintJobs } from '@/lib/print';
 *   await sendSmartPrintJobs(supabase, orderId);
 */

/**
 * Gửi lệnh in thông minh — routing theo category máy in.
 *
 * Logic:
 *  1. Fetch order_items + category_id của từng món
 *  2. Fetch tất cả máy in active + printer_categories
 *  3. Group items theo máy in phù hợp (dựa vào category)
 *  4. Items không thuộc category nào → máy in mặc định (is_default=true)
 *  5. INSERT 1 print_job / máy in có items
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} orderId
 * @returns {Promise<{ success: boolean, jobCount?: number, error?: string }>}
 */
export async function sendSmartPrintJobs(supabase, orderId) {
  try {
    // 1. Fetch order_items kèm category_id của menu_item
    const { data: items, error: itemsErr } = await supabase
      .from('order_items')
      .select('id, menu_item:menu_items(id, category_id)')
      .eq('order_id', orderId);

    if (itemsErr) throw new Error('Không lấy được order_items: ' + itemsErr.message);
    if (!items || items.length === 0) return { success: true, jobCount: 0 };

    // 2. Fetch printers active + categories của từng máy
    const { data: printers, error: printersErr } = await supabase
      .from('printers')
      .select('id, name, is_default, printer_categories(category_id)')
      .eq('is_active', true)
      .order('sort_order');

    if (printersErr) throw new Error('Không lấy được printers: ' + printersErr.message);
    if (!printers || printers.length === 0) {
      console.warn('[Print] Không có máy in active nào được cấu hình.');
      return { success: true, jobCount: 0 };
    }

    // 3. Build map: category_id → printer_id (ưu tiên printer có sort_order nhỏ nhất)
    const categoryToPrinter = {}; // { [category_id]: printer }
    const defaultPrinter = printers.find(p => p.is_default) || null;

    for (const printer of printers) {
      for (const pc of (printer.printer_categories || [])) {
        if (!categoryToPrinter[pc.category_id]) {
          categoryToPrinter[pc.category_id] = printer;
        }
      }
    }

    // 4. Group items theo printer
    // printerItems: { [printer_id]: Set<category_id> }
    const printerCategoryMap = {}; // { [printer_id]: { printer, categoryIds: Set } }

    for (const item of items) {
      const categoryId = item.menu_item?.category_id;
      const assignedPrinter = categoryId
        ? (categoryToPrinter[categoryId] || defaultPrinter)
        : defaultPrinter;

      if (!assignedPrinter) {
        console.warn('[Print] Món không có máy in phù hợp và không có máy mặc định:', item.id);
        continue;
      }

      if (!printerCategoryMap[assignedPrinter.id]) {
        printerCategoryMap[assignedPrinter.id] = { printer: assignedPrinter, categoryIds: new Set() };
      }
      if (categoryId) {
        printerCategoryMap[assignedPrinter.id].categoryIds.add(categoryId);
      }
    }

    // 5. INSERT 1 print_job / printer có items
    const jobs = Object.values(printerCategoryMap).map(({ printer, categoryIds }) => ({
      order_id: orderId,
      printer_id: printer.id,
      filter_category_ids: categoryIds.size > 0 ? Array.from(categoryIds) : null,
      status: 'pending',
    }));

    if (jobs.length === 0) return { success: true, jobCount: 0 };

    const { error: insertErr } = await supabase.from('print_jobs').insert(jobs);
    if (insertErr) throw new Error('Lỗi insert print_jobs: ' + insertErr.message);

    console.log(`[Print] Đã gửi ${jobs.length} lệnh in cho đơn ${orderId}`);
    return { success: true, jobCount: jobs.length };

  } catch (err) {
    console.error('[Print] sendSmartPrintJobs lỗi:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Gửi lệnh in thông minh cho nhiều đơn cùng lúc (ví dụ: toàn bàn).
 * Mỗi order gọi sendSmartPrintJobs riêng → 1 job/máy/order.
 */
export async function sendSmartPrintJobsBatch(supabase, orderIds) {
  if (!orderIds || orderIds.length === 0) return { success: true, jobCount: 0 };
  let totalJobs = 0;
  for (const orderId of orderIds) {
    const result = await sendSmartPrintJobs(supabase, orderId);
    if (!result.success) return result;
    totalJobs += result.jobCount || 0;
  }
  return { success: true, jobCount: totalJobs };
}

// ─── Legacy (backward compat) ─────────────────────────────────────────────────

/** @deprecated Dùng sendSmartPrintJobs thay thế */
export async function sendPrintJob(supabase, orderId) {
  return sendSmartPrintJobs(supabase, orderId);
}

/** @deprecated Dùng sendSmartPrintJobsBatch thay thế */
export async function sendPrintJobs(supabase, orderIds) {
  return sendSmartPrintJobsBatch(supabase, orderIds);
}

// ─── Admin: In phiếu gộp toàn bàn ───────────────────────────────────────────

/**
 * Gửi 1 print_job gộp tất cả orders của bàn → in 1 phiếu duy nhất trên máy mặc định.
 * Dùng cho 2 nút "In hoá đơn" và "In phiếu tạm tính" trong trang quản lý bàn.
 *
 * PrintAgent nhận job có order_ids[] → fetch + merge tất cả orders → in 1 phiếu.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} orderIds - danh sách order_id của bàn cần gộp
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function sendTableSummaryPrintJob(supabase, orderIds) {
  if (!orderIds || orderIds.length === 0) return { success: true };

  try {
    // 1. Tìm máy in mặc định (is_default = true, is_active = true)
    const { data: printers, error: printerErr } = await supabase
      .from('printers')
      .select('id, name')
      .eq('is_default', true)
      .eq('is_active', true)
      .limit(1);

    if (printerErr) throw new Error(printerErr.message);

    const defaultPrinter = printers?.[0];
    if (!defaultPrinter) {
      return { success: false, error: 'Chưa cấu hình máy in mặc định (is_default = true).' };
    }

    // 2. Insert 1 print_job với order_ids[] (flag để PrintAgent biết cần gộp)
    const { error: insertErr } = await supabase.from('print_jobs').insert({
      order_id: orderIds[0],      // required FK, dùng order đầu tiên
      order_ids: orderIds,         // danh sách đầy đủ để PrintAgent merge
      printer_id: defaultPrinter.id,
      filter_category_ids: null,   // không filter — in tất cả món
      status: 'pending',
    });

    if (insertErr) throw new Error(insertErr.message);

    console.log(`[Print] 📋 Gửi 1 job gộp ${orderIds.length} orders → máy "${defaultPrinter.name}"`);
    return { success: true };

  } catch (err) {
    console.error('[Print] sendTableSummaryPrintJob lỗi:', err.message);
    return { success: false, error: err.message };
  }
}
