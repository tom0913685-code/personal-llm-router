import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { AppShell } from '../components/AppShell';
import './globals.css';

// next/font 在 build time 自行打包字體檔案，不用像 <link> 那樣讓瀏覽器多一次
// 對 fonts.googleapis.com 的請求；只載 latin 子集（Inter 本身沒有中文字符，
// 中文顯示靠 globals.css 的 --font-sans 字型堆疊接微軟正黑體/PingFang TC）。
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: '個人版 LLM Router',
  description: '個人版 LLM Router 管理後台',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant" className={inter.variable}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
