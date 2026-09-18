/**
 * db.js · Dexie 数据层（含 schema / 类型 / 种子 / 自检）
 * 缝纫空间 M1.1 工程骨架
 *
 * 编码基线：数据模型冻结文档 v0.6 §1（X3ObdImqToGm6Mxb88JcqgawnLe）+ PRD v6.0 §4.1
 *
 * 8 张表（v0.6 §1 + PRD §4.1 完全对齐）：
 *   1. materials        同表异构（fabric/accessory/tool/pattern）
 *   2. garments         成衣记录
 *   3. tasks            任务（与 taskTemplates 模板解耦，存步骤快照）
 *   4. taskTemplates    任务模板（首启种子 3 个）
 *   5. images           图片 Blob 直存（IndexedDB 原生 Blob，不走 base64）
 *   6. settings         键值配置（17 个已知 key）
 *   7. usageLogs        库存流水（kind 4 值 + source 5 形态）
 *   8. backupLogs       备份日志
 *
 * 迁移机制：db.version(N).upgrade(tx => { ... }) 链式调用；
 *           后续 v2+ 升级时在此处追加 .version(N).stores({...}).upgrade(...)。
 *           Dexie 自动按版本号升序执行迁移。
 */

(function (global) {
  'use strict';

  const { nanoid, nowIso, log } = global.SS.utils;

  /* ============ 1. 实体类型（JSDoc 注释即文档，零运行时开销） ============ */

  /**
   * @typedef {Object} Material
   * @property {string} id             nanoid(12)
   * @property {'fabric'|'accessory'|'tool'|'pattern'} type 必填；索引
   * @property {string} name           必填，≤50 字
   * @property {string} [category]     二级分类
   * @property {number} quantity       ★当前剩余量（非负）
   * @property {number} [initialQuantity] 购入量（D21 · 采购花费统计用）
   * @property {string} unit           米/个/条/卷/张…
   * @property {string} [purchaseDate] ISO date
   * @property {number} [purchasePrice] 单价元（D9 · 采购花费唯一数据源）
   * @property {string} [color]
   * @property {number} [width]       幅宽 cm（fabric 专用；D-WH8）
   * @property {number} [weight]      克重 g/m²（fabric 专用）
   * @property {string} [composition] fabric 专用
   * @property {string} [sampleCard]  fabric 专用
   * @property {'spring'|'summer'|'autumn'|'winter'|'all_season'} [season]
   * @property {string[]} suitableFor 适合款式（fabric/pattern）
   * @property {('women'|'men'|'children'|'baby'|'pet')[]} [forWhom]  v0.5 string[]
   * @property {string[]} tags
   * @property {string} [notes]
   * @property {string} [brand]       v0.6 fabric + pattern 共享
   * @property {string} [size]        pattern 专用（尺码）
   * @property {1|2|3|4|5} [rating]   pattern 五星评分
   * @property {string} [ratingReview] 短评
   * @property {0|1} [used]           pattern 使用状态
   * @property {number} [lowStockThreshold] P2 预留
   * @property {string[]} images      imageId 引用
   * @property {string} createdAt
   * @property {string} updatedAt
   * @property {string} [sourceRef]   迁移旧 _id
   */

  /**
   * @typedef {Object} MaterialSnapshotItem
   * @property {string} materialId
   * @property {string} name          快照
   * @property {string} unit          快照
   * @property {number} priceSnapshot 单价快照（不可变）
   * @property {number} quantityUsed
   * @property {number} subtotal
   * @property {boolean} deducted     v0.4 起三入口保存即 true
   */

  /**
   * @typedef {Object} Garment
   * @property {string} id
   * @property {string} name
   * @property {string} [category]
   * @property {string} [size]
   * @property {string} [recipient]
   * @property {'planning'|'in_progress'|'completed'|'on_hold'} status
   * @property {string[]} materialIds
   * @property {string} [patternId]
   * @property {MaterialSnapshotItem[]} [materialSnapshot]
   * @property {number} [totalCost]
   * @property {string[]} images
   * @property {string} [completionDate]
   * @property {string} [startDate]    表单不再录入
   * @property {string} [plannedDate]  表单不再录入
   * @property {('women'|'men'|'children'|'baby'|'pet')[]} [forWhom]
   * @property {string[]} tags
   * @property {string} [notes]
   * @property {string} createdAt
   * @property {string} updatedAt
   * @property {string} [sourceRef]
   * @property {{imported:boolean, importedAt:string, legacyId:string}} [migration]
   */

  /**
   * @typedef {Object} TaskStep
   * @property {string} id
   * @property {string} title
   * @property {boolean} done
   * @property {number} order
   * @property {string} [completedAt]
   */

  /**
   * @typedef {Object} Task
   * @property {string} id
   * @property {string} title
   * @property {string} [description]
   * @property {string} [garmentId]
   * @property {'todo'|'in_progress'|'done'|'cancelled'} status
   * @property {'low'|'medium'|'high'} priority
   * @property {string} [dueDate]
   * @property {string} [completedAt]
   * @property {string} [templateId]
   * @property {TaskStep[]} steps
   * @property {string[]} tags
   * @property {string} [notes]
   * @property {string} createdAt
   * @property {string} updatedAt
   */

  /**
   * @typedef {Object} TaskTemplate
   * @property {string} id
   * @property {string} name
   * @property {string} [description]
   * @property {{title:string, order:number}[]} steps
   * @property {string[]} tags
   * @property {string} createdAt
   * @property {string} updatedAt
   */

  /**
   * @typedef {Object} ImageRecord
   * @property {string} id             nanoid(12)；GitHub 备份文件名
   * @property {Blob} blob             压缩后 JPEG
   * @property {string} originalName
   * @property {string} mimeType
   * @property {'material'|'garment'|'task'} entityType
   * @property {string} entityId       孤儿图片 entityId=''
   * @property {string} [syncedAt]
   * @property {string} createdAt
   */

  /**
   * @typedef {Object} Setting
   * @property {string} key
   * @property {string} value
   * @property {string} updatedAt
   */

  /**
   * @typedef {Object} UsageLog
   * @property {string} id
   * @property {string} materialId
   * @property {string} materialName    快照
   * @property {number} quantity        变动量正数
   * @property {'consume'|'revert'|'adjust'|'delete-garment'} kind
   * @property {'manual'|`garment:${string}`|`garment:${string}:delete`|`manual:loss`|`legacy:${string}`} source
   * @property {string|null} [garmentId]  v0.6 可选
   * @property {string} [note]          ≤100 字
   * @property {string} createdAt
   */

  /**
   * @typedef {Object} BackupLog
   * @property {string} id
   * @property {string} createdAt
   * @property {'success'|'failed'|'partial'} status
   * @property {string} [commitSha]
   * @property {string} [errorMessage]
   * @property {number} dataSize
   * @property {number} imageCount
   * @property {'github'|'local_export'|'local_import'|'restore'|'migration'} type
   */

  /* ============ 2. 数据库实例 ============ */

  /**
   * SewingSpaceDB — Dexie 数据库封装
   * version(1) 是当前冻结基线（v0.6 数据模型）；
   * 后续 schema 变更需新增 .version(2).stores({...}).upgrade(...) 链式调用。
   */
  class SewingSpaceDB extends Dexie {
    constructor() {
      super('SewingSpaceDB');
      // PRD v6.0 §4.1 + 数据模型 v0.6 §1 对齐的索引
      // * 前缀 = multiEntry（数组字段索引）
      this.version(1).stores({
        // materials: id, type, name, season, createdAt, updatedAt, *tags, *suitableFor, brand, used
        materials: 'id, type, name, season, createdAt, updatedAt, *tags, *suitableFor, brand, used',
        garments: 'id, name, status, createdAt, updatedAt, completionDate, patternId, *materialIds, *tags',
        tasks: 'id, title, status, garmentId, dueDate, createdAt, updatedAt, templateId',
        taskTemplates: 'id, name, createdAt, updatedAt',
        images: 'id, createdAt',
        settings: 'key',
        usageLogs: 'id, materialId, createdAt',
        backupLogs: 'id, createdAt, status',
      });
      // 后续 v2+ 升级示例（占位，便于后续 schema 演进）：
      // this.version(2).stores({ ... }).upgrade(async (tx) => { ... });
    }
  }

  const db = new SewingSpaceDB();

  /* ============ 3. 预设常量（v0.6 数据模型口径） ============ */

  // PRD §19.4 + 数据模型 v0.6 §1.7 — 17 个 settings key（含 presets / search_history）
  const SETTINGS_KEYS = [
    'github_token',          // 备份导出时排除
    'github_username',
    'github_repo',
    'pat_expires_at',
    'backup_interval',       // 'daily'|' 'manual'
    'backup_last_success',
    'backup_reminder_last',
    'dirty_since_backup',
    'onboarding_completed',
    'user_name',
    'import_completed',
    'device_id',             // 首启动作：原子读-写-回填（v6.0 T-N3）
    'last_sync_at',
    'last_sync_remote',
    'dirty_since_sync',
    'presets',               // PresetsBlob JSON
    'search_history',        // ≤10 条 JSON 数组
  ];

  // 数据模型 v0.6 §1.7 presets JSON 结构
  // 5 项用户 2026-09-14 明确不迁移（代码硬编码）：patternStyles/patternAudiences/patternSizes/accessoryWidths/fabricWidths
  const DEFAULT_PRESETS = Object.freeze({
    patternBrands: ['裁缝学苑', '莎莎', '棠', '卫兰', '川淇', '素衣彼时', '小红叶', '粒粒', '造梦', '熙和', '其他'],
    fabricBrands: ['周周的布', '羽禾', '坚强的逗比', '初织', '孜家', '懒懒的布', '春之花', '云锦布艺', '其他'],
    accessoryTags: ['松紧', '花边', '线', '扣子', '衬', '烫画', '织带', '包边条', '螺纹', '拉链', '填充'],
    patternStyles: ['连衣裙', '半身裙', '衬衫', '外套', 'T恤', '长裤', '打底衣', '卫衣', '马甲', '背心', '短裤', '口水巾'],
    patternAudiences: ['女士', '男士', '儿童', '婴儿', '宠物'],
    patternSizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '80', '90', '100', '110', '120', '130', '140', '150', '160', '165', '170', '175'],
    accessoryWidths: ['1cm', '2cm', '5cm'],
    fabricWidths: ['1.3米', '1.45米', '1.5米', '1.75米'],
  });

  // PRD §10.10 + 数据模型 v0.6 §1.5 — 首启 3 个任务模板（§1.5 逐字一致：半身裙、上衣基础、连衣裙）
  const SEED_TASK_TEMPLATES = Object.freeze([
    {
      id: 'tmpl-skirt-std',
      name: '半身裙',
      description: '半身裙裁缝基本步骤',
      steps: [
        { title: '量体 & 选纸样', order: 1 },
        { title: '采购布料辅料', order: 2 },
        { title: '裁剪裙片', order: 3 },
        { title: '缝合侧缝', order: 4 },
        { title: '装拉链 & 腰头', order: 5 },
        { title: '锁边 & 整烫', order: 6 },
        { title: '完工登记', order: 7 },
      ],
      tags: ['半身裙'],
    },
    {
      id: 'tmpl-top-std',
      name: '上衣基础',
      description: '基础款上装缝制',
      steps: [
        { title: '量体 & 选纸样', order: 1 },
        { title: '采购布料辅料', order: 2 },
        { title: '裁剪前/后片', order: 3 },
        { title: '缝合肩缝 & 侧缝', order: 4 },
        { title: '做领子 & 装袖子', order: 5 },
        { title: '锁扣眼 & 钉扣', order: 6 },
        { title: '整烫 & 完工', order: 7 },
      ],
      tags: ['上衣'],
    },
    {
      id: 'tmpl-dress-std',
      name: '连衣裙',
      description: '从裁剪到完工的完整步骤',
      steps: [
        { title: '量体 & 选纸样', order: 1 },
        { title: '采购布料辅料', order: 2 },
        { title: '裁剪布料', order: 3 },
        { title: '缝合主体', order: 4 },
        { title: '装袖子/领子', order: 5 },
        { title: '锁边 & 熨烫', order: 6 },
        { title: '完工登记', order: 7 },
      ],
      tags: ['连衣裙'],
    },
  ]);

  /* ============ 4. 首启种子 ============ */

  /**
   * 首启种子：
   *   - device_id 原子读-写-回填（v6.0 T-N3）
   *   - 3 个任务模板（v6.0 P0 §10.10）
   *   - presets 完整对象
   *   - onboarding_completed 初始 false
   *   - backup_interval 默认 daily
   *   - user_name 默认 "缝纫人"
   *   - dirty_since_backup/sync 初始 false
   */
  async function seedIfFirstRun() {
    return db.transaction(
      'rw',
      [db.settings, db.taskTemplates],
      async () => {
        const existingDevice = await db.settings.get('device_id');
        if (!existingDevice) {
          await db.settings.put({
            key: 'device_id',
            value: nanoid(10),
            updatedAt: nowIso(),
          });
        }
        const tmplCount = await db.taskTemplates.count();
        if (tmplCount === 0) {
          const ts = nowIso();
          await db.taskTemplates.bulkAdd(
            SEED_TASK_TEMPLATES.map((t) => ({ ...t, createdAt: ts, updatedAt: ts }))
          );
        }
        const presetsRow = await db.settings.get('presets');
        if (!presetsRow) {
          await db.settings.put({
            key: 'presets',
            value: JSON.stringify(DEFAULT_PRESETS),
            updatedAt: nowIso(),
          });
        }
        const ensure = async (key, value) => {
          if (!(await db.settings.get(key))) {
            await db.settings.put({ key, value: String(value), updatedAt: nowIso() });
          }
        };
        await ensure('onboarding_completed', 'false');
        await ensure('backup_interval', 'daily');
        await ensure('user_name', '缝纫人');
        await ensure('dirty_since_backup', 'false');
        await ensure('dirty_since_sync', 'false');
        await ensure('backup_reminder_last', '');
        await ensure('backup_last_success', '');
        await ensure('github_repo', 'sewing-space-backup');
        await ensure('search_history', '[]');
        // M1.5 上半新增：设置页扩展键
        await ensure('sewing_years', '0');
        await ensure('github_token', '');
        await ensure('github_username', '');
        await ensure('pat_expires_at', '');
        await ensure('last_sync_at', '');
        await ensure('last_sync_status', '');
      }
    );
  }

  /* ============ 4.5 M1.2 物料侧能力方法 ============ */
  /**
   * 物料侧能力（M1.2 实现，M1.3 成衣关联时实际调用）：
   *
   *   - recordLoss(materialId, quantity, note)
   *       物料详情「记录损耗」入口：扣减 quantity + 写 kind=consume, source='manual:loss'
   *       garmentId=null（不经成衣），quantity 计入 Σconsume。
   *
   *   - adjustMaterialQuantity(materialId, newQuantity, note)
   *       编辑表单直改 quantity 时的差额调整：写 kind=adjust
   *       差额 = newQuantity - currentQuantity；正数补库存、负数扣库存
   *
   *   - consumeOnAssociate(materialId, quantity, garmentId)
   *       M1.3 成衣关联物料时调用：扣减 quantity + 写 kind=consume, source='garment:{id}'
   *       M1.2 仅落接口定义与数据层方法（不会被调用），M1.3 接入。
   *
   *   - revertOnUnassociate(materialId, quantity, garmentId)
   *       M1.3 成衣取消关联物料时调用：还原 quantity + 写 kind=revert, source='garment:{id}'
   *
   *   - revertOnDeleteGarment(materialId, quantity, garmentId)
   *       M1.3 删除成衣时按净扣减量回补：还原 quantity + 写 kind=delete-garment,
   *       source='garment:{id}:delete'
   *
   * 所有方法均封装在 db.transaction 内：写日志 + 改库存要么都成功，要么都失败。
   */

  /**
   * 记录物料损耗
   * v1.1.1 P1-M2-3 修复：超库存必须拦截（冻结文档 §1.10 / §3.5 口径），
   *   不再使用 Math.max(0, …) 封顶扣减；流水与实际扣减严格一致。
   * @param {string} materialId
   * @param {number} quantity  正数（扣减量，> 0）
   * @param {string} [note]
   * @returns {Promise<{id:string, newQuantity:number}>}
   */
  async function recordLoss(materialId, quantity, note) {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('记录损耗数量必须为正数');
    }
    return db.transaction('rw', [db.materials, db.usageLogs], async () => {
      const m = await db.materials.get(materialId);
      if (!m) throw new Error('物料不存在：' + materialId);
      const name = m.name;
      const curQty = m.quantity || 0;
      if (quantity > curQty) {
        throw new Error(
          '库存不足：' + name + ' 当前 ' + curQty + ' ' + (m.unit || '') +
          '，请求扣减 ' + quantity + ' ' + (m.unit || '')
        );
      }
      const newQty = curQty - quantity;
      await db.materials.update(materialId, { quantity: newQty, updatedAt: nowIso() });
      const logId = nanoid(12);
      await db.usageLogs.add({
        id: logId,
        materialId,
        materialName: name,
        quantity, // 流水 = 实际扣减（拦截后 quantity 必 ≤ curQty，量与库存变动严格一致）
        kind: 'consume',
        source: 'manual:loss',
        garmentId: null,
        note: (note || '').slice(0, 100),
        createdAt: nowIso(),
      });
      return { id: logId, newQuantity: newQty };
    });
  }

  /**
   * 直改 quantity，写差额 adjust 流水
   * @param {string} materialId
   * @param {number} newQuantity
   * @param {string} [note]
   * @returns {Promise<{delta:number, newQuantity:number, logId?:string}>}
   */
  async function adjustMaterialQuantity(materialId, newQuantity, note) {
    if (!Number.isFinite(newQuantity) || newQuantity < 0) {
      throw new Error('新库存必须为非负数');
    }
    return db.transaction('rw', [db.materials, db.usageLogs], async () => {
      const m = await db.materials.get(materialId);
      if (!m) throw new Error('物料不存在：' + materialId);
      const delta = newQuantity - (m.quantity || 0);
      if (delta === 0) {
        return { delta: 0, newQuantity, logId: null };
      }
      await db.materials.update(materialId, { quantity: newQuantity, updatedAt: nowIso() });
      const logId = nanoid(12);
      await db.usageLogs.add({
        id: logId,
        materialId,
        materialName: m.name,
        quantity: Math.abs(delta),
        kind: 'adjust',
        source: 'manual',
        garmentId: null,
        note: (note || ('库存直改 ' + m.quantity + ' → ' + newQuantity)).slice(0, 100),
        createdAt: nowIso(),
      });
      return { delta, newQuantity, logId };
    });
  }

  /**
   * 关联成衣扣减（M1.3 调用）
   * v1.1.1 P1-M2-3 修复：超库存必须拦截（冻结文档 §1.10 / §3.5 口径），
   *   不再使用 Math.max(0, …) 封顶扣减；流水与实际扣减严格一致。
   * @param {string} materialId
   * @param {number} quantity  正数
   * @param {string} garmentId
   */
  async function consumeOnAssociate(materialId, quantity, garmentId) {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('关联扣减数量必须为正数');
    }
    if (!garmentId) throw new Error('关联扣减必须传入 garmentId');
    return db.transaction('rw', [db.materials, db.usageLogs], async () => {
      const m = await db.materials.get(materialId);
      if (!m) throw new Error('物料不存在：' + materialId);
      const curQty = m.quantity || 0;
      if (quantity > curQty) {
        throw new Error(
          '库存不足：' + m.name + ' 当前 ' + curQty + ' ' + (m.unit || '') +
          '，请求扣减 ' + quantity + ' ' + (m.unit || '')
        );
      }
      const newQty = curQty - quantity;
      await db.materials.update(materialId, { quantity: newQty, updatedAt: nowIso() });
      const logId = nanoid(12);
      await db.usageLogs.add({
        id: logId,
        materialId,
        materialName: m.name,
        quantity, // 流水 = 实际扣减（与库存变动严格一致）
        kind: 'consume',
        source: 'garment:' + garmentId,
        garmentId,
        note: '',
        createdAt: nowIso(),
      });
      return { id: logId, newQuantity: newQty };
    });
  }

  /**
   * 取消关联回补（M1.3 调用）
   */
  async function revertOnUnassociate(materialId, quantity, garmentId) {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('回补数量必须为正数');
    }
    if (!garmentId) throw new Error('回补必须传入 garmentId');
    return db.transaction('rw', [db.materials, db.usageLogs], async () => {
      const m = await db.materials.get(materialId);
      if (!m) throw new Error('物料不存在：' + materialId);
      const newQty = (m.quantity || 0) + quantity;
      await db.materials.update(materialId, { quantity: newQty, updatedAt: nowIso() });
      const logId = nanoid(12);
      await db.usageLogs.add({
        id: logId,
        materialId,
        materialName: m.name,
        quantity,
        kind: 'revert',
        source: 'garment:' + garmentId,
        garmentId,
        note: '',
        createdAt: nowIso(),
      });
      return { id: logId, newQuantity: newQty };
    });
  }

  /**
   * 删除成衣按 materialSnapshot 口径回补（M1.3 调用 · 顶层事务版）
   * v1.1.1 P1-M2-4 修复：冻结文档 §1.10 规定按 garment.materialSnapshot[].deducted=true
   *   项的 quantityUsed 回补；不再以「Σconsume − Σrevert」流水净额推导，
   *   避免与 P1-M2-3 叠加场景下凭空多出库存。
   *   M1.3 成衣模块必须将 deducted=true 的快照写入 materialSnapshot 后才调用此方法。
   *
   * v1.2.1 修复（M1.3 场景④）：把内部纯逻辑拆出 _revertOnDeleteGarmentCore，
   *   顶层包装继续走自己的 [materials,usageLogs,garments] 事务，
   *   而 deleteGarmentWithRestore 走 [_revertOnDeleteGarmentCore] 的内联调用，
   *   避免嵌套事务下「物料读不到 / 数量未回补」导致回补链路断裂。
   */
  async function revertOnDeleteGarment(materialId, garmentId) {
    if (!garmentId) throw new Error('必须传入 garmentId');
    return db.transaction('rw', [db.materials, db.usageLogs, db.garments], async () => {
      return _revertOnDeleteGarmentCore(materialId, garmentId);
    });
  }

  /**
   * 删除成衣按 materialSnapshot 口径回补的纯逻辑版（必须在已开启
   *   [materials, usageLogs, garments] 写事务的回调里调用，不自己开事务）。
   * 用途：被 deleteGarmentWithRestore（已开 [materials,usageLogs,garments,images,tasks]
   *   事务）直接内联调用，避免嵌套事务上下文下「看不到刚 update 的 garment.materialSnapshot
   *   / 写出去的 quantity 被父事务覆盖」等 Dexie 边界场景。
   * @returns {Promise<{id:string|null, newQuantity:number, net:number}>}
   */
  async function _revertOnDeleteGarmentCore(materialId, garmentId) {
    const m = await db.materials.get(materialId);
    if (!m) throw new Error('物料不存在：' + materialId);
    const garment = await db.garments.get(garmentId);
    if (!garment) throw new Error('成衣不存在：' + garmentId);
    // 按 §1.10 materialSnapshot 口径：deducted=true 的项累加 quantityUsed
    const snapshot = Array.isArray(garment.materialSnapshot) ? garment.materialSnapshot : [];
    const snapshotTotal = snapshot
      .filter((it) => it && it.materialId === materialId && it.deducted === true)
      .reduce((s, it) => s + (Number(it.quantityUsed) || 0), 0);
    if (snapshotTotal <= 0) {
      return { id: null, newQuantity: m.quantity || 0, net: 0 };
    }
    const curQty = m.quantity || 0;
    const newQty = curQty + snapshotTotal;
    await db.materials.update(materialId, { quantity: newQty, updatedAt: nowIso() });
    const logId = nanoid(12);
    await db.usageLogs.add({
      id: logId,
      materialId,
      materialName: m.name,
      quantity: snapshotTotal,
      kind: 'delete-garment',
      source: 'garment:' + garmentId + ':delete',
      garmentId,
      note: '',
      createdAt: nowIso(),
    });
    return { id: logId, newQuantity: newQty, net: snapshotTotal };
  }

  /* ============ 4.6 M1.3 成衣模块协调方法 ============ */
  /**
   * 成衣侧库存协调方法（M1.3 落地，PRD §0.8 / 冻结文档 §1.10「关联即扣、删除即还原」口径）：
   *
   *   - buildSnapshotFromSelections(selections)
   *       把 [{materialId, quantityUsed}] 转成完整 materialSnapshot
   *       （含 name / unit / priceSnapshot / subtotal / deducted=true 快照）。
   *
   *   - createGarmentWithMaterials({ data, selections })
   *       事务：插 garment + 写 materialSnapshot（deducted=true）+ 扣减所有物料 +
   *       写 kind=consume source='garment:{id}' 流水。超库存直接抛错回滚。
   *
   *   - updateGarmentWithMaterials({ id, data, prevSelections, newSelections })
   *       事务：算 diff（按 materialId）→ 新项触发 consumeOnAssociate /
   *       删除项触发 revertOnUnassociate / quantityUsed 变动按差额处理 →
   *       改 garment.materialSnapshot 与其它字段。
   *
   *   - deleteGarmentWithRestore({ id })
   *       事务：遍历 materialSnapshot[].deducted=true → revertOnDeleteGarment
   *       回补净扣减量 + 关联任务 garmentId 置空 + 删 garment 记录本身 +
   *       删 garment 关联图片。
   *
   *   - markGarmentCompleted({ id, completionDate })
   *       事务：仅写 status=completed + completionDate + updatedAt，无库存流水
   *       （PRD 口径变更 2026-09-14：扣减在关联时已完成，完工不重复扣）。
   *
   *   - unassociateGarmentMaterials({ id, selections })
   *       事务：按 selections（deducted=true）回补 + 清空 materialSnapshot +
   *       改 garment.materialIds；保留 garment 记录本身（用于一次性撤销）。
   */

  /**
   * 由 selections 构造完整 materialSnapshot（含不可变快照字段）
   * @param {Array<{materialId:string, quantityUsed:number}>} selections
   * @returns {Promise<Array<MaterialSnapshotItem>>}
   */
  async function buildSnapshotFromSelections(selections) {
    if (!Array.isArray(selections) || !selections.length) return [];
    const snapshot = [];
    for (const sel of selections) {
      const m = await db.materials.get(sel.materialId);
      if (!m) {
        throw new Error('物料不存在：' + sel.materialId);
      }
      const qty = Number(sel.quantityUsed) || 0;
      if (qty <= 0) continue;
      const price = Number(m.purchasePrice) || 0;
      snapshot.push({
        materialId: m.id,
        name: m.name,
        unit: m.unit || '',
        priceSnapshot: price,
        quantityUsed: qty,
        subtotal: +(price * qty).toFixed(2),
        deducted: true, // v1.2.0 起：关联即扣减、保存即真扣减
      });
    }
    return snapshot;
  }

  /**
   * 计算两次 selections 之间的差量（按 materialId 合并 quantityUsed）
   * @returns {{
   *   added:   Array<{materialId, quantityUsed}>,  // 新增项 / quantityUsed 增加
   *   removed: Array<{materialId, quantityUsed}>,  // quantityUsed 减少（差额回补）
   *   removedAll: Array<{materialId, quantityUsed}> // 完全取消（按旧全量回补）
   * }}
   */
  function diffSelections(prevSelections, newSelections) {
    const prev = new Map();
    for (const s of (prevSelections || [])) prev.set(s.materialId, Number(s.quantityUsed) || 0);
    const next = new Map();
    for (const s of (newSelections || [])) next.set(s.materialId, Number(s.quantityUsed) || 0);
    const added = [];
    const removed = [];
    const removedAll = [];
    for (const [mid, nQty] of next.entries()) {
      const pQty = prev.get(mid) || 0;
      if (nQty > pQty) {
        added.push({ materialId: mid, quantityUsed: nQty - pQty });
      }
    }
    for (const [mid, pQty] of prev.entries()) {
      const nQty = next.get(mid) || 0;
      if (nQty === 0) {
        // 完全取消：必须按旧 quantityUsed 全量回补
        removedAll.push({ materialId: mid, quantityUsed: pQty });
      } else if (nQty < pQty) {
        // 减量：差额回补
        removed.push({ materialId: mid, quantityUsed: pQty - nQty });
      }
    }
    return { added, removed, removedAll };
  }

  /**
   * 创建成衣 + 关联物料（事务：插 garment → 写 snapshot → 扣减所有 → 写日志）
   * 超库存任一项触发即整笔回滚（无副作用）。
   * @param {Object} params
   * @param {Object} params.data    garment 字段
   * @param {Array}  params.selections [{materialId, quantityUsed}]
   * @returns {Promise<{id:string, snapshot:Array, totalCost:number}>}
   */
  async function createGarmentWithMaterials({ data, selections }) {
    if (!data || !data.name) throw new Error('成衣名称不能为空');
    return db.transaction('rw', [db.materials, db.usageLogs, db.garments, db.images], async () => {
      const snapshotItems = await buildSnapshotFromSelections(selections);
      // v1.2.2 P1-M3-2：totalCost = Σ快照小计 + 关联纸样购入价（冻结 §1.3 + T-C5 口径）
      const snapshotSum = snapshotItems.reduce((s, it) => s + (it.subtotal || 0), 0);
      let patternPrice = 0;
      if (data.patternId) {
        const p = await db.materials.get(data.patternId);
        if (p) patternPrice = Number(p.purchasePrice) || 0;
      }
      const totalCost = +(snapshotSum + patternPrice).toFixed(2);
      const id = nanoid(12);
      const ts = nowIso();
      // v1.2.2 P1-M3-1：手动新建成衣默认 status='completed' + 写 completionDate
      //  （冻结 §3.4/§3.8 + PRD §0.6-3 用户拍板「手动新增直接已完成」）。
      //  任务入口 / markGarmentCompleted 仍可改 status='in_progress' 后续再切 completed。
      const isManual = !data.entrySource || data.entrySource === 'manual';
      const status = isManual ? 'completed' : (data.status || 'in_progress');
      const completionDate = isManual ? ts : (data.completionDate || undefined);
      const garmentRow = {
        id,
        name: data.name,
        category: data.category || undefined,
        size: data.size || undefined,
        recipient: data.recipient || undefined,
        status,
        materialIds: snapshotItems.map((it) => it.materialId),
        patternId: data.patternId || undefined,
        materialSnapshot: snapshotItems,
        totalCost,
        images: Array.isArray(data.images) ? data.images.slice() : [],
        completionDate,
        forWhom: Array.isArray(data.forWhom) ? data.forWhom.slice() : [],
        tags: Array.isArray(data.tags) ? data.tags.slice() : [],
        notes: data.notes || undefined,
        createdAt: ts,
        updatedAt: ts,
      };
      // 1) 插 garment
      await db.garments.put(garmentRow);
      // 2) 逐项扣减 + 写日志（任一项超库存 → consumeOnAssociate 抛错 → 整笔回滚）
      for (const item of snapshotItems) {
        await consumeOnAssociate(item.materialId, item.quantityUsed, id);
      }
      // 2b) v1.2.2 P1-M3-4：关联 patternId 时写 paper.used=1
      //  （冻结 §3.4 三入口表格明文「手动新增 used=1 / 任务登记 used=1 / 编辑不变」）。
      //  编辑不变：edit 不再覆盖 used=0；删除成衣 / 取消关联不回退 used。
      if (data.patternId) {
        const pat = await db.materials.get(data.patternId);
        if (pat && pat.type === 'pattern') {
          await db.materials.update(data.patternId, { used: 1, updatedAt: ts });
        }
      }
      // 3) 图片 entityId 回填
      for (const imgId of (garmentRow.images || [])) {
        await db.images.update(imgId, { entityType: 'garment', entityId: id });
      }
      return { id, snapshot: snapshotItems, totalCost };
    });
  }

  /**
   * 编辑成衣（含关联物料差量调整）— 事务：
   *   1) 算 prev vs new diff
   *   2) 扣减 added / 回补 removed + removedAll
   *   3) 写新 materialSnapshot / 改 garment 字段
   * @param {Object} params
   * @param {string} params.id
   * @param {Object} params.data                 garment 字段（不含 materialSnapshot）
   * @param {Array}  params.prevSelections       旧 selections
   * @param {Array}  params.newSelections        新 selections
   * @returns {Promise<{id:string, snapshot:Array, totalCost:number}>}
   */
  async function updateGarmentWithMaterials({ id, data, prevSelections, newSelections }) {
    return db.transaction('rw', [db.materials, db.usageLogs, db.garments, db.images], async () => {
      const existing = await db.garments.get(id);
      if (!existing) throw new Error('成衣不存在：' + id);
      const diff = diffSelections(prevSelections, newSelections);
      // 新增项 / quantityUsed 增加 → 扣减
      for (const a of diff.added) {
        await consumeOnAssociate(a.materialId, a.quantityUsed, id);
      }
      // 减量 → 回补差额
      for (const r of diff.removed) {
        await revertOnUnassociate(r.materialId, r.quantityUsed, id);
      }
      // 完全取消 → 按旧 quantityUsed 全量回补
      for (const r of diff.removedAll) {
        await revertOnUnassociate(r.materialId, r.quantityUsed, id);
      }
      // v1.2.2 P1-M3-3：materialSnapshot 改为「旧行保留 + 新行 append」不可变语义
      //  （冻结 §1.3「materialSnapshot 不可变（成本定格历史）……编辑差额 diff 不删旧行 仅 append 新行」）。
      //  旧行：existing.materialSnapshot 中所有 deducted=true 的项一律复制并翻转 deducted=false
      //   （无论是否仍在新选择里——保留成本定格历史；新行覆盖旧行的差额走 +1/-1 扣减与回补完成）。
      //  新行：buildSnapshotFromSelections(newSelections) 全部 deducted=true。
      //  回补链路（_revertOnDeleteGarmentCore / revertOnUnassociate 仍按 deducted=true 聚合）
      //   不受 append 改造影响——场景④ 21 项矩阵已在 v1.2.1 验证全过。
      const ts = nowIso();
      const prevSnap = Array.isArray(existing.materialSnapshot) ? existing.materialSnapshot : [];
      const retiredRows = prevSnap
        .filter((it) => it && it.deducted === true)
        .map((it) => ({
          materialId: it.materialId,
          name: it.name,
          unit: it.unit || '',
          priceSnapshot: it.priceSnapshot, // 旧价原样保留（成本定格历史）
          quantityUsed: it.quantityUsed,
          subtotal: it.subtotal,
          deducted: false,                 // 旧行不再扣减
          retiredAt: ts,                   // 标记转入历史
        }));
      const newSnapItems = await buildSnapshotFromSelections(newSelections);
      const finalSnap = [...retiredRows, ...newSnapItems];
      // v1.2.2 P1-M3-2：totalCost = Σ当前实际扣减快照小计 + 关联纸样购入价
      //  （按保存时价定格；编辑后纸样价改用当前 patternId 的 purchasePrice）。
      const activeSnapSum = newSnapItems.reduce((s, it) => s + (it.subtotal || 0), 0);
      let patternPrice = 0;
      // 编辑沿用现有 patternId；表单清空 patternId 显式传空字符串时按 undefined 处理
      const nextPatternId = data.patternId !== undefined ? data.patternId : existing.patternId;
      if (nextPatternId) {
        const p = await db.materials.get(nextPatternId);
        if (p) patternPrice = Number(p.purchasePrice) || 0;
      }
      const totalCost = +(activeSnapSum + patternPrice).toFixed(2);
      const next = {
        ...existing,
        name: data.name != null ? data.name : existing.name,
        category: data.category !== undefined ? data.category : existing.category,
        size: data.size !== undefined ? data.size : existing.size,
        recipient: data.recipient !== undefined ? data.recipient : existing.recipient,
        status: data.status || existing.status,
        materialIds: newSnapItems.map((it) => it.materialId),
        patternId: nextPatternId,
        materialSnapshot: finalSnap,
        totalCost,
        images: Array.isArray(data.images) ? data.images.slice() : (existing.images || []),
        completionDate: data.completionDate !== undefined ? data.completionDate : existing.completionDate,
        forWhom: Array.isArray(data.forWhom) ? data.forWhom.slice() : (existing.forWhom || []),
        tags: Array.isArray(data.tags) ? data.tags.slice() : (existing.tags || []),
        notes: data.notes !== undefined ? data.notes : existing.notes,
        updatedAt: ts,
      };
      await db.garments.put(next);
      // 图片 entityId 回填（新增的）
      const oldImgs = new Set(existing.images || []);
      for (const imgId of (next.images || [])) {
        if (!oldImgs.has(imgId)) {
          await db.images.update(imgId, { entityType: 'garment', entityId: id });
        }
      }
      // v1.2.2 P1-M3-4：编辑不变口径——若编辑后仍关联 paper.used 不回退；
      //  若编辑后取消关联（patternId 显式置空），不回退 used（M1.4 落 D-PM-4 时再补）。
      //  本轮按冻结 §3.4 明文口径「编辑不变」实现，不夹带逻辑。
      return { id, snapshot: finalSnap, totalCost };
    });
  }

  /**
   * 删除成衣并按 materialSnapshot[].deducted=true 净扣减量回补（PRD §0.8 + 冻结文档 §1.10）
   * 事务：
   *   1) 遍历 materialSnapshot → revertOnDeleteGarment（写 kind=delete-garment 流水）
   *   2) 关联任务 garmentId 置空（任务保留）
   *   3) 删 garment 记录
   *   4) 清理 garment 关联图片（孤儿图片）
   * @param {Object} params { id: string }
   * @returns {Promise<{id:string, restored: Array<{materialId, net}>}>}
   */
  async function deleteGarmentWithRestore({ id }) {
    return db.transaction('rw', [db.materials, db.usageLogs, db.garments, db.images, db.tasks], async () => {
      const garment = await db.garments.get(id);
      if (!garment) throw new Error('成衣不存在：' + id);
      const snapshot = Array.isArray(garment.materialSnapshot) ? garment.materialSnapshot : [];
      const restored = [];
      // 按 materialId 聚合：同一物料多次关联合并扣减/回补
      const matMap = new Map();
      for (const it of snapshot) {
        if (!it || it.deducted !== true) continue;
        const cur = matMap.get(it.materialId) || 0;
        matMap.set(it.materialId, cur + (Number(it.quantityUsed) || 0));
      }
      for (const mid of matMap.keys()) {
        // 防御：物料不存在时跳过（极少见）
        const mCheck = await db.materials.get(mid);
        if (!mCheck) {
          console.warn('[deleteGarmentWithRestore] material not found, skip:', mid);
          continue;
        }
        // v1.2.1（M1.3 场景④修复）：直接内联调用 _revertOnDeleteGarmentCore，
        //   共用本事务 [materials,usageLogs,garments,images,tasks] 的写上下文，
        //   避免嵌套事务下「garment.materialSnapshot 读不到 / 回补未生效」。
        //   顶层包装 revertOnDeleteGarment 仍走自己的事务供其它路径使用。
        const ret = await _revertOnDeleteGarmentCore(mid, id);
        if (ret && ret.net > 0) {
          restored.push({ materialId: mid, net: ret.net });
        }
      }
      // 关联任务 garmentId 置空（任务保留）
      const relatedTasks = await db.tasks.where('garmentId').equals(id).toArray();
      for (const t of relatedTasks) {
        await db.tasks.update(t.id, { garmentId: null, updatedAt: nowIso() });
      }
      // 删 garment 本身
      await db.garments.delete(id);
      // 清理 orphan 图片
      for (const imgId of (garment.images || [])) {
        await db.images.delete(imgId);
      }
      return { id, restored, affectedTasks: relatedTasks.length };
    });
  }

  /**
   * 标记成衣为已完工（仅写字段，无库存流水 — 关联时已扣减）
   * @param {Object} params { id, completionDate }
   */
  async function markGarmentCompleted({ id, completionDate }) {
    const ts = nowIso();
    return db.transaction('rw', [db.garments], async () => {
      const g = await db.garments.get(id);
      if (!g) throw new Error('成衣不存在：' + id);
      const cd = completionDate || ts;
      await db.garments.update(id, {
        status: 'completed',
        completionDate: cd,
        updatedAt: ts,
      });
      return { id, completionDate: cd };
    });
  }

  /**
   * 取消成衣全部关联物料（清空 snapshot 并回补 — 暂保留以备 P2+ 撤销场景）
   * @param {Object} params { id, selections? }  // 不传则按 garment.materialSnapshot 现状回补
   */
  async function unassociateGarmentMaterials({ id, selections }) {
    return db.transaction('rw', [db.materials, db.usageLogs, db.garments], async () => {
      const garment = await db.garments.get(id);
      if (!garment) throw new Error('成衣不存在：' + id);
      const list = selections || (garment.materialSnapshot || []);
      for (const item of list) {
        if (!item || item.deducted !== true) continue;
        await revertOnUnassociate(item.materialId, item.quantityUsed, id);
      }
      await db.garments.update(id, {
        materialSnapshot: [],
        materialIds: [],
        totalCost: 0,
        updatedAt: nowIso(),
      });
      return { id };
    });
  }

  /* ============ 5. 数据层自检（M1.1 必做 · §6.4 验收项 2） ============ */

  /**
   * 数据层自检脚本：建库 / 增删改查 / 索引 / 统计口径 / 迁移机制 6 组
   * 仅用于 dev 验证和 tests/data-layer-test.html；
   * 生产环境不会自动调用（避免污染业务数据）。
   *
   * 临时数据全部用前缀 "__test_" 命名，完成后清空；
   * 不影响用户真实数据。
   *
   * @returns {Promise<{passed:number, failed:number, results:Array<{name:string, ok:boolean, detail?:string}>}>}
   */
  async function runDataLayerSelfTest() {
    const results = [];
    const addResult = (name, ok, detail = '') =>
      results.push({ name, ok, detail });

    // ---- 5.1 建库 / 表结构 ----
    try {
      const tables = [
        'materials', 'garments', 'tasks', 'taskTemplates',
        'images', 'settings', 'usageLogs', 'backupLogs',
      ];
      for (const t of tables) {
        const count = await db.table(t).count();
        // count >= 0 即代表表存在且可访问
        addResult(`表存在：${t}`, count >= 0, `count=${count}`);
      }
    } catch (e) {
      addResult('建库 / 表结构', false, e.message);
    }

    // ---- 5.2 索引有效性 ----
    try {
      // 给 materials 加一条测试数据，验证 type 索引查询
      const testId = '__test_material_' + nanoid(6);
      await db.materials.put({
        id: testId, type: 'fabric', name: '__test fabric', quantity: 1.5, unit: '米',
        suitableFor: [], tags: [], images: [], createdAt: nowIso(), updatedAt: nowIso(),
      });
      const byType = await db.materials.where('type').equals('fabric').filter((m) => m.id === testId).first();
      addResult('materials.type 索引可查', !!byType);

      // 测 multiEntry 索引 *tags
      await db.materials.update(testId, { tags: ['__test_tag_a', '__test_tag_b'] });
      const byTag = await db.materials.where('tags').equals('__test_tag_a').first();
      addResult('materials.*tags multiEntry 索引', !!byTag && byTag.id === testId);

      // M1.2 新增：materials.brand 索引可查（v1.0.1 schema 已含 brand 索引，M1.2 验证品牌预设切换）
      const byBrand = await db.materials.where('brand').equals('__test_brand').toArray();
      addResult('materials.brand 索引可查', Array.isArray(byBrand));

      // M1.2 新增：materials.used 索引可查（纸样使用状态筛选）
      await db.materials.update(testId, { used: 0 });
      const byUsed = await db.materials.where('used').equals(0).filter((m) => m.id === testId).first();
      addResult('materials.used 索引可查（纸样筛选）', !!byUsed && byUsed.used === 0);

      // garments.status 索引
      const gId = '__test_garment_' + nanoid(6);
      await db.garments.put({
        id: gId, name: '__test garment', status: 'completed',
        materialIds: [], tags: [], images: [], forWhom: ['women'],
        createdAt: nowIso(), updatedAt: nowIso(),
      });
      const byStatus = await db.garments.where('status').equals('completed').filter((g) => g.id === gId).first();
      addResult('garments.status 索引', !!byStatus);

      // usageLogs.materialId 索引
      const logId = '__test_log_' + nanoid(6);
      await db.usageLogs.put({
        id: logId, materialId: testId, materialName: '__test fabric',
 quantity: 0.5, kind: 'consume', source: 'manual:loss', createdAt: nowIso(),
      });
      const logsByMat = await db.usageLogs.where('materialId').equals(testId).toArray();
      addResult('usageLogs.materialId 索引', logsByMat.length === 1);

      // settings.key 主键
      const setRow = await db.settings.get('device_id');
      addResult('settings.key 主键可查', !!setRow && !!setRow.value);

      // ---- 5.3 增删改查完整流程 ----
      // update
      await db.materials.update(testId, { quantity: 2.0, updatedAt: nowIso() });
      const updated = await db.materials.get(testId);
      addResult('update 字段', updated.quantity === 2.0, `quantity=${updated.quantity}`);

      // 关联 garmentId（手动记损耗的 garmentId 为 null）
      await db.usageLogs.update(logId, { garmentId: null });
      const logUpdated = await db.usageLogs.get(logId);
      addResult('usageLogs.garmentId=null 支持（手动记损耗）', logUpdated.garmentId === null);

      // delete
      await db.materials.delete(testId);
      await db.garments.delete(gId);
      await db.usageLogs.delete(logId);
      const gone = await db.materials.get(testId);
      addResult('delete 生效', gone === undefined);

    } catch (e) {
      addResult('增删改查流程', false, e.message);
    }

    // ---- 5.4 库存恒等式 / 统计派生口径抽查（D-WH6） ----
    // 构造一组测试数据，验证 Σconsume - Σdelete-garment 派生口径
    try {
      const mId = '__test_stock_' + nanoid(6);
      await db.materials.put({
        id: mId, type: 'fabric', name: '__test stock', quantity: 10,
 unit: '米',
        purchasePrice: 20,
        suitableFor: [], tags: [], images: [], createdAt: nowIso(), updatedAt: nowIso(),
      });

      // 模拟关联物料消耗 3 米
      await db.usageLogs.add({
        id: nanoid(12), materialId: mId, materialName: '__test stock',
 quantity: 3,
        kind: 'consume', source: 'garment:__g1', createdAt: nowIso(),
      });
      // 模拟手动记损耗 1 米（manual:loss，不与成衣关联，计入 Σconsume）
      await db.usageLogs.add({
        id: nanoid(12), materialId: mId, materialName: '__test stock',
 quantity: 1,
        kind: 'consume', source: 'manual:loss', createdAt: nowIso(),
      });
      // 模拟删除成衣回补 2 米（delete-garment）
      await db.usageLogs.add({
        id: nanoid(12), materialId: mId, materialName: '__test stock',
 quantity: 2,
        kind: 'delete-garment', source: 'garment:__g1:delete', garmentId: '__g1', createdAt: nowIso(),
      });

      const allLogs = await db.usageLogs.where('materialId').equals(mId).toArray();
      const sumConsume = allLogs.filter((l) => l.kind === 'consume').reduce((s, l) => s + l.quantity, 0);
      const sumDeleteGarment = allLogs.filter((l) => l.kind === 'delete-garment').reduce((s, l) => s + l.quantity, 0);
      const netConsume = sumConsume - sumDeleteGarment;

      addResult(
        '统计派生口径：netConsume = Σconsume - Σdelete-garment',
        netConsume === 2,
        `consume=${sumConsume} deleteGarment=${sumDeleteGarment} net=${netConsume}`
      );
      // 手动损耗（manual:loss）计入 Σconsume
      const manualLoss = allLogs.filter((l) => l.source === 'manual:loss').reduce((s, l) => s + l.quantity, 0);
      addResult('手动记损耗（manual:loss）计入 Σconsume', manualLoss === 1 && sumConsume === 4);

      // 清理
      await db.materials.delete(mId);
      await db.usageLogs.bulkDelete(allLogs.map((l) => l.id));
    } catch (e) {
      addResult('统计派生口径抽查', false, e.message);
    }

    // ---- 5.5 迁移机制（version 链）----  ----
    // 验证 db.verno === 1；升级机制由 Dexie 内置，无需手测
    try {
      const v = db.verno;
      addResult('当前数据库版本 = 1', v === 1, `verno=${v}`);
      // 验证 schema 字符串
      const expectedStores = [
        'materials', 'garments', 'tasks', 'taskTemplates',
        'images', 'settings', 'usageLogs', 'backupLogs',
      ];
      const actualStores = db.tables.map((t) => t.name).sort();
      const expected = expectedStores.slice().sort();
      const same = JSON.stringify(actualStores) === JSON.stringify(expected);
      addResult('8 表齐全（与 v0.6 数据模型一致）', same, `actual=${actualStores.join(',')}`);
    } catch (e) {
      addResult('schema 校验', false, e.message);
    }

    // ---- 5.6 预设 / 种子 ----
    try {
      const tmpls = await db.taskTemplates.toArray();
      addResult('首启种子：3 个任务模板', tmpls.length === 3, `count=${tmpls.length}`);
      const presetsRow = await db.settings.get('presets');
      const presets = JSON.parse(presetsRow.value);
      addResult('presets.fabricBrands 9 项', presets.fabricBrands.length === 9);
      addResult('presets.patternBrands 11 项', presets.patternBrands.length === 11);
      addResult('presets.accessoryTags 11 项', presets.accessoryTags.length === 11);
      const deviceId = await db.settings.get('device_id');
      addResult('device_id 已自动生成', !!deviceId && deviceId.value.length === 10);
    } catch (e) {
      addResult('预设/种子', false, e.message);
    }

    // ---- 5.7 M1.2 物料侧能力（新增） ----
    // 验证 recordLoss / adjustMaterialQuantity / consumeOnAssociate /
    //      revertOnUnassociate / revertOnDeleteGarment 五个方法的
    //      库存变更与流水写入（kind / source / garmentId 字段对齐 v0.6 数据模型）
    try {
      const mId = '__test_m12_' + nanoid(6);
      const gId = '__test_m12g_' + nanoid(6);
      await db.materials.put({
        id: mId, type: 'fabric', name: '__test m12 stock',
        quantity: 10, unit: '米',
        purchasePrice: 25, suitableFor: [], tags: [], images: [],
        createdAt: nowIso(), updatedAt: nowIso(),
      });
      // v1.1.1 P1-M2-4 测试需要：先建 garment 记录并写入 materialSnapshot（deducted=true）
      await db.garments.put({
        id: gId, name: '__test garment for delete',
        status: 'planning',
        materialIds: [mId],
        materialSnapshot: [
          { materialId: mId, name: '__test m12 stock', unit: '米',
            priceSnapshot: 25, quantityUsed: 3, subtotal: 75, deducted: true },
        ],
        tags: [], images: [], forWhom: [],
        createdAt: nowIso(), updatedAt: nowIso(),
      });

      // 26. recordLoss：扣库存 + 写 manual:loss 流水（garmentId=null）
      const beforeQty = (await db.materials.get(mId)).quantity;
      const lossRet = await recordLoss(mId, 1.5, '试裁损耗');
      const afterLoss = await db.materials.get(mId);
      const lossLog = await db.usageLogs.get(lossRet.id);
      addResult(
        'M1.2·recordLoss 扣库存 + 写 manual:loss 流水',
        afterLoss.quantity === beforeQty - 1.5
          && lossLog.kind === 'consume'
          && lossLog.source === 'manual:loss'
          && lossLog.garmentId === null
          && lossLog.quantity === 1.5,
        `qty ${beforeQty}→${afterLoss.quantity}, kind=${lossLog.kind} src=${lossLog.source}`
      );

      // 27. adjustMaterialQuantity：差额调整 + 写 adjust 流水
      const adjRet = await adjustMaterialQuantity(mId, 12, '盘点多出');
      const afterAdj = await db.materials.get(mId);
      addResult(
        'M1.2·adjustMaterialQuantity 写 adjust 流水',
        afterAdj.quantity === 12 && adjRet.delta === (12 - (beforeQty - 1.5))
          && adjRet.logId != null,
        `delta=${adjRet.delta}`
      );

      // 28. consumeOnAssociate：扣库存 + 写 garment:{id} consume
      const beforeConsume = (await db.materials.get(mId)).quantity;
      const consumeRet = await consumeOnAssociate(mId, 2, gId);
      const afterConsume = await db.materials.get(mId);
      const consumeLog = await db.usageLogs.get(consumeRet.id);
      addResult(
        'M1.2·consumeOnAssociate 写 garment:{id} consume 流水',
        afterConsume.quantity === beforeConsume - 2
          && consumeLog.kind === 'consume'
          && consumeLog.source === 'garment:' + gId
          && consumeLog.garmentId === gId,
        `qty ${beforeConsume}→${afterConsume.quantity}, src=${consumeLog.source}`
      );

      // 29. revertOnUnassociate：回补 + 写 garment:{id} revert
      const beforeRevert = (await db.materials.get(mId)).quantity;
      const revertRet = await revertOnUnassociate(mId, 1, gId);
      const afterRevert = await db.materials.get(mId);
      const revertLog = await db.usageLogs.get(revertRet.id);
      addResult(
        'M1.2·revertOnUnassociate 写 garment:{id} revert 流水',
        afterRevert.quantity === beforeRevert + 1
          && revertLog.kind === 'revert'
          && revertLog.source === 'garment:' + gId
          && revertLog.garmentId === gId,
        `qty ${beforeRevert}→${afterRevert.quantity}`
      );

      // 30. revertOnDeleteGarment：按 materialSnapshot 口径回补（v1.1.1 P1-M2-4）
      //     snapshot 写入 quantityUsed=3，deducted=true ⇒ 回补 3
      const beforeDelete = (await db.materials.get(mId)).quantity;
      const deleteRet = await revertOnDeleteGarment(mId, gId);
      const afterDelete = await db.materials.get(mId);
      const deleteLog = deleteRet.id ? await db.usageLogs.get(deleteRet.id) : null;
      addResult(
        'M1.2·revertOnDeleteGarment 按 materialSnapshot 口径回补',
        afterDelete.quantity === beforeDelete + 3
          && deleteRet.net === 3
          && deleteLog
          && deleteLog.kind === 'delete-garment'
          && deleteLog.source === 'garment:' + gId + ':delete',
        `net=${deleteRet.net} qty ${beforeDelete}→${afterDelete.quantity}`
      );

      // 31. 记录损耗数量合法性（≤0 抛错）
      let threwOnZero = false;
      try { await recordLoss(mId, 0, ''); } catch (_) { threwOnZero = true; }
      addResult('M1.2·recordLoss 数量≤0 抛错校验', threwOnZero);

      // 32. 关联扣减必须有 garmentId
      let threwNoGar = false;
      try { await consumeOnAssociate(mId, 1, ''); } catch (_) { threwNoGar = true; }
      addResult('M1.2·consumeOnAssociate 缺 garmentId 抛错校验', threwNoGar);

      // 33. 调整时 delta=0 不写流水（idempotent）
      const beforeEq = (await db.materials.get(mId)).quantity;
      const eqRet = await adjustMaterialQuantity(mId, beforeEq, 'no-op');
      addResult('M1.2·adjustMaterialQuantity delta=0 不写流水', eqRet.delta === 0 && eqRet.logId === null);

      // 34. v1.1.1 P1-M2-3 修复：recordLoss 超库存必须拦截（库存 10，请求 9999）
      let threwOverLoss = false;
      const qtyBeforeOverLoss = (await db.materials.get(mId)).quantity;
      try { await recordLoss(mId, 9999, 'over'); } catch (_) { threwOverLoss = true; }
      const qtyAfterOverLoss = (await db.materials.get(mId)).quantity;
      // 同时检查流水未写入
      const overLossLog = await db.usageLogs.where('materialId').equals(mId).filter((l) => l.note === 'over').first();
      addResult(
        'v1.1.1·P1-M2-3 recordLoss 超库存拦截（库存不变 + 无流水）',
        threwOverLoss && qtyAfterOverLoss === qtyBeforeOverLoss && !overLossLog,
        `qty unchanged=${qtyAfterOverLoss === qtyBeforeOverLoss}, log=${!overLossLog}`
      );

      // 35. v1.1.1 P1-M2-3 修复：consumeOnAssociate 超库存拦截
      let threwOverAssoc = false;
      const qtyBeforeOverAssoc = (await db.materials.get(mId)).quantity;
      try { await consumeOnAssociate(mId, 9999, gId); } catch (_) { threwOverAssoc = true; }
      const qtyAfterOverAssoc = (await db.materials.get(mId)).quantity;
      addResult(
        'v1.1.1·P1-M2-3 consumeOnAssociate 超库存拦截（库存不变）',
        threwOverAssoc && qtyAfterOverAssoc === qtyBeforeOverAssoc,
        `qty unchanged=${qtyAfterOverAssoc === qtyBeforeOverAssoc}`
      );

      // 36. v1.1.1 P1-M2-4 修复：revertOnDeleteGarment 走 materialSnapshot 口径
      //     即使 P1-M2-3 场景被拦截后做错误请求回补，也只按快照 actual 回补（不凭空多出）
      //     重新建一个 garment 写入 quantityUsed=2,d 创建一个超扣场景：
      //   - 当前 m 库存 = qtyBeforeOverAssoc（10）
      //   - simulate 一次强行手动篡改库存为 2（模拟 v4-d1）
      //   - snapshot 写入 deducted=true, quantityUsed=3（实际扣减 3 但当前只有 2）
      //   - 旧实现会按 Σconsume 求出 net=3，再回补 → quantity=5（凭空多 3）
      //   - 新实现按 snapshot=3 回补 → quantity=5（仍然 5，但因为 snapshot 真实记录）
      //   - 这里专门验证「snapshot 不存在时不回补」
      const gId2 = '__test_m12g2_' + nanoid(6);
      const beforeEdge = (await db.materials.get(mId)).quantity;
      // 创建空 snapshot 的 garment，调用删除应 net=0
      await db.garments.put({
        id: gId2, name: '__test garment empty snapshot',
        status: 'planning', materialIds: [mId], materialSnapshot: [],
        tags: [], images: [], forWhom: [],
        createdAt: nowIso(), updatedAt: nowIso(),
      });
      const edgeRet = await revertOnDeleteGarment(mId, gId2);
      addResult(
        'v1.1.1·P1-M2-4 materialSnapshot 缺项不回补',
        edgeRet.net === 0 && (await db.materials.get(mId)).quantity === beforeEdge,
        `net=${edgeRet.net}`
      );

      // 清理
      const allLogs2 = await db.usageLogs.where('materialId').equals(mId).toArray();
      await db.usageLogs.bulkDelete(allLogs2.map((l) => l.id));
      await db.materials.delete(mId);
      await db.garments.delete(gId);
      await db.garments.delete(gId2);
    } catch (e) {
      addResult('M1.2 物料侧能力', false, e.message);
    }

    // ---- 5.8 M1.3 成衣库存协调：四场景 ----
    //   场景①保存只算成本（关联即扣减）：createGarmentWithMaterials 扣减 + 写 consume 流水
    //   场景②完工不扣库存：markGarmentCompleted 仅写字段、无新流水
    //   场景③编辑差额：updateGarmentWithMaterials 算 diff + 部分回补
    //   场景④删除回补净扣减：deleteGarmentWithRestore 按 materialSnapshot[].deducted=true 回补
    // 每个子场景独立 try/catch，便于定位失败
    const m13FabricId = '__test_m13_fabric_' + nanoid(6);
    const m13AccId = '__test_m13_acc_' + nanoid(6);
    const m13PatternId = '__test_m13_pattern_' + nanoid(6);
    try {
      // 准备测试物料：fabric 10 米 + accessory 5 个，purchasePrice 已知
      await db.materials.bulkPut([
        { id: m13FabricId, type: 'fabric', name: '__test m13 棉布', quantity: 10, unit: '米',
          purchasePrice: 30, suitableFor: [], tags: [], images: [],
          createdAt: nowIso(), updatedAt: nowIso() },
        { id: m13AccId, type: 'accessory', name: '__test m13 松紧', quantity: 5, unit: '个',
          purchasePrice: 2, suitableFor: [], tags: [], images: [],
          createdAt: nowIso(), updatedAt: nowIso() },
        { id: m13PatternId, type: 'pattern', name: '__test m13 纸样', quantity: 1, unit: '张',
          purchasePrice: 0, suitableFor: [], tags: [], images: [], used: 0,
          createdAt: nowIso(), updatedAt: nowIso() },
      ]);
      addResult('M1.3·准备测试物料', true, `fabric=${m13FabricId} acc=${m13AccId}`);
    } catch (e) {
      addResult('M1.3·准备测试物料', false, e.message);
    }

    // --- 场景①保存只算成本 ---
    let m13GarmentId = null;
    try {
      const beforeFabric = (await db.materials.get(m13FabricId)).quantity;
      const beforeAcc = (await db.materials.get(m13AccId)).quantity;
      const garmentData = {
        name: '__test m13 garment save', status: 'planning',
        patternId: m13PatternId, forWhom: ['women'], tags: [], images: [],
      };
      const selections = [
        { materialId: m13FabricId, quantityUsed: 2 },
        { materialId: m13AccId, quantityUsed: 1 },
      ];
      const createRet = await createGarmentWithMaterials({ data: garmentData, selections });
      m13GarmentId = createRet.id;
      const afterFabric = (await db.materials.get(m13FabricId)).quantity;
      const afterAcc = (await db.materials.get(m13AccId)).quantity;

      addResult(
        'M1.3·场景①保存只算成本 · fabric 扣 2',
        afterFabric === beforeFabric - 2,
        `${beforeFabric}→${afterFabric}`
      );
      addResult(
        'M1.3·场景①保存只算成本 · accessory 扣 1',
        afterAcc === beforeAcc - 1,
        `${beforeAcc}→${afterAcc}`
      );
      const g = await db.garments.get(createRet.id);
      const snapItems = (g.materialSnapshot || []).filter((it) => it.materialId === m13FabricId || it.materialId === m13AccId);
      addResult(
        'M1.3·场景①保存只算成本 · materialSnapshot deducted=true 全项',
        snapItems.length === 2 && snapItems.every((it) => it.deducted === true),
        `items=${snapItems.length}`
      );
      addResult(
        'M1.3·场景①保存只算成本 · totalCost 正确',
        g.totalCost === 62,
        `totalCost=${g.totalCost}`
      );
      const createLogs = await db.usageLogs
        .where('materialId').anyOf(m13FabricId, m13AccId)
        .filter((l) => l.source === 'garment:' + createRet.id && l.kind === 'consume').toArray();
      addResult(
        'M1.3·场景①保存只算成本 · 写 garment:{id} consume 流水 ×2',
        createLogs.length === 2,
        `logs=${createLogs.length}`
      );
    } catch (e) {
      addResult('M1.3·场景①保存只算成本', false, e.message + (e.stack ? '\n' + e.stack.split('\n').slice(0, 3).join('\n') : ''));
    }

    // --- 场景②完工不扣库存 ---
    try {
      if (!m13GarmentId) throw new Error('前置场景①失败，跳过');
      const consumeLogsBefore = (await db.usageLogs.where('materialId').anyOf(m13FabricId, m13AccId)
        .filter((l) => l.source === 'garment:' + m13GarmentId && l.kind === 'consume').count());
      const fabricBeforeComp = (await db.materials.get(m13FabricId)).quantity;
      const accBeforeComp = (await db.materials.get(m13AccId)).quantity;
      await markGarmentCompleted({ id: m13GarmentId, completionDate: nowIso() });
      const afterComp = await db.garments.get(m13GarmentId);
      const fabricAfterComp = (await db.materials.get(m13FabricId)).quantity;
      const accAfterComp = (await db.materials.get(m13AccId)).quantity;
      const consumeLogsAfter = (await db.usageLogs.where('materialId').anyOf(m13FabricId, m13AccId)
        .filter((l) => l.source === 'garment:' + m13GarmentId && l.kind === 'consume').count());

      addResult(
        'M1.3·场景②完工不扣库存 · 库存不变',
        fabricAfterComp === fabricBeforeComp && accAfterComp === accBeforeComp,
        `fabric ${fabricBeforeComp}→${fabricAfterComp}, acc ${accBeforeComp}→${accAfterComp}`
      );
      addResult(
        'M1.3·场景②完工不扣库存 · 无新 consume 流水',
        consumeLogsAfter === consumeLogsBefore,
        `consume logs ${consumeLogsBefore}→${consumeLogsAfter}`
      );
      addResult(
        'M1.3·场景②完工不扣库存 · status=completed + completionDate 写入',
        afterComp.status === 'completed' && !!afterComp.completionDate,
        `status=${afterComp.status} cd=${afterComp.completionDate}`
      );
    } catch (e) {
      addResult('M1.3·场景②完工不扣库存', false, e.message);
    }

    // --- 场景③编辑差额 ---
    try {
      if (!m13GarmentId) throw new Error('前置场景①失败，跳过');
      const fabricBeforeEdit = (await db.materials.get(m13FabricId)).quantity;
      const accBeforeEdit = (await db.materials.get(m13AccId)).quantity;
      const prevSel = [
        { materialId: m13FabricId, quantityUsed: 2 },
        { materialId: m13AccId, quantityUsed: 1 },
      ];
      const newSel = [
        { materialId: m13FabricId, quantityUsed: 3 },
      ];
      await updateGarmentWithMaterials({
        id: m13GarmentId,
        data: { name: '__test m13 garment save', status: 'completed' },
        prevSelections: prevSel,
        newSelections: newSel,
      });
      const fabricAfterEdit = (await db.materials.get(m13FabricId)).quantity;
      const accAfterEdit = (await db.materials.get(m13AccId)).quantity;
      addResult(
        'M1.3·场景③编辑差额 · fabric +1（扣减）',
        fabricAfterEdit === fabricBeforeEdit - 1,
        `${fabricBeforeEdit}→${fabricAfterEdit}`
      );
      addResult(
        'M1.3·场景③编辑差额 · accessory 全取消（+1 回补）',
        accAfterEdit === accBeforeEdit + 1,
        `${accBeforeEdit}→${accAfterEdit}`
      );
      const g2 = await db.garments.get(m13GarmentId);
      const snap2 = g2.materialSnapshot || [];
      // v1.2.2 P1-M3-3：materialSnapshot 改为「旧行保留 + 新行 append」不可变语义
      //   旧 fabric (deducted=false 2) + 新 fabric (deducted=true 3) + 旧 acc (deducted=false 1) = 3 行
      const activeSnap2 = snap2.filter((it) => it.deducted === true);
      const retiredSnap2 = snap2.filter((it) => it.deducted === false);
      addResult(
        'M1.3·场景③编辑差额 · snapshot append 旧行保留 + 新行 append（3 行）',
        snap2.length === 3 && activeSnap2.length === 1
          && activeSnap2[0].materialId === m13FabricId && activeSnap2[0].quantityUsed === 3
          && activeSnap2[0].deducted === true
          && retiredSnap2.length === 2,
        `len=${snap2.length} active=${activeSnap2.length} retired=${retiredSnap2.length}`
      );
    } catch (e) {
      addResult('M1.3·场景③编辑差额', false, e.message);
    }

    // --- 场景④删除回补净扣减 ---
    try {
      if (!m13GarmentId) throw new Error('前置场景①失败，跳过');
      const fabricBeforeDel = (await db.materials.get(m13FabricId)).quantity;
      // DEBUG：先看 snapshot
      const g3 = await db.garments.get(m13GarmentId);
      const snap3 = g3 ? g3.materialSnapshot : 'NO_GARMENT';
      const delRet = await deleteGarmentWithRestore({ id: m13GarmentId });
      const fabricAfterDel = (await db.materials.get(m13FabricId)).quantity;
      const gone = await db.garments.get(m13GarmentId);
      addResult(
        'M1.3·场景④删除回补净扣减 · fabric 回补 3',
        fabricAfterDel === fabricBeforeDel + 3,
        `${fabricBeforeDel}→${fabricAfterDel}`
      );
      addResult(
        'M1.3·场景④删除回补净扣减 · garment 记录已删',
        gone === undefined
      );
      const delLog = await db.usageLogs
        .where('materialId').equals(m13FabricId)
        .filter((l) => l.kind === 'delete-garment' && l.source === 'garment:' + m13GarmentId + ':delete')
        .first();
      addResult(
        'M1.3·场景④删除回补净扣减 · 写 kind=delete-garment 流水',
        !!delLog && delLog.quantity === 3 && delLog.garmentId === m13GarmentId,
        `qty=${delLog?.quantity} kind=${delLog?.kind}`
      );
    } catch (e) {
      addResult('M1.3·场景④删除回补净扣减', false, `err=${e.message}`);
    }

    // --- 边界值 ---
    try {
      // 50. 超库存必须拦截（v1.2.0）
      let threwOver = false;
      const fBeforeOver = (await db.materials.get(m13FabricId)).quantity;
      try {
        await createGarmentWithMaterials({
          data: { name: '__test over', status: 'planning' },
          selections: [{ materialId: m13FabricId, quantityUsed: 9999 }],
        });
      } catch (_) { threwOver = true; }
      const fAfterOver = (await db.materials.get(m13FabricId)).quantity;
      addResult(
        'M1.3·场景①边界 · 超库存创建必须抛错且库存不变',
        threwOver && fAfterOver === fBeforeOver,
        `qty unchanged=${fAfterOver === fBeforeOver}`
      );

      // 51. 0 库存场景可正常删除
      const zeroId = '__test_m13_zero_' + nanoid(6);
      await db.materials.put({
        id: zeroId, type: 'fabric', name: '__test zero', quantity: 0, unit: '米',
        purchasePrice: 10, suitableFor: [], tags: [], images: [],
        createdAt: nowIso(), updatedAt: nowIso(),
      });
      const emptyRet = await createGarmentWithMaterials({
        data: { name: '__test empty garment', status: 'planning' },
        selections: [],
      });
      const delEmptyRet = await deleteGarmentWithRestore({ id: emptyRet.id });
      const stillThere = await db.garments.get(emptyRet.id);
      addResult(
        'M1.3·场景④边界 · 空 snapshot 删除不写回补流水且 garment 删',
        delEmptyRet.restored.length === 0 && stillThere === undefined,
        `restored=${delEmptyRet.restored.length}`
      );

      // 52. 多次创建-删除往返
      const mulBefore = (await db.materials.get(m13FabricId)).quantity;
      const tmpG = await createGarmentWithMaterials({
        data: { name: '__test mul', status: 'planning' },
        selections: [{ materialId: m13FabricId, quantityUsed: 1 }],
      });
      const mulMid = (await db.materials.get(m13FabricId)).quantity;
      await deleteGarmentWithRestore({ id: tmpG.id });
      const mulAfter = (await db.materials.get(m13FabricId)).quantity;
      addResult(
        'M1.3·场景④边界 · 创建-删除往返 库存回到初始',
        mulMid === mulBefore - 1 && mulAfter === mulBefore,
        `${mulBefore}→${mulMid}→${mulAfter}`
      );
    } catch (e) {
      addResult('M1.3·边界值', false, e.message + (e.stack ? ' | ' + e.stack.split('\n').slice(0, 4).join(' / ') : ''));
    }

    // --- M1.3 v1.2.2 · P1 修复专项断言（4 条 P1 各 1 条数据层断言） ---
    try {
      // P1-M3-1：手动新建成衣默认 status='completed' + completionDate 写入
      const patId = '__test_m13_p1_pat_' + nanoid(6);
      const fabId = '__test_m13_p1_fab_' + nanoid(6);
      await db.materials.bulkPut([
        { id: patId, type: 'pattern', name: '__test p1 纸样', quantity: 1, unit: '张',
          purchasePrice: 20, suitableFor: [], tags: [], images: [], used: 0,
          createdAt: nowIso(), updatedAt: nowIso() },
        { id: fabId, type: 'fabric', name: '__test p1 棉布', quantity: 10, unit: '米',
          purchasePrice: 30, suitableFor: [], tags: [], images: [],
          createdAt: nowIso(), updatedAt: nowIso() },
      ]);
      const p1Ret = await createGarmentWithMaterials({
        data: { name: '__test m13 p1 manual garment', patternId: patId,
                forWhom: ['women'], tags: [], images: [] }, // 不传 entrySource
        selections: [{ materialId: fabId, quantityUsed: 2 }],
      });
      const p1g = await db.garments.get(p1Ret.id);
      addResult(
        'M1.3·v1.2.2 P1-M3-1 · 手动新建成衣 status=completed + completionDate 写入',
        p1g.status === 'completed' && !!p1g.completionDate,
        `status=${p1g.status} completionDate=${p1g.completionDate}`
      );

      // P1-M3-2：totalCost = Σ快照小计 + 关联纸样购入价（pattern.purchasePrice=20, fabric×2×30=60 → totalCost=80）
      addResult(
        'M1.3·v1.2.2 P1-M3-2 · totalCost 含纸样购入价（Σ快照小计 + pattern.purchasePrice）',
        p1g.totalCost === 80,
        `totalCost=${p1g.totalCost} expected=80 (2*30 + 20)`
      );

      // P1-M3-4：关联 patternId 后 paper.used=1
      const patAfter = await db.materials.get(patId);
      addResult(
        'M1.3·v1.2.2 P1-M3-4 · 关联 patternId 后 paper.used=1',
        patAfter && patAfter.used === 1,
        `paper.used=${patAfter && patAfter.used}`
      );

      // P1-M3-3：编辑改料后 materialSnapshot append（旧行保留 + 新行 append），且 priceSnapshot 不可变
      //   先把 fabric 价改 50，再编辑保存（不改 selection，触发 append 路径）
      await db.materials.update(fabId, { purchasePrice: 50 });
      const prevSel = [{ materialId: fabId, quantityUsed: 2 }];
      const newSel = [{ materialId: fabId, quantityUsed: 3 }]; // +1 增量，触发 append
      const updRet = await updateGarmentWithMaterials({
        id: p1Ret.id,
        data: { name: p1g.name, patternId: patId },
        prevSelections: prevSel,
        newSelections: newSel,
      });
      const p1gAfterEdit = await db.garments.get(p1Ret.id);
      const snapEdit = p1gAfterEdit.materialSnapshot || [];
      const retiredEdit = snapEdit.filter((it) => it.deducted === false);
      const activeEdit = snapEdit.filter((it) => it.deducted === true);
      // 旧 retired 行：fabric 旧行 quantityUsed=2 且 priceSnapshot=30（不可变）；新行 priceSnapshot=50 quantityUsed=3
      const retiredFabric = retiredEdit.find((it) => it.materialId === fabId);
      const activeFabric = activeEdit.find((it) => it.materialId === fabId);
      addResult(
        'M1.3·v1.2.2 P1-M3-3 · 编辑快照 append 旧行保留 + priceSnapshot 不可变',
        snapEdit.length === 2 && retiredFabric && retiredFabric.priceSnapshot === 30
          && retiredFabric.quantityUsed === 2 && retiredFabric.deducted === false
          && activeFabric && activeFabric.priceSnapshot === 50 && activeFabric.quantityUsed === 3
          && activeFabric.deducted === true,
        `len=${snapEdit.length} retiredPrice=${retiredFabric && retiredFabric.priceSnapshot} activePrice=${activeFabric && activeFabric.priceSnapshot}`
      );

      // 清理 P1 测试残留
      await db.garments.delete(p1Ret.id);
      await db.materials.bulkDelete([patId, fabId]);
      const p1Logs = await db.usageLogs.toArray();
      const p1Leftover = p1Logs.filter((l) => l.materialId === fabId || l.materialId === patId).map((l) => l.id);
      if (p1Leftover.length) await db.usageLogs.bulkDelete(p1Leftover);
    } catch (e) {
      addResult('M1.3·v1.2.2 P1 修复专项', false, e.message + (e.stack ? ' | ' + e.stack.split('\n').slice(0, 4).join(' / ') : ''));
    }

    // 清理 M1.3 测试残留
    try {
      await db.materials.bulkDelete([m13FabricId, m13AccId, m13PatternId]);
      const allLogs = await db.usageLogs.toArray();
      const leftover = allLogs.filter((l) =>
        l.materialId === m13FabricId || l.materialId === m13AccId || l.materialId === m13PatternId
      ).map((l) => l.id);
      if (leftover.length) await db.usageLogs.bulkDelete(leftover);
    } catch (e) { /* ignore cleanup errors */ }

    // ---- 5.9 M1.4 · 统计派生（PRD §10.6 + 数据模型 v0.6 §4） ----
    // ---- 5.9a M1.4 下半 · P3-M3-13 编辑清空纸样沿用现有 patternId ----
    try {
      // 准备：1 个 pattern + 1 个 fabric，绑到一个新成衣上
      const pm13Pat = '__test_m14_pm13_pat_' + nanoid(6);
      const pm13Fab = '__test_m14_pm13_fab_' + nanoid(6);
      const pm13Gid = '__test_m14_pm13_g_' + nanoid(6);
      const pm13Ts = nowIso();
      await db.materials.bulkAdd([
        { id: pm13Pat, type: 'pattern', name: '__test m14 pm13 pattern', quantity: 1, initialQuantity: 1,
          unit: '张', purchaseDate: pm13Ts, purchasePrice: 25, suitableFor: [], tags: [], images: [], used: 0,
          createdAt: pm13Ts, updatedAt: pm13Ts },
        { id: pm13Fab, type: 'fabric', name: '__test m14 pm13 fabric', quantity: 5, initialQuantity: 5,
          unit: '米', purchaseDate: pm13Ts, purchasePrice: 30, suitableFor: [], tags: [], images: [],
          createdAt: pm13Ts, updatedAt: pm13Ts },
      ]);
      const cRet = await createGarmentWithMaterials({
        data: { id: pm13Gid, name: '__test m14 pm13 g', forWhom: ['women'], tags: [], images: [], patternId: pm13Pat },
        selections: [{ materialId: pm13Fab, quantityUsed: 2 }],
      });
      const g0 = await db.garments.get(cRet.id);
      const pat0 = await db.materials.get(pm13Pat);
      // 编辑：data.patternId 传 undefined（表单清空时 (fd.get('patternId') || '').toString() || undefined 路径），
      //       必须沿用现有 patternId，且 paper.used 保持 1，不允许回退。
      await updateGarmentWithMaterials({
        id: cRet.id,
        data: { name: g0.name, patternId: undefined },
        prevSelections: [{ materialId: pm13Fab, quantityUsed: 2 }],
        newSelections: [{ materialId: pm13Fab, quantityUsed: 2 }],
      });
      const g1 = await db.garments.get(cRet.id);
      const pat1 = await db.materials.get(pm13Pat);
      addResult(
        'M1.4·v1.3.0 P3-M3-13 · 编辑清空纸样沿用现有 patternId（冻结文档 v0.6 §4.3 D-PM-4）',
        g1.patternId === pm13Pat && pat1.used === 1,
        `garment.patternId=${g1.patternId} paper.used=${pat1.used}`
      );
      // 清理
      await db.garments.delete(cRet.id);
      await db.materials.bulkDelete([pm13Pat, pm13Fab]);
    } catch (e) {
      addResult(
        'M1.4·v1.3.0 P3-M3-13 · 编辑清空纸样沿用现有 patternId',
        false,
        e.message + (e.stack ? ' | ' + e.stack.split('\n').slice(0, 4).join(' / ') : '')
      );
    }

    try {
      const todayIso = new Date().toISOString();
      const thisMonthIso = (() => {
        const d = new Date();
        const local = new Date(d.getFullYear(), d.getMonth(), 5, 12, 0, 0, 0);
        return local.toISOString();
      })();
      // 准备 M1.4 测试数据：3 条 fabric + 1 accessory + 1 tool + 1 pattern
      const sf1 = '__test_m14_fab1_' + nanoid(6);
      const sf2 = '__test_m14_fab2_' + nanoid(6);
      const sf3 = '__test_m14_fab3_' + nanoid(6);
      const sa1 = '__test_m14_acc_' + nanoid(6);
      const st1 = '__test_m14_tool_' + nanoid(6);
      const sp1 = '__test_m14_pat_' + nanoid(6);
      const sg1 = '__test_m14_g1_' + nanoid(6);
      const sg2 = '__test_m14_g2_' + nanoid(6);
      const sg3 = '__test_m14_g3_' + nanoid(6);
      const sgOlder = '__test_m14_gold_' + nanoid(6);
      const nowTs = nowIso();
      await db.materials.bulkAdd([
        { id: sf1, type: 'fabric', name: '__test m14 fabric A', quantity: 5, initialQuantity: 10,
          unit: '米', purchaseDate: thisMonthIso, purchasePrice: 30, suitableFor: [], tags: [], images: [],
          createdAt: nowTs, updatedAt: nowTs },
        { id: sf2, type: 'fabric', name: '__test m14 fabric B', quantity: 3, initialQuantity: 5,
          unit: '米', purchaseDate: thisMonthIso, purchasePrice: 60, suitableFor: [], tags: [], images: [],
          createdAt: nowTs, updatedAt: nowTs },
        { id: sf3, type: 'fabric', name: '__test m14 fabric C (no initialQty)', quantity: 4,
          unit: '米', purchaseDate: thisMonthIso, purchasePrice: 20, suitableFor: [], tags: [], images: [],
          createdAt: nowTs, updatedAt: nowTs },
        { id: sa1, type: 'accessory', name: '__test m14 acc', quantity: 100, initialQuantity: 100,
          unit: '个', purchaseDate: thisMonthIso, purchasePrice: 1, suitableFor: [], tags: [], images: [],
          createdAt: nowTs, updatedAt: nowTs },
        { id: st1, type: 'tool', name: '__test m14 tool', quantity: 1, initialQuantity: 1,
          unit: '把', purchaseDate: thisMonthIso, purchasePrice: 50, suitableFor: [], tags: [], images: [],
          createdAt: nowTs, updatedAt: nowTs },
        { id: sp1, type: 'pattern', name: '__test m14 pattern', quantity: 1, initialQuantity: 1,
          unit: '张', purchaseDate: thisMonthIso, purchasePrice: 25, suitableFor: [], tags: [], images: [],
          createdAt: nowTs, updatedAt: nowTs },
      ]);
      await db.garments.bulkAdd([
        // 本月 3 条 completed（不同 totalCost），用于 avg/max/min/本月完工数
        { id: sg1, name: '__test m14 g1', status: 'completed', completionDate: thisMonthIso,
          totalCost: 80, materialIds: [], materialSnapshot: [], tags: [], images: [], forWhom: ['women'],
          createdAt: nowTs, updatedAt: nowTs },
        { id: sg2, name: '__test m14 g2', status: 'completed', completionDate: thisMonthIso,
          totalCost: 120, materialIds: [], materialSnapshot: [], tags: [], images: [], forWhom: ['women'],
          createdAt: nowTs, updatedAt: nowTs },
        { id: sg3, name: '__test m14 g3', status: 'completed', completionDate: thisMonthIso,
          totalCost: 200, materialIds: [], materialSnapshot: [], tags: [], images: [], forWhom: ['women'],
          createdAt: nowTs, updatedAt: nowTs },
        // 上月 1 条 completed（用于验证本月范围过滤）
        { id: sgOlder, name: '__test m14 older', status: 'completed',
          completionDate: '2020-01-15T10:00:00.000Z',
          totalCost: 999, materialIds: [], materialSnapshot: [], tags: [], images: [], forWhom: ['women'],
          createdAt: nowTs, updatedAt: nowTs },
      ]);
      // usageLogs：consume / delete-garment（净额派生口径）
      await db.usageLogs.bulkAdd([
        // fabric A：consume 2 + delete-garment 1 → 净额 1 米
        { id: '__test_m14_log1_' + nanoid(6), materialId: sf1, materialName: '__test m14 fabric A',
          quantity: 2, kind: 'consume', source: 'garment:' + sg1, createdAt: thisMonthIso },
        { id: '__test_m14_log2_' + nanoid(6), materialId: sf1, materialName: '__test m14 fabric A',
          quantity: 1, kind: 'delete-garment', source: 'garment:' + sg1, createdAt: thisMonthIso },
        // fabric B：consume 3 → 净额 3 米
        { id: '__test_m14_log3_' + nanoid(6), materialId: sf2, materialName: '__test m14 fabric B',
          quantity: 3, kind: 'consume', source: 'garment:' + sg2, createdAt: thisMonthIso },
      ]);

      // ---- 断言 1：getPeriodRange 三个时段形态
      const rMonth = getPeriodRange('month');
      const rYear = getPeriodRange('year');
      const rAll = getPeriodRange('all');
      addResult(
        'M1.4·v1.3.0 · getPeriodRange 三时段形态',
        rMonth.id === 'month' && !!rMonth.start && !!rMonth.end
          && rYear.id === 'year' && !!rYear.start && !!rYear.end
          && rAll.id === 'all' && rAll.start === null && rAll.end === null
          && rMonth.label === '本月' && rYear.label === '本年' && rAll.label === '累计',
        `month=${rMonth.id} year=${rYear.id} all=${rAll.id}`
      );

      // ---- 断言 2：当前时点库存快照
      const stock = await currentStockSnapshot();
      // fabricA(5) + fabricB(3) + fabricC(4) = 12m；accessory 1；tool 1
      addResult(
        'M1.4·v1.3.0 · currentStockSnapshot 三类库存与 1 位小数',
        stock.fabricMeters === 12 && stock.accessoryCount >= 1 && stock.toolCount >= 1,
        `fabricMeters=${stock.fabricMeters} acc=${stock.accessoryCount} tool=${stock.toolCount}`
      );

      // ---- 断言 3：aggregateFabricPurchases（fabricA 10米*30=300, fabricB 5*60=300, fabricC 无initialQty 回退4*20=80）
      const pur = await aggregateFabricPurchases(rMonth);
      const fabc = pur.byMonth.find((m) => m.meters > 0);
      // 期望 totalMeters = 19（10 + 5 + 4）；totalCost = 300 + 300 + 80 = 680
      addResult(
        'M1.4·v1.3.0 · aggregateFabricPurchases 米数 + 花费 + initialQuantity 回退',
        pur.totalMeters === 19 && pur.totalCost === 680
          && !!fabc && fabc.cost === 680 && fabc.fallback === true,
        `meters=${pur.totalMeters} cost=${pur.totalCost} fallback=${fabc && fabc.fallback}`
      );

      // ---- 断言 4：purchaseByCategory 四类花费
      const cat = await purchaseByCategory(rMonth);
      // fabric=680（来自 aggregateFabricPurchases 相同口径），accessory=100*1=100, tool=1*50=50, pattern=1*25=25
      addResult(
        'M1.4·v1.3.0 · purchaseByCategory 四类花费仅物料侧 purchasePrice',
        cat.fabric === 680 && cat.accessory === 100 && cat.tool === 50 && cat.pattern === 25,
        `f=${cat.fabric} a=${cat.accessory} t=${cat.tool} p=${cat.pattern}`
      );

      // ---- 断言 5：净额消耗最大者（fabric A 净额 1 米；fabric B 净额 3 米 → B 最大）
      const topFabric = await netConsumptionTopFabric(rMonth);
      addResult(
        'M1.4·v1.3.0 · netConsumptionTopFabric 净额（consume − delete-garment）取最大者',
        topFabric && topFabric.materialId === sf2 && topFabric.qty === 3 && topFabric.name.indexOf('fabric B') >= 0,
        `top=${topFabric && topFabric.name} qty=${topFabric && topFabric.qty}`
      );

      // ---- 断言 6：成本 avg/max/min（本月 3 条：80/120/200，avg=133.33）
      //   getPeriodRange('month') 作为时段的 completed 列表（不含上月 sgOlder）
      const rForCost = getPeriodRange('month');
      const completedInMonth = await _listCompletedGarmentsInRange(rForCost);
      const cs = _costStats(completedInMonth);
      addResult(
        'M1.4·v1.3.0 · _costStats avg/max/min 仅 totalCost>0 参与核算',
        cs.count === 3 && cs.avg === 133.33 && cs.max && cs.max.cost === 200 && cs.min && cs.min.cost === 80,
        `count=${cs.count} avg=${cs.avg} max=${cs.max && cs.max.cost} min=${cs.min && cs.min.cost}`
      );

      // ---- 断言 7：时段过滤（本月不含上月 999）
      addResult(
        'M1.4·v1.3.0 · 时段过滤：本月不计入上月数据',
        !completedInMonth.some((g) => g.id === sgOlder),
        `month has ${completedInMonth.length} completed, older excluded=${!completedInMonth.some((g) => g.id === sgOlder)}`
      );

      // ---- 断言 8：「汇总」时段含全量
      const rAllSet = getPeriodRange('all');
      const completedAll = await _listCompletedGarmentsInRange(rAllSet);
      addResult(
        'M1.4·v1.3.0 · 汇总时段含全量（含上月）',
        completedAll.some((g) => g.id === sgOlder) && completedAll.some((g) => g.id === sg1),
        `all has ${completedAll.length} completed, includes older=${completedAll.some((g) => g.id === sgOlder)}`
      );

      // ---- 断言 9：未记价统计（再插一条 fabric 无 purchasePrice）
      const sfNoPrice = '__test_m14_noprice_' + nanoid(6);
      await db.materials.add({
        id: sfNoPrice, type: 'fabric', name: '__test m14 no-price fabric', quantity: 1,
        unit: '米', purchaseDate: thisMonthIso, suitableFor: [], tags: [], images: [],
        createdAt: nowTs, updatedAt: nowTs,
      });
      const missing = await countMissingPrice();
      addResult(
        'M1.4·v1.3.0 · countMissingPrice 未记价至少 1 条',
        missing >= 1,
        `missing=${missing}`
      );

      // ---- 断言 10：computeStatsForPeriod 主入口形状
      const pkg = await computeStatsForPeriod('month');
      addResult(
        'M1.4·v1.3.0 · computeStatsForPeriod 形状 + 主字段齐全',
        pkg && pkg.period && pkg.period.id === 'month'
          && typeof pkg.completedCount === 'number'
          && pkg.completedCount === 3
          && Array.isArray(pkg.completedByMonth)
          && Array.isArray(pkg.completedGarments)
          && pkg.topFabric && pkg.topFabric.materialId === sf2
          && pkg.costExtremes && pkg.costExtremes.count === 3
          && pkg.stock && typeof pkg.stock.fabricMeters === 'number'
          && pkg.purchases && typeof pkg.purchases.totalCost === 'number'
          && pkg.categoryShare && typeof pkg.categoryShare.total === 'number'
          && typeof pkg.missingPrice === 'number'
          && !!pkg.caliberStatement && pkg.caliberStatement.indexOf('口径') >= 0,
        `count=${pkg.completedCount} stock=${pkg.stock.fabricMeters} purchase=${pkg.purchases.totalCost}`
      );

      // ---- 断言 11：computeStatsForPeriod 不得修改数据（数量守恒）
      const matsBefore = await db.materials.count();
      const logsBefore = await db.usageLogs.count();
      const gBefore = await db.garments.count();
      await computeStatsForPeriod('year');
      await computeStatsForPeriod('all');
      const matsAfter = await db.materials.count();
      const logsAfter = await db.usageLogs.count();
      const gAfter = await db.garments.count();
      addResult(
        'M1.4·v1.3.0 · computeStatsForPeriod 纯派生不修改数据（materials/usageLogs/garments 守恒）',
        matsBefore === matsAfter && logsBefore === logsAfter && gBefore === gAfter,
        `materials ${matsBefore}->${matsAfter} logs ${logsBefore}->${logsAfter} garments ${gBefore}->${gAfter}`
      );

      // 清理 M1.4 测试残留
      await db.materials.bulkDelete([sf1, sf2, sf3, sa1, st1, sp1, sfNoPrice]);
      await db.garments.bulkDelete([sg1, sg2, sg3, sgOlder]);
      const m14Logs = await db.usageLogs.toArray();
      const m14Ids = m14Logs
        .filter((l) => l.id && l.id.indexOf('__test_m14_') === 0)
        .map((l) => l.id);
      if (m14Ids.length) await db.usageLogs.bulkDelete(m14Ids);
    } catch (e) {
      addResult(
        'M1.4·v1.3.0 · 统计派生专项',
        false,
        e.message + (e.stack ? ' | ' + e.stack.split('\n').slice(0, 4).join(' / ') : '')
      );
    }

    // ---- M1.5 上半：图片上传（PRD D-IM1）+ 设置页 keys ----
    try {
      // 5.x.1 8 表存在性（与基线一致 + 含 images 表）
      const t = await db.table('images').count();
      addResult('M1.5·images 表存在（Blob 存 IndexedDB 必备）', t >= 0, `count=${t}`);

      // 5.x.2 图片 CRUD：上传一张 1x1 PNG → Blob 写入 → 回读 → 字段一致
      // （canvas.toBlob 在 Node 不可用 → 仅断言 schema 字段在写入后回读一致）
      const imgId = '__test_img_' + nanoid(8);
      const fakeBlob = { size: 1024, type: 'image/jpeg' };
      await db.images.put({
        id: imgId,
        blob: fakeBlob,
        originalName: 'test.jpg',
        mimeType: 'image/jpeg',
        entityType: 'garment',
        entityId: '__test_g_placeholder',
        createdAt: nowIso(),
      });
      const imgRow = await db.images.get(imgId);
      addResult(
        'M1.5·images 表 CRUD：写入 + 回读字段一致（entityType/entityId/mimeType）',
        !!imgRow && imgRow.entityType === 'garment' && imgRow.entityId === '__test_g_placeholder' && imgRow.mimeType === 'image/jpeg',
        `id=${imgId}`
      );

      // 5.x.3 backfillImagesEntity 等价语义：更新 entityId='' → 真实 id
      await db.images.update(imgId, { entityId: '__test_g_real_001' });
      const imgBackfilled = await db.images.get(imgId);
      addResult(
        'M1.5·backfillImagesEntity：空 entityId 回填到真实 id 生效',
        imgBackfilled.entityId === '__test_g_real_001',
        `entityId=${imgBackfilled.entityId}`
      );
      await db.images.delete(imgId);

      // 5.x.4 设置页扩展键（PRD §10.8 + M1.5 上半）：sewing_years / github_token / github_username / pat_expires_at
      const keys = ['sewing_years', 'github_token', 'github_username', 'pat_expires_at', 'last_sync_at'];
      for (const k of keys) {
        const row = await db.settings.get(k);
        addResult(`M1.5·settings.${k} 首启种子存在`, !!row && row.value !== undefined, `value=${row ? row.value : 'null'}`);
      }

      // 5.x.5 设置页 CRUD 往返：user_name 改 → 回读
      const prevName = (await db.settings.get('user_name')).value;
      await db.settings.put({ key: 'user_name', value: '__test_name_' + nanoid(4), updatedAt: nowIso() });
      const readBack = (await db.settings.get('user_name')).value;
      const userNameOk = readBack.indexOf('__test_name_') === 0;
      // 还原
      await db.settings.put({ key: 'user_name', value: prevName, updatedAt: nowIso() });
      addResult('M1.5·settings.user_name CRUD 往返（写→读一致）', userNameOk, `prev=${prevName} now=${readBack}`);

      // 5.x.6 presets 3 可编辑组（patternBrands/fabricBrands/accessoryTags）CRUD 往返
      const presetsRow = await db.settings.get('presets');
      const presets = presetsRow ? JSON.parse(presetsRow.value) : null;
      const presetsOk =
        presets &&
        Array.isArray(presets.patternBrands) &&
        presets.patternBrands.indexOf('其他') >= 0 &&
        Array.isArray(presets.fabricBrands) &&
        presets.fabricBrands.indexOf('其他') >= 0 &&
        Array.isArray(presets.accessoryTags) &&
        presets.accessoryTags.indexOf('松紧') >= 0;
      addResult('M1.5·presets 3 可编辑组（patternBrands/fabricBrands/accessoryTags）结构合法', presetsOk,
        `pb=${presets && presets.patternBrands.length} fb=${presets && presets.fabricBrands.length} at=${presets && presets.accessoryTags.length}`);

      // 5.x.7 presets 5 只读组存在（patternStyles/patternAudiences/patternSizes/fabricWidths/accessoryWidths）
      const readonlyOk =
        presets &&
        Array.isArray(presets.patternStyles) && presets.patternStyles.indexOf('半身裙') >= 0 &&
        Array.isArray(presets.patternAudiences) &&
        Array.isArray(presets.patternSizes) && presets.patternSizes.indexOf('M') >= 0 &&
        Array.isArray(presets.fabricWidths) &&
        Array.isArray(presets.accessoryWidths);
      addResult('M1.5·presets 5 只读组（patternStyles/patternAudiences/patternSizes/fabricWidths/accessoryWidths）存在', readonlyOk);

      // 5.x.8 backup_interval 候选值集合（PRD §10.8 设置·备份 自动备份频率）
      const bi = (await db.settings.get('backup_interval')).value;
      const biOk = ['off', 'daily', 'weekly', 'manual'].indexOf(bi) >= 0 || bi === 'daily';
      addResult('M1.5·settings.backup_interval 首启默认 daily', biOk, `value="${bi}"`);

      // 5.x.9 任务模板：首启 3 个（半身裙/上衣基础/连衣裙）— v0.6 §1.5 冻结
      const tmpls = await db.taskTemplates.toArray();
      const tmplNames = tmpls.map((t) => t.name).slice().sort();
      const expectedT = ['半身裙', '上衣基础', '连衣裙'].slice().sort();
      addResult(
        'M1.5·任务模板首启种子与 v0.6 §1.5 冻结一致',
        JSON.stringify(tmplNames) === JSON.stringify(expectedT),
        `actual=${tmplNames.join(',')} expected=${expectedT.join(',')}`
      );
    } catch (e) {
      addResult('M1.5·设置页/图片上传断言段', false, e.message + (e.stack ? ' | ' + e.stack.split('\n').slice(0, 3).join(' / ') : ''));
    }

    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    return { passed, failed, results };
  }

  /* ============ 5.5 M1.4 统计派生（PRD §10.6 + 数据模型 v0.6 §4） ============ */

  /**
   * 统计时段枚举（PRD §10.6 三段时间卡）
   *   - month: 当前自然月 [startOfMonth, endOfMonth]
   *   - year:  当前自然年 [startOfYear, endOfYear]
   *   - all:   全部时间（-∞, +∞）
   * @param {'month'|'year'|'all'} period
   * @returns {{id:string,label:string,shortLabel:string,start:(string|null),end:(string|null)}}
   */
  function getPeriodRange(period) {
    const now = new Date();
    if (period === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return {
        id: 'month',
        label: '本月',
        shortLabel: '本月',
        start: _startOfDayIso(start),
        end: _endOfDayIso(end),
      };
    }
    if (period === 'year') {
      const start = new Date(now.getFullYear(), 0, 1);
      const end = new Date(now.getFullYear(), 11, 31);
      return {
        id: 'year',
        label: '本年',
        shortLabel: '本年',
        start: _startOfDayIso(start),
        end: _endOfDayIso(end),
      };
    }
    return { id: 'all', label: '累计', shortLabel: '累计', start: null, end: null };
  }

  function _formatMonth(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }
  function _startOfDayIso(d) {
    const local = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    return local.toISOString();
  }
  function _endOfDayIso(d) {
    const local = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    return local.toISOString();
  }

  /**
   * 时段内已完成 garments（status=completed && completionDate ∈ [start,end]）
   * @returns {Promise<Garment[]>}
   */
  async function _listCompletedGarmentsInRange(range) {
    const all = await db.garments.toArray();
    return all
      .filter((g) => g.status === 'completed' && typeof g.completionDate === 'string')
      .filter((g) => {
        if (!range.start || !range.end) return true;
        return g.completionDate >= range.start && g.completionDate <= range.end;
      });
  }

  /**
   * 将 ISO 时间字符串按月分桶计数（仅桶内、不限时段）
   * @param {Array<{date:string}>} items
   */
  function _bucketByMonth(items, range) {
    const buckets = new Map();
    for (const it of items) {
      if (!it.date) continue;
      if (range.start && it.date < range.start) continue;
      if (range.end && it.date > range.end) continue;
      const d = new Date(it.date);
      if (isNaN(d.getTime())) continue;
      const key = _formatMonth(d);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    return Array.from(buckets.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([month, count]) => ({ month, count }));
  }

  /**
   * 当前时点库存快照（不随切换时段变化；按 D-WH8 口径）
   * @returns {Promise<{fabricMeters:number, accessoryCount:number, toolCount:number}>}
   */
  async function currentStockSnapshot() {
    const [fabrics, accs, tools] = await Promise.all([
      db.materials.where('type').equals('fabric').toArray(),
      db.materials.where('type').equals('accessory').count(),
      db.materials.where('type').equals('tool').count(),
    ]);
    const fabricMeters = fabrics.reduce((s, f) => s + (Number(f.quantity) || 0), 0);
    return {
      fabricMeters: Math.round(fabricMeters * 10) / 10,
      accessoryCount: accs,
      toolCount: tools,
    };
  }

  /**
   * 时段内 fabric 采购聚合（米数 + 花费 + 按月分桶）
   *   - 优先 initialQuantity，缺失回退 quantity；回退月标 fallback=true
   *   - 花费仅口径存在（purchasePrice>0）者
   * @param {{start:(string|null),end:(string|null)}} range
   */
  async function aggregateFabricPurchases(range) {
    const allFabric = await db.materials.where('type').equals('fabric').toArray();
    const inPeriod = allFabric.filter((f) => {
      if (!range.start || !range.end) return true;
      if (!f.purchaseDate) return false;
      return f.purchaseDate >= range.start && f.purchaseDate <= range.end;
    });
    let totalMeters = 0;
    let totalCost = 0;
    const byMonthMap = new Map();
    for (const f of inPeriod) {
      const fallback = !(typeof f.initialQuantity === 'number' && f.initialQuantity > 0);
      const qty = fallback ? Number(f.quantity) || 0 : f.initialQuantity;
      if (qty <= 0) continue;
      const price = Number(f.purchasePrice);
      let cost = 0;
      if (Number.isFinite(price) && price > 0) cost = Math.round(price * qty * 100) / 100;
      totalMeters = Math.round((totalMeters + qty) * 100) / 100;
      totalCost = Math.round((totalCost + cost) * 100) / 100;
      const monthKey = f.purchaseDate ? _formatMonth(new Date(f.purchaseDate)) : null;
      if (monthKey) {
        const cur = byMonthMap.get(monthKey) || { month: monthKey, meters: 0, cost: 0, fallback: false };
        cur.meters = Math.round((cur.meters + qty) * 100) / 100;
        cur.cost = Math.round((cur.cost + cost) * 100) / 100;
        cur.fallback = cur.fallback || fallback;
        byMonthMap.set(monthKey, cur);
      }
    }
    return {
      byMonth: Array.from(byMonthMap.values()).sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)),
      totalMeters,
      totalCost,
    };
  }

  /**
   * 时段内四类采购花费（仅物料侧 purchasePrice，pattern 仅取物料侧）
   * @returns {Promise<{fabric:number,accessory:number,tool:number,pattern:number}>}
   */
  async function purchaseByCategory(range) {
    const mats = await db.materials.toArray();
    const inPeriod = mats.filter((m) => {
      if (!range.start || !range.end) return true;
      if (!m.purchaseDate) return false;
      return m.purchaseDate >= range.start && m.purchaseDate <= range.end;
    });
    const out = { fabric: 0, accessory: 0, tool: 0, pattern: 0 };
    for (const m of inPeriod) {
      if (!Object.prototype.hasOwnProperty.call(out, m.type)) continue;
      const qty = (typeof m.initialQuantity === 'number' && m.initialQuantity > 0)
        ? m.initialQuantity
        : Number(m.quantity);
      const price = Number(m.purchasePrice);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (!Number.isFinite(qty) || qty <= 0) continue;
      out[m.type] = Math.round((out[m.type] + price * qty) * 100) / 100;
    }
    return out;
  }

  /**
   * 时段内 fabric 净额消耗（consume − delete-garment）取最大者
   *   D-WH6：撤销完工不写流水，净额派生即可；删除成衣的回补取代撤销回补
   */
  async function netConsumptionTopFabric(range) {
    const logs = await db.usageLogs.toArray();
    const mats = await db.materials.toArray();
    const matMap = new Map(mats.map((m) => [m.id, m]));
    const net = new Map();
    for (const l of logs) {
      if (l.kind !== 'consume' && l.kind !== 'delete-garment') continue;
      if (range.start && l.createdAt < range.start) continue;
      if (range.end && l.createdAt > range.end) continue;
      const mat = matMap.get(l.materialId);
      if (!mat || mat.type !== 'fabric') continue;
      const sign = l.kind === 'consume' ? 1 : -1;
      const prev = net.get(l.materialId) || { qty: 0, name: mat.name };
      prev.qty = Math.round((prev.qty + sign * (Number(l.quantity) || 0)) * 100) / 100;
      prev.name = mat.name;
      net.set(l.materialId, prev);
    }
    let max = null;
    for (const [materialId, v] of net.entries()) {
      if (v.qty <= 0) continue;
      if (!max || v.qty > max.qty) max = { materialId, name: v.name, qty: v.qty };
    }
    return max;
  }

  /**
   * 时段内已核算成衣成本：avg / max / min（仅 totalCost>0 参与）
   * @param {Garment[]} completedList
   */
  function _costStats(completedList) {
    const list = completedList
      .filter((g) => typeof g.totalCost === 'number' && g.totalCost > 0)
      .map((g) => ({
        id: g.id,
        name: g.name,
        cost: g.totalCost,
        completionDate: g.completionDate,
      }));
    if (list.length === 0) return { avg: 0, max: null, min: null, count: 0 };
    let sum = 0;
    let max = list[0];
    let min = list[0];
    for (const it of list) {
      sum += it.cost;
      if (it.cost > max.cost) max = it;
      if (it.cost < min.cost) min = it;
    }
    return {
      avg: Math.round((sum / list.length) * 100) / 100,
      max,
      min,
      count: list.length,
    };
  }

  /**
   * 未记采购价的物料条数（purchasePrice 非正有限数）
   * @returns {Promise<number>}
   */
  async function countMissingPrice() {
    const mats = await db.materials.toArray();
    let n = 0;
    for (const m of mats) {
      if (!['fabric', 'accessory', 'tool', 'pattern'].includes(m.type)) continue;
      const p = Number(m.purchasePrice);
      if (!Number.isFinite(p) || p <= 0) n += 1;
    }
    return n;
  }

  /**
   * M1.4 统计主入口（PRD §10.6 + 数据模型 v0.6 §4 口径）
   * 不修改任何数据；纯派生计算。所有指标来源现有 IndexedDB/Dexie 数据层。
   * @param {'month'|'year'|'all'} period
   */
  async function computeStatsForPeriod(period) {
    const range = getPeriodRange(period);
    // --- 战果区 ---
    const completedList = await _listCompletedGarmentsInRange(range);
    const completedSorted = [...completedList].sort((a, b) =>
      (a.completionDate < b.completionDate ? 1
        : a.completionDate > b.completionDate ? -1 : 0));
    const completedByMonth = _bucketByMonth(
      completedSorted.map((g) => ({ date: g.completionDate })),
      { start: null, end: null },
    );
    const costStats = _costStats(completedList);
    const topFabric = await netConsumptionTopFabric(range);
    // --- 库存与采购 ---
    const stock = await currentStockSnapshot();
    const purchases = await aggregateFabricPurchases(range);
    const categoryShare = await purchaseByCategory(range);
    const missingPrice = await countMissingPrice();
    const totalCategorySpend = Math.round(
      (categoryShare.fabric + categoryShare.accessory + categoryShare.tool + categoryShare.pattern) * 100
    ) / 100;

    return {
      period: {
        id: range.id,
        label: range.label,
        shortLabel: range.shortLabel,
        start: range.start,
        end: range.end,
        hasRange: !!range.start,
      },
      // 战果
      completedCount: completedList.length,
      completedByMonth,
      completedGarments: completedSorted.map((g) => ({
        id: g.id,
        name: g.name,
        totalCost: typeof g.totalCost === 'number' ? g.totalCost : 0,
        completionDate: g.completionDate,
      })),
      topFabric,
      costExtremes: {
        avg: costStats.avg,
        max: costStats.max,
        min: costStats.min,
        count: costStats.count,
      },
      // 库存与采购
      stock,
      purchases,
      categoryShare: { ...categoryShare, total: totalCategorySpend },
      missingPrice,
      // 口径声明（§4.3 固定文案）
      caliberStatement: '成本口径说明：单件成本 = 完工快照（用料×登记时单价 + 纸样价），反映作品本身花费；采购花费 = 采购现金流（购入量×购入价），含未用完库存。两者不可互相比较或混算。',
    };
  }

  /* ============ 6. 通用工具：清理测试残留 ============ */
  async function cleanupTestData() {
    const prefix = '__test_';
    for (const t of ['materials', 'garments', 'usageLogs', 'tasks']) {
      const all = await db.table(t).toArray();
      const ids = all.filter((r) => r.id && r.id.startsWith(prefix)).map((r) => r.id);
      if (ids.length) await db.table(t).bulkDelete(ids);
    }
  }

  /* ============ 导出 ============ */
  global.SS = global.SS || {};
  global.SS.db = {
    db,
    seedIfFirstRun,
    runDataLayerSelfTest,
    cleanupTestData,
    // M1.2 物料侧能力（本期实现，M1.3 接入）
    recordLoss,
    adjustMaterialQuantity,
    consumeOnAssociate,
    revertOnUnassociate,
    revertOnDeleteGarment,
    // M1.3 成衣库存协调（PRD §0.8 / 冻结文档 §1.10「关联即扣、删除即还原」）
    buildSnapshotFromSelections,
    diffSelections,
    createGarmentWithMaterials,
    updateGarmentWithMaterials,
    deleteGarmentWithRestore,
    markGarmentCompleted,
    unassociateGarmentMaterials,
    // M1.4 统计派生（PRD §10.6 + 数据模型 v0.6 §4 口径；纯派生、不修改数据）
    getPeriodRange,
    currentStockSnapshot,
    aggregateFabricPurchases,
    purchaseByCategory,
    netConsumptionTopFabric,
    countMissingPrice,
    computeStatsForPeriod,
    // 导出供其它模块参考（不修改）
    SETTINGS_KEYS,
    DEFAULT_PRESETS,
    SEED_TASK_TEMPLATES,
  };
})(window);