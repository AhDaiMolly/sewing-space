// src/components/CompletionWizard.tsx — 完工登记浮层（S5-B · 任务 5-1 UI）
//
// UI 基线：docs/demo/src/components/CompletionWizard.jsx（PR §9 逐字复刻版）
// 落地 PRD §9 全部要点：
//   - 纯只读确认页（§9.2 三件事 / §9.3 界面构成）
//   - 浮层容器 stopPropagation 防冒泡击穿背景 onCancel 关闭钩子
//   - 不动库存、不查库存（PRD §9.1 一 / S5-A 单写路径）
//   - 明细只取 garment.materialSnapshot 中 retiredAt 不存在的活跃行（§9.4）
//   - 物料名称 / 单位 / 价格 / 数量 / 小计一律取快照值，不回落物料表
//   - 工具类行单价位置显示「不计价」；不显示小计与扣减标记
//   - 物料已删除（悬挂引用）时类型标签不渲染；名称与小计照常显示
//   - 纸样行仅当 garment.patternId 在 materials 中能查到时渲染
//   - 物料小计 = 非工具类行 subtotal 之和；总成本 = 物料小计 + 纸样价（先求和再 round2，不逐行取整）
//   - 「确认完工」只回传 { garmentId, totalCost } 两个字段；completionDate 由 S5-A 服务层
//     markGarmentCompleted 默认生成（YYYY-MM-DD, UTC 截取），并在写入时完成 §9.6 校验
//   - 不调用 window.prompt/alert/confirm（PRD §15.3）
//   - 仅使用冻结 CSS 中已存在的类名（form-overlay/form-sheet/form-header/form-body/form-footer/
//     completion-overlay/completion-wizard/wizard-garment-{header,icon,info,name,meta}/
//     wizard-section-title/-hint/wizard-empty/material-qty-row.{readonly,tool-row}/mqr-* /pattern-row.{readonly}
//     /pattern-price-display/wizard-total-preview/preview-row/total-value/completion-hint/btn-{primary,secondary}）

import { useMemo } from 'react';
import { createElement as h } from 'react';
import type { Garment, Material, GarmentMaterialSnapshot } from '@/db/types';
import {
  IconDress,
  IconPattern,
} from './Icons';

interface CompletionWizardProps {
  /** 当前在制中的成衣行。 */
  garment: Garment;
  /** 物料行数组。仅用于判断快照行指向的物料是否还存在（悬挂引用提示），
   *  以及反查纸样。不用于取价格、单位、名称（这些值取自快照）。 */
  materials: Material[];
  /** 关闭浮层，无写入。点遮罩或「取消」时触发。 */
  onCancel: () => void;
  /** 用户点击「确认完工」时调用。父级负责走 S5-A markGarmentCompleted 服务层写库。 */
  onConfirm: (payload: { garmentId: string; totalCost: number }) => void;
}

/** 取快照行的「当前类型」标签。物料已删除时不渲染标签。 */
function getTypeTag(mat: Material | undefined): '面料' | '辅料' | '工具' | null {
  if (!mat) return null;
  if (mat.type === 'fabric') return '面料';
  if (mat.type === 'accessory') return '辅料';
  if (mat.type === 'tool') return '工具';
  return null;
}

/** 「3.5 米」一类的格式化：两位小数 + 去尾 0 + 单位 */
function fmtQtyWithUnit(qty: number, unit: string): string {
  const fixed = qty.toFixed(2);
  // 去尾 0（3.50 → 3.5；3.00 → 3）
  const trimmed = fixed.replace(/\.?0+$/, '');
  return `${trimmed}${unit}`;
}

/** 金额格式化：「¥43.75」两位小数。千分位不加分隔符。 */
function fmtCurrency(v: number): string {
  return `¥${v.toFixed(2)}`;
}

