'use client';

import { useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';

// 08-api-key-layer.md 已定案：明文 key 只在新增/重新產生那一次的回應裡
// 出現，關掉這個 Dialog 之後畫面上就再也看不到，跟 GitHub PAT/Stripe key
// 的慣例一致——所以特別用醒目的警示文案跟一個「複製」按鈕，減少使用者
// 沒複製到就關掉的機率。
export function PlaintextKeyDialog({
  open,
  onOpenChange,
  plaintextKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plaintextKey: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(plaintextKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API 在非 HTTPS/非安全上下文可能不可用，退回讓使用者自
      // 己選取文字複製，不用額外跳錯誤訊息打斷流程。
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="API Key 已產生"
      width={480}
      footer={
        <Button onClick={() => onOpenChange(false)}>我已複製，關閉</Button>
      }
    >
      <p className="rounded border border-warning/30 bg-warning-bg px-2.5 py-1.5 text-[12px] text-warning">
        這是這把 key 唯一一次顯示明文的機會，關閉後就只會顯示前綴，請先複製保存。
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded border border-shell bg-surface px-2.5 py-1.5 text-[13px] break-all">
          {plaintextKey}
        </code>
        <Button variant="ghost" onClick={handleCopy}>
          {copied ? '已複製' : '複製'}
        </Button>
      </div>
    </Dialog>
  );
}
