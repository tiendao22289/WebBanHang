'use client';
/**
 * Khung "Nợ cũ còn lại" trong form Tạo báo cáo / ghi chú mới: liệt kê mọi khoản
 * đang nợ của các phiếu cũ, tích khoản nào thì trả khoản đó (sửa được số tiền để
 * trả một phần), và tuỳ chọn lấy tiền dư của chuyến chợ để trả nợ.
 *
 * Có thêm khung "Tiền thừa phiếu trước chưa trả chủ": tích để lấy tiền đó trả nợ,
 * tích "Cộng tiền dư cũ vào phiếu này" để chuyển hẳn sang phiếu mới (hiện tách dư cũ / dư mới),
 * hoặc bấm "Đã trả chủ" khi người đi chợ đã đưa lại tiền thừa.
 *
 * Danh sách nợ và danh sách tiền thừa thu gọn, bấm để mở (tự mở khi đã chọn khoản trả).
 * value: { [debtKey]: số tiền } — khoản đang chọn trả.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { allOpenDebts, allocateToDebts, debtKey } from '@/lib/notesDebts.mjs';

const money = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
const dayMonth = iso => { const d = new Date(new Date(iso).getTime() + 7 * 3600000).toISOString(); return `${d.slice(8, 10)}/${d.slice(5, 7)}`; };
const digits = v => String(v ?? '').replace(/\D/g, '');

export default function DebtPicker({ notes, value, onChange, surplus, useSurplus, onUseSurplus,
  leftovers = [], useLeftover, onUseLeftover, onReturnLeftover, canCarry, carry, onCarry, surplusOld = 0, step = 3 }) {
  const [openLines, setOpenLines] = useState(false);
  const [openLeft, setOpenLeft] = useState(false);
  const lines = useMemo(() => allOpenDebts(notes || []), [notes]);
  const total = lines.reduce((a, l) => a + l.left, 0);
  const chosen = Object.values(value || {}).reduce((a, v) => a + (Number(v) || 0), 0);
  const leftoverTotal = leftovers.reduce((a, l) => a + l.left, 0);

  // "Lấy tiền dư / tiền thừa trả nợ": chia vào khoản đã tích trước, rồi phiếu cũ nhất.
  useEffect(() => {
    if (!useSurplus && !useLeftover) return;
    const pool = (useLeftover ? leftoverTotal : 0) + (useSurplus ? Math.max(0, surplus || 0) : 0);
    const next = allocateToDebts(pool, lines, Object.keys(value || {}));
    if (JSON.stringify(next) !== JSON.stringify(value || {})) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useSurplus, useLeftover, surplus, leftoverTotal, lines]);

  if (!lines.length && !leftovers.length) return null;
  const toggle = line => {
    const key = debtKey(line);
    const next = { ...(value || {}) };
    if (next[key]) delete next[key]; else next[key] = line.left;
    onUseSurplus(false);
    onUseLeftover?.(false);
    onChange(next);
  };
  const setAmount = (line, raw) => {
    const n = Math.min(line.left, Number(digits(raw)) || 0);
    onUseSurplus(false);
    onUseLeftover?.(false);
    onChange({ ...(value || {}), [debtKey(line)]: n });
  };

  // Danh sách dài nên thu gọn; tự mở khi đã chọn khoản trả.
  const showLines = openLines || chosen > 0;
  const showLeft = openLeft || !!carry || !!useLeftover;
  return (
    <section className="np-section">
      <div className="np-section-head"><span className="np-step">{step}</span><b>Tiền thừa & nợ cũ</b>
        {chosen > 0 && <span className="np-aside violet">Trả {money(chosen)}</span>}</div>
      {leftovers.length > 0 && (
        <div className="np-box ok">
          <button type="button" className="np-box-head" onClick={() => setOpenLeft(o => !o)} aria-expanded={showLeft}>
            <span>💵 Tiền thừa phiếu trước</span><b>{money(leftoverTotal)}</b><ChevronDown size={16} className={showLeft ? 'up' : ''} />
          </button>
          {showLeft && leftovers.map(l => (
            <div key={l.note_id} className="np-box-line">
              <span>Phiếu {dayMonth(l.created_at)}{l.writer ? ` · ${l.writer}` : ''} · còn <b>{money(l.left)}</b></span>
              <button type="button" className="np-mini ok" onClick={() => onReturnLeftover?.(l)}>Đã trả chủ</button>
            </div>
          ))}
          {showLeft && canCarry && (
            <label className="np-check ok">
              <input type="checkbox" checked={!!carry} onChange={e => { onCarry?.(e.target.checked); if (e.target.checked) onUseLeftover?.(false); }} />
              Cộng tiền dư cũ vào phiếu này
            </label>
          )}
          {showLeft && lines.length > 0 && !carry && (
            <label className="np-check ok">
              <input type="checkbox" checked={!!useLeftover} onChange={e => onUseLeftover?.(e.target.checked)} />
              Dùng tiền thừa này để trả nợ
            </label>
          )}
        </div>
      )}
      {lines.length > 0 && (
        <div className="np-box debt">
          <button type="button" className="np-box-head" onClick={() => setOpenLines(o => !o)} aria-expanded={showLines}>
            <span>📋 Nợ cũ · {lines.length} khoản <small>{showLines ? '' : '(bấm để trả)'}</small></span><b>{money(total)}</b><ChevronDown size={16} className={showLines ? 'up' : ''} />
          </button>
          {(showLines || useSurplus) && surplus > 0 && (
            <label className="np-check violet">
              <input type="checkbox" checked={!!useSurplus} onChange={e => onUseSurplus(e.target.checked)} />
              <span>Lấy tiền dư {money(surplus)} trả nợ{surplusOld > 0 && <small> (mới {money(surplus - surplusOld)} + cũ {money(surplusOld)})</small>}</span>
            </label>
          )}
          {showLines && <div className="np-debt-list">
            {lines.map(line => {
              const key = debtKey(line);
              const picked = value?.[key] !== undefined;
              return (
                <div key={key} className={`np-debt-line${picked ? ' on' : ''}`}>
                  <input type="checkbox" checked={picked} onChange={() => toggle(line)} aria-label={`Trả ${line.name}`} />
                  <div>
                    <b>{line.creditor || 'Không ghi tên'} — {line.name}</b>
                    <small>Phiếu {dayMonth(line.created_at)}{line.writer ? ` · ${line.writer}` : ''} · còn <em>{money(line.left)}</em></small>
                  </div>
                  {picked && (
                    <input type="text" inputMode="numeric" className="np-input" value={Number(value[key] || 0).toLocaleString('vi-VN')} onChange={e => setAmount(line, e.target.value)} aria-label="Số tiền trả" />
                  )}
                </div>
              );
            })}
          </div>}
        </div>
      )}
    </section>
  );
}
