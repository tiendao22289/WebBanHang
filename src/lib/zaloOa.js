/**
 * zaloOa.js — Quản lý token Zalo OA và gửi tin nhắn cho khách.
 *
 * CHỈ dùng ở server (cần SUPABASE_SERVICE_ROLE_KEY + ZALO_APP_SECRET).
 *
 * VÌ SAO PHẢI LƯU TOKEN Ở DB, KHÔNG PHẢI BIẾN MÔI TRƯỜNG:
 *  - access_token của Zalo hết hạn sau ~1 GIỜ.
 *  - refresh_token dùng ĐƯỢC ĐÚNG MỘT LẦN: mỗi lần làm mới, Zalo trả về một
 *    refresh_token MỚI và vô hiệu cái cũ. Biến môi trường không ghi lại được
 *    lúc chạy, nên bắt buộc phải cất ở bảng `zalo_oa_tokens` (bảng này bật RLS
 *    và chỉ cấp quyền cho service_role — khách không đọc được).
 *  - Mất refresh_token = phải uỷ quyền lại bằng tay, nên luôn lưu token mới
 *    TRƯỚC khi dùng access_token.
 */

const TOKEN_URL = 'https://oauth.zaloapp.com/v4/oa/access_token';
const PERMISSION_URL = 'https://oauth.zaloapp.com/v4/oa/permission';
const SEND_MESSAGE_URL = 'https://openapi.zalo.me/v3.0/oa/message/cs';
const ROW_ID = 'default';

/** Link để chủ quán bấm uỷ quyền OA cho app (chạy 1 lần). */
export function buildPermissionUrl(redirectUri, state = '') {
  const appId = process.env.ZALO_APP_ID || '';
  const q = new URLSearchParams({ app_id: appId, redirect_uri: redirectUri });
  if (state) q.set('state', state);
  return `${PERMISSION_URL}?${q.toString()}`;
}

/** Gọi endpoint token của Zalo. Trả về { access_token, refresh_token, expires_in }. */
async function callTokenEndpoint(params) {
  // trim() phòng lúc dán bị dính khoảng trắng / xuống dòng ở cuối.
  const secret = (process.env.ZALO_APP_SECRET || '').trim();
  const appId = (process.env.ZALO_APP_ID || '').trim();
  if (!secret || !appId) throw new Error('Thiếu ZALO_APP_ID hoặc ZALO_APP_SECRET');
  // Secret đi trong HEADER, mà header HTTP chỉ nhận ký tự ASCII. Khoá thật của
  // Zalo chỉ gồm chữ và số; có dấu tiếng Việt nghĩa là dán nhầm nội dung khác.
  // Không chặn ở đây thì fetch ném "Cannot convert argument to a ByteString",
  // đọc không ra vấn đề.
  if (!/^[\x20-\x7E]+$/.test(secret)) {
    throw new Error('ZALO_APP_SECRET chứa ký tự có dấu — có vẻ dán nhầm. '
      + 'Hãy copy lại đúng "Khóa bí mật của ứng dụng" (chỉ gồm chữ và số) trên Zalo Developers.');
  }
  if (!/^\d+$/.test(appId)) {
    throw new Error('ZALO_APP_ID phải là dãy số — hiện đang không đúng định dạng.');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: secret },
    body: new URLSearchParams({ app_id: appId, ...params }).toString(),
  });
  const data = await res.json().catch(() => null);
  // Zalo trả 200 kèm `error` khác 0 khi hỏng, nên phải xét cả body.
  if (!res.ok || !data?.access_token) {
    const reason = data ? JSON.stringify(data) : `HTTP ${res.status}`;
    throw new Error(`Zalo từ chối cấp token: ${reason}`);
  }
  return data;
}

