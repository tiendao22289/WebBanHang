'use client';

import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { AlertCircle, X, CheckCircle2, Printer, BellOff } from 'lucide-react';

// ── Audio: alarm gắt cho lỗi máy in (square wave, khác chuông đơn mới) ──
let _printerAudioCtx = null;
function getPrinterAudioCtx() {
  if (typeof window === 'undefined') return null;
  if (_printerAudioCtx && _printerAudioCtx.state !== 'closed') return _printerAudioCtx;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  _printerAudioCtx = new AudioCtx();
  return _printerAudioCtx;
}

// Alarm burst: triple-beep square wave xen kẽ 880/660Hz, kéo dài ~10 giây
function playPrinterAlarm() {
  try {
    const audioCtx = getPrinterAudioCtx();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const master = audioCtx.createGain();
    master.gain.value = 0.55;
    master.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    const BURST_DURATION = 10;
    const BEEP_DUR = 0.2;
    const BEEP_GAP = 0.08;
    const GROUP_GAP = 0.4;
    const HIGH = 880;
    const LOW = 660;

    let t = now;
    let groupIdx = 0;
    while (t < now + BURST_DURATION) {
      for (let i = 0; i < 3 && t < now + BURST_DURATION; i++) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.value = groupIdx % 2 === 0 ? HIGH : LOW;
        osc.connect(gain);
        gain.connect(master);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.55, t + 0.005);
        gain.gain.setValueAtTime(0.55, t + BEEP_DUR - 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + BEEP_DUR);
        osc.start(t);
        osc.stop(t + BEEP_DUR);
        t += BEEP_DUR + BEEP_GAP;
      }
      t += GROUP_GAP;
      groupIdx++;
    }
  } catch (e) {
    console.log('Printer alarm not supported');
  }
}

// "Ting!" vui khi máy in OK lại — glide 880Hz → 1320Hz
function playPrinterRecovered() {
  try {
    const audioCtx = getPrinterAudioCtx();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const master = audioCtx.createGain();
    master.gain.value = 0.7;
    master.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.2);
    osc.connect(gain);
    gain.connect(master);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.6, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc.start(now);
    osc.stop(now + 0.6);
  } catch (e) {
    console.log('Recovered chime not supported');
  }
}

// Job còn 'pending' quá lâu nghĩa là PrintAgent không nhận/không xử lý được
// (crash, mất mạng, rớt Realtime...) — job dạng này KHÔNG BAO GIỜ tự chuyển
// sang 'failed' nên phải chủ động dò, nếu không nhân viên sẽ không biết gì.
const STALE_PENDING_SECONDS = 60;
const STALE_POLL_INTERVAL_MS = 15000;

// Lỗi "kẹt hàng đợi Windows" TỰ PHỤC HỒI (spooler thông là phiếu in ra) — KHÔNG
// phải máy in hỏng, không nên hụ còi báo động. (Offline / lỗi khác vẫn báo.)
function isQueueJamError(raw) {
  const r = (raw || '').toLowerCase();
  return r.includes('ket trong hang doi') || r.includes('kẹt trong hàng đợi') || r.includes('kẹt') || r.includes('hang doi') || r.includes('hàng đợi');
}
const ACTIVE_ORDER_STATUSES = ['pending', 'preparing'];

/** Lấy tên bàn + món (để hiện trong card lỗi) và tên máy in của 1 print_job. */
async function fetchJobDisplayInfo(job) {
  let orderInfo = '';
  const targetIds = job.order_ids?.length ? job.order_ids : [job.order_id].filter(Boolean);

  if (targetIds.length > 0) {
    const { data: oData } = await supabase.from('orders')
      .select('table:tables(table_number), order_items(quantity, menu_item:menu_items(name))')
      .in('id', targetIds);

    if (oData && oData.length > 0) {
      const tableNumbers = [...new Set(oData.map(o => o.table?.table_number).filter(Boolean))].join(', ');
      const items = [];
      oData.forEach(o => {
        (o.order_items || []).forEach(oi => {
          if (oi.menu_item) items.push(`${oi.quantity}x ${oi.menu_item.name}`);
        });
      });
      const displayItems = items.slice(0, 3).join(', ') + (items.length > 3 ? ', ...' : '');
      orderInfo = `Bàn ${tableNumbers}: ${displayItems}`;
    }
  }

  let printerName = 'Máy in Bếp';
  if (job.printer_id) {
    const { data: pData } = await supabase.from('printers').select('name').eq('id', job.printer_id).maybeSingle();
    if (pData) printerName = pData.name;
  }

  return { orderInfo, printerName };
}

