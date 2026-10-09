// src/services/taskService.ts
//
// 工作台任务服务层（S4-A）：P9 任务 CRUD 与状态变更（完工走 handleTaskComplete
// 单函数）、P10 任务模板管理（内置只读 / 自建 CRUD / 复制为自建 / 套用）、
// P4 手工损耗入口（recordManualConsume，委托 materialService.recordLoss）、
// 任务与成衣的引用绑定 / 解绑。函数签名风格对齐 materialService /
// garmentService；口径（字段上限、步骤 id 生成规则、completedAt 双条件、
// 事务边界、打脏规则、级联矩阵）逐字对齐数据模型 v2.0 §3.3 / §3.4 / §5.2 /
// §5.5 / §5.6 / §6.6 / §6.7 与架构文档 v3.0 §6.5 / §13.4。
//
// 关键约束（架构 §13.4 S4 DoD）：
//   1. 完工只走 handleTaskComplete 单函数——本模块内没有任何第二处「把任务写
//      成 done」的实现；toggleTaskStep 的「全勾自动完工」派生分支在事务内
//      调用 handleTaskComplete 本体（Dexie 同表嵌套事务复用外层事务），
//      setTaskStatus('done') 同样只是转发。UI 层所有完工入口都必须调它。
//   2. 【V-C 工作台Q4 新口径，2026-09-28 用户验收推翻本条旧口径】任务完工
//      时其关联成衣若处于 in_progress，状态联动更新为 completed（写入点
//      唯一在 handleTaskComplete 事务内）。planning 态成衣不联动——
//      S3-FIX-A 语义下 planning = 快照落库但未扣库存、未开始制作，完工
//      联动会绕过扣减边界制造脏状态；completed 已完成则幂等跳过。
//      手工新增成衣默认 completed 的口径见 garmentService（V-C 成衣Q3）。
//   3. 任务不写任何库存流水（DM §3.3 硬约束 6）——「这个任务用掉多少料」
//      由成衣用料清单承担；开始制作的扣库存在 garmentService.
//      startGarmentProduction（S3 预留接入点的落地，见其处注释）。
//   4. 【W-C 新增任务2 口径修订，2026-09-29】删除任务时关联成衣的处置：
//      in_progress / completed 成衣保留（DM §5.5 九原口径不变，不动库存
//      零流水）；planning 成衣随任务一并级联删除（用户倾向口径 + 工程现状
//      复用 deleteGarmentWithRestore——planning 快照行 deducted=false，
//      删除零回补零流水）。级联守卫：仍有其他任务绑定同一成衣时保留不删
//      （详见 deleteTask 处注释与 wc-notes 口径变更记录）。
//
// 三处口径裁定（与任务文 / 文档冲突处的取舍，均在《S4-A 实现说明》披露）：
//   A. 任务标题上限：任务文写「trim 后 1–30 字」，数据模型 §3.3 / §8.2 冻结
//      为「trim 后 1–50 字」（types.ts 同）。任务文同时指定数据模型为
//      「tasks/taskTemplates 表字段与上限」的权威文档，故按 1–50 实现并
//      抛「标题不能超过 50 字」。模板名 1–30 两者一致，无冲突。
//   B. completedAt 空值：status !== 'done' 时写 undefined（DM §3.3 硬约束 3
//      「必须缺失（undefined，不是 ''）」），不用空串。
//   C. 【W-C 新增任务2 落地，2026-09-29 用户验收口径】P7b 任务状态 →
//      成衣状态联动按新状态机实现：建任务（todo）→ 成衣 planning（TaskFormSheet
//      生成成衣入口写 'planning'）；任务开始（todo→in_progress）→ 关联
//      planning 成衣经 startGarmentProduction 联动为 in_progress 并在该时点
//      扣库存（S3-FIX-A 扣减边界不绕过）；任务完工 → in_progress 成衣联动
//      completed（V-C 工作台Q4 原口径）。幂等边界：任务开始时成衣已
//      in_progress / completed（成衣侧入口先行或手工新增场景）→ 跳过不降级
//      不阻塞；任务完工时成衣 planning → 不联动（V-C 决策保留，见 ②）。

import { nanoid } from 'nanoid';
import { db } from '@/db/schema';
import { recordLoss } from '@/services/materialService';
import {
  startGarmentProduction,
  deleteGarmentWithRestore,
} from '@/services/garmentService';
import { todayIsoDate } from '@/lib/date';
import type {
  IsoDateTime,
  NanoId12,
  Task,
  TaskPriority,
  TaskStatus,
  TaskStep,
  TaskTemplate,
  TaskTemplateStep,
} from '@/db/types';

// ============================ 导出入参类型 ============================

