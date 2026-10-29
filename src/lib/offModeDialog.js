/**
 * Hộp "Tắt bao lâu?" dùng chung cho trang Bàn (khung Tắt / bật món) và trang Thực đơn (nút ẩn món,
 * ẩn lựa chọn). 4 ô lớn ghi sẵn giờ bán lại, bấm một ô là xong; ô dùng lần trước được tô sẵn.
 * Trả về 'today' | '2h' | '4h' | 'off', hoặc null nếu bấm Huỷ / bấm ra ngoài.
 */
import Swal from 'sweetalert2';
import { offModeChoices } from './menuAvailability.mjs';

const LAST_KEY = 'offModeLast';
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const STYLE = `<style>
.omd { text-align: left; }
.omd-tag { display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: .06em; color: #b91c1c; background: #fee2e2; border-radius: 999px; padding: 3px 10px; }
.omd-name { margin-top: 8px; font-size: 18px; font-weight: 800; color: #0f172a; line-height: 1.3; }
.omd-choice { margin-top: 2px; font-size: 15px; font-weight: 700; color: #dc2626; }
.omd-q { margin: 14px 0 10px; padding-top: 12px; border-top: 1px solid #f1f5f9; font-size: 13px; font-weight: 600; color: #64748b; }
.omd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.omd-opt { display: flex; flex-direction: column; gap: 3px; text-align: left; padding: 12px 12px 11px; border: 1.5px solid #e5e7eb; border-radius: 12px; background: #fff; cursor: pointer; font-family: inherit; transition: border-color .15s, background .15s; }
.omd-opt b { font-size: 15px; font-weight: 800; color: #0f172a; }
.omd-opt span { font-size: 12px; font-weight: 500; color: #64748b; }
.omd-opt:hover, .omd-opt:focus-visible { border-color: #fca5a5; background: #fff7f7; outline: none; }
.omd-opt:active { transform: scale(.98); }
.omd-opt.last { border-color: #ef4444; background: #fef2f2; }
.omd-opt.last b { color: #b91c1c; }
.omd-actions { margin: 14px 0 0 !important; width: 100%; padding: 0 !important; }
.omd-cancel { width: 100%; padding: 11px; border: none; border-radius: 12px; background: #f1f5f9; color: #475569; font-size: 14px; font-weight: 700; cursor: pointer; }
.omd-cancel:hover { background: #e2e8f0; }
</style>`;

export async function askOffMode({ kind = 'dish', name, choice } = {}) {
  let last = 'today';
  try { const v = localStorage.getItem(LAST_KEY); if (['today', '2h', '4h', 'off'].includes(v)) last = v; } catch { }
  const options = offModeChoices().map(o =>
    `<button type="button" class="omd-opt${o.mode === last ? ' last' : ''}" data-mode="${o.mode}"><b>${o.label}</b><span>${o.hint}</span></button>`).join('');
  let picked = null;
  await Swal.fire({
    html: `${STYLE}<div class="omd">
      <span class="omd-tag">${kind === 'choice' ? 'TẮT LOẠI' : 'TẮT MÓN'}</span>
      <div class="omd-name">${esc(name)}</div>
      ${choice ? `<div class="omd-choice">${esc(choice)}</div>` : ''}
      <div class="omd-q">Tắt trong bao lâu?</div>
      <div class="omd-grid">${options}</div>
    </div>`,
    width: 360, padding: '20px 18px 18px',
    showConfirmButton: false, showCancelButton: true, cancelButtonText: 'Huỷ', buttonsStyling: false,
    customClass: { actions: 'omd-actions', cancelButton: 'omd-cancel' },
    didOpen: popup => popup.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
      picked = b.dataset.mode;
      Swal.close();
    })),
  });
  if (picked) try { localStorage.setItem(LAST_KEY, picked); } catch { }
  return picked;
}
