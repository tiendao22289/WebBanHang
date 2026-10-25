/**
 * So khuôn mặt ở máy quầy (app iPhone "Chấm công"). App tính "dấu mặt" — 128 số, mô hình SFace — ngay
 * trên máy sau khi người đứng trước máy chớp mắt; máy chủ chỉ lưu dấu mặt mẫu của từng người (không lưu
 * ảnh) và so bằng độ giống cosine (1 = y hệt). Mặt mẫu lấy trên máy quầy khi có chủ quán đăng nhập.
 *
 * Quét mã xong, nếu người đó có mặt mẫu và máy quầy là app: chưa ghi giờ, chờ máy quầy so mặt (1 phút).
 * Đúng mặt → ghi giờ. Sai → lượt đó không tính. Sai 3 lần liền → vẫn ghi giờ nhưng ca đó "chờ chủ duyệt"
 * (chưa tính lương tới khi chủ bấm Đúng người).
 */
export const FACE_MODEL = 'sface-2021dec';
export const FACE_DIM = 128;
// Độ khắt khe: ngưỡng độ giống để coi là cùng người (SFace trên bộ ảnh chuẩn dùng 0,363).
export const FACE_LEVELS = { loose: 0.34, normal: 0.4, strict: 0.48 };
export const FACE_LEVEL_TEXT = { loose: 'Dễ', normal: 'Vừa', strict: 'Chặt' };
export const FACE_WAIT_MS = 60000;
export const FACE_TRIES = 3;
// Các lần sai trong 1 giờ (chưa có lần đúng xen giữa) mới tính là sai liền nhau.
export const FACE_STREAK_MS = 3600000;
// Máy quầy là app nếu app vừa hỏi mã trong 2 phút qua.
export const FACE_APP_FRESH_MS = 120000;
export const ENROLL_MIN = 3, ENROLL_MAX = 5;
// Các dấu mặt lấy mẫu một lần phải giống nhau (cùng một người, ảnh rõ).
export const ENROLL_SELF_MIN = 0.5;
// Lý do app báo không so được (không tính là sai mặt).
export const FACE_MISS_TEXT = {
  no_face: 'Máy quầy không thấy mặt',
  no_blink: 'Chưa thấy chớp mắt',
  camera: 'Camera máy quầy lỗi',
  busy: 'Máy quầy đang so mặt người khác',
  cancelled: 'Đã huỷ',
  error: 'Máy quầy lỗi khi so mặt',
  timeout: 'Hết 1 phút chờ so mặt',
};

/** Dấu mặt hợp lệ (128 số thật) → đã chuẩn hoá độ dài 1; không thì null. */
export function faceVector(v) {
  if (!Array.isArray(v) || v.length !== FACE_DIM) return null;
  const nums = v.map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const norm = Math.sqrt(nums.reduce((a, x) => a + x * x, 0));
  return norm > 1e-6 ? nums.map(x => x / norm) : null;
}

/** Danh sách dấu mặt hợp lệ (đúng số lượng) hoặc null. */
export function faceVectors(list, min = 1, max = ENROLL_MAX) {
  if (!Array.isArray(list) || list.length < min || list.length > max) return null;
  const out = list.map(faceVector);
  return out.every(Boolean) ? out : null;
}

export const cosine = (a, b) => a.reduce((acc, x, i) => acc + x * b[i], 0);

/** Độ giống cao nhất giữa các dấu mặt vừa chụp và các dấu mặt mẫu. */
export function bestScore(probes, templates) {
  let best = -1;
  for (const p of probes || []) for (const t of templates || []) best = Math.max(best, cosine(p, t));
  return best;
}

/** Độ giống thấp nhất giữa các dấu mặt của một lần lấy mẫu (ảnh mờ / hai người khác nhau thì thấp). */
export function enrollConsistency(vectors) {
  let worst = 1;
  for (let i = 0; i < vectors.length; i += 1) for (let j = i + 1; j < vectors.length; j += 1) worst = Math.min(worst, cosine(vectors[i], vectors[j]));
  return worst;
}

export const faceThreshold = settings => FACE_LEVELS[settings?.level] ?? FACE_LEVELS.normal;

/**
 * Kết quả một lần so: đúng mặt → 'ok'; sai mà đã sai liền (wrongStreak lần trước) đủ 3 lần → 'review'
 * (ghi giờ, chờ chủ duyệt); không thì 'wrong' (lượt này không tính).
 */
export function faceOutcome(score, threshold, wrongStreak = 0) {
  if (score >= threshold) return 'ok';
  return wrongStreak + 1 >= FACE_TRIES ? 'review' : 'wrong';
}

/** Số lần sai liền gần nhất (các lượt mới nhất trước): dừng ở lần đúng / chờ duyệt; lượt hết giờ, huỷ thì bỏ qua. */
export function wrongStreak(checks) {
  let n = 0;
  for (const c of checks || []) {
    if (c.status === 'wrong') n += 1;
    else if (c.status === 'ok' || c.status === 'review') break;
  }
  return n;
}

// Bảng so mặt chưa tạo (web mới vừa lên, chưa chạy migration checkin_face.sql): chấm công, tính lương vẫn chạy như cũ.
export const missingTable = e => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(String(e.message || '')));

export async function readFaceSettings(db) {
  const { data, error } = await db.from('checkin_face_settings').select('*').eq('id', 1).maybeSingle();
  if (missingTable(error)) return { enabled: false, level: 'normal', missing: true };
  if (error) throw error;
  return { enabled: data ? data.enabled !== false : true, level: FACE_LEVELS[data?.level] ? data.level : 'normal' };
}

/**
 * Lượt quét này có phải so mặt không: so mặt đang bật, máy quầy là app (vừa hỏi mã) → 'face' nếu người
 * đó có mặt mẫu, 'no_template' nếu chưa (vẫn chấm như cũ, ghi cảnh báo). Không thì null.
 */
export async function faceNeeded(db, staffId, kioskId, now) {
  const settings = await readFaceSettings(db);
  if (!settings.enabled) return null;
  const [app, template] = await Promise.all([
    db.from('checkin_kiosk_apps').select('seen_at').eq('kiosk_id', kioskId).maybeSingle(),
    db.from('staff_face_templates').select('staff_id').eq('staff_id', staffId).maybeSingle(),
  ]);
  for (const r of [app, template]) if (r.error) throw r.error;
  if (!app.data || now - Date.parse(app.data.seen_at) > FACE_APP_FRESH_MS) return null;
  return template.data ? 'face' : 'no_template';
}

/** Mã các ca đang "chờ chủ duyệt mặt" trong danh sách ca (ca đó chưa tính lương). */
export async function faceHolds(db, sessionIds) {
  const held = new Set();
  for (let i = 0; i < sessionIds.length; i += 200) {
    const { data, error } = await db.from('attendance_face_reviews').select('attendance_id').eq('status', 'pending').in('attendance_id', sessionIds.slice(i, i + 200));
    if (missingTable(error)) return held;
    if (error) throw error;
    for (const r of data || []) held.add(r.attendance_id);
  }
  return held;
}

/** Đánh dấu face_hold lên các ca đang chờ duyệt mặt (computeSalary / monthTallies bỏ qua các ca này). */
export const markFaceHolds = (sessions, held) => (held.size ? sessions.map(s => (held.has(s.id) ? { ...s, face_hold: true } : s)) : sessions);
