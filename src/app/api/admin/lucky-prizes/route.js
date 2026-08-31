/**
 * /api/admin/lucky-prizes — CRUD cơ cấu quà vòng xoay, CHỈ chạy ở server.
 *
 * VÌ SAO CẦN ROUTE NÀY: trước đây admin/settings ghi thẳng vào bảng
 * lucky_prizes bằng anon key (RLS cho anon ghi tự do "tạm cho admin sửa
 * được"), nhưng anon key là khoá PUBLIC nằm ngay trong JS gửi cho khách —
 * ai cũng lấy được và tự ý đổi tỉ lệ/giá trị quà qua thẳng REST API của
 * Supabase, không cần vào được /admin/settings. Route này dùng
 * SERVICE_ROLE_KEY, còn RLS trên lucky_prizes chỉ còn cho anon ĐỌC.
 */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function fail(message, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request) {
  const supabase = getServiceClient();
  if (!supabase) return fail('Thiếu cấu hình server', 500);

  const { data: prizes } = await supabase.from('lucky_prizes').select('sort_order');
  const nextOrder = (prizes || []).reduce((m, p) => Math.max(m, Number(p.sort_order) || 0), 0) + 1;

  const { data, error } = await supabase.from('lucky_prizes').insert({
    label: 'Phần quà mới',
    short: 'Quà',
    type: 'percent',
    value: 1,
    weight: 10,
    color: '#94a3b8',
    is_active: false,
    sort_order: nextOrder,
  }).select().maybeSingle();

  if (error) return fail(error.message);
  return NextResponse.json({ prize: data });
}

export async function PATCH(request) {
  const supabase = getServiceClient();
  if (!supabase) return fail('Thiếu cấu hình server', 500);

  const body = await request.json().catch(() => ({}));
  const { id, label, short, type, value, weight, color, is_active, sort_order } = body;
  if (!id) return fail('Thiếu id phần quà');

  const trimmedLabel = String(label || '').trim();
  if (!trimmedLabel) return fail('Phần quà cần có tên');
  const numWeight = Number(weight);
  if (!(numWeight >= 0)) return fail('Tỉ lệ phải là số không âm');
  if (type === 'percent') {
    const numValue = Number(value);
    if (!(numValue > 0 && numValue <= 100)) return fail('% giảm phải trong khoảng 1 – 100');
  }

  const { error } = await supabase.from('lucky_prizes').update({
    label: trimmedLabel,
    short: String(short || trimmedLabel).slice(0, 14),
    type,
    value: Number(value) || 0,
    weight: numWeight,
    color: color || '#94a3b8',
    is_active: !!is_active,
    sort_order: Number(sort_order) || 0,
  }).eq('id', id);

  if (error) return fail(error.message);
  return NextResponse.json({ success: true });
}

export async function DELETE(request) {
  const supabase = getServiceClient();
  if (!supabase) return fail('Thiếu cấu hình server', 500);

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return fail('Thiếu id phần quà');

  const { error } = await supabase.from('lucky_prizes').delete().eq('id', id);
  if (error) return fail(error.message);
  return NextResponse.json({ success: true });
}
