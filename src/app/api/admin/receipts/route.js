/**
 * /api/admin/receipts — trang "Bill giấy" cho thu ngân (nhân viên + admin).
 *
 * GET  → bill giấy hôm nay + bill chuyển khoản hôm nay (để thêm ảnh CK) +
 *        danh sách thẻ nhận tiền. Không trả lãi lỗ / tổng tháng.
 * POST (multipart, field action):
 *   create_paper     amount, method, account_id?, table_label?, note?, image (bắt buộc), transfer_image?
 *   attach_transfer  order_id | receipt_id | source, image
 *   attach_bill      receipt_id | source, image — ảnh tờ bill chụp bổ sung (bill từ trang Mã QR)
 *   delete_paper     id — nhân viên chỉ xoá bill giấy mình nhập trong ngày; admin xoá được mọi bill giấy
 *
 *   qr_confirm       code, amount, account_id, kind ('ck' | 'bill'), image — trang Mã QR: "Xác nhận đã nhận tiền"
 *   qr_cash          receipt_id, amount, image — trang Mã QR: "Nhận tiền mặt"
 *   table_pay        table_id, order_ids, amount, method, account_id?, hide_stats, transaction_code?,
 *                    image | skip_reason — trang Bàn: đóng bàn (complete_table_payment_atomic) chỉ khi có
 *                    ảnh màn hình CK / tiền mặt khách đưa, hoặc lý do không chụp được (máy lỗi...)
 *
 * source = 'qr:<mã>' / 'cash:<id phiếu>': bill giấy DB tự ghi khi thu ở trang
 * Mã QR (owner_finance.sql, capture_qr_page_receipt). qr_confirm / qr_cash bắt
 * buộc có ảnh (tờ bill hoặc màn hình ĐT khách): chưa chụp thì chưa ghi tiền.
 *
 * Chạy bằng service role (bảng sổ thu chi đã chặn anon). Không đụng orders
 * hay trang Thống kê.
 */
import { NextResponse } from 'next/server';
import { getStaffSession, statusDatabase } from '@/lib/statusAuth';
import { FINANCE_START_DATE, vnDate } from '@/lib/ownerFinance.mjs';
import { purgeOldReceiptImages, receiptImageProblem, removeReceiptImages, signReceiptImages, uploadReceiptImage } from '@/lib/receiptImages.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const SOURCE = /^(qr:[A-Z0-9]{8}|cash:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
const MAX_AMOUNT = 1_000_000_000;
const missingTable = error => ['PGRST205', '42P01', '42703'].includes(error?.code);
const fail = (error, status = 400) => NextResponse.json({ error }, { status, headers });

async function requireStaff(request) {
  const session = await getStaffSession(request);
  if (session.code !== 200) return { code: session.code };
  return session;
}

// Bill giấy theo id, hoặc theo source khi gửi từ trang Mã QR.
const paperKey = form => form.get('source') ? { key: 'source', id: form.get('source') } : { key: 'id', id: form.get('receipt_id') };
const validKey = (key, id) => !!id && (key === 'source' ? SOURCE : UUID).test(id);

function denied(code) {
  return fail(code === 503 ? 'Không kiểm tra được đăng nhập.' : 'Cần đăng nhập nhân viên.', code);
}

async function activeAccounts(db) {
  const { data, error } = await db.from('bank_accounts').select('id, bank_name, account_name, account_number, is_active').order('sort_order');
  if (error) throw error;
  return (data || []).filter(a => a.is_active).map(a => ({
    id: a.id, name: [a.bank_name, a.account_name].filter(Boolean).join(' · ') || 'Tài khoản', last4: String(a.account_number || '').slice(-4),
  }));
}

export async function GET(request) {
  try {
    const session = await requireStaff(request);
    if (session.code !== 200) return denied(session.code);
    const db = statusDatabase();
    const today = vnDate(Date.now());
    purgeOldReceiptImages(db).catch(error => console.error('[receipts] purge', error));
    const [paper, transfers, accounts] = await Promise.all([
      db.from('finance_manual_receipts').select('*').eq('business_date', today).order('received_at', { ascending: false }),
      db.from('finance_revenue_ledger').select('order_id, paid_at, table_number, customer_name, amount, account_id, transfer_image_path')
        .eq('business_date', today).eq('payment_method', 'transfer').order('paid_at', { ascending: false }),
      activeAccounts(db),
    ]);
    for (const result of [paper, transfers]) {
      if (result.error) {
        if (missingTable(result.error)) return fail('Chưa cài bảng bill giấy trên cơ sở dữ liệu (owner_finance.sql).', 503);
        throw result.error;
      }
    }
    const urls = await signReceiptImages(db, [
      ...paper.data.flatMap(r => [r.image_path, r.transfer_image_path]),
      ...transfers.data.map(r => r.transfer_image_path),
    ]);
    return NextResponse.json({
      today, startDate: FINANCE_START_DATE, accounts, me: { id: session.user.id, role: session.user.role },
      paperBills: paper.data.map(r => ({
        id: r.id, receivedAt: r.received_at, amount: Number(r.amount), paymentMethod: r.payment_method, accountId: r.account_id,
        tableLabel: r.table_label, note: r.note, createdByName: r.created_by_name, mine: r.created_by_id === session.user.id,
        imageUrl: urls[r.image_path] || null, transferImageUrl: urls[r.transfer_image_path] || null,
      })),
      transferBills: transfers.data.map(r => ({
        orderId: r.order_id, paidAt: r.paid_at, tableNumber: r.table_number, customerName: r.customer_name,
        amount: Number(r.amount), accountId: r.account_id, transferImageUrl: urls[r.transfer_image_path] || null,
      })),
    }, { headers });
  } catch (error) {
    console.error('[receipts] GET', error);
    return fail('Không tải được dữ liệu, thử lại.', 500);
  }
}

