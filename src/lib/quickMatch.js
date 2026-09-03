// ─────────────────────────────────────────────────────────────────────────
// Bộ nhận diện "Gọi món nhanh / Chọn nhanh" — DÙNG CHUNG cho web khách và web
// admin. Sửa từ khoá / cách viết tắt của khách ở ĐÂY là cả hai web cùng hiểu.
//
// Ý tưởng:
//  - Nhận diện MÓN qua "từ đặc trưng" của tên (ghẹ, lông, hương, mai…) chứ
//    không cần đủ tên → khách ghi tắt "ghẹ rang muối", "long hành" vẫn ra.
//  - Từ chung nhiều món (sò, ốc) và động từ chế biến (nướng, xào, rang…) KHÔNG
//    tự khớp món → tránh đoán bừa.
//  - Chữ càng hiếm càng nặng điểm → "hương tỏi" ra Ốc Hương (không phải Ốc Tỏi).
//  - Bộ đồng nghĩa cho LOẠI: luộc↔hấp, xã/xả↔sả.
//  - Bộ chuẩn hoá từ khoá: ngao→nghêu, chíp→chem chép, sate→sa tế, phomai→phô mai…
// ─────────────────────────────────────────────────────────────────────────
import { removeVietnameseTones } from '@/lib/utils';

// Động từ chế biến + từ chung / đơn vị — không bao giờ là "tên con hải sản".
export const COOKING_WORDS = new Set([
  'nuong', 'xao', 'hap', 'rang', 'luoc', 'chien', 'sot', 'ham', 'kho', 'chao', 'sup', 'lau',
  'mon', 'con', 'cai', 'dia', 'phan', 'ly', 'chai', 'ban', 'nay', 'cho', 'giup', 'them',
]);

// Từ đồng nghĩa khi chọn LOẠI (đã bỏ dấu): luộc↔hấp, xã/xả↔sả.
export const LOAI_SYNONYMS = { luoc: ['hap'], hap: ['luoc'], xa: ['sa'], sa: ['xa'] };

// Chuẩn hoá từ khoá khách gõ → về đúng chữ trong thực đơn. [chữ khách gõ, chữ chuẩn].
// THÊM DÒNG MỚI VÀO ĐÂY khi gặp cách gọi lạ của khách — cả 2 web cùng có hiệu lực.
export const KEYWORD_ALIASES = [
  // ── Tên món khách hay gọi khác / viết sai ──
  ['ngao', 'ngheu'],            // ngao = nghêu (miền Bắc)
  ['chip chip', 'chem chep'],   // chíp chíp = chem chép
  ['chip chep', 'chem chep'],
  ['chem chip', 'chem chep'],
  ['chip', 'chem chep'],
  ['sting', 'siting'],          // sting = Siting (nước tăng lực)
  ['bu lot', 'bulot'],          // bu lốt = bulot
  ['bulo', 'bulot'],
  // ── Cách chế biến viết liền / viết lẫn ──
  ['phomai', 'pho mai'],        // phômai viết liền
  ['pmai', 'pho mai'],
  ['sate', 'sa te'],            // sa tế / satế viết liền
  ['xa te', 'sa te'],           // menu ghi lẫn "xa tế" ↔ "sa tế"
  ['botoi', 'bo toi'],
  ['laque', 'la que'],
  ['7up', '7 up'],
];

// Biên dịch mẫu tìm 1 LẦN (module-level). \b = ranh giới từ ASCII, an toàn mọi
// trình duyệt kể cả iOS cũ (không dùng lookbehind).
const CANON_REGEXES = KEYWORD_ALIASES.map(([from, to]) => [new RegExp('\\b' + from.replace(/ /g, '\\s+') + '\\b', 'g'), to]);

export function canonQuery(q) {
  let s = ' ' + (q || '') + ' ';
  for (const [re, to] of CANON_REGEXES) s = s.replace(re, to);
  return s.trim().replace(/\s+/g, ' ');
}

// Điểm khớp 1 từ khách gõ với 1 lựa chọn LOẠI: khớp thẳng (nguyên từ) = 2, qua
// từ đồng nghĩa = 1 (để "Luộc" vẫn thắng khi món có sẵn "Luộc").
export function loaiWordScore(choiceNorm, w) {
  const cwords = choiceNorm.split(/[^a-z0-9]+/).filter(Boolean);
  if (cwords.includes(w)) return 2;
  const syns = LOAI_SYNONYMS[w];
  if (syns && syns.some(s => cwords.includes(s))) return 1;
  return 0;
}

// Tách số lượng khỏi dòng: "sò mai nướng phô mai 2 con" → {qty:2, text:"sò mai nướng phô mai"}
export function splitQtyFromLine(line) {
  let raw = (line || '').trim();
  let qty = 1;
  const mTrail = raw.match(/[\s]+(\d{1,2})\s*(con|ph[aầ]n|d[iĩ]a|d)?\.?$/i);
  const mLead = raw.match(/^(\d{1,2})\s+/);
  if (mTrail) { qty = parseInt(mTrail[1]) || 1; raw = raw.slice(0, mTrail.index).trim(); }
  else if (mLead) { qty = parseInt(mLead[1]) || 1; raw = raw.slice(mLead[0].length).trim(); }
  return { qty: Math.min(Math.max(qty, 1), 50), text: raw };
}

