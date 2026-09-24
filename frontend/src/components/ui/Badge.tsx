import type { ReactNode } from 'react';

// 語意化色票，對齊 tailwind.config.ts 的 success/danger/warning token，
// 不寫死 hex，比照另一套正式版 Router 的 BadgeStatus 做法。
const VARIANTS = {
  success: 'bg-success-bg text-success border-success/30',
  danger: 'bg-danger-bg text-danger border-danger/30',
  warning: 'bg-warning-bg text-warning border-warning/30',
  neutral: 'bg-surface text-text-muted border-shell',
} as const;

export function Badge({ variant = 'neutral', children }: { variant?: keyof typeof VARIANTS; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[12px] font-medium ${VARIANTS[variant]}`}>
      {children}
    </span>
  );
}
