'use client';

import { useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import type { Credential, Deployment } from '../../types';

export interface DeploymentFormValues {
  credentialId: string;
  publicModelName: string;
  providerModelId: string;
  priority: number;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  enabled: boolean;
  autoHealthCheckEnabled: boolean;
}

export function DeploymentForm({
  open,
  onOpenChange,
  initial,
  credentials,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: Deployment;
  credentials: Credential[];
  onSubmit: (values: DeploymentFormValues) => Promise<void>;
}) {
  const isEdit = Boolean(initial);
  const [values, setValues] = useState<DeploymentFormValues>({
    credentialId: initial?.credentialId ?? credentials[0]?.id ?? '',
    publicModelName: initial?.publicModelName ?? '',
    providerModelId: initial?.providerModelId ?? '',
    priority: initial?.priority ?? 0,
    inputCostPerMillion: initial?.inputCostPerMillion ?? 0,
    outputCostPerMillion: initial?.outputCostPerMillion ?? 0,
    enabled: initial?.enabled ?? true,
    autoHealthCheckEnabled: initial?.autoHealthCheckEnabled ?? false,
  });
  // 數字欄位額外用字串草稿追蹤輸入框「目前顯示的文字」，跟要送出的數字分開
  // ——原本直接把 Number(e.target.value) 綁進 values，使用者清空欄位想重新
  // 輸入時會立刻 snap 回顯示 0、打斷輸入手感；更重要的是如果沒注意到直接
  // 按儲存，會靜默把 priority/定價存成 0（定價存 0 等於免費，後端沒有任何
  // 防呆會擋這個組合）。改成草稿是空字串/非數字時直接擋住送出按鈕，而不是
  // 悄悄轉成 0。
  const [priorityDraft, setPriorityDraft] = useState(String(initial?.priority ?? 0));
  const [inputCostDraft, setInputCostDraft] = useState(String(initial?.inputCostPerMillion ?? 0));
  const [outputCostDraft, setOutputCostDraft] = useState(String(initial?.outputCostPerMillion ?? 0));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function isValidNonNegativeNumber(draft: string): boolean {
    if (draft.trim() === '') return false;
    const n = Number(draft);
    return Number.isFinite(n) && n >= 0;
  }

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        ...values,
        priority: Number(priorityDraft),
        inputCostPerMillion: Number(inputCostDraft),
        outputCostPerMillion: Number(outputCostDraft),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '儲存失敗');
    } finally {
      setSaving(false);
    }
  }

  const valid =
    values.credentialId &&
    values.publicModelName &&
    values.providerModelId &&
    isValidNonNegativeNumber(priorityDraft) &&
    Number.isInteger(Number(priorityDraft)) &&
    isValidNonNegativeNumber(inputCostDraft) &&
    isValidNonNegativeNumber(outputCostDraft);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? '編輯 Deployment' : '新增 Deployment'}
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
      <Field label="所屬 Credential">
        <Select value={values.credentialId} onChange={(e) => setValues({ ...values, credentialId: e.target.value })}>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Public Model Name（client 呼叫時用的名稱）">
        <Input
          value={values.publicModelName}
          onChange={(e) => setValues({ ...values, publicModelName: e.target.value })}
          placeholder="gpt-4o"
        />
      </Field>

      <Field label="Provider Model ID（實際打給上游的名稱）">
        <Input
          value={values.providerModelId}
          onChange={(e) => setValues({ ...values, providerModelId: e.target.value })}
          placeholder="gpt-4o"
        />
      </Field>

      <Field label="Priority（Fallback 順序，數字小的先試；同一個 Public Model Name 底下不能重複）">
        <Input type="number" step="1" value={priorityDraft} onChange={(e) => setPriorityDraft(e.target.value)} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Input 定價（$/百萬 token）">
          <Input type="number" step="0.01" value={inputCostDraft} onChange={(e) => setInputCostDraft(e.target.value)} />
        </Field>
        <Field label="Output 定價（$/百萬 token）">
          <Input type="number" step="0.01" value={outputCostDraft} onChange={(e) => setOutputCostDraft(e.target.value)} />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-[13px] text-text">
        <input
          type="checkbox"
          checked={values.enabled}
          onChange={(e) => setValues({ ...values, enabled: e.target.checked })}
        />
        啟用
      </label>

      <label className="flex items-start gap-2 text-[13px] text-text">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={values.autoHealthCheckEnabled}
          onChange={(e) => setValues({ ...values, autoHealthCheckEnabled: e.target.checked })}
        />
        <span>
          排進排程健康檢查（每 <code className="text-[12px] text-text-muted">HEALTH_CHECK_INTERVAL_MINUTES</code>{' '}
          分鐘自動檢查一次；雲端模型會產生 API 呼叫成本，建議只給本機/免費模型開）
        </span>
      </label>

      {error && (
        <p className="rounded border border-danger/30 bg-danger-bg px-2.5 py-1.5 text-[12px] text-danger">{error}</p>
      )}
    </Dialog>
  );
}
