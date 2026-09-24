// 淺灰底襯 + 浮動白卡片（2026-09-19 使用者確認）：白底卡片配一點陰影，
// 在淺灰的頁面背景上「浮」起來，比純邊框更有層次感。
export function StatCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-card-border bg-white shadow-sm py-[18px] px-5">
      <p className="text-[13px] text-text-muted mb-[6px]">{title}</p>
      <p className="text-[26px] font-bold text-text tabular-nums">{value}</p>
      {sub && <p className="text-[12px] text-text-small mt-0.5">{sub}</p>}
    </div>
  );
}
