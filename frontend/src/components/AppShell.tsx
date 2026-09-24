'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Sidebar, NAV_ITEMS } from './Sidebar';

// 原本 Vite SPA 版本的 App.tsx 用 useState 記錄「目前是哪個分頁」，換成
// Next.js 後每個分頁是獨立路由，這裡改成依 usePathname() 查對應的
// NAV_ITEMS 項目，取它的 label/subLabel 當頁首標題，行為跟原本一致。
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = NAV_ITEMS.find((item) => item.href === pathname) ?? NAV_ITEMS[0];

  // /login 自己有一個獨立、置中的全螢幕表單版面（見 app/login/page.tsx），
  // 不套用側邊欄/頁首這套「已登入後台」的 chrome——登入頁本來就不該讓人
  // 看到 Dashboard/Models/Logs 這些導覽項目。
  if (pathname === '/login') {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />

      <div className="flex-1 min-w-0">
        <header className="flex items-center border-b border-shell bg-white px-6 py-4">
          <h1 className="text-[16px] font-semibold text-text">
            {current.label} <span className="text-text-muted font-normal">{current.subLabel}</span>
          </h1>
        </header>

        {/* max-w-5xl（1024px）太窄，寬螢幕下右側空白太明顯——使用者
            2026-09-19 要求加寬，改成 max-w-7xl（1280px），仍是固定寬度
            上限，不是跟著視窗無限擴張。 */}
        <main className="max-w-7xl px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
