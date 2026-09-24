// src/pages/StatsPage.tsx — 统计页（S5-C · 任务 5-4 / 5-5）
//
// UI 基线：PRD §8.15（统计口径）/ 架构 §6.6（statsService 函数清单）/ styles-batch3.css
// 已冻结的统计页相关类（.period-cards / .period-card / .stats-block / .result-main-card.v2 /
// .inventory-three / .heatmap-calendar / .heatmap-row / .stockpile-delta-chart / .cost-pie-row …）。
//
// 数据约束（教训清单）：
// - **不**在组件里做聚合：所有数字一律经 statsService（PRD §8.15）；
// - 区间随三卡切换（PRD §8.15「数据来源与派生」表口径）；
// - 热力图无四档阈值：连续 alpha 着色（PRD §8.15）；
// - 环形图占比从 purchaseByCategory 现算（不进任何缓存表）；
// - legacy: 流水全表不计入——已在 statsService 层彻底拦截，组件层无需再过滤。
//
// UI 行为细节：
// - 默认周期 = 本月；
// - 三张卡片互斥（互不并存）；
// - 文案不带「累计」字眼（与 PRD §8.15 / demo 用词一致）；
// - 切换后各区块标题带区间名（「本月 · 完工趋势」等）；
// - 空态按 demo：库存为零时三角图与汇总均显示空态卡；
// - 0 值类别不进采购占比图例（UI 过滤，不动服务层）；
// - 浮层 stopPropagation / 不弹原生框 / 日期显式格式化（按既有冻结写法）。

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  type PeriodKey,
  type StatsForPeriod,
  type CompletionHeatmap,
  type StockpileIndex,
  type CategorySpend,
  getStatsForPeriod,
  getCompletionHeatmap,
  getStockpileIndex,
  getPeriodRange,
  heatmapAlpha,
} from '@/services/statsService';
import { todayIsoDate } from '@/lib/date';

// — 类型 —

/** 四类物料色与图例色（PRD §8.15 色序：面料/辅料/工具/纸样）。
 *  样式仅以组件内联/SVG 填充生效，不动冻结 CSS（styles-batch3.css .cost-pie-visual 的 conic-gradient
 *  实际被白底圆覆盖，仅作 dead fallback 保留旧值）。 */
const PIE_COLOR_FALLBACK: Record<string, string> = {
  fabric: '#FF8FB0',
  accessory: '#FFB3C7',
  tool: '#FFDCE6',
  pattern: '#FFC8D8',
};

// — 工具 —

/** 「今天」日期串（YYYY-MM-DD），与 statsService.getPeriodRange 的 today 对齐。 */
const today = (): string => todayIsoDate();

/** 数字保留两位小数（与 statsService.round2 同步；UI 不再二次舍入）。 */
const fmt2 = (n: number): string => (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);

/** 整数（≥0 才有语义）。 */
const fmtInt = (n: number): string => String(Math.max(0, Math.round(n)));

/** 日期串 → 中文展示（YYYY.MM.DD）。 */
const fmtYmd = (s: string): string => (s ? s.split('-').join('.') : '');

// — 子组件 —

interface PeriodCardsProps {
  period: PeriodKey;
  onChange: (p: PeriodKey) => void;
  /** 三张卡各自的展示区间副标题（YYYY.MM.DD ~ YYYY.MM.DD 或「全部历史」）。 */
  subs: Record<PeriodKey, string>;
}

function PeriodCards({ period, onChange, subs }: PeriodCardsProps) {
  const items: { key: PeriodKey; label: string }[] = [
    { key: 'month', label: '本月' },
    { key: 'year', label: '本年' },
    { key: 'all', label: '汇总' },
  ];
  return (
    <div className="period-cards" role="tablist" aria-label="统计周期">
      {items.map((it) => (
        <div
          key={it.key}
          className={`period-card${period === it.key ? ' active' : ''}`}
          role="tab"
          aria-selected={period === it.key}
          tabIndex={0}
          onClick={() => onChange(it.key)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onChange(it.key);
            }
          }}
        >
          <div className="period-card-label">{it.label}</div>
          <div className="period-card-sub">{subs[it.key]}</div>
        </div>
      ))}
    </div>
  );
}

// — 热力图 —

/** 把 0~1 的 alpha 拼到主色上（rgba 字符串）。 */
function alphaColor(rgb: string, a: number): string {
  // rgb 形如 "#FF8FB0"
  if (rgb.startsWith('#')) {
    const hex = rgb.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
  }
  return rgb;
}