export default function PrintErrorAlert({ isAdmin = false, customerOrderId = null, customerOrderIds = [], onRecovered = null }) {
  const [errors, setErrors] = useState([]);
  const [mutedErrorIds, setMutedErrorIds] = useState(() => new Set());
  // Job bị khách/nhân viên bấm X bỏ qua — không cho lần poll sau "hồi sinh" lại
  // (job vẫn pending thật trong DB, nhưng người dùng đã chủ động ẩn rồi).
  const dismissedIdsRef = useRef(new Set());

  useEffect(() => {
    // Customer mode: chỉ cần có tableId là đủ, hoặc isAdmin
    // Lắng nghe ngay cả khi customerOrderId null (dùng customerOrderIds từ previousOrders)
    if (!isAdmin && !customerOrderId && customerOrderIds.length === 0) return;

    const extractErrorMessage = (raw) => {
      if (!raw) return 'Lỗi máy in không xác định';
      const r = raw.toLowerCase();
      if (r.includes('ket trong hang doi') || r.includes('kẹt trong hàng đợi')) {
        return 'Máy in bị kẹt giấy hoặc đang tắt nguồn. Vui lòng kiểm tra lại cuộn giấy và nguồn điện.';
      }
      if (r.includes('offline') || r.includes('ngoại tuyến')) {
        return 'Máy in đang ngoại tuyến (Offline). Vui lòng kiểm tra cáp mạng hoặc kết nối.';
      }
      if (r.includes('command failed') || r.includes('powershell')) {
         return 'Lỗi kết nối bộ phận in. Vui lòng kiểm tra dịch vụ PrintAgent tại trạm.';
      }
      // Trim error base on standard exceptions if possible
      const match = raw.match(/(Lệnh in|Lenh in)[^()\[\]]{10,}/i);
      if (match) return match[0].split('+')[0].trim();
      return raw;
    };

    const channel = supabase
      .channel('print_errors_listener_' + Date.now())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'print_jobs' }, async (payload) => {
        const { new: job } = payload;
        
        // ── KHÔNG CAN THIỆP CÁC TRẠNG THÁI BÌNH THƯỜNG KHÁC ──
        if (job.status !== 'failed' && job.status !== 'done') return;

        // Nếu là Customer, chỉ quan tâm đến hoá đơn của họ
        if (!isAdmin) {
             const targetIds = job.order_ids || [job.order_id];
             // Kiểm tra theo customerOrderId (đơn hiện tại) HOẶC customerOrderIds (tất cả đơn của bàn)
             const allKnownIds = [customerOrderId, ...customerOrderIds].filter(Boolean);
             const belongs = allKnownIds.length === 0 || targetIds.some(id => allKnownIds.includes(id));
             if (!belongs) return;
        }

        // Fetch Order Info for BOTH failed and recovered workflows
        const { orderInfo, printerName } = await fetchJobDisplayInfo(job);

        // ── XỬ LÝ FAILED ──
        if (job.status === 'failed') {
          // Kẹt hàng đợi tự phục hồi → không hụ còi báo động (phiếu vẫn in ra).
          if (isQueueJamError(job.error_message)) return;
          const cleanMsg = extractErrorMessage(job.error_message);
          setErrors(prev => {
             const exists = prev.find(e => e.id === job.id);
             if (exists) return prev.map(e => e.id === job.id ? { ...e, isDone: false, msg: cleanMsg, orderInfo, printerName } : e);
             return [{ id: job.id, isDone: false, msg: cleanMsg, orderInfo, printerName, time: new Date() }, ...prev];
          });
        }
        
        // ── XỬ LÝ DONE AUTO-RECOVERY ──
        if (job.status === 'done') {
           setErrors(prev => {
               const exists = prev.find(e => e.id === job.id);
               // CHỈ hiện Toast Success nếu nó là Phục hồi (Recovery) từ lỗi
               const isRecovery = exists || (job.error_message && job.error_message.includes('Đã tự động in'));
               if (!isRecovery) return prev; // Tránh hiện Toast phiền phức cho các lệnh in bình thường

               // Phát chuông "ting!" khi máy in OK lại (chỉ admin)
               if (isAdmin) playPrinterRecovered();

               const msg = 'Máy bật lên đã in được bill thành công.';
               if (exists) {
                   return prev.map(e => e.id === job.id ? { ...e, isDone: true, msg } : e);
               } else {
                   return [{ id: job.id, isDone: true, msg, orderInfo, printerName, time: new Date() }, ...prev];
               }
           });
           
           // Callback để parent re-fetch orders ngay
           if (onRecovered) onRecovered();
           
           // Tự tắt sau 5s khi đã khắc phục
           setTimeout(() => {
              setErrors(prev => prev.filter(e => e.id !== job.id));
           }, 5000);
        }
      })
      .subscribe();
      
    return () => { supabase.removeChannel(channel); }
  }, [isAdmin, customerOrderId, customerOrderIds.length]); // Re-run khi có thêm orders

  // ── Dò job 'pending' bị treo — Realtime UPDATE ở trên chỉ bắt được job đã
  // CHUYỂN sang failed/done; nếu PrintAgent tắt/rớt mạng, job nằm im ở pending
  // mãi mãi và không có UPDATE nào bắn ra cả, nên phải chủ động poll. ──
  const staleSeenRef = useRef(new Set());
  useEffect(() => {
    const allKnownIds = [customerOrderId, ...customerOrderIds].filter(Boolean);
    if (!isAdmin && allKnownIds.length === 0) return;

    const checkStalePending = async () => {
      const cutoff = new Date(Date.now() - STALE_PENDING_SECONDS * 1000).toISOString();
      let query = supabase
        .from('print_jobs')
        .select('id, order_id, order_ids, printer_id, status, created_at')
        .eq('status', 'pending')
        .lt('created_at', cutoff)
        .limit(20);

      if (!isAdmin) {
        query = query.or(`order_id.in.(${allKnownIds.join(',')}),order_ids.ov.{${allKnownIds.join(',')}}`);
      }

      const { data: staleJobs, error } = await query;
      if (error || !staleJobs?.length) return;

      // Chỉ báo cho ĐƠN CÒN MỞ (pending/preparing). Lệnh in 'pending' mồ côi trên
      // bill đã THANH TOÁN / HUỶ không phải "máy in lỗi" → bỏ qua, nếu không thẻ
      // báo đỏ "Máy in đang gặp lỗi" cứ hiện hoài mỗi lần F5 dù máy in vẫn tốt.
      const orderIds = [...new Set(staleJobs.flatMap(j => (j.order_ids?.length ? j.order_ids : [j.order_id])).filter(Boolean))];
      const activeOrderIds = new Set();
      if (orderIds.length) {
        const { data: ords } = await supabase.from('orders').select('id, status').in('id', orderIds);
        (ords || []).forEach(o => { if (ACTIVE_ORDER_STATUSES.includes(o.status)) activeOrderIds.add(o.id); });
      }
      const activeStale = staleJobs.filter(j => {
        const ids = j.order_ids?.length ? j.order_ids : [j.order_id].filter(Boolean);
        return ids.some(id => activeOrderIds.has(id));
      });
      if (!activeStale.length) return;

      for (const job of activeStale) {
        if (dismissedIdsRef.current.has(job.id) || staleSeenRef.current.has(job.id)) continue;
        staleSeenRef.current.add(job.id);

        const { orderInfo, printerName } = await fetchJobDisplayInfo(job);
        setErrors(prev => {
          if (prev.some(e => e.id === job.id)) return prev;
          return [{
            id: job.id,
            isDone: false,
            msg: `Máy in không phản hồi sau ${STALE_PENDING_SECONDS}s — có thể PrintAgent tại quán đang tắt hoặc mất mạng.`,
            orderInfo,
            printerName,
            time: new Date(),
          }, ...prev];
        });
      }
    };

    checkStalePending();
    const interval = setInterval(checkStalePending, STALE_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isAdmin, customerOrderId, customerOrderIds.length]);

  // ── Alarm interval: kêu cycle 20s (10s ring + 10s im) khi có lỗi chưa được giải quyết ──
  const hasActiveError = errors.some(e => !e.isDone && !mutedErrorIds.has(e.id));
  useEffect(() => {
    if (!isAdmin || !hasActiveError) return;
    playPrinterAlarm();                                       // kêu ngay lần đầu
    const interval = setInterval(playPrinterAlarm, 20000);    // cứ 20s lặp 1 burst (10s ring + 10s im)
    return () => clearInterval(interval);
  }, [isAdmin, hasActiveError]);

  if (errors.length === 0) return null;

  return (
    <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 99999, display: 'flex', flexDirection: 'column', gap: 12 }}>
       {errors.map(err => {
         const isDone = err.isDone;
         return (
           <div key={err.id} style={{ 
               background: isDone ? '#f0fdf4' : '#fef2f2', 
               border: `1.5px solid ${isDone ? '#86efac' : '#fecaca'}`,
               borderRadius: 16, padding: '14px 18px', width: 360, maxWidth: 'calc(100vw - 40px)',
               boxShadow: isDone ? '0 10px 20px rgba(22, 163, 74, 0.1)' : '0 10px 25px rgba(220, 38, 38, 0.15)', 
               display: 'flex', gap: 14, alignItems: 'flex-start',
               transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
               animation: 'slideInRight 0.4s ease-out forwards'
           }}>
              <div style={{ background: isDone ? '#dcfce7' : '#fee2e2', padding: 8, borderRadius: 12, flexShrink: 0 }}>
                 {isDone ? <CheckCircle2 size={24} color="#16a34a" strokeWidth={2.5}/> : <AlertCircle size={24} color="#dc2626" strokeWidth={2.5}/>}
              </div>
              <div style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
                 <div style={{ fontWeight: 800, fontSize: '0.92rem', color: isDone ? '#16a34a' : '#dc2626', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                   {isDone ? 'Máy in đã hồi phục' : 'Máy in đang gặp lỗi'}
                   {!isDone && <div style={{width: 6, height: 6, background: '#ef4444', borderRadius: '50%', animation: 'pulse 1s infinite'}}></div>}
                 </div>
                 
                 <div style={{ fontSize: '0.8rem', color: '#4b5563', lineHeight: 1.4, marginBottom: 6 }}>
                   {isDone ? err.msg : (isAdmin ? err.msg : 'Hệ thống báo bếp bị gián đoạn. Xin lỗi bạn vì sự chậm trễ này, quản lý sẽ xử lý ngay.')}
                 </div>
                 
                 {err.orderInfo && (
                    <div style={{ 
                       fontSize: '0.75rem', fontWeight: 600, color: isDone ? '#166534' : '#991b1b', 
                       background: isDone ? '#dcfce7' : '#fee2e2', 
                       padding: '6px 10px', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 4, width: 'fit-content' 
                    }}>
                      {isAdmin && <span style={{ display:'flex', alignItems:'center', gap:4, fontWeight: 700 }}><Printer size={12} /> {err.printerName || 'Máy in'}</span>}
                      <span>{err.orderInfo}</span>
                    </div>
                 )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
                <button
                   onClick={() => {
                     dismissedIdsRef.current.add(err.id);
                     setErrors(prev => prev.filter(e => e.id !== err.id));
                   }}
                   style={{ background:'none', border:'none', cursor:'pointer', padding: 4, color: isDone ? '#16a34a' : '#ef4444', transition: 'all 0.2s', marginTop: 2 }}>
                   <X size={18} />
                </button>
                {isAdmin && !isDone && (() => {
                  const isMuted = mutedErrorIds.has(err.id);
                  return (
                    <button
                       onClick={() => setMutedErrorIds(prev => {
                         const next = new Set(prev);
                         if (next.has(err.id)) next.delete(err.id); else next.add(err.id);
                         return next;
                       })}
                       title={isMuted ? 'Bật chuông lại' : 'Tắt chuông cho lỗi này'}
                       style={{
                         background: isMuted ? '#f3f4f6' : '#fee2e2',
                         border: 'none', cursor: 'pointer', padding: 5,
                         color: isMuted ? '#9ca3af' : '#dc2626',
                         borderRadius: 6, transition: 'all 0.2s',
                         display: 'flex', alignItems: 'center', justifyContent: 'center'
                       }}>
                       <BellOff size={15} />
                    </button>
                  );
                })()}
              </div>
           </div>
         );
       })}
       <style dangerouslySetInnerHTML={{__html:`
         @keyframes slideInRight {
           0% { opacity: 0; transform: translateX(50px); }
           100% { opacity: 1; transform: translateX(0); }
         }
         @keyframes pulse {
           0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
           70% { transform: scale(1); box-shadow: 0 0 0 4px rgba(239, 68, 68, 0); }
           100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
         }
       `}} />
    </div>
  )
}
