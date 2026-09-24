'use client';

import { useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import type { AdapterType, Credential } from '../../types';

export interface CredentialFormValues {
  name: string;
  adapterType: AdapterType;
  baseUrl?: string;
  apiKey: string; // 空字串在編輯模式代表「不更新」，新增模式代表必填
  enabled: boolean;
}

export function CredentialForm({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: Credential;
  onSubmit: (values: CredentialFormValues) => Promise<void>;
}) {
  const isEdit = Boolean(initial);
  const [values, setValues] = useState<CredentialFormValues>({
    name: initial?.name ?? '',
    adapterType: initial?.adapterType ?? 'passthrough',
    baseUrl: initial?.baseUrl ?? '',
    apiKey: '',
    enabled: initial?.enabled ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsBaseUrl = values.adapterType === 'passthrough';

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      await onSubmit(values);
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
      title={isEdit ? '編輯 Credential' : '新增 Credential'}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              saving ||
              !values.name ||
              (!isEdit && !values.apiKey) ||
              // adapterType=passthrough 卻沒填 baseUrl 時前端就先擋（後端
              // credentials.routes.ts 的 PATCH 現在也會擋，這裡是提早給
              // 使用者回饋，避免送出後才看到錯誤）。
              (needsBaseUrl && !values.baseUrl?.trim())
            }
          >
            {saving ? '儲存中...' : '儲存'}
          </Button>
        </>
      }
    >
      <Field label="名稱">
        <Input value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} placeholder="例如：OpenAI 個人 key" />
      </Field>

      <Field label="Adapter 類型">
        <Select
          value={values.adapterType}
          onChange={(e) => setValues({ ...values, adapterType: e.target.value as AdapterType })}
        >
          <option value="passthrough">passthrough（OpenAI-compatible）</option>
          <option value="anthropic_native">anthropic_native</option>
        </Select>
      </Field>

      {needsBaseUrl && (
        <Field label="Base URL">
          <Input
            value={values.baseUrl}
            onChange={(e) => setValues({ ...values, baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </Field>
      )}

      <Field label={isEdit ? 'API Key（留空表示不更新）' : 'API Key'}>
        <Input
          type="password"
          value={values.apiKey}
          onChange={(e) => setValues({ ...values, apiKey: e.target.value })}
          placeholder={isEdit ? '輸入後不會再顯示明文' : 'sk-...'}
        />
      </Field>

      <label className="flex items-center gap-2 text-[13px] text-text">
        <input
          type="checkbox"
          checked={values.enabled}
          onChange={(e) => setValues({ ...values, enabled: e.target.checked })}
        />
        啟用
      </label>

      {error && (
        <p className="rounded border border-danger/30 bg-danger-bg px-2.5 py-1.5 text-[12px] text-danger">{error}</p>
      )}
    </Dialog>
  );
}
