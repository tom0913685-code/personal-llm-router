'use client';

import { useEffect, useState } from 'react';
import { Pencil, RefreshCw, RotateCcw } from 'lucide-react';
import {
  listApiKeys,
  listDeployments,
  createApiKey,
  updateApiKey,
  regenerateApiKey,
  resetApiKeyBudget,
  type ApiKeyInput,
} from '../../lib/api';
import type { ApiKey, CreatedApiKey } from '../../types';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { RowActionButton } from '../ui/RowActionButton';
import { ApiKeyForm } from './ApiKeyForm';
import { PlaintextKeyDialog } from './PlaintextKeyDialog';

function formatMoney(n: number): string {
  return `$${n.toFixed(4)}`;
}

function isExpired(key: ApiKey): boolean {
  return key.expiresAt != null && new Date(key.expiresAt).getTime() < Date.now();
}

export function ApiKeysTab() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKey | undefined>();
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    setLoadError(null);
    Promise.all([listApiKeys(), listDeployments()])
      .then(([keys, deployments]) => {
        setApiKeys(keys);
        // allowedModels 選單要選 model 而不是 deployment，一個 model 底下
        // 可能有多筆 Fallback 候選 deployment，這裡去重。
        setAvailableModels([...new Set(deployments.map((d) => d.publicModelName))]);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : '載入失敗'))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  async function handleSubmit(values: ApiKeyInput) {
    if (editing) {
      await updateApiKey(editing.id, values);
      reload();
    } else {
      const created = await createApiKey(values);
      reload();
      setPlaintextKey(created.plaintextKey);
    }
  }

  async function handleRegenerate(key: ApiKey) {
    if (!window.confirm(`確定要重新產生「${key.name}」的 key 嗎？舊的明文會立刻失效，正在使用它的地方會全部打不通。`)) return;
    setBusyId(key.id);
    try {
      const regenerated: CreatedApiKey = await regenerateApiKey(key.id);
      reload();
      setPlaintextKey(regenerated.plaintextKey);
    } catch (err) {
      alert(err instanceof Error ? err.message : '重新產生失敗');
    } finally {
      setBusyId(null);
    }
  }

  async function handleResetBudget(key: ApiKey) {
    if (!window.confirm(`確定要把「${key.name}」目前的花費歸零嗎？`)) return;
    setBusyId(key.id);
    try {
      await resetApiKeyBudget(key.id);
      reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : '重置額度失敗');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            setEditing(undefined);
            setFormOpen(true);
          }}
        >
          + 新增 API Key
        </Button>
      </div>

      <div className="rounded border border-card-border bg-white overflow-hidden overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-shell text-left text-text-muted whitespace-nowrap">
              <th className="px-3 py-2 font-medium">名稱</th>
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium">狀態</th>
              <th className="px-3 py-2 font-medium">可用模型</th>
              <th className="px-3 py-2 font-medium">額度</th>
              <th className="px-3 py-2 font-medium">到期</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-text-muted">
                  載入中...
                </td>
              </tr>
            )}
            {!loading && loadError && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-danger">
                  載入失敗：{loadError}
                  <RowActionButton className="ml-2" title="重試" onClick={reload}>
                    <RefreshCw size={14} />
                  </RowActionButton>
                </td>
              </tr>
            )}
            {!loading && !loadError && apiKeys.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-text-muted">
                  還沒有任何 API Key。
                </td>
              </tr>
            )}
            {!loading &&
              !loadError &&
              apiKeys.map((key) => (
                <tr key={key.id} className="border-b border-shell last:border-0 whitespace-nowrap hover:bg-surface">
                  <td className="px-3 py-2.5 font-medium">{key.name}</td>
                  <td className="px-3 py-2.5 text-text-muted">
                    <code className="text-[12px]">{key.keyPrefix}...</code>
                  </td>
                  <td className="px-3 py-2.5 space-x-1">
                    <Badge variant={key.enabled ? 'success' : 'danger'}>{key.enabled ? '啟用' : '停用'}</Badge>
                    {isExpired(key) && <Badge variant="warning">已過期</Badge>}
                  </td>
                  <td className="px-3 py-2.5 text-text-muted">
                    {key.allowedModels === null ? '不限制' : key.allowedModels.length === 0 ? '（無任何 model）' : key.allowedModels.join(', ')}
                  </td>
                  <td className="px-3 py-2.5 text-text-muted tabular-nums">
                    {formatMoney(key.currentSpend)} / {key.budgetLimit === null ? '不限制' : formatMoney(key.budgetLimit)}
                    {key.budgetResetDay !== null && (
                      <span className="text-[11px] text-text-small">（每月 {key.budgetResetDay} 日重置）</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-text-muted">{key.expiresAt ? key.expiresAt.slice(0, 10) : '永不過期'}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <div className="inline-flex gap-1.5">
                      <RowActionButton title="重置額度" onClick={() => handleResetBudget(key)} disabled={busyId === key.id}>
                        <RotateCcw size={14} />
                      </RowActionButton>
                      <RowActionButton title="重新產生" onClick={() => handleRegenerate(key)} disabled={busyId === key.id}>
                        <RefreshCw size={14} />
                      </RowActionButton>
                      <RowActionButton
                        title="編輯"
                        onClick={() => {
                          setEditing(key);
                          setFormOpen(true);
                        }}
                      >
                        <Pencil size={14} />
                      </RowActionButton>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {formOpen && (
        <ApiKeyForm
          open={formOpen}
          onOpenChange={setFormOpen}
          initial={editing}
          availableModels={availableModels}
          onSubmit={handleSubmit}
        />
      )}

      {plaintextKey && <PlaintextKeyDialog open={plaintextKey !== null} onOpenChange={() => setPlaintextKey(null)} plaintextKey={plaintextKey} />}
    </div>
  );
}