/** 步骤草稿：id 缺省时按 DM §3.3 硬约束 1 生成 nanoid(8)（手工步骤规则）。 */
export interface TaskStepDraft {
  /** 既有步骤的 id（编辑场景透传保留）；缺省生成 8 位 nanoid。 */
  id?: string;
  /** 步骤标题，trim 后 1–100 字。 */
  title: string;
  /** 是否完成。仅编辑替换场景生效；新建任务的步骤一律未勾选。 */
  done?: boolean;
  /** 完成时刻。done 为 true 时缺失则补当前时刻；done 为 false 时忽略。 */
  completedAt?: IsoDateTime;
}

/** 新建任务入参（status 恒 'todo'，completedAt 键缺失，均由服务层写死）。 */
export interface TaskCreateInput {
  /** 标题，trim 后 1–50 字（口径裁定 A）。 */
  title: string;
  /** 描述，≤ 500 字。 */
  description?: string;
  /** 优先级，缺省 'medium'。 */
  priority?: TaskPriority;
  /** 关联成衣 id，'' / 缺省 = 不关联；非空时成衣必须存在（强引用）。 */
  garmentId?: string;
  /** 来源模板 id（弱引用，不校验存在性，模板删除后保留原值）。 */
  templateId?: string;
  /** 关联纸样 id（V-C 工作台Q2）。'' / 缺省 = 不关联；弱引用不校验存在性。 */
  patternId?: string;
  /** 步骤草稿，≤ 30 条。 */
  steps?: TaskStepDraft[];
  /** 截止日期，'' / 缺省 = 未设置；非空时必须严格 YYYY-MM-DD。 */
  dueDate?: string;
  /** 标签，元素 1–20 字，去重。 */
  tags?: string[];
  /** 备注，≤ 500 字。 */
  notes?: string;
}

/** 编辑任务入参：只出现要改的字段。status / completedAt / id / createdAt
 * 不可通过编辑修改（完工走 handleTaskComplete，回退走 setTaskStatus）。 */
export interface TaskUpdateInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  /** 传 '' = 解绑；非空 = 绑定（成衣必须存在）。与 garmentName 同事务成对写。 */
  garmentId?: string;
  templateId?: string;
  /** 关联纸样 id（V-C 工作台Q2）。'' = 清除；弱引用不校验存在性。 */
  patternId?: string;
  /** 整体替换步骤清单，≤ 30 条；order 按新顺序整体重编号 1..n
   *  （DM §3.3 硬约束 2 允许的唯一 order 改动方式）。 */
  steps?: TaskStepDraft[];
  dueDate?: string;
  tags?: string[];
  notes?: string;
}

/** 模板步骤草稿：order 缺省时按数组顺序 1..n 编号。 */
export interface TaskTemplateStepDraft {
  /** 步骤标题，trim 后 1–100 字。 */
  title: string;
  /** 次序；缺省按数组位置 1..n。 */
  order?: number;
}

/** 新建自建模板入参（id / source / createdAt / updatedAt 由服务层写死）。 */
export interface TaskTemplateCreateInput {
  /** 模板名，trim 后 1–30 字。 */
  name: string;
  /** 说明，≤ 200 字。 */
  description?: string;
  /** 分类，≤ 20 字。 */
  category?: string;
  /** 步骤草稿，1–30 条（空数组非法）。 */
  steps: TaskTemplateStepDraft[];
  /** 标签，元素 1–20 字，去重。 */
  tags?: string[];
}

/** 编辑自建模板入参。source 不可改；内置模板一律拒绝（§6.7）。 */
export interface TaskTemplateUpdateInput {
  name?: string;
  description?: string;
  category?: string;
  steps?: TaskTemplateStepDraft[];
  tags?: string[];
}

// ============================ 模块内辅助 ============================

function nowIso(): string {
  return new Date().toISOString();
}

async function markDirty(): Promise<void> {
  await db.settings.put({
    key: 'dirty_since_backup',
    value: 'true',
    updatedAt: nowIso(),
  });
}

/** 服务层长度兜底（S2 P0-3 模式）：trim + 上限断言，返回 trim 后的值。 */
function assertTextField(
  value: string | undefined,
  label: string,
  max: number,
): string {
  const v = String(value ?? '').trim();
  if (v.length > max) throw new Error(`${label}不能超过 ${max} 字`);
  return v;
}

/** 任务标题（DM §3.3：trim 后 1–50 字，不得为纯空白；口径裁定 A）。 */
function assertTitle(value: string | undefined): string {
  const title = String(value ?? '').trim();
  if (!title) throw new Error('标题不能为空');
  if (title.length > 50) throw new Error('标题不能超过 50 字');
  return title;
}

/** 模板名（DM §3.4：trim 后 1–30 字）。 */
function assertTemplateName(value: string | undefined): string {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('名称不能为空');
  if (name.length > 30) throw new Error('名称不能超过 30 字');
  return name;
}

