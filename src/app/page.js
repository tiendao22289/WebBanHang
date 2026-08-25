'use client';

// Trang chủ chuyển hướng PHÍA CLIENT (không dùng redirect() server nữa):
// bot xác thực domain của Zalo cần GET / trả về 200 kèm thẻ meta
// zalo-platform-site-verification trong <head> — redirect 307 làm bot
// không nhìn thấy thẻ. Người dùng thật vẫn được chuyển đi ngay lập tức.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  useEffect(() => { router.replace('/admin/tables'); }, [router]);
  return (
    <p style={{ padding: 24, textAlign: 'center', color: '#64748b', fontFamily: 'system-ui' }}>
      Đang chuyển đến trang quản lý...
    </p>
  );
}
