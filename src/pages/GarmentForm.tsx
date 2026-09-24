// src/pages/GarmentForm.tsx — 成衣表单页（新增/编辑）
// PRD §8.7；任务 3-4/3-5/3-7/3-8。
// UI 基线：demo/src/pages/GarmentForm.jsx
// 不复刻清单（PRD §8.7 缺陷表）：
//   #1 手动新增强制 completed（本版给 planning/in_progress 两值 chip）
//   #2 款式预设错（本版用 DM §4.9.6 的 12 项）
//   #3 编辑时完工日期静默清掉（本版不提供完工日期控件）
//   #4 超库存自动封顶（本版拦截不静默改写）
//   #5 校验失败不移动焦点（本版移到第一个出错字段）
//   #6 冗余 patternName 副本（本版反查）
//   #7 整体重建 materialSnapshot（本版 append+退休）
//   #8 unit 兜底「个」+tool 进快照（本版原样取 unit，tool 不进）
//   #9 分类按 30 字校验（本版 20 字，标签「款式」）
//   #10 无人群控件（本版同样不做）
// S2 教训：
//   P0-1 编辑态 useLiveQuery 异步返回后必须重同步表单 state
//   P1-3 超库存不静默改写用户输入（提交时拦截）
//   P2-3 删图只改 form state，保存时对账
// 任务 3-8：编辑不碰 status，已完工不回退，状态控件只读
//
// S3-FIX-B 调整：
//   - P1-1：选择器改为页内浮层（不卸载表单）；demo 同构做法：onOpenMaterialPicker/onOpenPatternPicker 回调
//     实际实现：渲染 MaterialPickerPage/PatternPickerPage 为 fixed 覆盖层，回调写回表单状态。
//   - P1-2：编辑态打开物料选择器传入并回显当前已选 materialIds 与用量（选中态+数量）
//   - P2-3：images[0] 是 images 表主键 id，patternObj 的图片需经 images 表解析 blob URL
//   - P2-5 #3：校验失败按 errors 键序聚焦第一个出错字段（不再只聚焦 name）
//   - 状态 chip：上游 FIX-A 已放行 planning；新建两值 chip 选定值传给 garmentService（status 字段随 data 进入）
//
// S3-FIX-C 调整：
//   - P1-1 回归 R1：选择器浮层为 form-overlay 内部 fixed 子树，浮层内点击会冒泡到外层
//     <div className="form-overlay" onClick={handleCancel}> → 触发取消、整表丢失。
//     修复：物料/纸样两处浮层渲染外加一层 <div onClick={stopPropagation}> 守卫，阻断冒泡链；
//     浮层外的表单背景区原有取消行为不变；表单内的 form-sheet 仍由自身 stopPropagation 维持。

import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { GarmentStatus, Material, MaterialType } from '@/db/types';
import {
  createGarmentWithMaterials,
  updateGarmentWithMaterials,
  type MaterialSelection,
} from '@/services/garmentService';
import { toast } from '@/store/toastStore';
import ImageGallery from '@/components/ImageGallery';
import {
  UserIconCatFabric,
  UserIconCatAccessory,
  UserIconCatPattern,
} from '@/components/UserIcons';
import MaterialPickerPage from '@/pages/pickers/MaterialPickerPage';
import PatternPickerPage from '@/pages/pickers/PatternPickerPage';

// ===================== 常量 =====================

const STYLE_PRESETS = [
  '连衣裙', '衬衫', '裤子', '外套', 'T恤', '半裙', '大衣', '旗袍', '上衣',
  '背带裙', '背心', '发饰',
];

const STATUS_LABEL: Record<GarmentStatus, string> = {
  planning: '规划中',
  in_progress: '制作中',
  completed: '已完成',
};

// ===================== 辅助 =====================

function joinNonEmpty(parts: (string | undefined | null)[]): string {
  return parts.map((p) => (p ?? '').trim()).filter(Boolean).join(' · ');
}

