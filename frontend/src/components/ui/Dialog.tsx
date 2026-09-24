import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

// 固定寬度、置中的 Dialog（非全畫面 Sheet），比照另一套正式版 Router 的做法：
// CRUD 這種小型操作用固定寬度卡片，Sheet 只留給「查看大量詳情」的場景
// （個人版目前沒有這種場景，所以只做 Dialog，不做 Sheet）。
export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 max-h-[86vh] flex flex-col rounded-lg border border-card-border bg-white shadow-lg"
          style={{ width }}
        >
          <div className="flex items-center justify-between border-b border-shell px-5 py-3">
            <RadixDialog.Title className="text-[14px] font-semibold text-text">{title}</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <button className="text-text-muted hover:text-text" aria-label="關閉">
                <X size={16} />
              </button>
            </RadixDialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-5 space-y-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-shell px-5 py-3">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
