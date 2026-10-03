-- ============================================================
-- Khoá chống in trùng cho lệnh in quà vòng xoay (sendGiftItemPrintJob).
--
-- Trước đây code gán print_jobs.id = order_item.id (UUID) để chống trùng,
-- nhưng print_jobs.id là bigint → insert luôn lỗi 22P02, quà không bao giờ
-- in và vòng reconcile (lucky-status / claim-ready) thử lại liên tục, làm
-- nghẽn database. Nay dùng cột riêng dedupe_key = 'gift:<order_item_id>'.
--
-- NULL không đụng nhau trong UNIQUE index → mọi lệnh in thường (không set
-- dedupe_key) và lệnh "In lại" của admin không bị ảnh hưởng.
-- ============================================================

ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_dedupe_key_uidx ON print_jobs (dedupe_key);
