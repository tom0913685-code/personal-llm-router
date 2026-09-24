import type { ButtonHTMLAttributes } from 'react';

// 表格列內／錯誤訊息旁的次要操作按鈕（編輯、重新產生、重置額度、手動
// 檢查、重試……）。使用者要求改成圖案（icon-only），不放文字——固定
// 正方形尺寸置中放 icon，靠 title/aria-label 補文字說明（原生 title 在
// hover 時會顯示提示，不用另外做 Tooltip 元件）。呼叫端一律要傳
// title，不能省略，不然滑鼠移過去、螢幕閱讀器都不知道這顆按鈕是做什麼
// 的。
export function RowActionButton({
  className = '',
  title,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return (
    <button
      title={title}
      aria-label={title}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-card-border text-text-muted transition-colors hover:border-text-muted hover:bg-surface hover:text-text disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      {...props}
    />
  );
}
