import type { DailyUsagePoint } from '../types';

const CHART_HEIGHT = 160;
const TICK_COUNT = 4;

function formatTick(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function formatDateLabel(date: string): string {
  // YYYY-MM-DD -> MM-DD，跟 Logs 頁面的時間篩選按鈕（1h/24h/7d）風格一致，畫面上不用重複年份。
  return date.slice(5);
}

// 手刻 CSS 長條圖（不另外裝圖表套件）：Dashboard 原本「依 Model 分解花費」
// 那段也是同樣手法，個人版規模的資料量沒有必要為了畫圖表多一個相依套件。
export function DailyCostChart({ data }: { data: DailyUsagePoint[] }) {
  const max = Math.max(...data.map((d) => d.cost), 0.0001);
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, i) => (max * (TICK_COUNT - i)) / TICK_COUNT);

  return (
    <div className="rounded-lg border border-card-border bg-white shadow-sm p-5">
      <h3 className="text-[13px] font-semibold text-text mb-4">近 {data.length} 天花費趨勢</h3>
      <div className="flex gap-2">
        <div className="flex flex-col justify-between text-[11px] text-text-muted shrink-0" style={{ height: CHART_HEIGHT }}>
          {ticks.map((t, i) => (
            <span key={i}>{formatTick(t)}</span>
          ))}
        </div>

        <div className="flex-1 min-w-0">
          <div className="relative border-l border-b border-shell" style={{ height: CHART_HEIGHT }}>
            <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
              {ticks.map((_, i) => (
                <div key={i} className="border-t border-dashed border-shell" />
              ))}
            </div>

            <div className="absolute inset-0 flex items-end">
              {data.map((d) => (
                <div key={d.date} className="flex-1 h-full flex items-end justify-center px-1">
                  <div
                    className="w-full max-w-[28px] rounded-t bg-chart-accent"
                    style={{ height: d.cost > 0 ? `${Math.max((d.cost / max) * 100, 2)}%` : '0%' }}
                    title={`${d.date}：$${d.cost.toFixed(6)}（${d.requests} 次）`}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex mt-1.5">
            {data.map((d) => (
              <span key={d.date} className="flex-1 text-center text-[11px] text-text-muted">
                {formatDateLabel(d.date)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