/** 标签数组：元素 ≤ 20 字，去重（DM §3.3 / §3.4）。 */
function cleanTags(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  for (const el of value) {
    if (String(el ?? '').trim().length > 20) {
      throw new Error('标签不能超过 20 字');
    }
  }
  return [...new Set(value)];
}

/** 截止日期：'' 或严格 YYYY-MM-DD（本地日期字符串，DM §3.3 硬约束 7）。 */
function assertDueDate(value: string | undefined): string {
  const v = String(value ?? '').trim();
  if (v === '') return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new Error('截止日期格式必须为 YYYY-MM-DD');
  }
  return v;
}

/** 优先级枚举（DM §4.5）。 */
function assertPriority(value: TaskPriority | undefined): TaskPriority {
  if (value !== 'high' && value !== 'medium' && value !== 'low') {
    throw new Error('优先级只能是 high / medium / low');
  }
  return value;
}

/** 步骤数上限（DM §3.3 硬约束 2 / §3.4 硬约束 2，文案逐字）。 */
const MAX_STEPS = 30;

function assertStepCount(count: number, min: number, label: string): void {
  if (count < min) throw new Error(`${label}不能为空`);
  if (count > MAX_STEPS) throw new Error('步骤不能超过 30 条');
}

/** 步骤草稿 → 规整后的 TaskStep[]：title trim 1–100 字；order 按数组顺序
 *  整体重编号 1..n；id 透传（同批内唯一，缺省 nanoid(8)）；done ⟺
 *  completedAt 同步（DM §3.3 硬约束 1 / 2）。allowDone=false 时全部强制
 *  未勾选（新建任务的步骤一律从零开始）。 */
function normalizeSteps(
  drafts: TaskStepDraft[] | undefined,
  allowDone: boolean,
): TaskStep[] {
  const list = Array.isArray(drafts) ? drafts : [];
  assertStepCount(list.length, 0, '步骤');
  const seenIds = new Set<string>();
  const now = nowIso();
  const out: TaskStep[] = [];
  list.forEach((draft, i) => {
    const title = String(draft?.title ?? '').trim();
    if (!title) throw new Error('步骤标题不能为空');
    if (title.length > 100) throw new Error('步骤标题不能超过 100 字');
    let id = String(draft?.id ?? '').trim();
    if (id === '') id = nanoid(8);
    if (seenIds.has(id)) throw new Error('步骤 id 不能重复');
    seenIds.add(id);
    const done = allowDone && draft?.done === true;
    out.push({
      id,
      title,
      done,
      order: i + 1,
      // done=false 时 completedAt 必须缺失（硬约束 2）；done=true 缺时刻则补 now。
      ...(done
        ? { completedAt: draft?.completedAt ?? now }
        : { completedAt: undefined }),
    });
  });
  return out;
}

/** 模板步骤草稿 → 规整后的 TaskTemplateStep[]：1–30 条（空数组非法）、
 *  title trim 1–100 字、order 按数组顺序 1..n。模板步骤无 id / done
 *  （DM §3.4 硬约束 1）。 */
function normalizeTemplateSteps(
  drafts: TaskTemplateStepDraft[] | undefined,
): TaskTemplateStep[] {
  const list = Array.isArray(drafts) ? drafts : [];
  assertStepCount(list.length, 1, '模板步骤');
  const out: TaskTemplateStep[] = [];
  list.forEach((draft, i) => {
    const title = String(draft?.title ?? '').trim();
    if (!title) throw new Error('步骤标题不能为空');
    if (title.length > 100) throw new Error('步骤标题不能超过 100 字');
    out.push({ title, order: i + 1 });
  });
  return out;
}

/** 解析 garmentId 入参 → {garmentId, garmentName} 快照对（DM §3.3 / §5.5
 *  P9：两者必须同时写）。'' = 未关联；非空时成衣必须存在（强引用），
 *  悬挂引用抛中文错误。 */
async function resolveBinding(
  garmentId: string | undefined,
): Promise<{ garmentId: string; garmentName: string }> {
  const gid = String(garmentId ?? '').trim();
  if (gid === '') return { garmentId: '', garmentName: '' };
  const g = await db.garments.get(gid);
  if (!g) throw new Error('关联的成衣不存在或已被删除');
  return { garmentId: gid, garmentName: g.name };
}

/** 编辑入参里的禁改字段（运行时兜底：TS 类型已排除，绕过类型直接传对象
 *  也拦住）。 */
const TASK_IMMUTABLE_FIELDS: Readonly<Record<string, string>> = {
  status: '任务状态不能通过编辑修改（完工请走完工操作）',
  completedAt: '完成时间不能通过编辑修改',
  id: '任务 id 不可修改',
  createdAt: '创建时间不可修改',
};

function assertNoImmutableFields(patch: object): void {
  for (const [key, message] of Object.entries(TASK_IMMUTABLE_FIELDS)) {
    if (
      key in patch &&
      (patch as Record<string, unknown>)[key] !== undefined
    ) {
      throw new Error(message);
    }
  }
}

