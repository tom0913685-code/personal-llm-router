import type { NextConfig } from 'next';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8787';

const nextConfig: NextConfig = {
  // repo 根目錄的 package-lock.json（後端）會讓 Next.js 誤判 workspace root，
  // 明確指定成 frontend/ 本身避免那個警告、也避免它掃到不相關的檔案。
  turbopack: {
    root: __dirname,
  },
  // Next.js dev 模式的浮動指示燈預設也在左下角，跟 Sidebar 的登出按鈕
  // （使用者要求放左下角）疊在一起——只影響 `next dev`，跟 production
  // build 無關，移到右下角讓兩者不要互相遮住。
  devIndicators: {
    position: 'bottom-right',
  },
  // 開發/production 都用同一份 rewrites：Next.js 沒有像 Vite dev server
  // 那種內建的 proxy 設定分開讀法，統一用這個轉發到 Express Gateway，前端
  // 程式碼裡繼續打相對路徑 /admin/...，不用管後端實際跑在哪個 port。
  async rewrites() {
    return [
      {
        source: '/admin/:path*',
        destination: `${BACKEND_URL}/admin/:path*`,
      },
    ];
  },
};

export default nextConfig;
