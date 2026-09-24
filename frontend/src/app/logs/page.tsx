'use client';

import { Fragment, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { listLogs, listDeployments, type LogFilters } from '../../lib/api';
import type { RequestLog, Deployment } from '../../types';
import { Badge } from '../../components/ui/Badge';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';
import { RowActionButton } from '../../components/ui/RowActionButton';

const PAGE_SIZE = 10;
const RANGE_OPTIONS = [
  { label: '1h', hours: 1 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
  { label: '全部', hours: undefined },
];

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-TW', { hour12: false });
}

export default function LogsPage() {
  const [rangeHours, setRangeHours] = useState<number | undefined>(24 * 7);
  const [modelFilter, setModelFilter] = useState('');
  const [deploymentFilter, setDeploymentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'success' | 'error' | ''>('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ items: RequestLog[]; total: number }>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  // 純粹用來讓「重試」按鈕能觸發 useEffect 重新執行——filters/page 都沒變的
  // 情況下（單純上次失敗想再試一次），靠 state 值不變不會重新觸發 effect。
  const [retryTick, setRetryTick] = useState(0);

  // 05-web-ui.md 把「依 deployment 篩選」列成明細頁面的功能需求之一，跟
  // status 並列；後端 GET /admin/logs 早就支援 deploymentId 參數，這裡補
  // 上下拉選單讓使用者選特定 deployment（不只是靠 model 名稱模糊比對，
  // 同一個 public model 底下的 primary/fallback 也能分開篩）。清單載入失
  // 敗不影響明細列表本身，靜默失敗即可，下拉選單維持空清單。
  useEffect(() => {
    listDeployments()
      .then(setDeployments)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const filters: LogFilters = {
      rangeHours,
      publicModelName: modelFilter || undefined,
      deploymentId: deploymentFilter || undefined,
      status: statusFilter || undefined,
      page,
      pageSize: PAGE_SIZE,
    };
    setLoading(true);
    setLoadError(null);
    listLogs(filters)
      .then(setResult)
      // 原本沒有 .catch：API 失敗時 result 維持初始值 { items: [], total: 0 }，
      // 畫面顯示「沒有符合條件的記錄」，使用者會誤以為真的沒資料而不是 API
      // 掛了。改成明確的錯誤列，不跟「真的沒資料」混在一起。
      .catch((err) => setLoadError(err instanceof Error ? err.message : '載入失敗'))
      .finally(() => setLoading(false));
  }, [rangeHours, modelFilter, deploymentFilter, statusFilter, page, retryTick]);

  function resetFiltersAndReload(fn: () => void) {
    fn();
    setPage(1);
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded border border-shell overflow-hidden">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              className={`px-3 py-1.5 text-[12px] ${
                rangeHours === opt.hours ? 'bg-primary text-white' : 'bg-white text-text-muted hover:bg-surface'
              }`}
              onClick={() => resetFiltersAndReload(() => setRangeHours(opt.hours))}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <Input
          className="w-40"
          placeholder="依 model 篩選"
          value={modelFilter}
          onChange={(e) => resetFiltersAndReload(() => setModelFilter(e.target.value))}
        />

        <Select
          className="w-48"
          value={deploymentFilter}
          onChange={(e) => resetFiltersAndReload(() => setDeploymentFilter(e.target.value))}
        >
          <option value="">全部 Deployment</option>
          {deployments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.publicModelName}（priority {d.priority}）
            </option>
          ))}
        </Select>

        <Select
          className="w-32"
          value={statusFilter}
          onChange={(e) => resetFiltersAndReload(() => setStatusFilter(e.target.value as 'success' | 'error' | ''))}
        >
          <option value="">全部狀態</option>
          <option value="success">success</option>
          <option value="error">error</option>
        </Select>

        {(modelFilter || deploymentFilter || statusFilter || rangeHours !== 24 * 7) && (
          <Button
            variant="ghost"
            onClick={() =>
              resetFiltersAndReload(() => {
                setModelFilter('');
                setDeploymentFilter('');
                setStatusFilter('');
                setRangeHours(24 * 7);
              })
            }
          >
            重設篩選
          </Button>
        )}
      </div>

      <div className="rounded border border-card-border bg-white overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-shell text-left text-text-muted whitespace-nowrap">
              <th className="px-3 py-2 font-medium w-6"></th>
              <th className="px-3 py-2 font-medium">時間</th>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium text-right">Input</th>
              <th className="px-3 py-2 font-medium text-right">Output</th>
              <th className="px-3 py-2 font-medium text-right">花費</th>
              <th className="px-3 py-2 font-medium text-right">Latency</th>
              <th className="px-3 py-2 font-medium">狀態</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-text-muted">
                  載入中...
                </td>
              </tr>
            )}
            {!loading && loadError && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-danger">
                  載入失敗：{loadError}
                  <RowActionButton className="ml-2" title="重試" onClick={() => setRetryTick((t) => t + 1)}>
                    <RefreshCw size={14} />
                  </RowActionButton>
                </td>
              </tr>
            )}
            {!loading && !loadError && result.items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-text-muted">
                  沒有符合條件的記錄
                </td>
              </tr>
            )}
            {!loading &&
              !loadError &&
              result.items.map((log) => (
                <Fragment key={log.id}>
                  <tr
                    key={log.id}
                    className="border-b border-shell last:border-0 cursor-pointer hover:bg-surface"
                    onClick={() => toggle(log.id)}
                  >
                    <td className="px-3 py-2.5 text-text-small">{expanded.has(log.id) ? '▾' : '▸'}</td>
                    <td className="px-3 py-2.5 text-text-muted whitespace-nowrap">{formatTime(log.createdAt)}</td>
                    <td className="px-3 py-2.5">{log.publicModelName}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{log.inputTokens}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{log.outputTokens}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">${log.cost.toFixed(6)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{log.latencyMs}ms</td>
                    <td className="px-3 py-2.5">
                      <Badge variant={log.status === 'success' ? 'success' : 'danger'}>{log.status}</Badge>
                    </td>
                  </tr>
                  {expanded.has(log.id) && (
                    <tr key={`${log.id}-detail`} className="border-b border-shell last:border-0 bg-surface">
                      <td colSpan={8} className="px-6 py-4">
                        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-[12px]">
                          <p>
                            <span className="text-text-muted">Request ID：</span>
                            {log.requestId}
                          </p>
                          <p>
                            <span className="text-text-muted">Provider Model ID：</span>
                            {log.providerModelId}
                          </p>
                          <p>
                            <span className="text-text-muted">HTTP 狀態碼：</span>
                            {log.statusCode}
                          </p>
                          <p>
                            <span className="text-text-muted">Latency：</span>
                            {log.latencyMs}ms
                          </p>
                        </div>
                        {log.status !== 'success' && (
                          <div className="mt-3 rounded border border-danger/30 bg-danger-bg p-3 text-[12px] text-danger">
                            <p className="font-medium">
                              {log.errorCode}：{log.errorMessage}
                            </p>
                            {log.providerError !== undefined && (
                              <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] opacity-80">
                                {JSON.stringify(log.providerError, null, 2)}
                              </pre>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-[12px] text-text-muted">
        <span>
          共 {result.total} 筆，第 {page} / {totalPages} 頁
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            上一頁
          </Button>
          <Button variant="ghost" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
            下一頁
          </Button>
        </div>
      </div>
    </div>
  );
}