// ============================ P9：任务 CRUD ============================

export async function createTask(input: TaskCreateInput): Promise<NanoId12> {
  // ---- 事务外校验（架构 §6.10 规则 1：先校验后进事务）----
  const title = assertTitle(input.title);
  const description = assertTextField(input.description, '描述', 500);
  const notes = assertTextField(input.notes, '备注', 500);
  const priority =
    input.priority === undefined ? 'medium' : assertPriority(input.priority);
  const dueDate = assertDueDate(input.dueDate);
  const tags = cleanTags(input.tags);
  const steps = normalizeSteps(input.steps, false); // 新建步骤一律未勾选
  const templateId = String(input.templateId ?? ''); // 弱引用，不校验
  const patternId = String(input.patternId ?? ''); // V-C 工作台Q2：弱引用，不校验
  const id = nanoid(12);
  const now = nowIso();

  // ---- 事务 [tasks, garments, settings]（DM §5.2 P9 / §6.6；
  //      garments 入清单：resolveBinding 强引用校验须与写任务同事务）----
  await db.transaction('rw', [db.tasks, db.garments, db.settings], async () => {
    const binding = await resolveBinding(input.garmentId);
    await db.tasks.add({
      id,
      title,
      description,
      status: 'todo', // 新建恒 todo；状态流转走专用入口
      priority,
      garmentId: binding.garmentId,
      garmentName: binding.garmentName,
      templateId,
      patternId,
      steps,
      dueDate,
      completedAt: undefined, // status !== 'done' ⟹ 键值缺失（口径裁定 B）
      tags,
      notes,
      createdAt: now,
      updatedAt: now,
    });
    await markDirty(); // P9 在打脏路径清单内（DM §5.6 六）
  });
  return id;
}

export async function updateTask(
  id: NanoId12,
  patch: TaskUpdateInput,
): Promise<void> {
  if (!id) throw new Error('任务 id 不能为空');
  assertNoImmutableFields(patch);

  // ---- 事务外校验（只断言 patch 里出现的字段）----
  const title = patch.title !== undefined ? assertTitle(patch.title) : undefined;
  const description =
    patch.description !== undefined
      ? assertTextField(patch.description, '描述', 500)
      : undefined;
  const notes =
    patch.notes !== undefined
      ? assertTextField(patch.notes, '备注', 500)
      : undefined;
  const priority =
    patch.priority !== undefined ? assertPriority(patch.priority) : undefined;
  const dueDate = patch.dueDate !== undefined ? assertDueDate(patch.dueDate) : undefined;
  const tags = patch.tags !== undefined ? cleanTags(patch.tags) : undefined;
  const steps = patch.steps !== undefined ? normalizeSteps(patch.steps, true) : undefined;
  const templateId =
    patch.templateId !== undefined ? String(patch.templateId) : undefined;
  const patternId =
    patch.patternId !== undefined ? String(patch.patternId) : undefined; // V-C 工作台Q2

  // ---- 事务 [tasks, garments, settings]（DM §5.2 P9 / §6.6；
  //      garments 入清单：绑定校验同事务）----
  await db.transaction('rw', [db.tasks, db.garments, db.settings], async () => {
    const t = await db.tasks.get(id);
    if (!t) throw new Error('任务不存在');
    const next: Task = { ...t, updatedAt: nowIso() };
    if (title !== undefined) next.title = title;
    if (description !== undefined) next.description = description;
    if (notes !== undefined) next.notes = notes;
    if (priority !== undefined) next.priority = priority;
    if (dueDate !== undefined) next.dueDate = dueDate;
    if (tags !== undefined) next.tags = tags;
    if (steps !== undefined) next.steps = steps;
    if (templateId !== undefined) next.templateId = templateId;
    if (patternId !== undefined) next.patternId = patternId; // V-C 工作台Q2
    if (patch.garmentId !== undefined) {
      // 绑定 / 解绑：garmentId 与 garmentName 必须同时写（DM §5.5 P9）。
      const binding = await resolveBinding(patch.garmentId);
      next.garmentId = binding.garmentId;
      next.garmentName = binding.garmentName;
    }
    await db.tasks.put(next);
    await markDirty();
  });
}

/** 删除任务：删本行 + 删该任务的图片行。关联成衣处置（W-C 新增任务2
 *  口径，2026-09-29）：
 *  - in_progress / completed 成衣：**保留**，不还原库存、不写流水（DM §5.5
 *    九原口径；想删去成衣库走 P3c）；
 *  - planning 成衣：**随任务一并级联删除**（planning = 快照落库但未扣库存，
 *    删除零回补零流水；复用 deleteGarmentWithRestore 单一实现，其内部
 *    deducted 过滤天然保证 planning 行零库存操作）。级联守卫：该成衣仍被
 *    其他任务绑定时**保留**（避免误删共享关联），只有本任务是最后一条
 *    绑定任务才删——守卫为工程裁定，记 wc-notes 口径变更记录。
 *  事务表扩容为 [tasks, images, garments, materials, usageLogs, settings]：
 *  级联删除 deleteGarmentWithRestore 的表集合是其子集，Dexie 嵌套事务
 *  复用外层，整组原子生效。 */
