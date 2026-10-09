// src/pages/MaterialForm.tsx — 物料表单页（新增/编辑抽屉）
// PRD §8.6 → 实为 §8.4；UI 基线：demo/src/pages/MaterialForm.jsx
// 不复刻清单（PRD §8.4 缺陷表）：
//   #1 适合款式面料+纸样都渲染（demo仅纸样）
//   #2 步长恒 0.1（demo 按单位切换）
//   #3 图片按 MIME 白名单保留类型（demo 固定 JPEG）
//   #4 压缩参数固定，超限拒绝不二次降质（demo 二分法逼近 200KB）
// + 图片上传走 imageService（非 demo 的 inline canvas）

import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Material, MaterialType, Season, ForWhom, PresetsConfig } from '@/db/types';
import { DEFAULT_PRESETS } from '@/db/seed';
import { updatePresets } from '@/services/settingsService';
import { createMaterial, updateMaterial, adjustMaterialQuantity } from '@/services/materialService';
import { toast } from '@/store/toastStore';
import { IconStar } from '@/components/Icons';
import {
  UserIconCatFabric, UserIconCatAccessory, UserIconCatTool, UserIconCatPattern,
  UserIconNavGarments,
} from '@/components/UserIcons';
import ImageGallery from '@/components/ImageGallery';
import GarmentPickerPage from '@/pages/pickers/GarmentPickerPage';
import { parseQuantityInput, quantityErrorMessage } from '@/lib/quantityInput';

// ===================== 常量 =====================

const TYPE_OPTIONS: { key: MaterialType; label: string; unit: string }[] = [
  { key: 'fabric', label: '面料', unit: '米' },
  { key: 'accessory', label: '辅料', unit: '个' },
  { key: 'tool', label: '工具', unit: '个' },
  { key: 'pattern', label: '纸样', unit: '件' },
];

const CATEGORY_PRESETS: Record<MaterialType, string[]> = {
  fabric: ['棉布', '麻布', '丝绸', '雪纺', '牛仔', '灯芯绒', '毛呢', '针织', '府绸', '帆布', '蕾丝', '其他'],
  accessory: ['拉链', '纽扣', '扣子', '线', '包边条', '衬', '衬布', '花边', '松紧', '织带', '螺纹', '填充', '填充棉', '烫画', '其他'],
  tool: ['剪刀', '尺子', '划粉', '针', '顶针', '拆线器', '珠针', '缝纫机油', '其他'],
  pattern: ['连衣裙', '上衣', '裤子', '半身裙', '外套', '童装', '大衣', '旗袍', '马甲', '背心', '其他'],
};

const SEASON_OPTIONS: { key: Season; label: string }[] = [
  { key: 'spring', label: '春' },
  { key: 'summer', label: '夏' },
  { key: 'autumn', label: '秋' },
  { key: 'winter', label: '冬' },
  { key: 'all_season', label: '四季' },
];

const FOR_WHOM_OPTIONS: { key: ForWhom; label: string }[] = [
  { key: 'women', label: '女士' },
  { key: 'men', label: '男士' },
  { key: 'children', label: '儿童' },
  { key: 'baby', label: '婴儿' },
  { key: 'pet', label: '宠物' },
];

// AH-A Q5：适合款式预置清单已移除（面料/纸样「适合款式」录入 UI 均已下线，
// 预置 chips 不再被引用；数据层 suitableFor 字段与存量值不受影响）

const PATTERN_SIZE_PRESETS: string[] = [
  'XS', 'S', 'M', 'L', 'XL', 'XXL',
  '36/S', '38/M', '40/L', '42/XL',
  '90', '100', '110', '120', '130', '140', '150',
  '均码',
];

const DEFAULT_UNITS: Record<MaterialType, string> = {
  fabric: '米',
  accessory: '个',
  tool: '个',
  pattern: '件',
};

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ===================== 组件 =====================

