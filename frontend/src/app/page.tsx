'use client';

import { useEffect, useState } from 'react';
import { getUsageSummary, getDailyUsage } from '../lib/api';
import type { UsageSummary, DailyUsage } from '../types';
import { StatCard } from '../components/StatCard';
import { DailyCostChart } from '../components/DailyCostChart';

const BAR_COLORS = ['#185FA5', '#16a34a', '#ca8a04', '#dc2626', '#7c3aed'];
const DAILY_TREND_DAYS = 7;

type RangePreset = 'today' | 'week' | 'month';

const RANGE_PRESETS: { label: string; value: RangePreset }[] = [
  { label: '今日', value: 'today' },
  { label: '本週', value: 'week' },
  { label: '本月', value: 'month' },
];

// @article topic:daily-cost-chart
// 「今日/本週/本月」都不是後端的新概念，只是「從某個 UTC 曆日起點到現在」
// 這個算法套用在不同的起點上——後端 /admin/logs/summary 只需要一個
// rangeHours（近 N 小時）就能表達全部三種，不用為了「本週」再開一個新的
// 查詢參數。跟 /admin/logs/daily 的 UTC 曆日分桶維持同一個時區基準（見
// logs.routes.ts），本週的起點固定用 ISO 週一，不特別做地區化。
function hoursSincePresetStart(preset: RangePreset): number {
  const now = new Date();
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  let start = startOfDay;
  if (preset === 'week') {
    const dayOfWeek = now.getUTCDay(); // 0=Sun..6=Sat
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    start = startOfDay - daysSinceMonday * 24 * 60 * 60 * 1000;
  } else if (preset === 'month') {
    start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  }
  return (Date.now() - start) / (1000 * 60 * 60);
}

export default function DashboardPage() {
  const [preset, setPreset] = useState<RangePreset>('month');
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [daily, setDaily] = useState<DailyUsage | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [dailyError, setDailyError] = useState<string | null>(null);

  // 「近 7 天花費趨勢」跟選定的時間範圍（今日/本週/本月）無關，只需要載入
  // 一次，不用因為切換 preset 而重新打一次。
  useEffect(() => {
    setDailyError(null);
    getDailyUsage(DAILY_TREND_DAYS)
      .then(setDaily)
      .catch((err) => setDailyError(err instanceof Error ? err.message : '載入失敗'));
  }, []);

  useEffect(() => {
    // 原本用 `!summary` 判斷是否還在載入：API 失敗時 state 永遠是 null，
    // 畫面會永久卡在「載入中...」，而且失敗完全沒有任何提示。改成明確的
    // error state；切換 preset 時先清空舊資料，避免畫面短暫顯示上一個
    // 範圍的數字。
    setSummaryError(null);
    setSummary(null);
    getUsageSummary(hoursSincePresetStart(preset))
      .then(setSummary)
      .catch((err) => setSummaryError(err instanceof Error ? err.message : '載入失敗'));
  }, [preset]);

  const presetLabel = RANGE_PRESETS.find((p) => p.value === preset)?.label ?? '';
  const maxCost = Math.max(...(summary?.byDeployment.map((d) => d.cost) ?? []), 0.0001);

  return (
    <div className="space-y-6">
      {/* 範圍選擇跟下面內容的 loading/error 狀態脫鉤，切換範圍時按鈕不會
          因為內容變成「載入中...」而整組消失再重新出現。 */}
      <div className="flex rounded border border-shell overflow-hidden w-fit">
        {RANGE_PRESETS.map((opt) => (
          <button
            key={opt.value}
            className={`px-3 py-1.5 text-[12px] ${
              preset === opt.value ? 'bg-primary text-white' : 'bg-white text-text-muted hover:bg-surface'
            }`}
            onClick={() => setPreset(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {summaryError && <p className="text-[13px] text-danger">載入失敗：{summaryError}</p>}
      {!summaryError && !summary && <p className="text-text-muted text-[13px]">載入中...</p>}
      {!summaryError && summary && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard title={`總花費（${presetLabel}）`} value={`$${summary.totalCost.toFixed(4)}`} />
            <StatCard title={`請求次數（${presetLabel}）`} value={String(summary.totalRequests)} />
            <StatCard title={`錯誤率（${presetLabel}）`} value={`${(summary.errorRate * 100).toFixed(1)}%`} />
            <StatCard title={`Fallback 觸發率（${presetLabel}）`} value={`${(summary.fallbackRate * 100).toFixed(1)}%`} />
          </div>

          <div className="rounded-lg border border-card-border bg-white shadow-sm p-5">
            <h3 className="text-[13px] font-semibold text-text mb-4">模型使用分佈（{presetLabel}）</h3>
            <div className="space-y-3">
              {summary.byDeployment.map((d, i) => (
                <div key={d.deploymentId ?? `unknown:${d.publicModelName}`} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 text-[12px] text-text-muted truncate">{d.publicModelName}</span>
                  <div className="flex-1 h-1.5 bg-shell rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${(d.cost / maxCost) * 100}%`, backgroundColor: BAR_COLORS[i % BAR_COLORS.length] }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right text-[12px] tabular-nums text-text">${d.cost.toFixed(4)}</span>
                  <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-text-small">{d.requests} 次</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {dailyError && <p className="text-[13px] text-danger">花費趨勢載入失敗：{dailyError}</p>}
      {!dailyError && daily && <DailyCostChart data={daily.days} />}
    </div>
  );
}
