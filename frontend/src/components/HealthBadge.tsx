import type { HealthStatus } from '../types';

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return '剛剛';
  if (minutes < 60) return `${minutes} 分鐘前`;
  return `${Math.round(minutes / 60)} 小時前`;
}

export interface HealthCheckSnapshot {
  healthStatus: HealthStatus;
  lastLatencyMs?: number;
  lastError?: string;
  lastCheckedAt?: string;
}

// 滑鼠移入顯示檢查細節，用純 CSS group-hover 取代 Radix HoverCard——
// 個人版只有這一個地方需要 hover 詳情，不值得為此多引入一個 headless
// primitive 依賴，行為簡化但視覺效果相同。吃的是通用的健檢結果形狀，
// 不是綁死 Deployment——Credential 的「測試連線」（connectivityStatus）
// 也是同一組欄位形狀，兩邊共用這個元件（2026-09-19 兩層健康檢查）。
//
// lastManualCheckedAt 是選填的獨立 prop，不是 HealthCheckSnapshot 的一
// 部分——只有 Deployment 才有「手動觸發 vs 排程/建立時自動觸發」這個區
// 分，Credential 目前沒有排程功能，硬塞進共用形狀反而誤導（2026-09-21）。
export function HealthBadge({ check, lastManualCheckedAt }: { check: HealthCheckSnapshot; lastManualCheckedAt?: string }) {
  const { healthStatus, lastLatencyMs, lastError, lastCheckedAt } = check;

  if (healthStatus === 'unknown') {
    return <span className="text-[12px] text-text-small">未檢查</span>;
  }

  const isHealthy = healthStatus === 'healthy';

  return (
    <div className="group relative inline-block">
      <span className={`text-[12px] cursor-default ${isHealthy ? 'text-success' : 'text-danger'}`}>
        ● {isHealthy ? `${lastLatencyMs}ms` : (lastError ?? '異常').slice(0, 36)}
      </span>
      <div className="absolute left-0 top-full z-10 mt-1 hidden w-64 rounded border border-card-border bg-white p-3 text-[12px] shadow-lg group-hover:block">
        <p className="text-text-muted">
          狀態：<span className={isHealthy ? 'text-success' : 'text-danger'}>{isHealthy ? '健康' : '異常'}</span>
        </p>
        {isHealthy && <p className="text-text-muted">延遲：{lastLatencyMs}ms</p>}
        {!isHealthy && lastError && <p className="text-danger break-words">{lastError}</p>}
        <p className="text-text-small mt-1">上次檢查：{timeAgo(lastCheckedAt)}</p>
        {lastManualCheckedAt !== undefined && (
          <p className="text-text-small">上次手動檢查：{lastManualCheckedAt ? timeAgo(lastManualCheckedAt) : '從未'}</p>
        )}
      </div>
    </div>
  );
}
