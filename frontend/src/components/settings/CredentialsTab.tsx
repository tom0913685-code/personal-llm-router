'use client';

import { useEffect, useState } from 'react';
import { Pencil, Plug, RefreshCw } from 'lucide-react';
import { listCredentials, createCredential, updateCredential, testCredentialConnection } from '../../lib/api';
import type { Credential } from '../../types';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { RowActionButton } from '../ui/RowActionButton';
import { HealthBadge } from '../HealthBadge';
import { CredentialForm, type CredentialFormValues } from './CredentialForm';

export function CredentialsTab() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Credential | undefined>();
  const [testingId, setTestingId] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    setLoadError(null);
    listCredentials()
      .then(setCredentials)
      .catch((err) => setLoadError(err instanceof Error ? err.message : '載入失敗'))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  async function handleSubmit(values: CredentialFormValues) {
    if (editing) {
      await updateCredential(editing.id, values);
    } else {
      await createCredential(values);
    }
    reload();
  }

  // @article topic:two-tier-health-check
  // 只驗連線/認證，不代表底下任何一個 Deployment 的 provider_model_id
  // 真的可用——那是 Deployments 分頁「手動檢查」的事，見
  // src/health/check.ts 的說明。
  async function handleTestConnection(credential: Credential) {
    setTestingId(credential.id);
    try {
      await testCredentialConnection(credential.id);
      reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : '測試連線失敗');
    } finally {
      setTestingId(null);
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
          + 新增 Credential
        </Button>
      </div>

      <div className="rounded border border-card-border bg-white overflow-hidden overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-shell text-left text-text-muted whitespace-nowrap">
              <th className="px-4 py-2 font-medium">名稱</th>
              <th className="px-4 py-2 font-medium">Adapter 類型</th>
              <th className="px-4 py-2 font-medium">Base URL</th>
              <th className="px-4 py-2 font-medium">狀態</th>
              <th className="px-4 py-2 font-medium">連線</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-text-muted">
                  載入中...
                </td>
              </tr>
            )}
            {!loading && loadError && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-danger">
                  載入失敗：{loadError}
                  <RowActionButton className="ml-2" title="重試" onClick={reload}>
                    <RefreshCw size={14} />
                  </RowActionButton>
                </td>
              </tr>
            )}
            {!loading &&
              !loadError &&
              credentials.map((c) => (
                <tr key={c.id} className="border-b border-shell last:border-0 whitespace-nowrap hover:bg-surface">
                  <td className="px-4 py-2.5">{c.name}</td>
                  <td className="px-4 py-2.5 text-text-muted">{c.adapterType}</td>
                  <td className="px-4 py-2.5 text-text-muted truncate max-w-[220px]">{c.baseUrl ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={c.enabled ? 'success' : 'danger'}>{c.enabled ? '啟用' : '停用'}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <HealthBadge check={{ healthStatus: c.connectivityStatus, lastLatencyMs: c.lastLatencyMs, lastError: c.lastError, lastCheckedAt: c.lastCheckedAt }} />
                  </td>
                  <td className="px-4 py-2.5 text-right space-x-1.5 whitespace-nowrap">
                    <RowActionButton title="測試連線" onClick={() => handleTestConnection(c)} disabled={testingId === c.id}>
                      <Plug size={14} />
                    </RowActionButton>
                    <RowActionButton
                      title="編輯"
                      onClick={() => {
                        setEditing(c);
                        setFormOpen(true);
                      }}
                    >
                      <Pencil size={14} />
                    </RowActionButton>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* @article topic:stale-form-bug-repeat
          只在開啟時才掛載：CredentialForm 的初始值是在 useState 初始化時只算
          一次，若一直掛載著，切換「編輯 A」→「編輯 B」時 initial prop 換了
          但 values 不會重新計算，表單會殘留上一筆的舊資料（同一個 bug
          DeploymentForm 之前修過，見 DeploymentsTab.tsx 的註解）。 */}
      {formOpen && <CredentialForm open={formOpen} onOpenChange={setFormOpen} initial={editing} onSubmit={handleSubmit} />}
    </div>
  );
}
