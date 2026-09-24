import type { InputHTMLAttributes, ReactNode } from 'react';

// w-full 只相對於外層容器（表單欄位 div），而外層容器已被 Dialog 的固定寬度
// 限制住，所以視覺上不會撐滿整個視窗——比照另一套正式版 Router 的 Input 元件做法，
// 不需要額外對 input 設 max-width。
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-8 w-full rounded border border-shell px-2.5 text-[13px] outline-none focus:border-primary ${props.className ?? ''}`}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-medium text-text-muted">{label}</span>
      {children}
    </label>
  );
}
