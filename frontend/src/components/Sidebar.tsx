'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, Cpu, ScrollText, KeyRound, Boxes, BookOpen, LogOut, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  subLabel: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', subLabel: '儀表板', icon: LayoutDashboard },
  { href: '/models', label: 'Models', subLabel: '模型列表', icon: Cpu },
  { href: '/logs', label: 'Logs', subLabel: '請求 Log', icon: ScrollText },
  // 08-api-key-layer.md 已定案：獨立 nav item，跟 Models/Logs 平行，不是
  // Settings 底下的分頁——這批 key 管的是 Gateway 存取權限，跟「設定哪些
  // model/credential」是不同性質的操作。
  { href: '/api-keys', label: 'API Keys', subLabel: 'API 金鑰', icon: KeyRound },
  // 2026-09-23 新增：純說明性質的頁面（服務簡介/用法/MCP 功能），放最後
  // 一項、登出按鈕之前——不是日常操作會用到的地方，跟前面幾個管理頁面
  // 性質不同。
  { href: '/about', label: 'About', subLabel: '使用說明', icon: BookOpen },
];

// 比照另一套正式版 Gateway 後台的側邊欄樣式：固定寬度、置左、
// icon + 雙行文字（英文主標籤 + 中文子標籤），選中項目用語意化的
// primary-light 底色 + primary 文字色高亮。
// Next.js 版本：active 狀態直接從網址（usePathname）判斷，不用像 SPA
// 時代那樣自己管理 active 字串 state。
export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <aside className="w-[220px] shrink-0 border-r border-shell bg-white min-h-screen py-5 px-3 flex flex-col">
      <div className="flex items-center gap-2 px-2 mb-6">
        <Boxes size={20} className="text-primary" />
        <span className="text-[14px] font-semibold text-text">個人版 LLM Router</span>
      </div>

      <nav className="space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                isActive ? 'bg-primary-light text-primary' : 'text-text-muted hover:bg-surface'
              }`}
            >
              <Icon size={18} />
              <span>
                <span className="block text-[13px] font-medium leading-tight">{item.label}</span>
                <span className={`block text-[11px] leading-tight ${isActive ? 'text-primary/70' : 'text-text-small'}`}>
                  {item.subLabel}
                </span>
              </span>
            </Link>
          );
        })}
      </nav>

      {/* mt-auto 把登出鈕推到 aside 底部——原本放在 AppShell 頁首右上角，
          使用者要求移到側邊欄左下角，跟導覽項目視覺上分開但同樣置左。 */}
      <button
        onClick={handleLogout}
        className="mt-auto flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-text-muted hover:bg-surface hover:text-text transition-colors"
      >
        <LogOut size={18} />
        <span className="text-[13px] font-medium">登出</span>
      </button>
    </aside>
  );
}