// Tạo bộ nhận diện gắn với 1 danh sách món (dựng chỉ mục 1 lần).
export function createQuickMatcher(menuItems) {
  const items = Array.isArray(menuItems) ? menuItems : [];
  const df = new Map(); // từ trong TÊN món → xuất hiện ở bao nhiêu món
  for (const item of items) {
    if (item.is_available === false) continue;
    const nameWords = new Set(removeVietnameseTones((item.name || '').toLowerCase()).split(/[^a-z0-9]+/).filter(w => w.length >= 2));
    nameWords.forEach(w => df.set(w, (df.get(w) || 0) + 1));
  }

  // Từ có "đặc trưng" cho tên món không: hiếm (≤3 món dùng), ≥3 ký tự, không
  // phải động từ chế biến. "ghẹ"/"lông"/"hương" đặc trưng; "sò"/"ốc"/"nướng" không.
  function isDistinctiveNameWord(w) {
    if (!w || w.length < 3) return false;
    if (COOKING_WORDS.has(w)) return false;
    const c = df.get(w) || 0;
    return c >= 1 && c <= 3;
  }

  // Gõ chữ → gợi ý MÓN (bỏ dấu, khớp gần đúng). Trả [{item, choice?, kind}].
  function getQuickSuggestions(query) {
    const q = canonQuery(removeVietnameseTones((query || '').trim().toLowerCase()));
    if (q.length < 2) return [];
    const out = [];
    for (const item of items) {
      if (item.is_available === false) continue;
      const normName = removeVietnameseTones((item.name || '').toLowerCase());
      if (!normName) continue;
      const qWords = q.split(/\s+/).filter(Boolean);
      const nameWords = normName.split(/[^a-z0-9]+/).filter(w => w.length >= 2);
      const nameInQuery = q.includes(normName);
      const queryInName = normName.includes(q);
      const firstWordMatch = q.split(' ')[0] === normName.split(' ')[0];
      const distinctiveMatch = nameWords.some(w => qWords.includes(w) && isDistinctiveNameWord(w));
      if (!nameInQuery && !queryInName && !firstWordMatch && !distinctiveMatch) continue;

      const loaiOpt = (item.options || []).find(o => o.name && o.name.toLowerCase().includes('loại'));
      if (loaiOpt && Array.isArray(loaiOpt.choices) && loaiOpt.choices.length > 0) {
        const remainder = nameInQuery ? q.replace(normName, ' ').trim() : (queryInName ? '' : qWords.filter(w => !nameWords.includes(w)).join(' '));
        const words = remainder.split(/\s+/).filter(w => w.length >= 2);
        const scored = words.length > 0
          ? loaiOpt.choices.map(c => {
              const nc = removeVietnameseTones((c || '').toLowerCase());
              const score = words.reduce((n, w) => n + loaiWordScore(nc, w), 0);
              return { c, score };
            }).filter(x => x.score > 0).sort((a, b) => b.score - a.score)
          : [];
        const maxScore = scored.length ? scored[0].score : 0;
        const matched = scored.filter(x => x.score === maxScore).map(x => x.c);
        if (matched.length > 0) matched.slice(0, 5).forEach(c => out.push({ item, choice: c, kind: 'specific' }));
        else out.push({ item, kind: 'pick' });
      } else {
        out.push({ item, kind: 'plain' });
      }
      if (out.length >= 8) break;
    }
    return out.slice(0, 8);
  }

  // Tìm MÓN khớp nhất cho 1 dòng chữ (đã bỏ số lượng). Trả {item, choice?, kind} | null.
  function matchOneLine(text) {
    const q = canonQuery(removeVietnameseTones((text || '').trim().toLowerCase()));
    if (q.length < 2) return null;
    const qWords = q.split(/\s+/).filter(Boolean);
    const qSet = new Set(qWords);
    let bestItem = null, bestScore = 0, bestRemainder = '', bestNameLen = 0;
    for (const item of items) {
      if (item.is_available === false) continue;
      const normName = removeVietnameseTones((item.name || '').toLowerCase());
      if (!normName) continue;
      const nameWords = normName.split(/[^a-z0-9]+/).filter(w => w.length >= 2);
      if (nameWords.length === 0) continue;
      let score = 0;
      if (q.includes(normName)) {
        score = 1000 + normName.length;
      } else if (nameWords.every(w => qSet.has(w))) {
        score = 500 + nameWords.join('').length;
      } else {
        let hasDistinct = false;
        for (const w of nameWords) {
          if (!qSet.has(w)) continue;
          if (isDistinctiveNameWord(w)) {
            hasDistinct = true;
            const dfw = df.get(w) || 3;
            score += 12 - Math.min(dfw, 3) * 2; // df1→10, df2→8, df3→6
          } else score += 1;
        }
        if (!hasDistinct) score = 0;
      }
      if (score > bestScore || (score > 0 && score === bestScore && normName.length > bestNameLen)) {
        bestScore = score; bestItem = item; bestNameLen = normName.length;
        bestRemainder = qWords.filter(w => !nameWords.includes(w)).join(' ');
      }
    }
    if (!bestItem) return null;
    const loaiOpt = (bestItem.options || []).find(o => o.name && o.name.toLowerCase().includes('loại'));
    if (loaiOpt && Array.isArray(loaiOpt.choices) && loaiOpt.choices.length) {
      const words = bestRemainder.split(/\s+/).filter(w => w.length >= 2);
      const scored = words.length ? loaiOpt.choices.map(c => {
        const nc = removeVietnameseTones((c || '').toLowerCase());
        return { c, s: words.reduce((n, w) => n + loaiWordScore(nc, w), 0) };
      }).filter(x => x.s > 0).sort((a, b) => b.s - a.s) : [];
      if (scored.length) return { item: bestItem, choice: scored[0].c, kind: 'specific' };
      return { item: bestItem, kind: 'pick' };
    }
    return { item: bestItem, kind: 'plain' };
  }

  return { df, isDistinctiveNameWord, getQuickSuggestions, matchOneLine, canonQuery, loaiWordScore, splitQtyFromLine };
}