/** Ghi token vào DB. Luôn lưu cả refresh_token mới vì Zalo xoay vòng nó. */
async function saveTokens(supabase, data) {
  const expiresIn = Number(data.expires_in) || 3600;
  const { error } = await supabase.from('zalo_oa_tokens').upsert({
    id: ROW_ID,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) throw new Error(`Không lưu được token: ${error.message}`);
}

/** Đổi mã uỷ quyền (lần đầu) lấy token và lưu lại. */
export async function exchangeCodeForTokens(supabase, code) {
  const data = await callTokenEndpoint({ code, grant_type: 'authorization_code' });
  await saveTokens(supabase, data);
  return data;
}

/**
 * Trả về access_token còn hạn; tự làm mới khi sắp hết.
 * Làm mới sớm 2 phút để tránh token chết giữa chừng một request.
 */
export async function getValidAccessToken(supabase) {
  const { data: row, error } = await supabase
    .from('zalo_oa_tokens').select('*').eq('id', ROW_ID).maybeSingle();
  if (error) throw new Error(`Không đọc được token: ${error.message}`);
  if (!row?.refresh_token) {
    throw new Error('Chưa uỷ quyền Zalo OA — chủ quán cần bấm link uỷ quyền một lần.');
  }
  const stillValid = row.access_token && row.expires_at
    && new Date(row.expires_at).getTime() - Date.now() > 120000;
  if (stillValid) return row.access_token;

  const data = await callTokenEndpoint({
    refresh_token: row.refresh_token, grant_type: 'refresh_token',
  });
  await saveTokens(supabase, data);
  return data.access_token;
}

/** Gửi tin nhắn tư vấn (text) cho 1 khách đã quan tâm OA. */
export async function sendOaText(supabase, userId, text, log = () => {}) {
  return sendOaMessage(supabase, userId, { text }, log);
}

/**
 * Gửi tin kèm nút "Chia sẻ số điện thoại" — khách bấm 1 cái là Zalo gửi SĐT
 * về webhook (event user_submit_info), khỏi phải gõ tay.
 */
export async function sendOaRequestPhone(supabase, userId, title, subtitle, log = () => {}) {
  // image_url phải là URL ảnh THẬT: gửi chuỗi rỗng bị Zalo trả về
  // {"error":-201,"message":"image_url is not valid"} và không gửi được tin.
  // Dùng icon có sẵn của web quán cho chắc chắn tồn tại.
  const base = (process.env.NEXT_PUBLIC_BASE_URL || 'https://ocbaokhang.vercel.app')
    .replace(/\/+$/, '');
  return sendOaMessage(supabase, userId, {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'request_user_info',
        elements: [{ title, subtitle, image_url: `${base}/icon-192.png` }],
      },
    },
  }, log);
}

async function sendOaMessage(supabase, userId, message, log = () => {}) {
  const accessToken = await getValidAccessToken(supabase);
  const res = await fetch(SEND_MESSAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', access_token: accessToken },
    body: JSON.stringify({ recipient: { user_id: String(userId) }, message }),
  });
  const data = await res.json().catch(() => null);
  // error = 0 là thành công; khác 0 kèm message mô tả (hết quota, ngoài khung
  // thời gian được phép nhắn, chưa quan tâm...).
  if (!res.ok || (data && data.error !== 0)) {
    const detail = data ? JSON.stringify(data) : `HTTP ${res.status}`;
    log(`gui tin OA that bai: ${detail}`);
    // Cất lý do vào DB — log của máy chủ khó lấy, mà không biết Zalo từ chối
    // vì sao thì không sửa được (hết quota / ngoài khung giờ / sai định dạng).
    await recordSendError(supabase, detail);
    return { ok: false, detail: data };
  }
  await recordSendError(supabase, null);
  return { ok: true, detail: data };
}

/** Ghi lý do gửi tin hỏng gần nhất (null = lần gần nhất gửi thành công). */
async function recordSendError(supabase, detail) {
  try {
    await supabase.from('zalo_oa_tokens')
      .update({ last_send_error: detail ? `${new Date().toISOString()} ${detail}`.slice(0, 1000) : null })
      .eq('id', ROW_ID);
  } catch { /* cột chưa tạo cũng không sao — đừng làm hỏng việc gửi tin */ }
}
