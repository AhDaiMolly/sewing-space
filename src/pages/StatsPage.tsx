// src/pages/StatsPage.tsx — 统计页（S5-C · 任务 5-4 / 5-5）
//
// UI 基线：PRD §8.15（统计口径）/ 架构 §6.6（statsService 函数清单）/ styles-batch3.css
// 统计页相关类（.period-cards / .period-card / .stats-block / .result-main-card.v2 /
// .inventory-three / .heatmap-calendar / .heatmap-row / .cost-pie-row …）。
// AA-F 统计3：原净差柱图组件已随囤布指数模块改版移除。
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
// - AA-F 统计4：模块标题不再带区间前缀（「囤布指数」「采购占比」「完工明细」）；
// - 空态按 demo：库存为零时三角图与汇总均显示空态卡；
// - 0 值类别不进采购占比图例（UI 过滤，不动服务层）；
// - 浮层 stopPropagation / 不弹原生框 / 日期显式格式化（按既有冻结写法）。

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  type PeriodKey,
  type StatsForPeriod,
  type CompletionHeatmap,
  type CategorySpend,
  type FabricFlowEntry,
  type PurchaseFlowEntry,
  getStatsForPeriod,
  getCompletionHeatmap,
  getPeriodRange,
  listFabricFlowsInRange,
  listPurchaseFlowsInRange,
  heatmapAlpha,
} from '@/services/statsService';
import { IconBack } from '@/components/Icons';

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
    { key: 'year', label: '今年' },
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

/** 本年 / 汇总：横排大方格。AH-A Q2：今年卡下月格可点——选中/再点取消（月份过滤入口）。 */
interface HeatmapRowProps {
  heatmap: CompletionHeatmap;
  /** AH-A Q2：是否启用月格点击（仅今年卡）。 */
  selectable?: boolean;
  /** 当前选中月份 'YYYY-MM'；null = 未选（全年全量）。 */
  selectedMonth?: string | null;
  /** 月格点击回调（内部已做再点取消）。 */
  onSelectMonth?: (key: string) => void;
}