export default function CompletionWizard({
  garment,
  materials,
  onCancel,
  onConfirm,
}: CompletionWizardProps) {
  // ── 明细行派生（§9.4 数据来源与派生） ──
  const materialRows = useMemo(() => {
    const snapshot = (garment.materialSnapshot ?? []) as GarmentMaterialSnapshot[];
    // 仅取活跃行（retiredAt 字段不存在）
    const active = snapshot.filter((r) => !('retiredAt' in r));
    return active.map((s) => {
      const mat = materials.find((m) => m.id === s.materialId);
      const isTool = mat?.type === 'tool';
      return {
        materialId: s.materialId,
        name: s.name,
        unit: s.unit,
        unitPrice: s.priceSnapshot ?? 0,
        quantityUsed: s.quantityUsed || 0,
        subtotal: s.subtotal ?? 0,
        deducted: !!s.deducted,
        typeTag: getTypeTag(mat),
        isTool,
        // 物料已删除 → 仍按可计价处理，正常显示小计；不阻断完工
        materialMissing: !mat,
      };
    });
  }, [garment.materialSnapshot, materials]);

  // ── 纸样行：仅当 garment.patternId 在 materials 里能查到时渲染 ──
  const pattern = garment.patternId
    ? materials.find((m) => m.id === garment.patternId) ?? null
    : null;

  // ── 成本计算（§9.4 · 先求和再 round2，不逐行取整） ──
  // 纸样成本口径：纸样就是一个 material.type === 'pattern' 的物料，购买价取自
  // material.purchasePrice（S5-A 已正式「纸样不再走 demo 已丢弃的 patternPurchasePrice
  // 近似」）。Garment 不存 patternPurchasePrice 字段。
  const calculated = useMemo(() => {
    let totalMaterial = 0;
    materialRows.forEach((row) => {
      if (row.isTool) return;
      totalMaterial += Number(row.subtotal || 0);
    });
    const patternPrice =
      pattern && pattern.purchasePrice != null
        ? Number(pattern.purchasePrice) || 0
        : 0;
    // 「先分别求和再一次性取整」——与 S5-A 服务层 round2 同源（(n + EPSILON)*100/100）
    const totalCost = Math.round((totalMaterial + patternPrice) * 100) / 100;
    return { totalMaterial, patternPrice, totalCost };
  }, [materialRows, pattern]);

  // ── 「确认完工」回调：只回传 { garmentId, totalCost } ──
  const handleConfirm = () => {
    onConfirm({
      garmentId: garment.id,
      totalCost: calculated.totalCost,
    });
  };

  // ── 渲染 ──
  return h(
    'div',
    {
      className: 'form-overlay completion-overlay',
      onClick: onCancel,
      role: 'dialog',
      'aria-modal': true,
      'aria-label': '完工确认',
    },
    h(
      'div',
      {
        className: 'form-sheet completion-wizard',
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
      },
      // ── 页头：左取消 / 中标题 / 右 32px 占位 ──
      h(
        'div',
        { className: 'form-header' },
        h(
          'button',
          { className: 'cancel', onClick: onCancel, type: 'button' },
          '取消',
        ),
        h('span', { className: 'title' }, '完工确认'),
        h('div', { style: { width: '32px' } }),
      ),

      // ── 信息头 + 明细区 ──
      h(
        'div',
        { className: 'form-body' },
        // 成衣信息头
        h(
          'div',
          { className: 'wizard-garment-header' },
          h(
            'div',
            { className: 'wizard-garment-icon' },
            h(IconDress, {
              style: { width: '36px', height: '36px', color: 'var(--accent)' },
            }),
          ),
          h(
            'div',
            { className: 'wizard-garment-info' },
            h('div', { className: 'wizard-garment-name' }, garment.name),
            h(
              'div',
              { className: 'wizard-garment-meta' },
              `${garment.category || '未分类'} · ${garment.size || '—'}`,
            ),
          ),
        ),

        // 分组标题
        h(
          'div',
          { className: 'wizard-section-title' },
          '用料明细',
          h(
            'span',
            { className: 'wizard-section-hint' },
            '（已在登记时扣减库存）',
          ),
        ),

        // 空态（仅当无任何活跃行时才渲染）
        materialRows.length === 0 &&
          h(
            'div',
            { className: 'wizard-empty' },
            '该成衣未关联物料，可直接完工',
          ),

        // 明细行
        materialRows.map((row, idx) =>
          h(
            'div',
            {
              key: row.materialId || `idx-${idx}`,
              className: `material-qty-row readonly${
                row.isTool ? ' tool-row' : ''
              }`,
            },
            h(
              'div',
              { className: 'mqr-info' },
              h(
                'div',
                { className: 'mqr-name' },
                row.name,
                row.typeTag
                  ? h(
                      'span',
                      { className: 'mqr-type-tag' },
                      row.typeTag,
                    )
                  : null,
              ),
              row.isTool
                ? h('div', { className: 'mqr-price tool-hint' }, '不计价')
                : h(
                    'div',
                    { className: 'mqr-price' },
                    `${fmtCurrency(row.unitPrice)}/${row.unit}`,
                  ),
            ),
            // 数量·单位（右）
            h(
              'div',
              { className: 'mqr-qty-readonly' },
              fmtQtyWithUnit(row.quantityUsed, row.unit),
            ),
            // 小计（非工具类显示，工具类不显示）
            !row.isTool
              ? h(
                  'div',
                  { className: 'mqr-subtotal' },
                  fmtCurrency(row.subtotal),
                )
              : null,
            // 扣减标记
            h(
              'div',
              { className: 'mqr-deduct-tag' },
              row.deducted ? '✓ 已扣' : '未扣',
            ),
          ),
        ),

        // 纸样行（仅当能查到 paperMaterial 时渲染）
        pattern
          ? h(
              'div',
              { className: 'pattern-row readonly' },
              h(
                'div',
                { className: 'pattern-label' },
                h(IconPattern, {
                  style: {
                    width: '16px',
                    height: '16px',
                    color: 'var(--accent)',
                  },
                }),
                `纸样：${pattern.name}`,
              ),
              h(
                'div',
                { className: 'pattern-price-display' },
                fmtCurrency(
                  pattern.purchasePrice != null
                    ? Number(pattern.purchasePrice) || 0
                    : 0,
                ),
              ),
            )
          : null,

        // 小计块
        h(
          'div',
          { className: 'wizard-total-preview' },
          h(
            'div',
            { className: 'preview-row' },
            h('span', null, '物料小计'),
            h('span', null, fmtCurrency(calculated.totalMaterial)),
          ),
          calculated.patternPrice > 0
            ? h(
                'div',
                { className: 'preview-row' },
                h('span', null, '纸样'),
                h('span', null, fmtCurrency(calculated.patternPrice)),
              )
            : null,
          h(
            'div',
            { className: 'preview-row total' },
            h('span', null, '总成本'),
            h(
              'span',
              { className: 'total-value' },
              fmtCurrency(calculated.totalCost),
            ),
          ),
          h(
            'div',
            { className: 'completion-hint' },
            '登记时价格定格 · 完工不重复扣库存',
          ),
        ),
      ),

      // ── 底部按钮区：单步，直接确认 ──
      h(
        'div',
        { className: 'form-footer' },
        h(
          'button',
          {
            type: 'button',
            className: 'btn btn-secondary',
            onClick: onCancel,
          },
          '取消',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'btn btn-primary',
            onClick: handleConfirm,
          },
          '确认完工',
        ),
      ),
    ),
  );
}
