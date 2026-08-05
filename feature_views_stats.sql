-- ═══════════════════════════════════════════════════════════════
--  Thống kê lượt xem các bảng ưu đãi ("Thử thách có quà", "Đặt tiệc có quà")
--  Chạy toàn bộ file này trong Supabase → SQL Editor.
-- ═══════════════════════════════════════════════════════════════

-- 1. Bảng đếm: mỗi feature 1 dòng, cột views = tổng lượt mở
create table if not exists public.feature_views (
  feature    text primary key,
  views      bigint      not null default 0,
  updated_at timestamptz not null default now()
);

-- 2. Seed sẵn 2 feature (nếu đã có thì bỏ qua)
insert into public.feature_views (feature, views) values
  ('challenge', 0),
  ('party', 0)
on conflict (feature) do nothing;

-- 3. Hàm tăng lượt xem (atomic) — trả về số mới nhất
create or replace function public.increment_feature_view(p_feature text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_views bigint;
begin
  insert into public.feature_views (feature, views, updated_at)
  values (p_feature, 1, now())
  on conflict (feature)
  do update set views = feature_views.views + 1, updated_at = now()
  returning views into new_views;
  return new_views;
end;
$$;

-- 4. RLS: cho phép đọc số liệu (hiển thị cho khách), ghi chỉ qua RPC ở trên
alter table public.feature_views enable row level security;

drop policy if exists "feature_views read" on public.feature_views;
create policy "feature_views read" on public.feature_views
  for select using (true);

grant select on public.feature_views to anon, authenticated;
grant execute on function public.increment_feature_view(text) to anon, authenticated;
