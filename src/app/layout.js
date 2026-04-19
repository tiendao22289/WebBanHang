import './globals.css';

export const metadata = {
  title: 'Nhà Hàng - Gọi Món',
  description: 'Quét QR để gọi món ngay tại bàn',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Nhà Hàng',
  },
  other: {
    'mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-status-bar-style': 'black-translucent',
    'format-detection': 'telephone=no',
  },
};

export const viewport = {
  themeColor: '#ffffff',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  minimumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="vi">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/icon-512.png" />
        <link rel="shortcut icon" href="/icon-192.png" type="image/png" />

        {/* ── PWA Standalone (iOS + Android + Zalo WebView) ── */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Nhà Hàng" />

        {/* ── Viewport fullscreen, no zoom, safe-area ── */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover"
        />

        {/* ── Theme colors: trắng để Zalo/Chrome ẩn thanh URL ── */}
        <meta name="theme-color" content="#ffffff" />

        {/* ── Tắt auto-detection số điện thoại (Zalo hay highlight) ── */}
        <meta name="format-detection" content="telephone=no, address=no, email=no" />

        {/* ── Friendly với mọi mobile browser ── */}
        <meta name="HandheldFriendly" content="true" />
        <meta name="MobileOptimized" content="width" />

        {/* ── Zalo share preview card ── */}
        <meta property="og:title" content="Gọi Món - Nhà Hàng" />
        <meta property="og:description" content="Quét QR để gọi món ngay tại bàn" />
        <meta property="og:type" content="website" />
        <meta property="og:image" content="/icon-512.png" />

        {/* ── Preconnect cải thiện tốc độ load ── */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="dns-prefetch" href="https://supabase.co" />

        {/* ── Suppress Zalo injected script errors in Development ── */}
        <script dangerouslySetInnerHTML={{
          __html: `
            window.addEventListener('error', function(e) {
              if (e.message && e.message.includes('zaloJSV2')) {
                e.stopImmediatePropagation();
                e.preventDefault();
              }
            }, true);
          `
        }} />
      </head>
      <body
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
          overscrollBehavior: 'none',
          WebkitOverflowScrolling: 'touch',
          touchAction: 'manipulation',
        }}
      >
        {children}
      </body>
    </html>
  );
}
