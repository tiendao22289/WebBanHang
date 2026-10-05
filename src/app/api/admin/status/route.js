import { NextResponse } from 'next/server';
import { requireStatusAdmin } from '@/lib/statusAuth';
import { getLocalStatus, getLocalLogs } from '@/lib/localStatus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET(request) {
  try {
    const code = await requireStatusAdmin(request);
    if (code !== 200) return NextResponse.json({ error: code === 503 ? 'Không kiểm tra được quyền admin.' : 'Vui lòng đăng nhập tài khoản admin.' }, { status: code, headers });
    if (process.platform !== 'win32') return NextResponse.json({ error: 'Trang này chỉ hỗ trợ máy chủ local Windows.' }, { status: 503, headers });
    const source = new URL(request.url).searchParams.get('log');
    if (source !== null) {
      const log = await getLocalLogs(source);
      if (log === null) return NextResponse.json({ error: 'Nguồn log không hợp lệ.' }, { status: 400, headers });
      return NextResponse.json({ log, checkedAt: new Date().toISOString() }, { headers });
    }
    return NextResponse.json(await getLocalStatus(), { headers });
  } catch { return NextResponse.json({ error: 'Không đọc được trạng thái. Kiểm tra log local.' }, { status: 503, headers }); }
}
