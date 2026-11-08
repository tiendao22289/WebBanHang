-- Ngày phát lương cố định cho người trả theo kỳ (vd CÔ 7 lãnh mỗi thứ 7): payday_anchor là một ngày phát bất kỳ; các ngày phát
-- là payday_anchor ± k × every_days. Kỳ vẫn bắt đầu ngày sau lần trả gần nhất, nhưng ngày phát luôn rơi đúng lịch (trả sớm /
-- trễ một lần không làm lệch thứ). Để trống = như cũ (ngày phát = ngày đầu kỳ + N − 1). Chạy lại được nhiều lần.
ALTER TABLE public.payroll_pay_cycles ADD COLUMN IF NOT EXISTS payday_anchor date;