/** 本月：日历周排布。 */
function HeatmapCalendar({ heatmap }: { heatmap: CompletionHeatmap }) {
  return (
    <div className="heatmap-calendar">
      <div className="heatmap-weekdays">
        {heatmap.dayLabels.map((d) => (
          <div key={d} className="heatmap-weekday">
            {d}
          </div>
        ))}
      </div>
      <div className="heatmap-weeks">
        {heatmap.weeks.map((week, wi) => (
          <div key={wi} className="heatmap-week">
            {week.map((cell, ci) => {
              if (!cell) {
                return <div key={ci} className="heatmap-cell empty" />;
              }
              const a = cell.isFuture
                ? 0.15
                : heatmapAlpha(cell.count, heatmap.maxCount);
              const bg = cell.isFuture
                ? undefined
                : alphaColor('#FF8FB0', a);
              return (
                <div
                  key={ci}
                  className={
                    cell.isFuture
                      ? 'heatmap-cell future'
                      : 'heatmap-cell filled'
                  }
                  style={bg ? { background: bg } : undefined}
                  title={
                    cell.isFuture
                      ? `${cell.label}（未来）`
                      : cell.count > 0
                        ? `${cell.label} · ${cell.count} 件`
                        : `${cell.label}`
                  }
                >
                  {cell.count > 0 && !cell.isFuture && (
                    <span className="heatmap-count">{cell.count}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {/* 图例四档仅为色阶示意（PRD §8.15 无四档阈值） */}
      <div className="heatmap-legend">
        <span className="heatmap-legend-label">少</span>
        {['#FFE6EE', '#FFC8D8', '#FFB3C7', '#FF8FB0'].map((c) => (
          <span
            key={c}
            className="heatmap-legend-scale"
            style={{ background: c }}
          />
        ))}
        <span className="heatmap-legend-label">多</span>
      </div>
    </div>
  );
}

/** 本年 / 汇总：横排大方格。 */
function HeatmapRow({ heatmap }: { heatmap: CompletionHeatmap }) {
  return (
    <div className="heatmap-row">
      <div className="heatmap-row-cells">
        {heatmap.cells.map((cell) => {
          const a = cell.isFuture
            ? 0.15
            : heatmapAlpha(cell.count, heatmap.maxCount);
          const bg = cell.isFuture
            ? undefined
            : alphaColor('#FF8FB0', a);
          return (
            <div
              key={cell.key}
              className={
                cell.isFuture ? 'heatmap-cell-lg future' : 'heatmap-cell-lg filled'
              }
              style={bg ? { background: bg } : undefined}
              title={
                cell.isFuture
                  ? `${cell.label}（未来）`
                  : cell.count > 0
                    ? `${cell.label} · ${cell.count} 件`
                    : `${cell.label}`
              }
            >
              <span className="heatmap-cell-label">{cell.label}</span>
              {cell.count > 0 && !cell.isFuture && (
                <span className="heatmap-count-lg">{cell.count}</span>
              )}
            </div>
          );
        })}
      </div>
      {/* 图例四档仅为色阶示意（PRD §8.15 无四档阈值） */}
      <div className="heatmap-legend">
        <span className="heatmap-legend-label">少</span>
        {['#FFE6EE', '#FFC8D8', '#FFB3C7', '#FF8FB0'].map((c) => (
          <span
            key={c}
            className="heatmap-legend-scale"
            style={{ background: c }}
          />
        ))}
        <span className="heatmap-legend-label">多</span>
      </div>
    </div>
  );
}

// — 囤布指数（净差柱图，零线居中） —

function StockpileDeltaChart({ stock }: { stock: StockpileIndex }) {
  // 零线居中（CSS 已设），柱高按 |delta| / maxAbs × 100% 计算
  const maxAbs = stock.maxAbs || 0.1;
  return (
    <div className="stockpile-delta-chart" aria-label="囤布指数柱图">
      <div className="stockpile-delta-axis" />
      <div
        className="stockpile-delta-bars"
        style={{
          // 月模式日期多时收紧列宽
          minWidth: stock.cells.length > 18 ? `${stock.cells.length * 24}px` : undefined,
        }}
      >
        {stock.cells.map((cell) => {
          const positive = cell.delta >= 0;
          const pct = Math.min(100, (Math.abs(cell.delta) / maxAbs) * 100);
          const value = Math.abs(cell.delta);
          const valueLabel = cell.delta === 0 ? '' : value.toFixed(2);
          return (
            <div key={cell.key} className="delta-col">
              <div className="delta-bar-wrap">
                <div
                  className={positive ? 'delta-bar delta-pos' : 'delta-bar delta-neg'}
                  style={{ height: `${pct}%` }}
                >
                  {valueLabel && <span className="delta-out">{valueLabel}</span>}
                </div>
              </div>
              <span className="delta-label">{cell.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// — 采购占比环形图（SVG donut，从 purchaseByCategory 现算） —

/** 单类扇区路径（环带：从 cx/cy/r 外环到 rIn 内环）。 */
function sectorPath(
  cx: number,
  cy: number,
  r: number,
  rIn: number,
  startDeg: number,
  endDeg: number,
): string {
  const toRad = (d: number): number => ((d - 90) * Math.PI) / 180;
  const start = toRad(startDeg);
  const end = toRad(endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  const x1 = cx + r * Math.cos(start);
  const y1 = cy + r * Math.sin(start);
  const x2 = cx + r * Math.cos(end);
  const y2 = cy + r * Math.sin(end);
  const x3 = cx + rIn * Math.cos(end);
  const y3 = cy + rIn * Math.sin(end);
  const x4 = cx + rIn * Math.cos(start);
  const y4 = cy + rIn * Math.sin(start);
  return [
    `M ${x1} ${y1}`,
    `A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rIn} ${rIn} 0 ${large} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ');
}

function PurchaseDonut({
  items,
  total,
  periodLabel,
}: {
  items: CategorySpend[];
  total: number;
  periodLabel: string;
}) {
  // 过滤 0 值类别（UI 层做，不动服务层；服务层恒返回四类全量）
  const nonzero = items.filter((c) => c.value > 0);
  // 空态：total=0 或 nonzero=[] → 显示「暂无{区间名}采购数据」（PRD §8.15）
  const showEmpty = total <= 0 || nonzero.length === 0;
  if (showEmpty) {
    return <div className="empty-pie-hint">暂无{periodLabel}采购数据</div>;
  }

  const cx = 60;
  const cy = 60;
  const r = 50;
  const rIn = 32;
  // 按 PRD §8.15 色序排（fabric / accessory / tool / pattern）
  const order = ['fabric', 'accessory', 'tool', 'pattern'];
  const sorted = order
    .map((t) => nonzero.find((c) => c.type === t))
    .filter((c): c is CategorySpend => c !== undefined);
  // 角度按各自占比累加
  const slices: { color: string; type: string; name: string; value: number; start: number; end: number }[] = [];
  let cursor = 0;
  for (const item of sorted) {
    const angle = (item.value / total) * 360;
    slices.push({
      color: PIE_COLOR_FALLBACK[item.type] ?? '#999',
      type: item.type,
      name: item.name,
      value: item.value,
      start: cursor,
      end: cursor + angle,
    });
    cursor += angle;
  }

  return (
    <div className="cost-pie-row">
      <svg
        width={120}
        height={120}
        viewBox="0 0 120 120"
        className="cost-pie-visual"
        aria-label="采购占比环形图"
        style={{ background: 'transparent' }}
      >
        {/* 背景环（白） */}
        <circle cx={cx} cy={cy} r={r} fill="#FFFFFF" />
        {slices.map((s) => (
          <path
            key={s.type}
            d={sectorPath(cx, cy, r, rIn, s.start, s.end)}
            fill={s.color}
            stroke="#FFFFFF"
            strokeWidth={1}
          />
        ))}
        {/* 中心圆（白） */}
        <circle cx={cx} cy={cy} r={rIn} fill="#FFFFFF" />
      </svg>
      <div className="cost-pie-total" style={{ marginLeft: '-86px', pointerEvents: 'none' }}>
        <div className="pie-total-value">¥{fmt2(total)}</div>
        <div className="pie-total-label">采购总额</div>
      </div>
      <div className="cost-pie-legend">
        {sorted.map((item) => (
          <div className="pie-legend-row" key={item.type}>
            <span
              className="pie-dot"
              style={{ background: PIE_COLOR_FALLBACK[item.type] ?? '#999' }}
            />
            <span className="pie-name">{item.name}</span>
            <span className="pie-value">¥{fmt2(item.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// — 主体 —

const PERIOD_LABEL: Record<PeriodKey, string> = {
  month: '本月',
  year: '本年',
  all: '汇总',
};

/** 热力图标题（PRD §8.15 区块 3：「每日成衣」/「月度成衣」/「年度成衣」）。 */
const TREND_TITLE: Record<PeriodKey, string> = {
  month: '每日成衣',
  year: '月度成衣',
  all: '年度成衣',
};

export default function StatsPage() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<PeriodKey>('month');

  // 各卡副标题（YYYY.MM.DD ~ YYYY.MM.DD；汇总为「全部历史」）
  const [subs, setSubs] = useState<Record<PeriodKey, string>>({
    month: '',
    year: '',
    all: '',
  });

  // stats：随 period 切换 + db 变化刷新
  const stats = useLiveQuery(
    async (): Promise<StatsForPeriod | null> => {
      const r = getPeriodRange(period);
      try {
        return await getStatsForPeriod(r.from, r.to);
      } catch {
        return null;
      }
    },
    [period],
  );

  // 热力图：随 period 切换 + db 变化刷新
  const heatmap: CompletionHeatmap | undefined = useLiveQuery<CompletionHeatmap | undefined>(
    async () => {
      try {
        return await getCompletionHeatmap(period);
      } catch {
        return undefined;
      }
    },
    [period],
  );

  // 囤布指数：随 period 切换 + db 变化刷新
  const stockpile: StockpileIndex | undefined = useLiveQuery<StockpileIndex | undefined>(
    async () => {
      try {
        return await getStockpileIndex(period);
      } catch {
        return undefined;
      }
    },
    [period],
  );

  // 初次挂载 + period 切换：刷新三张卡副标题
  useEffect(() => {
    const m = getPeriodRange('month');
    const y = getPeriodRange('year');
    const a = getPeriodRange('all');
    setSubs({
      month: `${fmtYmd(m.from)}~${fmtYmd(m.to)}`,
      year: `${fmtYmd(y.from)}~${fmtYmd(y.to)}`,
      all: `${fmtYmd(a.from.slice(0, 4) === '0000' ? a.to : a.from)}~${fmtYmd(a.to)}`,
    });
  }, []);

  // 完工明细（仅展示前 N 条；展开按 demo 风格做）
  const [expanded, setExpanded] = useState(false);
  const completedList = stats?.completedGarments ?? [];
  // PRD §8.15 区块 6：列表最多 10 条，超过 10 条时显示「展开全部」按钮；空区间整块不渲染。
  const listMax = expanded ? completedList.length : 10;

  const label = PERIOD_LABEL[period];
  const isCurrentMonth = period === 'month';

  // 囤布指数一句话点评（PRD §8.15：{区间名}入布 {入布}m，消耗 {消耗}m，净囤布 {±值}m）
  const summaryNode = useMemo(() => {
    if (!stockpile) return null;
    const { inbound, consumed, delta } = stockpile.summary;
    if (Math.abs(delta) < 0.005 && inbound === 0 && consumed === 0) {
      return (
        <div className="stockpile-summary">
          本区间内<strong> 入布与消耗均为 0</strong>
        </div>
      );
    }
    return (
      <div className="stockpile-summary">
        {label}入布 <strong>{fmt2(inbound)}</strong>m，
        消耗 <strong>{fmt2(consumed)}</strong>m，
        净囤布
        <strong className={delta >= 0 ? 'delta-up' : 'delta-down'}>
          {' '}{delta > 0 ? '+' : ''}{fmt2(delta)}m
        </strong>
      </div>
    );
  }, [stockpile, label]);

  return (
    <div className="page stats-page">
      <div className="page-header">
        <h1 className="title">统计</h1>
      </div>
      <div className="page-content with-bottom-nav">
        <PeriodCards period={period} onChange={setPeriod} subs={subs} />

        {/* 战果主卡：单指标 · 完工数（PRD §8.15） */}
        <div className="stats-block">
          <div className="stats-block-title">{label} · 战果</div>
          <div className="result-main-card v2">
            <div className="result-main-single">
              <div className="result-main-value v2">
                {fmtInt(stats?.completedCount ?? 0)}
                <span className="result-main-unit v2">件</span>
              </div>
              <div className="result-main-label v2">{label}完工数</div>
            </div>
          </div>

          {/* 库存三指标（PRD §8.15：入布 / 消耗 / 净囤布） */}
          <div className="inventory-three">
            <div className="inv-item">
              <div className="inv-value">
                {fmt2(stats?.fabricInbound ?? 0)}
                <span className="inv-unit">m</span>
              </div>
              <div className="inv-label">入布</div>
            </div>
            <div className="inv-divider" />
            <div className="inv-item">
              <div className="inv-value">
                {fmt2(stats?.fabricConsumed ?? 0)}
                <span className="inv-unit">m</span>
              </div>
              <div className="inv-label">消耗</div>
            </div>
            <div className="inv-divider" />
            <div className="inv-item">
              <div
                className="inv-value"
                style={{
                  color:
                    (stats?.netFabric ?? 0) >= 0
                      ? 'var(--accent)'
                      : '#8BC34A',
                }}
              >
                {(stats?.netFabric ?? 0) >= 0 ? '+' : ''}
                {fmt2(stats?.netFabric ?? 0)}
                <span className="inv-unit">m</span>
              </div>
              <div className="inv-label">净囤布</div>
            </div>
          </div>

          {/* 采购占比环形图（PRD §8.15；占比从 purchaseByCategory 现算） */}
          <div className="stats-card" style={{ paddingTop: 18 }}>
            <div className="stats-card-title">
              <span>{label} · 采购占比</span>
              <span className="stats-card-count">
                总额 ¥{fmt2(stats?.purchaseTotal ?? 0)}
              </span>
            </div>
            <PurchaseDonut
              items={stats?.purchaseByCategory ?? []}
              total={stats?.purchaseTotal ?? 0}
              periodLabel={label}
            />
            <div className="cost-disclaimer" style={{ marginTop: 12, marginBottom: 0 }}>
              <div className="disclaimer-text">
                单件成本是这件成衣用了多少料、花多少钱的<strong>记录值</strong>；
                采购花费是这段时间里<strong>现金流出</strong>的汇总，两者口径不同，
                <strong>不可互相比较、不可混算</strong>（PRD §8.15）。
              </div>
            </div>
            <div className="cost-disclaimer" style={{ marginTop: 8, marginBottom: 0 }}>
              <div className="disclaimer-text">
                口径：<strong>购买当时</strong>的 purchasePrice × initialQuantity（PRD §8.15）。
                {` `}legacy: 前缀流水不计入任何汇总。
              </div>
            </div>
          </div>
        </div>

        {/* 完工热力图（PRD §8.15 · 连续 alpha，无四档阈值） */}
        <div className="stats-block">
          <div className="stats-block-title">{TREND_TITLE[period]}</div>
          <div className="stats-card">
            {!heatmap ? (
              <div className="empty-pie-hint">加载中…</div>
            ) : isCurrentMonth ? (
              <HeatmapCalendar heatmap={heatmap} />
            ) : (
              <HeatmapRow heatmap={heatmap} />
            )}
          </div>
        </div>

        {/* 囤布指数（PRD §8.15） */}
        <div className="stats-block">
          <div className="stats-block-title">{label} · 囤布指数</div>
          <div className="stats-card">
            <div className="stockpile-legend">
              <div className="legend-item">
                <span className="legend-dot legend-dot-in" />
                <span className="legend-text">净囤布（+）</span>
              </div>
              <div className="legend-item">
                <span className="legend-dot legend-dot-green" />
                <span className="legend-text">净消耗（−）</span>
              </div>
            </div>
            {!stockpile ? (
              <div className="empty-pie-hint">加载中…</div>
            ) : (
              <StockpileDeltaChart stock={stockpile} />
            )}
            {summaryNode}
          </div>
        </div>

        {/* 完工明细（PRD §8.15 区块 6：列表最多 10 条；空区间整块不渲染） */}
        {completedList.length > 0 && (
          <div className="stats-block">
            <div className="stats-block-title">
              <span>{label} · 完工明细</span>
              <span className="stats-card-count">{completedList.length} 件</span>
            </div>
            <div className="stats-card">
              <div className="completion-list">
                {completedList.slice(0, listMax).map((g) => (
                  <div
                    key={g.id}
                    className="completion-list-item"
                    onClick={() => navigate(`/garments/${g.id}`)}
                  >
                    <div className="cl-left">
                      <div className="cl-name">{g.name || '（未命名）'}</div>
                      <div className="cl-date">{fmtYmd(g.completionDate)}</div>
                    </div>
                    <div className="cl-right">
                      {g.totalCost == null ? (
                        <span className="cl-cost uncalculated">未核算</span>
                      ) : (
                        <span className="cl-cost">¥{fmt2(g.totalCost)}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {completedList.length > 10 && (
                <div
                  className="expand-all-btn"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? '收起' : '展开全部'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 区间提示 + 今日（按 demo 基线放底部） */}
        <div
          className="stats-block"
          style={{
            paddingTop: 6,
            paddingBottom: 18,
            color: 'var(--secondary-foreground)',
            fontSize: 11,
            textAlign: 'center',
          }}
        >
          区间 {fmtYmd(stats?.from ?? '')} ~ {fmtYmd(stats?.to ?? '')}（{label}） · 今日 {fmtYmd(today())}
        </div>
      </div>
    </div>
  );
}