export async function deleteTask(id: NanoId12): Promise<void> {
  if (!id) throw new Error('任务 id 不能为空');
  await db.transaction(
    'rw',
    [db.tasks, db.images, db.garments, db.materials, db.usageLogs, db.settings],
    async () => {
      const t = await db.tasks.get(id);
      if (!t) throw new Error('任务不存在');
      const imgIds = (
        await db.images
          .where('[entityType+entityId]')
          .equals(['task', id])
          .toArray()
      ).map((r) => r.id);
      if (imgIds.length) await db.images.bulkDelete(imgIds);
      await db.tasks.delete(id);

      // W-C：planning 成衣随任务级联删除（守卫：无其他任务绑定才删）。
      if (t.garmentId) {
        const g = await db.garments.get(t.garmentId);
        if (g && g.status === 'planning') {
          const otherBound = await db.tasks
            .where('garmentId')
            .equals(t.garmentId)
            .count(); // 本任务行已删，>0 即仍有其他任务绑定
          if (otherBound === 0) {
            await deleteGarmentWithRestore({ id: g.id });
          }
        }
      }

      await markDirty();
    },
  );
}

// ============================ P9：状态变更（完工单函数） ============================

/** 完工唯一入口（架构 §13.4 S4 DoD：完工逻辑只允许这一处实现）。
 *  事务 [tasks, garments, settings] 内写：
 *  ① 任务行：status='done' + completedAt=当前时刻 + updatedAt；
 *  ② 【V-C 工作台Q4 新口径】关联成衣联动：task.garmentId 非空且成衣存在
 *     且 status='in_progress' 时，写成衣 status='completed' +
 *     completionDate=当天（YYYY-MM-DD，对齐 markGarmentCompleted 日期口径）
 *     + updatedAt。只写这三字段——totalCost 仍归 P11 完工登记维护；
 *     planning 态成衣不动（S3-FIX-A：未扣库存未开始制作，联动会绕过
 *     扣减边界）；completed 幂等跳过。任务与成衣同一事务，原子生效。
 *  ③ 不写任何库存流水（DM §3.3 硬约束 6）。已完成的任务重复调用为幂等
 *  no-op，不写库、不重复打脏。 */
export async function handleTaskComplete(taskId: string): Promise<void> {
  if (!taskId) throw new Error('任务 id 不能为空');
  await db.transaction('rw', [db.tasks, db.garments, db.settings], async () => {
    const t = await db.tasks.get(taskId);
    if (!t) throw new Error('任务不存在');
    if (t.status === 'done') return; // 幂等 no-op（对齐 P11 的重复提交语义）
    const now = nowIso();
    await db.tasks.put({ ...t, status: 'done', completedAt: now, updatedAt: now });

    // ② V-C 工作台Q4：任务完工 → 关联成衣状态联动（in_progress → completed）。
    if (t.garmentId) {
      const g = await db.garments.get(t.garmentId);
      if (g && g.status === 'in_progress') {
        await db.garments.put({
          ...g,
          status: 'completed',
          completionDate: todayIsoDate(),
          updatedAt: nowIso(),
        });
      }
      // planning 不联动（见函数注释）；completed 已完成，幂等跳过。
    }

    await markDirty();
  });
}

/** 任务状态流转入口。'done' 一律转发 handleTaskComplete（完工单函数约束，
 *  本函数自身不含任何完工写入）；'todo' / 'in_progress' 直写 status 并清
 *  completedAt（DM §5.5 八：done 可以退回，退回时 completedAt 必须缺失，
 *  不是 ''）。同值写入为幂等 no-op。
 *
 *  W-C 新增任务2（2026-09-29 用户验收口径）：任务转入 in_progress 时，
 *  关联成衣若仍 planning → 事务内调用 garmentService.startGarmentProduction
 *  （唯一跨扣减边界的成衣状态入口）联动为 in_progress 并扣库存；成衣已
 *  in_progress / completed（成衣侧入口先行 / 手工新增场景）→ 幂等跳过，
 *  不降级、不阻塞任务开始。任务回退（→ todo）不回退成衣状态（无此口径）。
 *  startGarmentProduction 抛错（如库存不足）时整个事务回滚——任务停留
 *  原状态、成衣停留 planning、零流水（原子性）。事务表扩容为
 *  [tasks, garments, materials, usageLogs, settings]：嵌套的
 *  startGarmentProduction 表集合是其子集，Dexie 复用外层事务。 */