function HeatmapRow({ heatmap, selectable = false, selectedMonth = null, onSelectMonth }: HeatmapRowProps) {
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
          const isSelected = selectable && !cell.isFuture && cell.key === selectedMonth;
          return (
            <div
              key={cell.key}
              className={
                cell.isFuture ? 'heatmap-cell-lg future' : 'heatmap-cell-lg filled'
              }
              style={{
                ...(bg ? { background: bg } : undefined),
                // AH-A Q2：选中月描边高亮（可再点取消）
                ...(isSelected ? { boxShadow: 'inset 0 0 0 2.5px var(--accent, #E85D9E)', cursor: 'pointer' } : undefined),
                ...(selectable && !cell.isFuture ? { cursor: 'pointer' } : undefined),
              }}
              onClick={selectable && !cell.isFuture ? () => onSelectMonth?.(cell.key) : undefined}
              role={selectable && !cell.isFuture ? 'button' : undefined}
              aria-pressed={selectable && !cell.isFuture ? isSelected : undefined}
              title={
                selectable && !cell.isFuture
                  ? isSelected
                    ? `${cell.label} · 已筛选（点击取消，恢复全年）`
                    : `${cell.label} · 点击筛选该月`
                  : cell.isFuture
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
      {/* AA-F 统计2：圆环中心只保留总金额数字（中心标签文字已删），绝对定位
          居中于 donut——替换原 marginLeft:-86px 负边距近似居中写法。 */}
      <div
        style={{
          position: 'relative',
          width: 120,
          height: 120,
          flexShrink: 0,
        }}
      >
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
        <div
          className="cost-pie-total"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div className="pie-total-value" style={{ whiteSpace: 'nowrap' }}>
            ¥{fmt2(total)}
          </div>
        </div>
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
  year: '今年',
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
  // AH-A Q2：今年卡「月度成衣」月份联动过滤。selectedMonth = 'YYYY-MM'，仅
  // period === 'year' 时有效；再点同一月取消（恢复全年全量）；切卡（含切回
  // 今年）一律重置为 null，不残留。
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const handlePeriodChange = (p: PeriodKey) => {
    setPeriod(p);
    setSelectedMonth(null);
  };

  const handleSelectMonth = (key: string) => {
    setSelectedMonth((prev) => (prev === key ? null : key));
  };

  // 有效区间：选中月份 → 该月 [月初, 月末]；否则周期全量。
  // 月份过滤作用于全部数据模块（见下方各 useLiveQuery）。
  const effRange = useMemo(() => {
    if (period === 'year' && selectedMonth) {
      const parts = selectedMonth.split('-').map(Number);
      const y = parts[0] ?? 0;
      const m = parts[1] ?? 0;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return {
        from: `${selectedMonth}-01`,
        to: `${selectedMonth}-${String(lastDay).padStart(2, '0')}`,
      };
    }
    return getPeriodRange(period);
  }, [period, selectedMonth]);

  // 各卡副标题（V-E Q3：不展示具体时间段，改 demo 短文案——「{月}月」「{年}年」「全部」）
  const subs = useMemo<Record<PeriodKey, string>>(() => {
    const m = getPeriodRange('month');
    const y = getPeriodRange('year');
    return {
      month: `${Number(m.from.slice(5, 7))}月`,
      year: `${y.from.slice(0, 4)}年`,
      all: '全部',
    };
  }, []);

  // stats：随 period / selectedMonth 切换 + db 变化刷新（AH-A Q2：月份过滤作用于
  // 战果主卡（完工数/完工明细）、囤布指数三指标、采购占比（总额与占比））
  const stats = useLiveQuery(
    async (): Promise<StatsForPeriod | null> => {
      try {
        return await getStatsForPeriod(effRange.from, effRange.to);
      } catch {
        return null;
      }
    },
    [effRange],
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

  // 囤布指数文字模块与布料明细共用 stats 的入布/消耗/净囤布；布料明细（AA-F
  // 统计6）随 period / selectedMonth 切换 + db 变化刷新（AH-A Q2：月份过滤作用）。
  const fabricFlows: FabricFlowEntry[] | undefined = useLiveQuery<FabricFlowEntry[] | undefined>(
    async () => {
      try {
        return await listFabricFlowsInRange(effRange.from, effRange.to);
      } catch {
        return undefined;
      }
    },
    [effRange],
  );
  const fabricFlowList = fabricFlows ?? [];

  // 采购明细（AD-D 统计1）：随 period / selectedMonth 切换 + db 变化刷新，与采购占比同一区间口径。
  const purchaseFlows: PurchaseFlowEntry[] | undefined = useLiveQuery<PurchaseFlowEntry[] | undefined>(
    async () => {
      try {
        return await listPurchaseFlowsInRange(effRange.from, effRange.to);
      } catch {
        return undefined;
      }
    },
    [effRange],
  );
  const purchaseFlowList = purchaseFlows ?? [];

  // 完工明细（AA-F 统计5：由近及远全量渲染，容器固定 10 条高度、超出滚动）
  const completedList = stats?.completedGarments ?? [];

  const label = PERIOD_LABEL[period];
  const isCurrentMonth = period === 'month';

  return (
    <div className="page stats-page">
      <div className="page-header">
        {/* V-E Q2：左上角返回箭头（对齐 demo icon-btn + IconBack 模式） */}
        <div className="left-actions">
          <button className="icon-btn" onClick={() => navigate('/')} aria-label="返回首页">
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
        <h1 className="title">统计</h1>
        <div className="right-actions" />
      </div>
      <div className="page-content with-bottom-nav">
        <PeriodCards period={period} onChange={handlePeriodChange} subs={subs} />

        {/* 战果主卡：单指标 · 完工数（PRD §8.15）；V-E Q4 去掉「{区间} · 战果」标题，直接展示完工件数（对齐 demo） */}
        <div className="stats-block">
          <div className="result-main-card v2">
            <div className="result-main-single">
              <div className="result-main-value v2">
                {fmtInt(stats?.completedCount ?? 0)}
                <span className="result-main-unit v2">件</span>
              </div>
              <div className="result-main-label v2">{label}完工数</div>
            </div>
          </div>
        </div>

        {/* 完工热力图（PRD §8.15 · 连续 alpha，无四档阈值）。
            AH-A Q2：今年卡下 HeatmapRow 兼作月份过滤入口——点击月格选中/再点取消，
            选中月加描边高亮；热力图自身保持全年 12 格（否则过滤后只剩一格失去
            切换入口），仅下方数据模块随选中月过滤。 */}
        <div className="stats-block">
          <div className="stats-block-title">{TREND_TITLE[period]}</div>
          <div className="stats-card">
            {!heatmap ? (
              <div className="empty-pie-hint">加载中…</div>
            ) : isCurrentMonth ? (
              <HeatmapCalendar heatmap={heatmap} />
            ) : (
              <HeatmapRow
                heatmap={heatmap}
                selectable={period === 'year'}
                selectedMonth={selectedMonth}
                onSelectMonth={handleSelectMonth}
              />
            )}
          </div>
        </div>

        {/* 完工明细（AA-F 统计5：改名去前缀 + 挪到「每日成衣」模块下方；
            由近及远全量渲染，容器固定 10 条高度、超过滚动；空区间整块不渲染） */}
        {completedList.length > 0 && (
          <div className="stats-block">
            <div className="stats-block-title">
              <span>完工明细</span>
              <span className="stats-card-count">{completedList.length} 件</span>
            </div>
            <div className="stats-card">
              <div className="completion-list aa-fixed10">
                {completedList.map((g) => (
                  <div
                    key={g.id}
                    className="completion-list-item"
                    onClick={() => navigate(`/garments/${g.id}`)}
                  >
                    {/* AG-A Q5：去掉成本列，成衣名称与完工时间同一行展示 */}
                    <div className="cl-left">
                      <span className="cl-name">{g.name || '（未命名）'}</span>
                      <span className="cl-date">{fmtYmd(g.completionDate)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 囤布指数（AA-F 统计3：原净差柱图替换为「入布 / 消耗 / 净囤布」文字模块，
            即原「本月完工数」卡片下方的三指标卡，标题去粒度前缀） */}
        <div className="stats-block">
          <div className="stats-block-title">囤布指数</div>
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
        </div>

        {/* 布料明细（AA-F 统计6：囤布指数下方；购入/损耗按时间由近及远，
            容器固定 10 条高度、超过滚动；空区间整块不渲染） */}
        {fabricFlowList.length > 0 && (
          <div className="stats-block">
            <div className="stats-block-title">
              <span>布料明细</span>
              <span className="stats-card-count">{fabricFlowList.length} 笔</span>
            </div>
            <div className="stats-card">
              <div className="fabric-flow-list aa-fixed10">
                {fabricFlowList.map((f) => (
                  <div key={f.id} className="fabric-flow-item">
                    <div className="ff-left">
                      <div className="ff-name">{f.materialName}</div>
                      <div className="ff-date">{fmtYmd(f.dateLabel)}</div>
                    </div>
                    <div className="ff-right">
                      <span className={`ff-type ${f.kind === 'purchase' ? 'ff-in' : 'ff-out'}`}>
                        {f.kind === 'purchase' ? '购入' : '损耗'}
                      </span>
                      <span className="ff-qty">
                        {fmt2(f.quantity)}
                        <span className="ff-unit">{f.unit}</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 采购占比（V-E Q5 顺序对齐；AA-F 统计1 去掉模块下方文字提示、
            统计4 标题去粒度前缀） */}
        <div className="stats-block">
          <div className="stats-card" style={{ paddingTop: 18 }}>
            <div className="stats-card-title">
              <span>采购占比</span>
              <span className="stats-card-count">
                总额 ¥{fmt2(stats?.purchaseTotal ?? 0)}
              </span>
            </div>
            <PurchaseDonut
              items={stats?.purchaseByCategory ?? []}
              total={stats?.purchaseTotal ?? 0}
              periodLabel={label}
            />
          </div>
        </div>

        {/* 采购明细（AD-D 统计1：采购占比下方；行结构与样式复用布料明细
            （fabric-flow-list aa-fixed10），容器固定 10 条高度、超过滚动；
            空区间整块不渲染；三粒度随 period 自动生效） */}
        {purchaseFlowList.length > 0 && (
          <div className="stats-block">
            <div className="stats-block-title">
              <span>采购明细</span>
              <span className="stats-card-count">{purchaseFlowList.length} 笔</span>
            </div>
            <div className="stats-card">
              <div className="fabric-flow-list aa-fixed10">
                {purchaseFlowList.map((p) => (
                  <div key={p.id} className="fabric-flow-item">
                    <div className="ff-left">
                      <div className="ff-name">{p.materialName}</div>
                      <div className="ff-date">
                        {fmtYmd(p.dateLabel)} · {fmt2(p.quantity)}
                        {p.unit}
                      </div>
                    </div>
                    <div className="ff-right">
                      <span className="ff-type ff-in">{p.typeName}</span>
                      <span className="ff-qty">¥{fmt2(p.spend)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}