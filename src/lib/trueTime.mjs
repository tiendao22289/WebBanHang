/**
 * Giờ thật theo internet cho chấm công. Máy tính chạy web ở quán có thể sai giờ (đã gặp chậm 9 phút
 * rưỡi), mà giờ vào / ra ca, mã QR máy quầy, trễ / sớm, quên ra ca đều tính theo giờ máy chủ. Ở đây hỏi
 * giờ của máy chủ ngoài (Cloudflare, Google), nhớ độ lệch và hỏi lại mỗi 10 phút. Chưa hỏi được lần nào
 * thì tạm dùng giờ máy tính (và hỏi lại sau 1 phút).
 */
const RECHECK_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 2500;

// Cloudflare trả "ts=<giây>"; Google trả tiêu đề Date. Cả hai chỉ đến từng giây → cộng nửa giây.
const trace = async response => {
  const match = /^ts=(\d+(?:\.\d+)?)$/m.exec(await response.text());
  return match ? Math.floor(Number(match[1])) * 1000 + 500 : NaN;
};
const dateHeader = async response => Date.parse(response.headers.get('date') || '') + 500;
const SOURCES = [
  { url: 'https://www.cloudflare.com/cdn-cgi/trace', read: trace },
  { url: 'https://1.1.1.1/cdn-cgi/trace', read: trace },
  { url: 'https://www.google.com/generate_204', read: dateHeader },
];

let offsetMs = 0, synced = false, checkedAt = -Infinity, source = null, inflight = null;

async function ask({ url, read }, fetchImpl) {
  const sent = Date.now();
  const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  const got = Date.now();
  const remote = await read(response);
  if (!Number.isFinite(remote)) throw new Error(`no time from ${url}`);
  // Giờ bên kia ứng với giữa lúc gửi và lúc nhận.
  return remote + (got - sent) / 2 - got;
}

/** Hỏi giờ internet ngay (nguồn đầu tiên trả lời được). Trả về độ lệch: giờ thật − giờ máy tính (ms). */
export async function syncClock(fetchImpl = fetch) {
  for (const s of SOURCES) {
    try {
      offsetMs = Math.round(await ask(s, fetchImpl));
      synced = true;
      source = s.url;
      checkedAt = Date.now();
      return offsetMs;
    } catch { /* thử nguồn sau */ }
  }
  checkedAt = Date.now() - RECHECK_MS + RETRY_MS;
  return offsetMs;
}

/**
 * Gọi đầu mỗi yêu cầu chấm công. Đã có độ lệch thì hỏi lại ở nền (không bắt nhân viên chờ);
 * chưa có lần nào thì chờ hỏi xong (tối đa vài giây).
 */
export async function refreshClock() {
  if (Date.now() - checkedAt < RECHECK_MS) return;
  inflight ||= syncClock().finally(() => { inflight = null; });
  if (!synced) await inflight;
}

/** Giờ thật (ms) theo internet. */
export const nowMs = () => Date.now() + offsetMs;

/** Đồng hồ máy tính lệch bao nhiêu so với internet, để báo chủ quán chỉnh giờ máy. */
export const clockStatus = () => ({ offsetMs, synced, checkedAt: Number.isFinite(checkedAt) ? new Date(checkedAt + offsetMs).toISOString() : null, source });
