'use client';

import { useEffect, useState } from 'react';
import { Activity, Loader2, Pencil, RefreshCw } from 'lucide-react';
import { listCredentials, listDeployments, createDeployment, updateDeployment, triggerHealthCheck } from '../../lib/api';
import type { Credential, Deployment } from '../../types';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { RowActionButton } from '../ui/RowActionButton';
import { HealthBadge } from '../HealthBadge';
import { DeploymentForm, type DeploymentFormValues } from './DeploymentForm';

export function DeploymentsTab() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Deployment | undefined>();
  const [checkingId, setCheckingId] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    setLoadError(null);
    Promise.all([listDeployments(), listCredentials()])
      .then(([d, c]) => {
        // 依 publicModelName 分組、組內依 priority 升冪排序——跟 Gateway 實際
        // 選路的順序一致（見 src/routing/resolve.ts），讓同一個 model 底下的
        // Fallback 候選在畫面上自然排在一起，一眼看出誰先誰後備援。
        const sorted = [...d].sort((a, b) => {
          if (a.publicModelName !== b.publicModelName) return a.publicModelName.localeCompare(b.publicModelName);
          return a.priority - b.priority;
        });
        setDeployments(sorted);
        setCredentials(c);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : '載入失敗'))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  async function handleSubmit(values: DeploymentFormValues) {
    if (editing) {
      await updateDeployment(editing.id, values);
    } else {
      await createDeployment(values);
    }
    reload();
  }

  async function handleHealthCheck(id: string) {
    setCheckingId(id);
    try {
      await triggerHealthCheck(id);
      reload();
    } catch (err) {
      // runHealthCheck() 在後端自己會把 adapter 失敗轉成 healthStatus:'unhealthy'
      // 正常回傳，不會走到這裡——這裡只會接到真的打不到後端這種例外狀況，
      // 用最簡單的方式提示就好，不特別為這個邊界情況做一整套 UI。
      alert(err instanceof Error ? err.message : '健康檢查失敗');
    } finally {
      setCheckingId(null);
    }
  }

  function credentialName(id: string) {
    return credentials.find((c) => c.id === id)?.name ?? '（未知 credential）';
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            setEditing(undefined);
            setFormOpen(true);
          }}
          disabled={credentials.length === 0}
        >
          + 新增 Deployment
        </Button>
      </div>

      <div className="rounded border border-card-border bg-white overflow-hidden overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-shell text-left text-text-muted whitespace-nowrap">
              <th className="px-3 py-2 font-medium">Public Model Name</th>
              <th className="px-3 py-2 font-medium">Provider Model ID</th>
              <th className="px-3 py-2 font-medium text-right">Priority</th>
              <th className="px-3 py-2 font-medium">Credential</th>
              <th className="px-3 py-2 font-medium">定價（$/M token）</th>
              <th className="px-3 py-2 font-medium">狀態</th>
              <th className="px-3 py-2 font-medium">排程健康檢查</th>
              <th className="px-3 py-2 font-medium">健康度</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-text-muted">
                  載入中...
                </td>
              </tr>
            )}
            {!loading && loadError && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-danger">
                  載入失敗：{loadError}
                  <RowActionButton className="ml-2" title="重試" onClick={reload}>
                    <RefreshCw size={14} />
                  </RowActionButton>
                </td>
              </tr>
            )}
            {!loading &&
              !loadError &&
              deployments.map((d) => (
                <tr key={d.id} className="border-b border-shell last:border-0 whitespace-nowrap hover:bg-surface">
                  <td className="px-3 py-2.5 font-medium">{d.publicModelName}</td>
                  <td className="px-3 py-2.5 text-text-muted">{d.providerModelId}</td>
                  <td className="px-3 py-2.5 text-right text-text-muted tabular-nums">{d.priority}</td>
                  <td className="px-3 py-2.5 text-text-muted">{credentialName(d.credentialId)}</td>
                  <td className="px-3 py-2.5 text-text-muted tabular-nums">
                    {d.inputCostPerMillion} / {d.outputCostPerMillion}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant={d.enabled ? 'success' : 'danger'}>{d.enabled ? '啟用' : '停用'}</Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant={d.autoHealthCheckEnabled ? 'success' : 'neutral'}>
                      {d.autoHealthCheckEnabled ? '開啟' : '關閉'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <HealthBadge check={d} lastManualCheckedAt={d.lastManualCheckedAt} />
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <div className="inline-flex gap-1.5">
                      <RowActionButton
                        title={checkingId === d.id ? '檢查中...' : '手動檢查'}
                        onClick={() => handleHealthCheck(d.id)}
                        disabled={checkingId === d.id}
                      >
                        {checkingId === d.id ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
                      </RowActionButton>
                      <RowActionButton
                        title="編輯"
                        onClick={() => {
                          setEditing(d);
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

      {credentials.length === 0 && !loading && !loadError && (
        <p className="text-[12px] text-text-muted">請先到「Credentials」分頁新增至少一組 credential，才能建立 Deployment。</p>
      )}

      {/* @article topic:stale-form-bug-repeat
          只在開啟時才掛載：DeploymentForm 的初始值（尤其 credentialId 預設第一筆）
          是在 useState 初始化時只算一次，若一直掛載著、頁面剛載入 credentials 還是空陣列
          時就會被鎖死成空字串，之後 credentials 載入完成也不會回頭補上。這個 bug 後來
          發現 CredentialsTab.tsx 也有同一款（漏套用這個修法），見那邊的註解。 */}
      {formOpen && (
        <DeploymentForm open={formOpen} onOpenChange={setFormOpen} initial={editing} credentials={credentials} onSubmit={handleSubmit} />
      )}
    </div>
  );
}