export async function setTaskStatus(
  taskId: string,
  status: TaskStatus,
): Promise<void> {
  if (status === 'done') {
    await handleTaskComplete(taskId); // 唯一完工实现
    return;
  }
  if (status !== 'todo' && status !== 'in_progress') {
    throw new Error('任务状态只能是 todo / in_progress / done');
  }
  if (!taskId) throw new Error('任务 id 不能为空');
  await db.transaction(
    'rw',
    [db.tasks, db.garments, db.materials, db.usageLogs, db.settings],
    async () => {
      const t = await db.tasks.get(taskId);
      if (!t) throw new Error('任务不存在');
      if (t.status === status) return; // 幂等 no-op
      await db.tasks.put({
        ...t,
        status,
        completedAt: undefined, // 离开 done 删 completedAt（口径裁定 B）
        updatedAt: nowIso(),
      });
      // W-C：任务开始 → 关联 planning 成衣联动开始制作（扣库存时点迁移至此）。
      if (status === 'in_progress' && t.garmentId) {
        const g = await db.garments.get(t.garmentId);
        if (g && g.status === 'planning') {
          await startGarmentProduction({ id: g.id });
        }
        // in_progress / completed：跳过（幂等不降级不阻塞）。
      }
      await markDirty();
    },
  );
}

/** 勾选 / 取消勾选某一步（PRD §8.10 四条副作用的服务侧落点）。
 *  步骤 done ⟺ completedAt 同步（DM §3.3 硬约束 2）；状态派生规则：
 *  全部勾完 → 完工（事务内调用 handleTaskComplete 本体，不另写第二份
 *  完工逻辑）；有任一步勾上且原状态 todo → in_progress（W-C 新增任务2：
 *  该派生同样触发关联 planning 成衣的 startGarmentProduction 联动，与
 *  setTaskStatus 口径一致）；取消勾选不自动回退状态（回退走
 *  setTaskStatus 显式入口，PRD §8.10 只定义正向派生）。
 *  事务表扩容为 [tasks, garments, materials, usageLogs, settings]：
 *  嵌套的 handleTaskComplete / startGarmentProduction 表集合均是其子集。 */
export async function toggleTaskStep(
  taskId: string,
  stepId: string,
  done: boolean,
): Promise<void> {
  if (!taskId) throw new Error('任务 id 不能为空');
  if (!stepId) throw new Error('步骤 id 不能为空');
  await db.transaction(
    'rw',
    [db.tasks, db.garments, db.materials, db.usageLogs, db.settings],
    async () => {
    const t = await db.tasks.get(taskId);
    if (!t) throw new Error('任务不存在');
    const hit = t.steps.find((s) => s.id === stepId);
    if (!hit) throw new Error('步骤不存在');
    const now = nowIso();
    const steps: TaskStep[] = t.steps.map((s) =>
      s.id === stepId
        ? {
            ...s,
            done,
            completedAt: done ? (s.completedAt ?? now) : undefined,
          }
        : s,
    );
    // 先写步骤（steps + updatedAt）。
    await db.tasks.put({ ...t, steps, updatedAt: now });

    // 状态派生（正向两条；写入均复用统一入口）：
    if (done && steps.length > 0 && steps.every((s) => s.done)) {
      // 全勾 → 完工。嵌套调用 handleTaskComplete（Dexie 同表子集事务复用
      // 本事务，不会新开）；它是完工的唯一实现。
      await handleTaskComplete(taskId);
    } else if (done && t.status === 'todo' && steps.some((s) => s.done)) {
      // 有勾且原 todo → in_progress（清 completedAt）。
      await db.tasks.put({
        ...t,
        steps,
        status: 'in_progress',
        completedAt: undefined,
        updatedAt: now,
      });
      // W-C：派生开始 → 关联 planning 成衣联动开始制作（与 setTaskStatus
      // 同口径；in_progress / completed 幂等跳过不降级）。
      if (t.garmentId) {
        const g = await db.garments.get(t.garmentId);
        if (g && g.status === 'planning') {
          await startGarmentProduction({ id: g.id });
        }
      }
    }
    await markDirty();
  });
}

// ============================ P9：任务 ↔ 成衣引用绑定 ============================

/** 绑定成衣：同事务写 garmentId + garmentName 快照（DM §5.5 P9：两者必须
 *  同时写）。成衣不存在抛中文错误（强引用）。 */
export async function bindGarmentToTask(
  taskId: string,
  garmentId: string,
): Promise<void> {
  if (!taskId) throw new Error('任务 id 不能为空');
  if (!garmentId) throw new Error('成衣 id 不能为空');
  // ---- 事务 [tasks, garments, settings]（garments 入清单：绑定校验同事务）----
  await db.transaction('rw', [db.tasks, db.garments, db.settings], async () => {
    const t = await db.tasks.get(taskId);
    if (!t) throw new Error('任务不存在');
    const binding = await resolveBinding(garmentId);
    await db.tasks.put({
      ...t,
      garmentId: binding.garmentId,
      garmentName: binding.garmentName,
      updatedAt: nowIso(),
    });
    await markDirty();
  });
}