export default function MaterialForm() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isEdit = !!id;
  // 新增时可从 query 取默认 type
  const defaultType: MaterialType =
    (searchParams.get('type') as MaterialType) || 'fabric';

  // 读取全部物料（编辑模式下找当前行）
  const allMaterials = useLiveQuery(() => db.materials.toArray(), []) ?? [];
  const editMaterial = isEdit ? allMaterials.find((m) => m.id === id) : undefined;

  // 读取 presets
  const settingsRows = useLiveQuery(() => db.settings.toArray(), []);
  const presetsRawValue = settingsRows?.find((s) => s.key === 'presets')?.value;
  // V-A Q7：品牌预设与设置页同源——读单 'presets' 键 JSON 的子键（DM §4.9.6
  // 单键 8 子键）。原实现读独立键 'presets.fabricBrands'，但种子与设置页都写
  // 单 'presets' 键，键位错配导致品牌预设永远为空。
  const {
    presetsObj,
    fabricBrandPresets,
    patternBrandPresets,
    patternStylePresets,
    patternSizePresets,
    fabricCategoryPresets,
    accessoryCategoryPresets,
  } = useMemo(() => {
    let obj: Partial<PresetsConfig> = {};
    if (presetsRawValue != null) {
      try {
        obj = JSON.parse(presetsRawValue) as Partial<PresetsConfig>;
      } catch {
        obj = {};
      }
    }
    return {
      presetsObj: obj,
      fabricBrandPresets: Array.isArray(obj.fabricBrands) ? obj.fabricBrands : [],
      patternBrandPresets: Array.isArray(obj.patternBrands) ? obj.patternBrands : [],
      // AD-A 物料6：纸样「分类」联动设置「款式预设」、「尺码」联动「尺码预设」
      patternStylePresets: Array.isArray(obj.patternStyles) ? obj.patternStyles : [],
      patternSizePresets: Array.isArray(obj.patternSizes) ? obj.patternSizes : [],
      // AD-D 预设1/2：面料/辅料「分类」联动设置「面料分类」「辅料分类」预设
      fabricCategoryPresets: Array.isArray(obj.fabricCategories) ? obj.fabricCategories : [],
      accessoryCategoryPresets: Array.isArray(obj.accessoryCategories) ? obj.accessoryCategories : [],
    };
  }, [presetsRawValue]);

  // ===================== 表单状态 =====================

  const [form, setForm] = useState({
    name: editMaterial?.name ?? '',
    type: editMaterial?.type ?? defaultType,
    category: editMaterial?.category ?? '',
    // V-A Q3：数量改字符串态（与 purchasePrice/width/weight 同 S4-FIX 口径）——
    // 允许清空输入框；「未触碰」= 新增默认 '1' / 编辑回显原值，「显式清空」= ''，
    // 提交时空值按校验拦截（toast 提示），不再自动回填 0。
    quantity:
      editMaterial?.quantity != null ? String(editMaterial.quantity) : '1',
    unit: editMaterial?.unit ?? DEFAULT_UNITS[editMaterial?.type ?? defaultType],
    purchaseDate: editMaterial?.purchaseDate ?? todayStr(),
    purchasePrice: editMaterial?.purchasePrice != null ? String(editMaterial.purchasePrice) : '',
    color: editMaterial?.color ?? '',
    season: editMaterial?.season ?? 'all_season',
    suitableFor: editMaterial?.suitableFor ?? [] as string[],
    forWhom: editMaterial?.forWhom ?? '' as ForWhom | '',
    brand: editMaterial?.brand ?? '',
    size: editMaterial?.size ?? '',
    rating: editMaterial?.rating ?? 0,
    ratingReview: editMaterial?.ratingReview ?? '',
    used: (editMaterial?.used ?? 0) as 0 | 1,
    notes: editMaterial?.notes ?? '',
    width: editMaterial?.width != null ? String(editMaterial.width) : '',
    weight: editMaterial?.weight != null ? String(editMaterial.weight) : '',
  });

  const [imageIds, setImageIds] = useState<string[]>(editMaterial?.images ?? []);
  // 【AB-A 需求 2/4】关联成衣（仅纸样）：从成衣库多选，可不选；编辑可增删。
  // 悬空 id（成衣已删）不渲染 chip，保存时随之移除（弱引用读侧容错口径）。
  // AD-A 物料4：选择器改为与成衣表单关联面料同构的浮层选择器（GarmentPickerPage）。
  const [linkedGarmentIds, setLinkedGarmentIds] = useState<string[]>(
    editMaterial?.linkedGarmentIds ?? [],
  );
  const [garmentPickerOpen, setGarmentPickerOpen] = useState(false);
  // 成衣库候选列表（名称 + 状态展示用）
  const allGarments = useLiveQuery(() => db.garments.toArray(), []) ?? [];
  // 编辑模式下记录原始库存，提交时计算 delta
  const initialQuantityRef = useRef(editMaterial?.quantity ?? 0);

  // P0-1 修复：数据源 useLiveQuery 首帧返回 undefined、异步就绪后 editMaterial
  // 才有值，表单 state 不能只在首帧初始化。当 editMaterial 从 undefined 变为
  // 有值（或换了编辑对象）时，重置表单 state 与 initialQuantityRef，保证编辑
  // 态各字段回显当前值。以 id+updatedAt 为同步键：liveQuery 因无关行重发时
  // （对象引用变化但 updatedAt 未变）不回灌，避免覆盖用户正在编辑的内容。
  const editSyncKeyRef = useRef('');
  useEffect(() => {
    if (!editMaterial) return;
    const syncKey = `${editMaterial.id}:${editMaterial.updatedAt}`;
    if (editSyncKeyRef.current === syncKey) return;
    editSyncKeyRef.current = syncKey;
    setForm({
      name: editMaterial.name,
      type: editMaterial.type,
      category: editMaterial.category,
      quantity: String(editMaterial.quantity), // V-A Q3：字符串态回显
      unit: editMaterial.unit,
      purchaseDate: editMaterial.purchaseDate,
      purchasePrice:
        editMaterial.purchasePrice != null ? String(editMaterial.purchasePrice) : '',
      color: editMaterial.color,
      season: editMaterial.season,
      suitableFor: editMaterial.suitableFor,
      forWhom: editMaterial.forWhom,
      brand: editMaterial.brand,
      size: editMaterial.size,
      rating: editMaterial.rating,
      ratingReview: editMaterial.ratingReview,
      used: editMaterial.used,
      notes: editMaterial.notes,
      width: editMaterial.width != null ? String(editMaterial.width) : '',
      weight: editMaterial.weight != null ? String(editMaterial.weight) : '',
    });
    setImageIds(editMaterial.images ?? []);
    setLinkedGarmentIds(editMaterial.linkedGarmentIds ?? []);
    initialQuantityRef.current = editMaterial.quantity;
  }, [editMaterial]);

  // 品牌新增
  const [brandInput, setBrandInput] = useState('');
  const [brandInputVisible, setBrandInputVisible] = useState(false);

  const currentBrandPresets = useMemo(
    () =>
      form.type === 'fabric'
        ? fabricBrandPresets
        : form.type === 'pattern'
          ? patternBrandPresets
          : [],
    [form.type, fabricBrandPresets, patternBrandPresets],
  );

  const updateField = useCallback(
    (key: string, value: unknown) => {
      setForm((prev) => {
        const next = { ...prev, [key]: value };
        if (key === 'type') {
          const newType = value as MaterialType;
          next.unit = DEFAULT_UNITS[newType];
          // 清空不兼容字段
          if (newType !== 'fabric' && newType !== 'pattern') {
            next.brand = '';
          }
          // AD-B 物料15：工具无分类字段，切到工具时清掉已选分类（表单态；
          // 编辑存量工具的既有 category 经编辑回显路径透传，不受影响）
          if (newType === 'tool') {
            next.category = '';
          }
          if (newType !== 'pattern') {
            next.size = '';
            next.rating = 0;
            next.ratingReview = '';
            next.forWhom = '';
          }
        }
        return next;
      });
    },
    [],
  );

  // ===================== 品牌新增 =====================

  const handleAddBrand = useCallback(async () => {
    const v = brandInput.trim();
    if (!v) return;
    if (currentBrandPresets.includes(v)) {
      toast('该品牌已在预设中');
      return;
    }
    // V-A Q7：与设置页同路径——updatePresets 写单 'presets' 键（缺省子键用
    // DEFAULT_PRESETS 补齐后整体落库），不再写独立键 presets.fabricBrands。
    const subkey: 'fabricBrands' | 'patternBrands' =
      form.type === 'fabric' ? 'fabricBrands' : 'patternBrands';
    const newList = [...currentBrandPresets, v];
    try {
      await updatePresets({
        ...DEFAULT_PRESETS,
        ...presetsObj,
        [subkey]: newList,
      } as PresetsConfig);
    } catch {
      toast('品牌保存失败');
      return;
    }
    updateField('brand', v);
    setBrandInput('');
    setBrandInputVisible(false);
    toast('已添加新品牌');
  }, [brandInput, currentBrandPresets, form.type, presetsObj, updateField]);

  // ===================== 适合款式 =====================
  // AH-A Q5：面料去掉「适合款式」录入（纸样 AD-A 物料3 已去）——录入辅助
  // （chips 切换 / 自由输入）整体移除；suitableFor 保留在 FormState 仅作
  // 编辑回显，提交时透传存量值（见 handleSubmit 内 suitableFor 提交逻辑）。

  // ===================== 提交 =====================

  const [saving, setSaving] = useState(false);

  const handleSubmit = useCallback(async () => {
    // 校验
    if (!form.name.trim()) {
      toast('名称不能为空');
      return;
    }
    // V-A Q3 + AD-A 物料5：数量字符串态——onChange 不再 Number() 转型（转型导致
    // 清空回显 0 + 提交 .trim() 抛 TypeError），统一走 parseQuantityInput 解析，
    // 空值/非数/负数按校验拦截，不自动回填。
    const qtyParsed = parseQuantityInput(form.quantity);
    if (!qtyParsed.ok) {
      toast(quantityErrorMessage(qtyParsed.reason));
      return;
    }
    const qtyNum = qtyParsed.value;

    setSaving(true);
    try {
      // 编辑态透传表单未管理的字段（表单无这些输入项，编辑不得把它们清空）：
      // composition / sampleCard / used / lowStockThreshold 取实体当前值。
      const preserve = isEdit && editMaterial
        ? {
            composition: editMaterial.composition,
            sampleCard: editMaterial.sampleCard,
            used: editMaterial.used,
            lowStockThreshold: editMaterial.lowStockThreshold,
          }
        : {
            composition: '',
            sampleCard: '',
            used: 0 as 0 | 1,
            lowStockThreshold: 0,
          };
      const baseData = {
        type: form.type,
        name: form.name.trim(),
        category: form.category,
        unit: form.unit,
        purchaseDate: form.purchaseDate,
        purchasePrice: form.purchasePrice !== '' ? Number(form.purchasePrice) : undefined,
        color: form.color,
        season: form.season,
        // AD-A 物料3 / AH-A Q5：面料也去掉「适合款式」录入——新增恒 []，编辑透传
        // 存量值（字段不删不展示，备份/恢复不受影响；纸样沿用 AD-A 物料3 同一口径）
        suitableFor: isEdit && editMaterial ? editMaterial.suitableFor : [],
        forWhom: form.forWhom,
        brand: form.brand,
        size: form.size,
        rating: form.rating as 0 | 1 | 2 | 3 | 4 | 5,
        // AD-A 物料8：纸样去掉「短评」录入——新增恒 ''，编辑透传存量值
        // （ratingReview 字段保留不删，备份/恢复不受影响）
        ratingReview:
          form.type === 'pattern' && isEdit && editMaterial
            ? editMaterial.ratingReview
            : '',
        notes: form.notes,
        width: form.width !== '' ? Number(form.width) : undefined,
        weight: form.weight !== '' ? Number(form.weight) : undefined,
        composition: preserve.composition,
        sampleCard: preserve.sampleCard,
        used: form.type === 'pattern' ? (form.used as 0 | 1) : preserve.used,
        lowStockThreshold: preserve.lowStockThreshold,
        linkedGarmentIds: form.type === 'pattern' ? linkedGarmentIds : [],
        images: imageIds,
        sourceRef: undefined,
      };

      if (isEdit && editMaterial) {
        // 编辑模式
        const newQuantity = qtyNum;
        const quantityChanged = newQuantity !== initialQuantityRef.current;

        if (quantityChanged) {
          // 库存有变化 → 走 adjustMaterialQuantity（写 adjust 流水）
          const note = `编辑物料：${form.name.trim()}`;
          const { newQuantity: actualNew } = await adjustMaterialQuantity(
            editMaterial.id,
            newQuantity,
            note,
          );
          // 服务层已更新库存，此处只更新其余字段
          await updateMaterial(editMaterial.id, {
            ...baseData,
            quantity: actualNew,
            images: imageIds,
            createdAt: editMaterial.createdAt,
          } as Partial<Omit<Material, 'id'>>);
        } else {
          // 库存不变 → 直接 updateMaterial
          await updateMaterial(editMaterial.id, {
            ...baseData,
            quantity: newQuantity,
            images: imageIds,
            createdAt: editMaterial.createdAt,
          } as Partial<Omit<Material, 'id'>>);
        }
        toast('物料已更新');
      } else {
        // 新增模式
        // AA-D 物料6：表单不再采集标签；数据模型 tags 必填（恒为数组），新增恒写 []。
        await createMaterial({
          ...baseData,
          tags: [] as string[],
          quantity: qtyNum,
          initialQuantity: qtyNum,
          images: imageIds,
        } as Omit<Material, 'id' | 'createdAt' | 'updatedAt'>);
        toast('物料已添加');
      }

      navigate('/materials');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '保存失败';
      toast(msg);
    } finally {
      setSaving(false);
    }
  }, [form, imageIds, linkedGarmentIds, isEdit, editMaterial, navigate]);

  // ===================== 渲染辅助 =====================

  // AD-A 物料6：纸样分类读设置「款式预设」（patternStyles）；AD-D 预设1/2：
  // 面料/辅料分类分别读设置「面料分类」「辅料分类」预设；预设为空 / 缺键时
  // 兜底代码预置清单（现状行为，与纸样侧口径一致）。工具无分类录入（AD-B 物料15）。
  const currentCategoryPresets =
    form.type === 'pattern'
      ? patternStylePresets.length > 0
        ? patternStylePresets
        : CATEGORY_PRESETS.pattern
      : form.type === 'fabric'
        ? fabricCategoryPresets.length > 0
          ? fabricCategoryPresets
          : CATEGORY_PRESETS.fabric
        : form.type === 'accessory'
          ? accessoryCategoryPresets.length > 0
            ? accessoryCategoryPresets
            : CATEGORY_PRESETS.accessory
          : [];

  // 字段可见性
  const showQuantityUnit = form.type !== 'pattern';
  const showBrand = form.type === 'fabric' || form.type === 'pattern';
  const showSeason = form.type === 'pattern';
  const showForWhom = form.type === 'pattern';
  const showFabricInfo = form.type === 'fabric';
  const showAccessoryWidth = form.type === 'accessory'; // PRD §8.4 字段14 辅料也显示幅宽
  const showFabricWidth = form.type === 'fabric' || showAccessoryWidth;
  const showPatternInfo = form.type === 'pattern';
  const showRating = form.type === 'pattern';

  const title = isEdit ? '编辑物料' : '新增物料';

  // ===================== 渲染 =====================

  return (
    <div className="form-overlay" onClick={() => navigate(-1)}>
      <div className="form-sheet" onClick={(e) => e.stopPropagation()}>
        {/* 顶部 */}
        <div className="form-header">
          <button className="cancel" onClick={() => navigate(-1)}>
            取消
          </button>
          <span className="title">{title}</span>
          <div style={{ width: '32px' }} />
        </div>

        <div className="form-body">
          {/* 1. 图片 (PRD §8.4 字段#1)  */}
          <ImageGallery
            entityType="material"
            entityId={editMaterial?.id ?? ''}
            imageIds={imageIds}
            onImageIdsChange={setImageIds}
          />

          {/* 2. 名称 (字段#2) */}
          <div className="input-row">
            <label className="input-label">名称 *</label>
            <input
              className="input-field"
              placeholder="输入物料名称"
              value={form.name}
              maxLength={50}
              onChange={(e) => updateField('name', e.target.value)}
            />
          </div>

          {/* 3. 类型 (字段#3) */}
          <div className="input-row">
            <label className="input-label">类型</label>
            <div className="type-selector">
              {TYPE_OPTIONS.map((opt) => {
                const OptIcon = {
                  fabric: UserIconCatFabric,
                  accessory: UserIconCatAccessory,
                  tool: UserIconCatTool,
                  pattern: UserIconCatPattern,
                }[opt.key];
                return (
                  <button
                    key={opt.key}
                    type="button"
                    className={`type-option ${form.type === opt.key ? 'selected' : ''}`}
                    onClick={() => updateField('type', opt.key)}
                  >
                    <span
                      className="type-icon"
                      style={{
                        color: form.type === opt.key ? 'var(--accent)' : 'var(--muted)',
                        display: 'inline-flex',
                      }}
                    >
                      <OptIcon style={{ width: '22px', height: '22px' }} />
                    </span>
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 4. 分类 (字段#4) — AD-B 物料15：工具去掉分类录入（存量字段保留，编辑透传） */}
          {form.type !== 'tool' && (
            <div className="input-row">
              <label className="input-label">分类</label>
              <div className="chips-container">
                {currentCategoryPresets.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    className={`chip ${form.category === cat ? 'selected' : ''}`}
                    onClick={() =>
                      updateField('category', form.category === cat ? '' : cat)
                    }
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 5. 数量 + 6. 单位 (字段#5-6) */}
          {showQuantityUnit && (
            <div className="input-row" style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label className="input-label">数量</label>
                <input
                  className="input-field"
                  type="number"
                  step="0.1"
                  min="0"
                  value={form.quantity}
                  onChange={(e) => updateField('quantity', e.target.value)}
                />
              </div>
              {form.type === 'accessory' ? (
                <div style={{ minWidth: '140px' }}>
                  <label className="input-label">单位</label>
                  <div className="unit-toggle-group">
                    {[
                      { key: '米', label: '米' },
                      { key: '个', label: '个' },
                    ].map((opt) => (
                      <button
                        key={opt.key}
                        type="button"
                        className={`unit-toggle-btn ${form.unit === opt.key ? 'selected' : ''}`}
                        onClick={() => updateField('unit', opt.key)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ width: '80px' }}>
                  <label className="input-label">单位</label>
                  <div className="unit-locked">{form.unit}</div>
                </div>
              )}
            </div>
          )}

          {/* 7. 购买日期 + 8. 价格 (字段#7-8) */}
          <div className="input-row purchase-info-row">
            <div className="purchase-info-col">
              <label className="input-label">购买日期</label>
              <input
                className="input-field"
                type="date"
                value={form.purchaseDate}
                onChange={(e) => updateField('purchaseDate', e.target.value)}
              />
            </div>
            <div className="purchase-info-col">
              <label className="input-label">价格（元）</label>
              <input
                className="input-field"
                type="number"
                step="0.1"
                min="0"
                placeholder="0.00"
                value={form.purchasePrice}
                onChange={(e) => updateField('purchasePrice', e.target.value)}
              />
            </div>
          </div>

          {/* 9. 品牌 (字段#9) */}
          {showBrand && (
            <div className="input-row">
              <label className="input-label">品牌</label>
              <div className="chips-container">
                {currentBrandPresets.map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={`chip ${form.brand === b ? 'selected' : ''}`}
                    onClick={() => updateField('brand', form.brand === b ? '' : b)}
                  >
                    {b}
                  </button>
                ))}
                {brandInputVisible ? (
                  <div className="chip-add-inline">
                    <input
                      className="chip-add-input"
                      placeholder="输入品牌名"
                      value={brandInput}
                      maxLength={20}
                      onChange={(e) => setBrandInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAddBrand();
                      }}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="chip-add-confirm"
                      onClick={handleAddBrand}
                      disabled={!brandInput.trim()}
                    >
                      添加
                    </button>
                    <button
                      type="button"
                      className="chip-add-cancel"
                      onClick={() => {
                        setBrandInputVisible(false);
                        setBrandInput('');
                      }}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="chip chip-add"
                    onClick={() => setBrandInputVisible(true)}
                  >
                    + 新增品牌
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 10. 颜色 (字段#10) — V-A Q4：四类新增表单去掉颜色输入框
              （demo UI 基线同口径：面料/辅料/工具/纸样均无颜色；编辑态原值
              经 form.color 透传保留，不清空已存数据）。 */}

          {/* 11. 季节 (字段#11 — 仅纸样) */}
          {showSeason && (
            <div className="input-row">
              <label className="input-label">季节</label>
              <div className="chips-container">
                {SEASON_OPTIONS.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    className={`chip ${form.season === s.key ? 'selected' : ''}`}
                    onClick={() => updateField('season', s.key)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 12. 适合款式 (字段#12) —— AH-A Q5：面料/纸样均移除录入 UI（数据层字段保留，
              存量值编辑透传，见上方提交逻辑；此区块整体不再渲染） */}

          {/* 13. 适用人群 (字段#13 — 仅纸样) */}
          {showForWhom && (
            <div className="input-row">
              <label className="input-label">适用人群</label>
              <div className="chips-container">
                <button
                  type="button"
                  className={`chip ${form.forWhom === '' ? 'selected' : ''}`}
                  onClick={() => updateField('forWhom', '')}
                >
                  不限
                </button>
                {FOR_WHOM_OPTIONS.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    className={`chip ${form.forWhom === o.key ? 'selected' : ''}`}
                    onClick={() => updateField('forWhom', o.key)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 14+15. 幅宽 + 克重 — V-A Q8：两字段合并一行（复用购买信息行的
              purchase-info-row / purchase-info-col 两列结构，不加新 CSS 类）。
              面料 = 幅宽 + 克重两列；辅料 = 仅幅宽一列。 */}
          {(showFabricWidth || showFabricInfo) && (
            <div className="input-row purchase-info-row">
              {showFabricWidth && (
                <div className="purchase-info-col">
                  <label className="input-label">幅宽（cm）</label>
                  <input
                    className="input-field"
                    type="number"
                    placeholder="140"
                    value={form.width}
                    onChange={(e) => updateField('width', e.target.value)}
                  />
                </div>
              )}
              {showFabricInfo && (
                <div className="purchase-info-col">
                  <label className="input-label">克重（g/m²）</label>
                  <input
                    className="input-field"
                    type="number"
                    placeholder="180"
                    value={form.weight}
                    onChange={(e) => updateField('weight', e.target.value)}
                  />
                </div>
              )}
            </div>
          )}

          {/* 16. 尺码 (字段#16 — 仅纸样；AD-A 物料7：上方「纸样信息」标题与
              分割线已去掉，尺码直接作为表单字段出现) */}
          {showPatternInfo && (
            <div className="input-row">
              <label className="input-label">尺码</label>
              <div className="chips-container">
                {(patternSizePresets.length > 0 ? patternSizePresets : PATTERN_SIZE_PRESETS).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`chip ${form.size === s ? 'selected' : ''}`}
                    onClick={() =>
                      updateField('size', form.size === s ? '' : s)
                    }
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* AA-D 物料9：是否使用（仅纸样，放开手工修改） */}
          {showPatternInfo && (
            <div className="input-row">
              <label className="input-label">是否使用</label>
              <div className="chips-container">
                <button
                  type="button"
                  className={`chip ${form.used === 1 ? 'selected' : ''}`}
                  onClick={() => updateField('used', 1)}
                >
                  已使用
                </button>
                <button
                  type="button"
                  className={`chip ${form.used === 0 ? 'selected' : ''}`}
                  onClick={() => updateField('used', 0)}
                >
                  未使用
                </button>
              </div>
            </div>
          )}

          {/* 18. 评分 (字段#18 — 仅纸样) */}
          {showRating && (
            <div className="input-row">
              <label className="input-label">评分</label>
              <div className="star-rating" style={{ display: 'flex', gap: '4px' }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <span
                    key={n}
                    onClick={() => updateField('rating', form.rating === n ? 0 : n)}
                    style={{ cursor: 'pointer', display: 'inline-flex' }}
                  >
                    <IconStar
                      filled={form.rating >= n}
                      style={{
                        width: '24px',
                        height: '24px',
                        color: form.rating >= n ? '#FFC107' : '#DDD',
                      }}
                    />
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 【AB-A 需求 2/4】关联成衣（仅纸样）：AD-A 物料4——名称改「关联成衣」，
              选择器样式与成衣表单关联面料同构（已选 chip 预览 + trigger 按钮 +
              浮层多选），不再用平铺 chips。 */}
          {showPatternInfo && (
            <div className="input-row">
              <label className="input-label">关联成衣（{linkedGarmentIds.length}）</label>
              {linkedGarmentIds.length > 0 && (
                <div className="linked-materials-preview">
                  {linkedGarmentIds.map((gid) => {
                    const g = allGarments.find((x) => x.id === gid);
                    if (!g) return null; // 悬空 id 不渲染（弱引用读侧容错）
                    return (
                      <div key={gid} className="linked-material-chip">
                        <UserIconNavGarments
                          style={{ width: '14px', height: '14px', marginRight: '4px', color: 'var(--accent)' }}
                        />
                        <span>{g.name}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <button
                type="button"
                className="pattern-picker-trigger"
                onClick={() => setGarmentPickerOpen(true)}
              >
                <span className="pattern-picker-icon">
                  {linkedGarmentIds.length > 0 ? '✎' : '+'}
                </span>
                <span>{linkedGarmentIds.length > 0 ? '管理成衣' : '去添加成衣'}</span>
              </button>
            </div>
          )}

          {/* 20. 备注 (字段#20) */}
          <div className="input-row">
            <label className="input-label">备注</label>
            <textarea
              className="input-field"
              rows={3}
              placeholder="补充说明…"
              value={form.notes}
              maxLength={500}
              onChange={(e) => updateField('notes', e.target.value)}
              style={{ resize: 'none' }}
            />
          </div>
        </div>

        {/* AD-A 物料4：关联成衣浮层选择器（fixed 全屏，z-index 1000 > form-overlay 50） */}
        {garmentPickerOpen && (
          <GarmentPickerPage
            initialSelectedIds={linkedGarmentIds}
            onClose={() => setGarmentPickerOpen(false)}
            onConfirm={(ids) => {
              setLinkedGarmentIds(ids);
              setGarmentPickerOpen(false);
            }}
          />
        )}

        {/* 底部按钮 */}
        <div className="form-footer">
          <button className="btn btn-secondary" onClick={() => navigate(-1)}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={saving}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}