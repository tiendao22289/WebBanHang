'use client';
// Điện thoại nhân viên: quét mã xong mà máy quầy cần so mặt → hỏi máy chủ vài giây một lần tới khi máy
// quầy so xong (đúng / sai / chờ chủ duyệt / hết giờ). Quá 90 giây thì coi như hết giờ.
export async function waitFaceCheck(id, { isStopped = () => false, everyMs = 1500, maxMs = 90000 } = {}) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    if (isStopped()) return { status: 'cancelled' };
    const r = await fetch(`/api/admin/workforce?face_check=${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(x => (x.ok ? x.json() : null)).catch(() => null);
    if (r?.status && r.status !== 'waiting') return r;
    await new Promise(done => setTimeout(done, everyMs));
  }
  return { status: 'expired', reason: 'timeout' };
}