/** 解绑成衣：garmentId 与 garmentName 一起置 ''（DM §5.5 十同款成对语义）。
 *  已解绑时幂等 no-op。删除成衣引发的批量解绑在 deleteGarmentWithRestore
 *  ③（S3 已实现），此处只服务任务表单的显式解绑。 */
export async function unbindGarmentFromTask(taskId: string): Promise<void> {
  if (!taskId) throw new Error('任务 id 不能为空');
  await db.transaction('rw', [db.tasks, db.settings], async () => {
    const t = await db.tasks.get(taskId);
    if (!t) throw new Error('任务不存在');
    if (t.garmentId === '') return; // 幂等 no-op
    await db.tasks.put({
      ...t,
      garmentId: '',
      garmentName: '',
      updatedAt: nowIso(),
    });
    await markDirty();
  });
}

// ============================ P10：任务模板管理 ============================

/** 套用模板（纯函数，不写库；DM §6.7）：把模板 steps 复制成任务自己的
 *  步骤，id 嵌 taskId（DM §3.3 硬约束 1 的模板生成规则
 *  `${taskId}_s${order}`），done 恒 false，order 取模板次序。 */
export function applyTemplate(
  template: Pick<TaskTemplate, 'steps'>,
  taskId: string,
): TaskStep[] {
  return [...template.steps]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({
      id: `${taskId}_s${s.order}`,
      title: s.title,
      done: false,
      order: s.order,
    }));
}

/** 用模板新建任务（DM §3.4 生命周期「套用」行）：读模板 steps 在新任务里
 *  生成带 id 的步骤，templateId 记模板 id；模板行零写入。标题缺省取模板名。
 *  内置 / 自建模板都可套用。 */
export async function createTaskFromTemplate(
  templateId: string,
  extra?: TaskCreateInput,
): Promise<NanoId12> {
  if (!templateId) throw new Error('模板 id 不能为空');
  // ---- 事务外校验 extra 的纯文本字段 ----
  const description = assertTextField(extra?.description, '描述', 500);
  const notes = assertTextField(extra?.notes, '备注', 500);
  const priority =
    extra?.priority === undefined ? 'medium' : assertPriority(extra.priority);
  const dueDate = assertDueDate(extra?.dueDate);
  const tags = cleanTags(extra?.tags);

  // ---- 事务 [tasks, taskTemplates, garments, settings]（套用是 P10 的
  //      读侧 + P9 的写侧；模板读与绑定校验同事务）----
  return await db.transaction(
    'rw',
    [db.tasks, db.taskTemplates, db.garments, db.settings],
    async () => {
      const tpl = await db.taskTemplates.get(templateId);
      if (!tpl) throw new Error('模板不存在');
      const title = assertTitle(extra?.title ?? tpl.name);
      const id = nanoid(12);
      const now = nowIso();
      const binding = await resolveBinding(extra?.garmentId);
      await db.tasks.add({
        id,
        title,
        description,
        status: 'todo',
        priority,
        garmentId: binding.garmentId,
        garmentName: binding.garmentName,
        templateId,
        patternId: String(extra?.patternId ?? ''), // V-C 工作台Q2：弱引用透传
        steps: applyTemplate(tpl, id),
        dueDate,
        completedAt: undefined,
        tags,
        notes,
        createdAt: now,
        updatedAt: now,
      });
      await markDirty(); // 任务创建在 P9 打脏清单内
      return id;
    },
  );
}

/** 新建自建模板（source 恒 'custom'）。事务表在 DM §6.7 伪代码的
 *  [taskTemplates] 基础上加宽为 [taskTemplates, settings]：P10 在打脏
 *  路径清单内（DM §5.6 六），markDirty 需写 settings（§6.6 尾注：
 *  §5 语义优先于本章事务边界）。 */
export async function createTaskTemplate(
  input: TaskTemplateCreateInput,
): Promise<string> {
  const name = assertTemplateName(input.name);
  const description = assertTextField(input.description, '描述', 200);
  const category = assertTextField(input.category, '分类', 20);
  const tags = cleanTags(input.tags);
  const steps = normalizeTemplateSteps(input.steps);
  const id = nanoid(12);
  const now = nowIso();
  await db.transaction('rw', [db.taskTemplates, db.settings], async () => {
    await db.taskTemplates.add({
      id,
      name,
      description,
      category,
      steps,
      tags,
      source: 'custom',
      createdAt: now,
      updatedAt: now,
    });
    await markDirty();
  });
  return id;
}