export async function POST(request) {
  try {
    const session = await requireStaff(request);
    if (session.code !== 200) return denied(session.code);
    const form = await request.formData().catch(() => null);
    if (!form) return fail('Dữ liệu gửi lên không hợp lệ.');
    const action = form.get('action');
    const db = statusDatabase();
    const today = vnDate(Date.now());
    const isAdmin = session.user.role === 'admin';

    if (action === 'create_paper') {
      const amount = Math.round(Number(String(form.get('amount') || '').replace(/\D/g, '')));
      const method = form.get('method');
      const accountId = form.get('account_id') || null;
      const image = form.get('image');
      const transferImage = form.get('transfer_image');
      if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return fail('Nhập số tiền tổng của bill.');
      if (!['cash', 'transfer'].includes(method)) return fail('Chọn tiền mặt hay chuyển khoản.');
      const problem = receiptImageProblem(image);
      if (problem) return fail(problem === 'Thiếu ảnh.' ? 'Chụp ảnh tờ bill giấy trước khi lưu.' : problem);
      const hasTransferImage = transferImage && typeof transferImage !== 'string' && transferImage.size > 0;
      if (hasTransferImage) { const p = receiptImageProblem(transferImage); if (p) return fail(`Ảnh chuyển khoản: ${p}`); }
      if (method === 'transfer') {
        if (!accountId || !UUID.test(accountId)) return fail('Chọn thẻ nhận tiền.');
        if (!(await activeAccounts(db)).some(a => a.id === accountId)) return fail('Thẻ nhận tiền không hợp lệ.');
      }
      const imagePath = await uploadReceiptImage(db, image, 'bill');
      const transferPath = hasTransferImage && method === 'transfer' ? await uploadReceiptImage(db, transferImage, 'ck') : null;
      const { data, error } = await db.from('finance_manual_receipts').insert({
        business_date: today, amount, payment_method: method, account_id: method === 'transfer' ? accountId : null,
        table_label: String(form.get('table_label') || '').trim().slice(0, 40) || null,
        note: String(form.get('note') || '').trim().slice(0, 200) || null,
        image_path: imagePath, transfer_image_path: transferPath,
        created_by_id: session.user.id, created_by_name: session.user.full_name || null,
      }).select('id').single();
      if (error) {
        await removeReceiptImages(db, [imagePath, transferPath]);
        if (missingTable(error)) return fail('Chưa cài bảng bill giấy trên cơ sở dữ liệu (owner_finance.sql).', 503);
        throw error;
      }
      return NextResponse.json({ ok: true, id: data.id }, { headers });
    }

    if (action === 'attach_transfer') {
      const image = form.get('image');
      const problem = receiptImageProblem(image);
      if (problem) return fail(problem);
      // Ngay sau "Đã nhận tiền": một ảnh cho tất cả bill của bàn vừa thanh toán.
      const orderIds = String(form.get('order_ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (orderIds.length) {
        if (orderIds.length > 50 || !orderIds.every(id => UUID.test(id))) return fail('Danh sách bill không hợp lệ.');
        const { data: rows, error } = await db.from('finance_revenue_ledger').select('order_id, transfer_image_path, payment_method, business_date').in('order_id', orderIds);
        if (error) throw error;
        const targets = (rows || []).filter(r => r.payment_method === 'transfer' && (isAdmin || r.business_date === today));
        if (!targets.length) return fail('Không tìm thấy bill chuyển khoản vừa thanh toán trong sổ.', 404);
        const path = await uploadReceiptImage(db, image, 'ck');
        const update = await db.from('finance_revenue_ledger')
          .update({ transfer_image_path: path, transfer_image_by: session.user.full_name || null })
          .in('order_id', targets.map(r => r.order_id));
        if (update.error) { await removeReceiptImages(db, [path]); throw update.error; }
        // Ảnh cũ không còn dòng nào dùng thì xoá.
        const old = [...new Set(targets.map(r => r.transfer_image_path).filter(p => p && p !== path))];
        await removeReceiptImages(db, old);
        return NextResponse.json({ ok: true, bills: targets.length }, { headers });
      }
      const orderId = form.get('order_id');
      const table = orderId ? 'finance_revenue_ledger' : 'finance_manual_receipts';
      const { key, id } = orderId ? { key: 'order_id', id: orderId } : paperKey(form);
      if (!validKey(key, id)) return fail('Thiếu bill cần thêm ảnh.');
      const { data: row, error } = await db.from(table).select(`${key}, transfer_image_path, payment_method, business_date`).eq(key, id).maybeSingle();
      if (error) throw error;
      if (!row || row.payment_method !== 'transfer') return fail('Không tìm thấy bill chuyển khoản này.', 404);
      // Nhân viên chỉ thêm ảnh cho bill hôm nay; admin thêm cho mọi ngày.
      if (!isAdmin && row.business_date !== today) return fail('Chỉ thêm ảnh cho bill hôm nay.', 403);
      const path = await uploadReceiptImage(db, image, 'ck');
      const patch = orderId ? { transfer_image_path: path, transfer_image_by: session.user.full_name || null } : { transfer_image_path: path };
      const update = await db.from(table).update(patch).eq(key, id);
      if (update.error) { await removeReceiptImages(db, [path]); throw update.error; }
      await removeReceiptImages(db, [row.transfer_image_path]);
      return NextResponse.json({ ok: true }, { headers });
    }

    if (action === 'attach_bill') {
      const image = form.get('image');
      const problem = receiptImageProblem(image);
      if (problem) return fail(problem);
      const { key, id } = paperKey(form);
      if (!validKey(key, id)) return fail('Thiếu bill cần thêm ảnh.');
      const { data: row, error } = await db.from('finance_manual_receipts').select('id, image_path, business_date').eq(key, id).maybeSingle();
      if (error) throw error;
      if (!row) return fail('Không tìm thấy bill giấy này.', 404);
      if (!isAdmin && row.business_date !== today) return fail('Chỉ thêm ảnh cho bill hôm nay.', 403);
      const path = await uploadReceiptImage(db, image, 'bill');
      const update = await db.from('finance_manual_receipts').update({ image_path: path }).eq('id', row.id);
      if (update.error) { await removeReceiptImages(db, [path]); throw update.error; }
      await removeReceiptImages(db, [row.image_path]);
      return NextResponse.json({ ok: true }, { headers });
    }

    if (action === 'qr_confirm' || action === 'qr_cash') {
      const cash = action === 'qr_cash';
      const image = form.get('image');
      const problem = receiptImageProblem(image);
      if (problem) return fail(problem === 'Thiếu ảnh.' ? 'Chụp tờ bill hoặc màn hình điện thoại khách trước khi xác nhận.' : problem);
      const amount = Number(form.get('amount'));
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) return fail('Số tiền không hợp lệ.');
      const code = String(form.get(cash ? 'receipt_id' : 'code') || '');
      const accountId = String(form.get('account_id') || '');
      if (cash ? !UUID.test(code) : (!/^[A-Z0-9]{8}$/.test(code) || !UUID.test(accountId))) return fail('Thiếu mã giao dịch.');
      const kind = !cash && form.get('kind') !== 'bill' ? 'ck' : 'bill';
      // Lưu ảnh trước: tiền chỉ được ghi khi ảnh đã nằm trong kho.
      const path = await uploadReceiptImage(db, image, kind);
      const { data, error } = cash
        ? await db.rpc('record_custom_cash_receipt', { p_id: code, p_amount: amount })
        : await db.rpc('confirm_custom_qr_payment', { p_code: code, p_expected_amount: amount, p_account_id: accountId });
      if (error || !data?.success) {
        await removeReceiptImages(db, [path]);
        // P0001 = câu báo lỗi tiếng Việt do hàm SQL tự đặt (mã không khớp, đã huỷ...).
        return fail(error?.code === 'P0001' ? error.message : 'Chưa ghi được tiền, thử lại.');
      }
      const column = kind === 'bill' ? 'image_path' : 'transfer_image_path';
      const { data: row, error: rowError } = await db.from('finance_manual_receipts').select(`id, ${column}`)
        .eq('source', `${cash ? 'cash' : 'qr'}:${code}`).maybeSingle();
      if (rowError || !row) {
        // Tiền đã ghi; chỉ thiếu dòng Sổ thu chi (trigger chưa cài / lỗi) → không giữ ảnh mồ côi.
        console.error('[receipts] QR page receipt missing', rowError || code);
        await removeReceiptImages(db, [path]);
        return NextResponse.json({ ok: true, photoSaved: false, alreadyDone: !!data.already_completed }, { headers });
      }
      const update = await db.from('finance_manual_receipts')
        .update({ [column]: path, created_by_name: `Trang Mã QR · ${session.user.full_name || 'nhân viên'}` }).eq('id', row.id);
      if (update.error) { await removeReceiptImages(db, [path]); throw update.error; }
      await removeReceiptImages(db, [row[column]]);
      return NextResponse.json({ ok: true, photoSaved: true, alreadyDone: !!data.already_completed }, { headers });
    }

    if (action === 'table_pay') {
      const method = form.get('method');
      if (!['cash', 'transfer'].includes(method)) return fail('Chọn tiền mặt hay chuyển khoản.');
      const tableId = String(form.get('table_id') || '');
      const orderIds = String(form.get('order_ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!UUID.test(tableId) || !orderIds.length || orderIds.length > 50 || !orderIds.every(id => UUID.test(id))) return fail('Bàn hoặc bill không hợp lệ.');
      const amount = Number(form.get('amount'));
      if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return fail('Số tiền không hợp lệ.');
      const accountId = method === 'transfer' ? String(form.get('account_id') || '') : null;
      if (method === 'transfer' && !UUID.test(accountId)) return fail('Thiếu thẻ nhận tiền.');
      const image = form.get('image');
      const hasImage = !!image && typeof image !== 'string' && image.size > 0;
      const skipReason = String(form.get('skip_reason') || '').trim().slice(0, 200);
      if (hasImage) {
        const problem = receiptImageProblem(image);
        if (problem) return fail(problem);
      } else if (skipReason.length < 3) {
        return fail(method === 'cash' ? 'Chụp tiền khách đưa trước khi đóng bàn.' : 'Chụp màn hình chuyển khoản của khách trước khi đóng bàn.');
      }
      // Lưu ảnh trước: bàn chỉ được đóng khi ảnh đã nằm trong kho.
      const path = hasImage ? await uploadReceiptImage(db, image, method === 'cash' ? 'cash' : 'ck') : null;
      const { data, error } = await db.rpc('complete_table_payment_atomic', {
        p_table_id: tableId, p_expected_order_ids: orderIds, p_expected_amount: amount, p_payment_method: method,
        p_account_id: accountId, p_hide_stats: form.get('hide_stats') === '1',
        p_staff_id: session.user.id, p_staff_name: session.user.full_name || null,
        p_transaction_code: method === 'transfer' ? String(form.get('transaction_code') || '') || null : null,
      });
      if (error || !data?.success) {
        await removeReceiptImages(db, [path]);
        // Bill đổi món / số tiền lúc thanh toán → trang Bàn đọc lại và cho kiểm tra lại.
        if (!error) return NextResponse.json({ error: 'Bill đã thay đổi.', reason: data?.reason || null, total: data?.total ?? null }, { status: 409, headers });
        return fail(error.code === 'P0001' ? error.message : 'Chưa đóng được bàn, thử lại.');
      }
      const by = session.user.full_name || null;
      const patch = !hasImage ? { photo_skip_reason: skipReason, photo_by: by }
        : method === 'cash' ? { cash_image_path: path, photo_by: by } : { transfer_image_path: path, transfer_image_by: by, photo_by: by };
      // Sổ thu chi đã ghi bill (trigger capture_finance_revenue, cùng giao dịch đóng bàn).
      const update = await db.from('finance_revenue_ledger').update(patch).in('order_id', orderIds).select('order_id');
      const photoSaved = !update.error && (update.data || []).length > 0;
      if (!photoSaved) {
        console.error('[receipts] table photo', update.error || 'no ledger rows');
        await removeReceiptImages(db, [path]);
      }
      return NextResponse.json({ ok: true, photoSaved }, { headers });
    }

    if (action === 'delete_paper') {
      const id = form.get('id');
      if (!id || !UUID.test(id)) return fail('Thiếu bill giấy cần xoá.');
      const { data: row, error } = await db.from('finance_manual_receipts').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!row) return fail('Không tìm thấy bill giấy.', 404);
      if (!isAdmin && (row.created_by_id !== session.user.id || row.business_date !== today)) {
        return fail('Chỉ xoá được bill giấy do bạn nhập trong hôm nay.', 403);
      }
      const del = await db.from('finance_manual_receipts').delete().eq('id', id);
      if (del.error) throw del.error;
      await removeReceiptImages(db, [row.image_path, row.transfer_image_path]);
      return NextResponse.json({ ok: true }, { headers });
    }

    return fail('Thao tác không hợp lệ.');
  } catch (error) {
    console.error('[receipts] POST', error);
    return fail('Không lưu được, thử lại.', 500);
  }
}
