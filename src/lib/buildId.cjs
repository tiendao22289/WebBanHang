// Mã bản: mỗi lần build (và mỗi lần chạy dev) một mã mới, nhúng vào trang và /api/version để tab
// mở lâu biết máy chủ đã lên bản mới (src/lib/buildRefresh.mjs). Có mã commit (GitHub Actions) thì ghi
// kèm để dễ biết bản nào đang chạy.
function makeBuildId(env = process.env, now = Date.now()) {
  const sha = /^[0-9a-f]{7,40}$/i.test(String(env.GITHUB_SHA || '')) ? env.GITHUB_SHA.slice(0, 12).toLowerCase() : 'local';
  return `${sha}-${Number(now).toString(36)}`;
}
module.exports = { makeBuildId };