/** 编辑模板。内置模板（source='preset'）一律拒绝（任务文要求 + DM §6.7
 *  伪代码 `if (old?.source === 'preset') throw new Error('内置模板不可修改')`；
 *  注：DM §3.4 硬约束 3 另有「允许编辑内置模板」的旧表述，与 §4.14
 *  「preset 完全只读」及本任务要求冲突，按只读实现，已在实现说明披露）。
 *  source 字段本身不可改。已套用该模板的任务不受影响（任务是独立副本）。 */
export async function updateTaskTemplate(
  id: string,
  patch: TaskTemplateUpdateInput,
): Promise<void> {
  if (!id) throw new Error('模板 id 不能为空');
  if ('source' in patch && (patch as Record<string, unknown>).source !== undefined) {
    throw new Error('模板来源不可修改');
  }
  // ---- 事务外校验（只断言 patch 里出现的字段）----
  const name = patch.name !== undefined ? assertTemplateName(patch.name) : undefined;
  const description =
    patch.description !== undefined
      ? assertTextField(patch.description, '描述', 200)
      : undefined;
  const category =
    patch.category !== undefined
      ? assertTextField(patch.category, '分类', 20)
      : undefined;
  const tags = patch.tags !== undefined ? cleanTags(patch.tags) : undefined;
  const steps =
    patch.steps !== undefined ? normalizeTemplateSteps(patch.steps) : undefined;

  await db.transaction('rw', [db.taskTemplates, db.settings], async () => {
    const old = await db.taskTemplates.get(id);
    if (!old) throw new Error('模板不存在');
    if (old.source === 'preset') throw new Error('内置模板不可修改');
    const next: TaskTemplate = { ...old, updatedAt: nowIso() };
    if (name !== undefined) next.name = name;
    if (description !== undefined) next.description = description;
    if (category !== undefined) next.category = category;
    if (tags !== undefined) next.tags = tags;
    if (steps !== undefined) next.steps = steps;
    await db.taskTemplates.put(next);
    await markDirty();
  });
}

/** 删除自建模板。内置模板拒绝删除（任务文要求；DM §6.7「同理」）。
 *  **删模板不检查引用**——已套用该模板的任务是独立副本，其 templateId
 *  悬挂但保留（DM §2.3 规则 3 / §3.4 生命周期）。 */
export async function deleteTaskTemplate(id: string): Promise<void> {
  if (!id) throw new Error('模板 id 不能为空');
  await db.transaction('rw', [db.taskTemplates, db.settings], async () => {
    const old = await db.taskTemplates.get(id);
    if (!old) throw new Error('模板不存在');
    if (old.source === 'preset') throw new Error('内置模板不可删除');
    await db.taskTemplates.delete(id);
    await markDirty();
  });
}

/** 复制为自建：从内置模板生成一份可编辑的 custom 副本（steps / tags /
 *  category / description 全量拷贝，order 保留；name 缺省 `${原名} 副本`，
 *  可用 overrides.name 覆盖并照常校验 1–30 字）。只能复制内置模板。 */
export async function copyPresetTemplateAsCustom(
  presetId: string,
  overrides?: { name?: string },
): Promise<string> {
  if (!presetId) throw new Error('模板 id 不能为空');
  const id = nanoid(12);
  const now = nowIso();
  await db.transaction('rw', [db.taskTemplates, db.settings], async () => {
    const orig = await db.taskTemplates.get(presetId);
    if (!orig) throw new Error('模板不存在');
    if (orig.source !== 'preset') throw new Error('只能复制内置模板');
    const name = assertTemplateName(
      overrides?.name !== undefined && String(overrides.name).trim() !== ''
        ? overrides.name
        : `${orig.name} 副本`,
    );
    await db.taskTemplates.add({
      id,
      name,
      description: orig.description,
      category: orig.category,
      steps: orig.steps.map((s) => ({ title: s.title, order: s.order })),
      tags: [...orig.tags],
      source: 'custom',
      createdAt: now,
      updatedAt: now,
    });
    await markDirty();
  });
  return id;
}

// ============================ P4：手工损耗（工作台入口） ============================

/** 手工损耗记录：kind='consume'、source='manual'、**不写 garmentId**（恒
 *  ''），走 applyStockDelta、库存与流水同事务。实现上直接委托 S2 已落地
 *  的 P4 唯一实现 materialService.recordLoss（同参数口径：数量必须 > 0、
 *  note trim 后留空回落「手动损耗」、超 100 字由 applyStockDelta 截断、
 *  库存不足抛中文错误）——避免同口径出现第二份实现（与「完工单函数」
 *  同源的入口收敛原则）。 */
export async function recordManualConsume(args: {
  materialId: NanoId12;
  quantity: number;
  note?: string;
}): Promise<void> {
  return recordLoss(args.materialId, args.quantity, String(args.note ?? ''));
}