function fmtCurrency(v: number): string {
  return `¥${v.toFixed(2)}`;
}

function fmtQtyUnit(qty: number, unit: string): string {
  return `×${qty}${unit}`;
}

/** P2-3：图片 blob URL 解析（与 GarmentDetail/GarmentsPage 同构）。 */
function useBlobUrl(imageId: string | undefined): string {
  const imgRec = useLiveQuery(
    () => (imageId ? db.images.get(imageId) : undefined),
    [imageId],
  );
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (imgRec?.blob) {
      const url = URL.createObjectURL(imgRec.blob);
      setSrc(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    }
    setSrc('');
  }, [imgRec]);
  return src;
}

/** P2-3：单张缩略图；images[0] 是 images 表主键 id，需经 images 表解析。 */
function PatternThumb({ pattern }: { pattern: Material }) {
  const blobUrl = useBlobUrl(pattern.images?.[0]);
  if (blobUrl) {
    return <img src={blobUrl} alt={pattern.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />;
  }
  return <UserIconCatPattern style={{ width: '22px', height: '22px', color: 'var(--accent)' }} />;
}

// ===================== 组件 =====================

export default function GarmentForm() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = !!id;

  // 数据层
  const rawMaterials = useLiveQuery(() => db.materials.toArray(), []);
  const allMaterials = useMemo(() => rawMaterials ?? [], [rawMaterials]);
  const rawGarments = useLiveQuery(() => db.garments.toArray(), []);
  const allGarments = useMemo(() => rawGarments ?? [], [rawGarments]);
  const editGarment = isEdit ? allGarments.find((g) => g.id === id) : undefined;

  // S2 P0-1 同步标记
  const [synced, setSynced] = useState(false);

  // 初始用量引用（编辑态上限 = 库存 + 本成衣已用量）
  const initialQtysRef = useRef<Record<string, number>>({});

  // 表单
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<GarmentStatus>('in_progress');
  const [size, setSize] = useState('');
  const [recipient, setRecipient] = useState('');
  const [notes, setNotes] = useState('');
  const [imageIds, setImageIds] = useState<string[]>([]);
  const [materialIds, setMaterialIds] = useState<string[]>([]);
  const [materialQtys, setMaterialQtys] = useState<Record<string, string>>({});
  const [patternId, setPatternId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // ---- S2 P0-1：编辑态同步初始值 ----
  useEffect(() => {
    if (isEdit && editGarment) {
      const g = editGarment;
      setName(g.name);
      setCategory(g.category);
      setStatus(g.status);
      setSize(g.size);
      setRecipient(g.recipient);
      setNotes(g.notes);
      setImageIds([...g.images]);
      setPatternId(g.patternId ?? '');

      const activeRows = g.materialSnapshot.filter((r) => !('retiredAt' in r));
      const ids = activeRows.map((r) => r.materialId);
      setMaterialIds(ids);
      const qtys: Record<string, string> = {};
      const ref: Record<string, number> = {};
      for (const row of activeRows) {
        qtys[row.materialId] = String(row.quantityUsed);
        ref[row.materialId] = row.quantityUsed;
      }
      setMaterialQtys(qtys);
      initialQtysRef.current = ref;
    }
    setSynced(true);
  }, [isEdit, editGarment]);

  // ---- P1-1：选择器改为页内浮层（不卸载表单），state 在本组件内维护 ----
  // overlay 形态：MaterialPickerPage/PatternPickerPage 渲染为 fixed 全屏覆盖层，
  // 关闭/确认通过回调写回表单状态。
  const [pickerState, setPickerState] = useState<
    | { kind: 'material'; type: MaterialType }
    | { kind: 'pattern' }
    | null
  >(null);

  // ---- P1-2：物料选择器回传合并 ----
  const handleMaterialPickerConfirm = useCallback(
    (ids: string[], returnedQtys: Record<string, string>) => {
      const pType = pickerState && pickerState.kind === 'material' ? pickerState.type : 'fabric';
      setMaterialIds((prev) => {
        // 保留另一类型，替换本类型
        const kept = prev.filter((mid) =>
          allMaterials.some((m) => m.id === mid && m.type !== pType),
        );
        return [...ids, ...kept];
      });
      setMaterialQtys((prev) => {
        const next: Record<string, string> = {};
        // 保留另一类型的 qty
        for (const mid of Object.keys(prev)) {
          const m = allMaterials.find((mm) => mm.id === mid);
          if (m && m.type !== pType) {
            const qty = prev[mid];
            if (qty !== undefined) next[mid] = qty;
          }
        }
        // 用选择器返回的 qty 覆盖本类型
        for (const mid of ids) {
          if (returnedQtys[mid]) next[mid] = returnedQtys[mid];
        }
        return next;
      });
      setPickerState(null);
    },
    [pickerState, allMaterials],
  );

  // ---- 纸样选择器回传 ----
  const handlePatternPickerSelect = useCallback((pattern: Material) => {
    setPatternId(pattern.id);
    setPickerState(null);
  }, []);

  // ---- 字段错误清除 ----
  const clearError = useCallback((field: string) => {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  // ---- 打开选择器（overlay 模式，不导航） ----
  const openMaterialPicker = useCallback((type: MaterialType) => {
    setPickerState({ kind: 'material', type });
  }, []);

  const openPatternPicker = useCallback(() => {
    setPickerState({ kind: 'pattern' });
  }, []);

  // ---- 缓存 ----
  const materialMap = useMemo(() => {
    const m = new Map<string, Material>();
    for (const mat of allMaterials) m.set(mat.id, mat);
    return m;
  }, [allMaterials]);

  const selectedFabrics = useMemo(
    () => materialIds.filter((mid) => materialMap.get(mid)?.type === 'fabric'),
    [materialIds, materialMap],
  );

  const selectedAccessories = useMemo(
    () => materialIds.filter((mid) => materialMap.get(mid)?.type === 'accessory'),
    [materialIds, materialMap],
  );

  const patternObj = useMemo(
    () => (patternId ? allMaterials.find((m) => m.id === patternId) ?? null : null),
    [patternId, allMaterials],
  );

  // ---- 成本试算 ----
  const costPreview = useMemo(() => {
    let totalMaterials = 0;
    let registeredCount = 0;
    let materialTotal = 0;
    const items: {
      id: string;
      name: string;
      qty: number;
      unit: string;
      price: number;
      subtotal: number;
    }[] = [];

    for (const mid of materialIds) {
      const mat = materialMap.get(mid);
      if (!mat) continue;
      if (mat.type === 'tool') continue;
      totalMaterials++;
      const qtyNum = parseFloat(materialQtys[mid] ?? '') || 0;
      const price = mat.purchasePrice ?? 0;
      const subtotal = qtyNum > 0 ? +(qtyNum * price).toFixed(2) : 0;
      items.push({ id: mid, name: mat.name, qty: qtyNum, unit: mat.unit, price, subtotal });
      if (qtyNum > 0) {
        materialTotal += subtotal;
        registeredCount++;
      }
    }

    const patternPrice = patternObj?.purchasePrice ?? 0;
    const total = +(+materialTotal + patternPrice).toFixed(2);

    return {
      items,
      materialTotal: +materialTotal.toFixed(2),
      patternPrice,
      total,
      registeredCount,
      totalMaterials,
    };
  }, [materialIds, materialQtys, materialMap, patternObj]);

  // ---- 库存限制（编辑态加回已用量） ----
  const stockLimit = useCallback(
    (matId: string): number => {
      const mat = materialMap.get(matId);
      if (!mat) return 0;
      const currentStock = mat.quantity;
      if (isEdit) {
        const initialUsed = initialQtysRef.current[matId] ?? 0;
        return +(currentStock + initialUsed).toFixed(2);
      }
      return currentStock;
    },
    [materialMap, isEdit],
  );

  // ---- 字段引用：用于按 errors 键序聚焦第一个出错字段（P2-5 #3） ----
  const sizeRef = useRef<HTMLInputElement>(null);
  const recipientRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const categoryRef = useRef<HTMLInputElement>(null);

  // ---- 校验 ----
  const validate = useCallback((): boolean => {
    const errs: Record<string, string> = {};
    const trimmedName = name.trim();
    if (!trimmedName) errs.name = '名称不能为空';
    else if (trimmedName.length > 50) errs.name = '名称不能超过 50 字';
    if (category.length > 20) errs.category = '款式不能超过 20 字';
    if (size.length > 20) errs.size = '尺码不能超过 20 字';
    if (recipient.length > 30) errs.recipient = '穿着者不能超过 30 字';
    if (notes.length > 500) errs.notes = '备注不能超过 500 字';

    for (const mid of materialIds) {
      const mat = materialMap.get(mid);
      if (!mat) continue;
      const qtyStr = materialQtys[mid] ?? '';
      const qtyNum = parseFloat(qtyStr);
      if (isNaN(qtyNum) || qtyNum <= 0) continue;
      const limit = stockLimit(mid);
      if (qtyNum > limit) {
        errs[`qty_${mid}`] = `「${mat.name}」用量超过库存（${limit}${mat.unit}）`;
      }
    }

    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      // P2-5 #3：按 errors 键序聚焦第一个出错字段（不仅聚焦 name）
      const firstKey = Object.keys(errs)[0];
      if (firstKey === 'name') nameRef.current?.focus();
      else if (firstKey === 'category') categoryRef.current?.focus();
      else if (firstKey === 'size') sizeRef.current?.focus();
      else if (firstKey === 'recipient') recipientRef.current?.focus();
      else if (firstKey === 'notes') notesRef.current?.focus();
      // qty_xxx 不聚焦（无对应输入框，错误已在 chip 旁渲染）
      return false;
    }
    return true;
  }, [name, category, size, recipient, notes, materialIds, materialQtys, materialMap, stockLimit]);

  // ---- 保存 ----
  const handleSave = useCallback(async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const selections: MaterialSelection[] = [];
      for (const mid of materialIds) {
        const mat = materialMap.get(mid);
        if (!mat) continue;
        if (mat.type === 'tool') continue;
        const qtyNum = parseFloat(materialQtys[mid] ?? '') || 0;
        if (qtyNum <= 0) continue;
        selections.push({ materialId: mid, quantity: qtyNum });
      }

      if (isEdit && id) {
        const g = editGarment;
        const prevSelections: MaterialSelection[] = g
          ? g.materialSnapshot
              .filter((r) => !('retiredAt' in r))
              .map((r) => ({ materialId: r.materialId, quantity: r.quantityUsed }))
          : [];
        await updateGarmentWithMaterials({
          id,
          data: {
            name: name.trim(),
            category,
            size,
            recipient,
            notes,
            images: imageIds,
            patternId,
          },
          prevSelections,
          newSelections: selections,
        });
        toast('成衣已更新');
        navigate(`/garments/${id}`, { replace: true });
      } else {
        await createGarmentWithMaterials({
          data: {
            name: name.trim(),
            category,
            status, // 状态 chip：planning/in_progress 选定值传给服务层
            size,
            recipient,
            notes,
            images: imageIds,
            patternId,
            tags: [],
            forWhom: '',
            startDate: '',
            plannedDate: '',
            sourceRef: undefined,
            totalCost: null,
            completionDate: '',
          },
          selections,
        });
        toast('成衣已添加');
        navigate('/garments', { replace: true });
      }
    } catch (err: unknown) {
      // 保存路径任何失败必须 toast 中文错误（不得静默）
      toast(err instanceof Error ? err.message : '保存失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }, [
    validate, materialIds, materialQtys, materialMap, isEdit, id, editGarment,
    name, category, status, size, recipient, notes, imageIds, patternId, navigate,
  ]);

  const handleCancel = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  // ---- P1-2：传入当前已选 materialIds / qtys 给 overlay 选择器 ----
  const overlaySelectedForType = useCallback(
    (type: MaterialType): string[] => materialIds.filter((mid) => materialMap.get(mid)?.type === type),
    [materialIds, materialMap],
  );

  if (!synced) return null;

  const showCost = materialIds.length > 0 || !!patternId;

  return (
    <div className="form-overlay" onClick={handleCancel}>
      <div className="form-sheet" onClick={(e) => e.stopPropagation()} style={{ maxHeight: '90%' }}>
        {/* 顶部 */}
        <div className="form-header">
          <button className="cancel" onClick={handleCancel}>取消</button>
          <div className="title">{isEdit ? '编辑成衣' : '新增成衣'}</div>
          <button
            className="cancel"
            style={{ color: 'var(--primary)', fontWeight: 600 }}
            onClick={handleSave}
            disabled={submitting}
          >
            {submitting ? '保存中…' : '保存'}
          </button>
        </div>

        <div className="form-body">
          {/* ① 图片 */}
          <ImageGallery
            entityType="garment"
            entityId={isEdit ? (id ?? '') : ''}
            imageIds={imageIds}
            onImageIdsChange={setImageIds}
            maxImages={5}
          />

          {/* ② 基本信息 */}
          <div className="garment-form-section">
            <div className="garment-form-section-title">基本信息</div>

            {/* 款式 */}
            <div className="form-group">
              <label className="form-label">款式</label>
              <div className="tag-chips">
                {STYLE_PRESETS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={'tag-chip' + (category === s ? ' active' : '')}
                    onClick={() => { setCategory(category === s ? '' : s); clearError('category'); }}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <input
                ref={categoryRef}
                className={'form-input' + (errors.category ? ' error' : '')}
                style={errors.category ? { borderColor: 'var(--destructive)' } : {}}
                value={category}
                placeholder="或输入自定义款式"
                onChange={(e) => { setCategory(e.target.value); clearError('category'); }}
                maxLength={20}
              />
              {errors.category && <div className="form-error">{errors.category}</div>}
            </div>

            {/* 名称 */}
            <div className="form-group">
              <label className="form-label">名称 *</label>
              <input
                ref={nameRef}
                className={'form-input' + (errors.name ? ' error' : '')}
                style={errors.name ? { borderColor: 'var(--destructive)' } : {}}
                value={name}
                placeholder="如：樱粉雪纺连衣裙"
                onChange={(e) => { setName(e.target.value); clearError('name'); }}
                maxLength={50}
              />
              {errors.name && <div className="form-error">{errors.name}</div>}
            </div>

            {/* 尺码 + 穿着者 */}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">尺码</label>
                <input
                  ref={sizeRef}
                  className={'form-input' + (errors.size ? ' error' : '')}
                  style={errors.size ? { borderColor: 'var(--destructive)' } : {}}
                  value={size}
                  placeholder="如 M / S / 均码"
                  onChange={(e) => { setSize(e.target.value); clearError('size'); }}
                  maxLength={20}
                />
                {errors.size && <div className="form-error">{errors.size}</div>}
              </div>
              <div className="form-group">
                <label className="form-label">穿着者</label>
                <input
                  ref={recipientRef}
                  className={'form-input' + (errors.recipient ? ' error' : '')}
                  style={errors.recipient ? { borderColor: 'var(--destructive)' } : {}}
                  value={recipient}
                  placeholder="如 自己 / 妈妈"
                  onChange={(e) => { setRecipient(e.target.value); clearError('recipient'); }}
                  maxLength={30}
                />
                {errors.recipient && <div className="form-error">{errors.recipient}</div>}
              </div>
            </div>

            {/* 状态 */}
            <div className="form-group">
              <label className="form-label">状态</label>
              {isEdit ? (
                <div style={{ padding: '8px 0' }}>
                  <span className="tag-chip active" style={{ cursor: 'default', opacity: 0.8 }}>
                    {STATUS_LABEL[status]}
                  </span>
                  {status === 'completed' && (
                    <p style={{ color: 'var(--secondary-foreground)', fontSize: '12px', marginTop: '4px' }}>
                      已完工的成衣不能改回未完工
                    </p>
                  )}
                </div>
              ) : (
                <div className="tag-chips">
                  {(['planning', 'in_progress'] as GarmentStatus[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={'tag-chip' + (status === s ? ' active' : '')}
                      onClick={() => setStatus(s)}
                    >
                      {STATUS_LABEL[s]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ③ 关联面料 */}
          <div className="garment-form-section">
            <div className="garment-form-section-title">
              关联面料（{selectedFabrics.length}）
            </div>
            {selectedFabrics.length > 0 && (
              <div className="linked-materials-preview">
                {selectedFabrics.map((mid) => {
                  const m = materialMap.get(mid);
                  if (!m) return null;
                  const qty = materialQtys[mid];
                  const qtyErr = errors[`qty_${mid}`];
                  return (
                    <div key={mid}>
                      <div className="linked-material-chip">
                        <UserIconCatFabric style={{ width: '14px', height: '14px', marginRight: '4px' }} />
                        <span>{m.name}</span>
                        {qty && (
                          <span style={{
                            color: qtyErr ? 'var(--destructive)' : 'var(--secondary-foreground)',
                            marginLeft: '4px', fontSize: '12px',
                          }}>
                            {fmtQtyUnit(parseFloat(qty) || 0, m.unit)}
                          </span>
                        )}
                      </div>
                      {qtyErr && <div className="form-error" style={{ marginLeft: '18px', fontSize: '11px' }}>{qtyErr}</div>}
                    </div>
                  );
                })}
              </div>
            )}
            <button type="button" className="pattern-picker-trigger" onClick={() => openMaterialPicker('fabric')}>
              <span className="pattern-picker-icon">{selectedFabrics.length > 0 ? '✎' : '+'}</span>
              <span>{selectedFabrics.length > 0 ? '管理面料' : '去添加面料'}</span>
            </button>
          </div>

          {/* ④ 关联辅料 */}
          <div className="garment-form-section">
            <div className="garment-form-section-title">
              关联辅料（{selectedAccessories.length}）
            </div>
            {selectedAccessories.length > 0 && (
              <div className="linked-materials-preview">
                {selectedAccessories.map((mid) => {
                  const m = materialMap.get(mid);
                  if (!m) return null;
                  const qty = materialQtys[mid];
                  const qtyErr = errors[`qty_${mid}`];
                  return (
                    <div key={mid}>
                      <div className="linked-material-chip">
                        <UserIconCatAccessory style={{
                          width: '14px', height: '14px', marginRight: '4px', color: 'var(--accent)',
                        }} />
                        <span>{m.name}</span>
                        {qty && (
                          <span style={{
                            color: qtyErr ? 'var(--destructive)' : 'var(--secondary-foreground)',
                            marginLeft: '4px', fontSize: '12px',
                          }}>
                            {fmtQtyUnit(parseFloat(qty) || 0, m.unit)}
                          </span>
                        )}
                      </div>
                      {qtyErr && <div className="form-error" style={{ marginLeft: '18px', fontSize: '11px' }}>{qtyErr}</div>}
                    </div>
                  );
                })}
              </div>
            )}
            <button type="button" className="pattern-picker-trigger" onClick={() => openMaterialPicker('accessory')}>
              <span className="pattern-picker-icon">{selectedAccessories.length > 0 ? '✎' : '+'}</span>
              <span>{selectedAccessories.length > 0 ? '管理辅料' : '去添加辅料'}</span>
            </button>
          </div>

          {/* ⑤ 关联纸样 */}
          <div className="garment-form-section">
            <div className="garment-form-section-title">关联纸样</div>
            {patternId && patternObj ? (
              <div className="pattern-selected-row">
                <div className="pattern-selected-thumb">
                  <PatternThumb pattern={patternObj} />
                </div>
                <div className="pattern-selected-info">
                  <div className="pattern-selected-name">{patternObj.name}</div>
                  <div className="pattern-selected-meta">
                    {joinNonEmpty([patternObj.size, patternObj.brand, patternObj.purchasePrice != null ? fmtCurrency(patternObj.purchasePrice) : ''])}
                  </div>
                </div>
                <div className="pattern-selected-actions">
                  <button type="button" className="pattern-action-btn" onClick={openPatternPicker}>更换</button>
                  <button type="button" className="pattern-action-btn pattern-clear-btn" onClick={() => setPatternId('')}>清除</button>
                </div>
              </div>
            ) : (
              <button type="button" className="pattern-picker-trigger" onClick={openPatternPicker}>
                <span className="pattern-picker-icon">+</span>
                <span>去选择纸样</span>
              </button>
            )}
          </div>

          {/* ⑥ 成本统计 */}
          {showCost && (
            <div className="garment-form-section garment-form-cost-section">
              <div className="garment-form-section-title">成本统计</div>
              <div className="cost-preview-row">
                <span className="cost-preview-label">已登记用料</span>
                <span className="cost-preview-value">
                  {costPreview.registeredCount} / {costPreview.totalMaterials} 项
                </span>
              </div>
              {costPreview.items.filter((it) => it.qty > 0).length > 0 && (
                <div className="cost-materials-detail">
                  {costPreview.items.filter((it) => it.qty > 0).map((item) => (
                    <div key={item.id} className="cost-detail-row">
                      <span className="cost-detail-name">{item.name}</span>
                      <span className="cost-detail-qty">{item.qty}{item.unit} × ¥{item.price.toFixed(2)}</span>
                      <span className="cost-detail-subtotal">{fmtCurrency(item.subtotal)}</span>
                    </div>
                  ))}
                </div>
              )}
              {costPreview.patternPrice > 0 && (
                <div className="cost-preview-row pattern-cost-row">
                  <span className="cost-preview-label">纸样</span>
                  <span className="cost-preview-value">{fmtCurrency(costPreview.patternPrice)}</span>
                </div>
              )}
              <div className="cost-preview-row total-cost-row">
                <span className="cost-preview-label">预计总成本</span>
                <span className="cost-preview-total">{fmtCurrency(costPreview.total)}</span>
              </div>
            </div>
          )}

          {/* ⑦ 备注 */}
          <div className="garment-form-section">
            <div className="garment-form-section-title">备注</div>
            <textarea
              ref={notesRef}
              className={'form-textarea' + (errors.notes ? ' error' : '')}
              value={notes}
              placeholder="记录设计想法、注意事项…"
              onChange={(e) => { setNotes(e.target.value); clearError('notes'); }}
              maxLength={500}
              rows={3}
            />
            <div style={{ textAlign: 'right', fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
              {notes.length}/500
            </div>
            {errors.notes && <div className="form-error">{errors.notes}</div>}
          </div>
        </div>
      </div>

      {/* ---- P1-1：选择器页内浮层（不卸载表单） ---- */}
      {/* S3-FIX-C R1：两处浮层外加 stopPropagation 守卫，避免浮层内点击冒泡到 form-overlay 的 handleCancel */}
      {pickerState?.kind === 'material' && (
        <div onClick={(e) => e.stopPropagation()}>
          <MaterialPickerPage
            initialType={pickerState.type}
            initialSelectedIds={overlaySelectedForType(pickerState.type)}
            initialQtys={materialQtys}
            onClose={() => setPickerState(null)}
            onConfirm={handleMaterialPickerConfirm}
          />
        </div>
      )}
      {pickerState?.kind === 'pattern' && (
        <div onClick={(e) => e.stopPropagation()}>
          <PatternPickerPage
            initialSelectedId={patternId}
            onClose={() => setPickerState(null)}
            onSelect={handlePatternPickerSelect}
          />
        </div>
      )}
    </div>
  );
}