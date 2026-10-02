// src/db/migrations/importReportView.ts
//
// S8-C 导入报告的展示视图构建（PRD §11.8 / §13.5 / DM §9.10）。
//
// ── 数据源唯一性（任务书硬约束）────────────────────────────────────────
// 界面上**全部**计数与清单只渲染 `importLegacyDatabase` 返回的
// `ImportReport`——UI 不另算任何数字。本模块是纯函数：输入只有 report
// 一个，输出是可直接渲染的视图结构；每个数字都能逐字段追溯到 report。
// 归档任务提醒（「旧库有 N 条归档任务，未迁移」）不在 report 里
// （importLegacyDatabase 没有 task_archive 输入位，§11.1 定死「读到也不
// 解析」），由 UI 层作为附加提醒单独展示，不冒充 report 数字。
//
// 跳过清单两组判定（§11.9 / §9.10）：reason 含「已存在」= 幂等保护组
// （「这些记录之前导入过，本次跳过」）；其余 = 校验未通过组（真丢数据，
// 逐条列出原因）。

import type { ImportReport } from './legacy';

/** 单条跳过记录的展示形态（表名:旧主键 + 原因）。 */
export interface SkippedItemView {
  /** 例 `fabric:old_ab12`；oldId 为空串时只显示表名。 */
  label: string;
  reason: string;
}

/** 导入报告的展示视图（全部字段源自 ImportReport，无第二数据源）。 */
export interface ImportReportView {
  /** 完成文案（§13.5）：`共导入 N 条物料、M 件成衣、K 条库存流水`。 */
  summaryLine: string;
  /** 三项入库计数（§11.8 前三行，标签原文）。 */
  counts: { label: string; value: number }[];
  /** 预设合并行（§11.8）：`新增面料品牌 a 项、纸样品牌 b 项、标签 c 项`。 */
  presetsLine: string;
  /** 图片四计数（§11.7/§11.8）：成功 / 未找到 / 格式拒绝 / 超限截断。 */
  imageCounts: { label: string; value: number }[];
  /** 幂等保护组（reason 含「已存在」）：计数 + 固定说明文案。 */
  skippedExisting: { count: number; note: string };
  /** 校验未通过组：逐条（label + 原因）。 */
  skippedInvalid: SkippedItemView[];
  /** 「有 n 处引用指向未能导入的数据」。 */
  danglingCount: number;
  /** 「已忽略旧库的 n 类字段」（report 已按 table+field 去重）。 */
  droppedFieldCount: number;
  /** 「因口径变更丢弃 n 条旧的用量明细」（= 各行 count 之和）。 */
  droppedAmountsCount: number;
  /** 【Y-A】「其中 n 条为迁移时库存对齐流水」（单列计数，§11.8 报告项）。 */
  alignmentLogsCount: number;
  /** 提醒逐条（§11.8 报告项「提醒」）。 */
  warnings: string[];
}

/** reason 是否属于「已存在」幂等保护组（§9.10 建议的分组判定）。 */
export function isExistingSkip(reason: string): boolean {
  return reason.includes('已存在');
}

/** skipped 条目 → 展示 label：`{table}:{oldId}`，oldId 空串时只显示表名。 */
function skippedLabel(table: string, oldId: string): string {
  return oldId === '' ? table : `${table}:${oldId}`;
}

/**
 * ImportReport → 展示视图。纯函数；所有数字逐字段取自 report，不做任何
 * 二次计算（droppedAmountsCount 是 report 内各条 count 的求和，仍属
 * report 自身数据的汇总，不引入外部数据源）。
 */
export function buildImportReportView(report: ImportReport): ImportReportView {
  const skippedExisting = report.skipped.filter((s) => isExistingSkip(s.reason));
  const skippedInvalid = report.skipped.filter((s) => !isExistingSkip(s.reason));
  return {
    summaryLine: `共导入 ${report.materials} 条物料、${report.garments} 件成衣、${report.usageLogs} 条库存流水`,
    counts: [
      { label: '导入物料', value: report.materials },
      { label: '导入成衣', value: report.garments },
      { label: '导入库存流水', value: report.usageLogs },
    ],
    presetsLine:
      `新增面料品牌 ${report.presets.fabricBrands} 项、纸样品牌 ${report.presets.patternBrands} 项、` +
      `标签 ${report.presets.accessoryTags} 项`,
    imageCounts: [
      { label: '成功导入', value: report.importedImages },
      { label: '未找到', value: report.missingImages },
      { label: '格式拒绝', value: report.rejectedImages },
      { label: '超限截断', value: report.truncatedImages },
    ],
    skippedExisting: {
      count: skippedExisting.length,
      note: '这些记录之前导入过，本次跳过',
    },
    skippedInvalid: skippedInvalid.map((s) => ({
      label: skippedLabel(s.table, s.oldId),
      reason: s.reason,
    })),
    danglingCount: report.danglingRefs.length,
    droppedFieldCount: report.droppedFields.length,
    droppedAmountsCount: report.droppedAmounts.reduce((sum, d) => sum + d.count, 0),
    alignmentLogsCount: report.alignmentLogs,
    warnings: [...report.warnings],
  };
}
