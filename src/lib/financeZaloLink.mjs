/**
 * Báo cáo Sổ thu chi qua Zalo — cài đặt lưu ở finance_settings['zalo_report']:
 *   { ownerIds: [zalo user id], linkCode, linkCodeExpires, linkAttempts,
 *     lastSentDate, lastSentAt, lastError }
 *
 * Liên kết: chủ quán lấy mã 6 số trong Sổ thu chi rồi nhắn "BC 123456" cho OA.
 * Webhook Zalo chưa kiểm chữ ký, nên mã chỉ sống 30 phút và sai 5 lần là huỷ
 * — người ngoài không dò được mã để nhận báo cáo tiền của quán.
 *
 * Không import gì: webhook truyền hàm gửi tin vào (sendOaText).
 */
export const REPORT_SETTINGS_KEY = 'zalo_report';
export const LINK_CODE_MINUTES = 30;
const MAX_LINK_ATTEMPTS = 5;
const MAX_OWNERS = 3;
const LINK_TEXT = /^\s*bc\s*(\d{6})\s*$/i;
const missingTable = error => ['PGRST205', '42P01'].includes(error?.code);

/** null = chưa cài bảng finance_settings. */
export async function readReportSettings(db) {
  const { data, error } = await db.from('finance_settings').select('value').eq('key', REPORT_SETTINGS_KEY).maybeSingle();
  if (error) { if (missingTable(error)) return null; throw error; }
  return { ownerIds: [], ...(data?.value || {}) };
}

export async function saveReportSettings(db, value) {
  const { error } = await db.from('finance_settings')
    .upsert({ key: REPORT_SETTINGS_KEY, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

/** Trạng thái gửi về trang Sổ thu chi (không lộ Zalo id). */
export function reportStatus(settings, now = Date.now()) {
  if (!settings) return null;
  const codeLive = !!settings.linkCode && Number(settings.linkCodeExpires) > now;
  return {
    linked: (settings.ownerIds || []).length,
    linkCode: codeLive ? settings.linkCode : null,
    linkCodeExpires: codeLive ? settings.linkCodeExpires : null,
    lastSentAt: settings.lastSentAt || null,
    lastSentDate: settings.lastSentDate || null,
    lastError: settings.lastError || null,
  };
}

/**
 * Tin "BC 123456" gửi tới OA. Trả true khi đã xử lý (là tin liên kết), để
 * webhook không đưa tin này vào luồng vòng quay / quà tặng.
 */
export async function linkFinanceReport(db, event, send = async () => {}, now = Date.now()) {
  if (event?.event_name !== 'user_send_text') return false;
  const match = LINK_TEXT.exec(String(event.message?.text || ''));
  const uid = event.sender?.id;
  if (!match || !uid) return false;
  const settings = await readReportSettings(db);
  if (!settings) return false;
  // Trả lời hỏng (hết hạn mức, token...) không được đẩy tin này sang luồng vòng quay.
  const reply = text => Promise.resolve().then(() => send(db, uid, text)).catch(() => {});
  const live = !!settings.linkCode && Number(settings.linkCodeExpires) > now;
  if (!live) {
    await reply('Mã liên kết đã hết hạn. Mở Sổ thu chi → Tổng quan → Báo cáo Zalo để lấy mã mới.');
    return true;
  }
  if (match[1] !== settings.linkCode) {
    const attempts = (Number(settings.linkAttempts) || 0) + 1;
    await saveReportSettings(db, { ...settings, linkAttempts: attempts,
      ...(attempts >= MAX_LINK_ATTEMPTS ? { linkCode: null, linkCodeExpires: null } : {}) });
    await reply(attempts >= MAX_LINK_ATTEMPTS ? 'Sai mã nhiều lần, mã đã bị huỷ. Lấy mã mới trong Sổ thu chi.' : 'Mã liên kết không đúng.');
    return true;
  }
  const ownerIds = [...new Set([...(settings.ownerIds || []), String(uid)])].slice(-MAX_OWNERS);
  await saveReportSettings(db, { ...settings, ownerIds, linkCode: null, linkCodeExpires: null, linkAttempts: 0, lastError: null });
  await reply('✅ Đã liên kết Zalo này với Sổ thu chi. Mỗi sáng khoảng 8 giờ sẽ có báo cáo của ngày hôm trước.');
  return true;
}
