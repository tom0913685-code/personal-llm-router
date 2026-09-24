'use client';

import { useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Input';
import { Button } from '../ui/Button';
import type { ApiKey } from '../../types';
import type { ApiKeyInput } from '../../lib/api';

// 日期 input 給的是 yyyy-mm-dd，後端存的是 ISO 字串——固定補一個 UTC
// 午夜的時間部分，避免帶入使用者時區造成的偏移（這裡只在乎「哪一天」，
// 不需要精確到時分秒）。
function toIsoDateOrNull(draft: string): string | null {
  return draft.trim() === '' ? null : `${draft}T00:00:00.000Z`;
}

function toDateInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

export function ApiKeyForm({
  open,
  onOpenChange,
  initial,
  availableModels,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ApiKey;
  availableModels: string[];
  onSubmit: (values: ApiKeyInput) => Promise<void>;
}) {
  const isEdit = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [budgetLimitDraft, setBudgetLimitDraft] = useState(initial?.budgetLimit != null ? String(initial.budgetLimit) : '');
  const [budgetResetDayDraft, setBudgetResetDayDraft] = useState(
    initial?.budgetResetDay != null ? String(initial.budgetResetDay) : ''
  );
  const [expiresAtDraft, setExpiresAtDraft] = useState(toDateInputValue(initial?.expiresAt ?? null));
  const [restrictModels, setRestrictModels] = useState(initial?.allowedModels != null);
  const [selectedModels, setSelectedModels] = useState<string[]>(initial?.allowedModels ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function isValidOptionalNonNegativeNumber(draft: string): boolean {
    if (draft.trim() === '') return true;
    const n = Number(draft);
    return Number.isFinite(n) && n >= 0;
  }

  function isValidOptionalResetDay(draft: string): boolean {
    if (draft.trim() === '') return true;
    const n = Number(draft);
    return Number.isInteger(n) && n >= 1 && n <= 31;
  }

  const valid =
    name.trim() !== '' && isValidOptionalNonNegativeNumber(budgetLimitDraft) && isValidOptionalResetDay(budgetResetDayDraft);

  function toggleModel(model: string) {
    setSelectedModels((prev) => (prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model]));
  }

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        enabled,
        budgetLimit: budgetLimitDraft.trim() === '' ? null : Number(budgetLimitDraft),
        budgetResetDay: budgetResetDayDraft.trim() === '' ? null : Number(budgetResetDayDraft),
        expiresAt: toIsoDateOrNull(expiresAtDraft),
        allowedModels: restrictModels ? selectedModels : null,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '儲存失敗');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? '編輯 API Key' : '新增 API Key'}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={saving || !valid}>
            {saving ? '儲存中...' : '儲存'}
          </Button>
        </>
      }
    >
      <Field label="名稱">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：本機開發用" />
      </Field>

      <label className="flex items-center gap-2 text-[13px] text-text">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        啟用
      </label>

      <div className="grid grid-cols-2 gap-3">
        <Field label="每月額度上限（$，留空＝不限制）">
          <Input
            type="number"
            step="0.01"
            value={budgetLimitDraft}
            onChange={(e) => setBudgetLimitDraft(e.target.value)}
            placeholder="不限制"
          />
        </Field>
        <Field label="每月重置日（1-31，留空＝不自動重置）">
          <Input
            type="number"
            step="1"
            value={budgetResetDayDraft}
            onChange={(e) => setBudgetResetDayDraft(e.target.value)}
            placeholder="不自動重置"
          />
        </Field>
      </div>

      <Field label="到期日（留空＝永不過期）">
        <Input type="date" value={expiresAtDraft} onChange={(e) => setExpiresAtDraft(e.target.value)} />
      </Field>

      <label className="flex items-center gap-2 text-[13px] text-text">
        <input
          type="checkbox"
          checked={restrictModels}
          onChange={(e) => {
            setRestrictModels(e.target.checked);
            if (!e.target.checked) setSelectedModels([]);
          }}
        />
        限制可用模型（未勾選＝不限制，可用任何 model）
      </label>

      {restrictModels && (
        <div className="rounded border border-shell p-2.5 space-y-1.5 max-h-[160px] overflow-y-auto">
          {availableModels.length === 0 && <p className="text-[12px] text-text-muted">目前沒有已設定的 model。</p>}
          {availableModels.map((model) => (
            <label key={model} className="flex items-center gap-2 text-[13px] text-text">
              <input type="checkbox" checked={selectedModels.includes(model)} onChange={() => toggleModel(model)} />
              {model}
            </label>
          ))}
        </div>
      )}

      {error && (
        <p className="rounded border border-danger/30 bg-danger-bg px-2.5 py-1.5 text-[12px] text-danger">{error}</p>
      )}
    </Dialog>
  );
}
