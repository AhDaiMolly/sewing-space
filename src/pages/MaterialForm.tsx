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
import type { Material, MaterialType, Season, ForWhom } from '@/db/types';
import { createMaterial, updateMaterial, adjustMaterialQuantity } from '@/services/materialService';
import { toast } from '@/store/toastStore';
import { IconStar } from '@/components/Icons';
import {
  UserIconCatFabric, UserIconCatAccessory, UserIconCatTool, UserIconCatPattern,
} from '@/components/UserIcons';
import ImageGallery from '@/components/ImageGallery';

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

const SUITABLE_FOR_PRESETS: string[] = [
  '连衣裙', '衬衫', '裤子', '外套', 'T恤', '半裙', '大衣', '旗袍', '上衣',
  '背带裙', '背心', '发饰', '半身裙', '童装', '睡衣', '抱枕', '围裙', '帽子',
];

const TAG_PRESETS: Record<MaterialType, string[]> = {
  fabric: ['夏季', '冬季', '春秋', '百搭', '高级', '复古', '棉麻', '真丝', '透气', '厚实', '垂感', '弹力'],
  accessory: ['必备', '隐形', 'YKK', '复古', '树脂', '涤纶', '纯棉', '百搭'],
  tool: ['必备', '锋利', '耐用', '多色', '量尺', '剪刀'],
  pattern: ['Burda', '春款', '秋款', '童装', '通勤', '复古', '休闲', '礼服'],
};

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
  const settingsRaw = useLiveQuery(() => db.settings.toArray(), []) ?? [];
  const getPreset = (key: string): string[] => {
    const rec = settingsRaw.find((s) => s.key === key);
    if (!rec) return [];
    try { return JSON.parse(rec.value) as string[]; } catch { return []; }
  };
  const fabricBrandPresets = getPreset('presets.fabricBrands');
  const patternBrandPresets = getPreset('presets.patternBrands');

  // ===================== 表单状态 =====================

  const [form, setForm] = useState({
    name: editMaterial?.name ?? '',
    type: editMaterial?.type ?? defaultType,
    category: editMaterial?.category ?? '',
    quantity: editMaterial?.quantity ?? 1,
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
    tags: editMaterial?.tags ?? [] as string[],
    notes: editMaterial?.notes ?? '',
    width: editMaterial?.width != null ? String(editMaterial.width) : '',
    weight: editMaterial?.weight != null ? String(editMaterial.weight) : '',
  });

  const [imageIds, setImageIds] = useState<string[]>(editMaterial?.images ?? []);
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
      quantity: editMaterial.quantity,
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
      tags: editMaterial.tags,
      notes: editMaterial.notes,
      width: editMaterial.width != null ? String(editMaterial.width) : '',
      weight: editMaterial.weight != null ? String(editMaterial.weight) : '',
    });
    setImageIds(editMaterial.images ?? []);
    initialQuantityRef.current = editMaterial.quantity;
  }, [editMaterial]);

  // 品牌新增
  const [brandInput, setBrandInput] = useState('');
  const [brandInputVisible, setBrandInputVisible] = useState(false);
  // 标签输入
  const [tagInput, setTagInput] = useState('');

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

  const handleAddBrand = useCallback(() => {
    const v = brandInput.trim();
    if (!v) return;
    if (currentBrandPresets.includes(v)) {
      toast('该品牌已在预设中');
      return;
    }
    const settingsKey =
      form.type === 'fabric' ? 'presets.fabricBrands' : 'presets.patternBrands';
    const newList = [...currentBrandPresets, v];
    db.settings.put({
      key: settingsKey,
      value: JSON.stringify(newList),
      updatedAt: new Date().toISOString(),
    });
    updateField('brand', v);
    setBrandInput('');
    setBrandInputVisible(false);
    toast('已添加新品牌');
  }, [brandInput, currentBrandPresets, form.type, updateField]);

  // ===================== 标签 =====================

  const handleAddTag = useCallback(() => {
    const v = tagInput.trim();
    if (!v) return;
    if (form.tags.includes(v)) {
      toast('标签已存在');
      return;
    }
    if (form.tags.length >= 10) {
      toast('标签最多 10 个');
      return;
    }
    setForm((prev) => ({ ...prev, tags: [...prev.tags, v] }));
    setTagInput('');
  }, [tagInput, form.tags]);

  const handleRemoveTag = useCallback((tag: string) => {
    setForm((prev) => ({ ...prev, tags: prev.tags.filter((t) => t !== tag) }));
  }, []);

  // ===================== 适合款式 =====================

  const toggleSuitableFor = useCallback((item: string) => {
    setForm((prev) => ({
      ...prev,
      suitableFor: prev.suitableFor.includes(item)
        ? prev.suitableFor.filter((s) => s !== item)
        : [...prev.suitableFor, item],
    }));
  }, []);

  // 自由输入适合款式
  const [suitableInput, setSuitableInput] = useState('');
  const handleAddSuitable = useCallback(() => {
    const v = suitableInput.trim();
    if (!v) return;
    if (form.suitableFor.includes(v)) return;
    setForm((prev) => ({ ...prev, suitableFor: [...prev.suitableFor, v] }));
    setSuitableInput('');
  }, [suitableInput, form.suitableFor]);

  // ===================== 提交 =====================

  const [saving, setSaving] = useState(false);

  const handleSubmit = useCallback(async () => {
    // 校验
    if (!form.name.trim()) {
      toast('名称不能为空');
      return;
    }
    if (form.quantity < 0) {
      toast('数量不能为负');
      return;
    }

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
        suitableFor: form.suitableFor,
        forWhom: form.forWhom,
        brand: form.brand,
        size: form.size,
        rating: form.rating as 0 | 1 | 2 | 3 | 4 | 5,
        ratingReview: form.ratingReview,
        tags: form.tags,
        notes: form.notes,
        width: form.width !== '' ? Number(form.width) : undefined,
        weight: form.weight !== '' ? Number(form.weight) : undefined,
        composition: preserve.composition,
        sampleCard: preserve.sampleCard,
        used: preserve.used,
        lowStockThreshold: preserve.lowStockThreshold,
        images: imageIds,
        sourceRef: undefined,
      };

      if (isEdit && editMaterial) {
        // 编辑模式
        const newQuantity = form.quantity;
        const quantityChanged = newQuantity !== initialQuantityRef.current;

        if (quantityChanged) {
          // 库存有变化 → 走 adjustMaterialQuantity（写 adjust 流水）
          const note = `编辑物料：${form.name.trim()}`;
          const { newQuantity: actualNew } = await adjustMaterialQuantity(
            editMaterial.id,
            Number(newQuantity),
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
        await createMaterial({
          ...baseData,
          quantity: Number(form.quantity),
          initialQuantity: Number(form.quantity),
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
  }, [form, imageIds, isEdit, editMaterial, navigate]);

  // ===================== 渲染辅助 =====================

  const currentCategoryPresets = CATEGORY_PRESETS[form.type] ?? [];
  const currentTagPresets = TAG_PRESETS[form.type] ?? [];

  // 字段可见性
  const showQuantityUnit = form.type !== 'pattern';
  const showBrand = form.type === 'fabric' || form.type === 'pattern';
  const showSeason = form.type === 'pattern';
  const showSuitableFor = form.type === 'fabric' || form.type === 'pattern'; // PRD 不复刻#1
  const showForWhom = form.type === 'pattern';
  const showFabricInfo = form.type === 'fabric';
  const showAccessoryWidth = form.type === 'accessory'; // PRD §8.4 字段14 辅料也显示幅宽
  const showFabricWidth = form.type === 'fabric' || showAccessoryWidth;
  const showPatternInfo = form.type === 'pattern';
  const showTagsBeforeNotes = form.type === 'fabric' || form.type === 'accessory';
  const showTagsInPattern = form.type === 'pattern';
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

          {/* 4. 分类 (字段#4) */}
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
                  onChange={(e) => updateField('quantity', Number(e.target.value))}
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

          {/* 10. 颜色 (字段#10) */}
          {true /* 颜色四类都渲染 */ && (
            <div className="input-row">
              <label className="input-label">颜色</label>
              <input
                className="input-field"
                placeholder="如：米白底粉花"
                value={form.color}
                onChange={(e) => updateField('color', e.target.value)}
              />
            </div>
          )}

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

          {/* 12. 适合款式 (字段#12 — 面料和纸样都渲染，PRD 不复刻#1) */}
          {showSuitableFor && (
            <div className="input-row">
              <label className="input-label">适合款式</label>
              <div className="chips-container">
                {SUITABLE_FOR_PRESETS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`chip ${form.suitableFor.includes(s) ? 'selected' : ''}`}
                    onClick={() => toggleSuitableFor(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {/* 自由输入 */}
              <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                <input
                  className="input-field"
                  style={{ flex: 1, fontSize: '13px', padding: '6px 10px' }}
                  placeholder="输入自定义款式"
                  value={suitableInput}
                  maxLength={20}
                  onChange={(e) => setSuitableInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddSuitable();
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '6px 12px', fontSize: '13px' }}
                  onClick={handleAddSuitable}
                >
                  添加
                </button>
              </div>
            </div>
          )}

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

          {/* 14. 幅宽 (字段#14 — 面料+辅料) */}
          {showFabricWidth && (
            <div className="input-row">
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

          {/* 15. 克重 (字段#15 — 仅面料) */}
          {showFabricInfo && (
            <div className="input-row">
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

          {/* 纸样专属信息 */}
          {showPatternInfo && (
            <div className="section-divider" />
          )}
          {showPatternInfo && (
            <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '12px' }}>
              纸样信息
            </div>
          )}

          {/* 16. 尺码 (字段#16 — 仅纸样) */}
          {showPatternInfo && (
            <div className="input-row">
              <label className="input-label">尺码</label>
              <div className="chips-container">
                {PATTERN_SIZE_PRESETS.map((s) => (
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

          {/* 17. 标签 (字段#17 — 纸样下在尺码后渲染) */}
          {showTagsInPattern && (
            <div className="input-row">
              <label className="input-label">标签</label>
              <div className="chips-container">
                {currentTagPresets.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`chip ${form.tags.includes(t) ? 'selected' : ''}`}
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        tags: prev.tags.includes(t)
                          ? prev.tags.filter((x) => x !== t)
                          : [...prev.tags, t],
                      }))
                    }
                  >
                    {t}
                  </button>
                ))}
              </div>
              {/* 标签自由输入 */}
              <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                <input
                  className="input-field"
                  style={{ flex: 1, fontSize: '13px', padding: '6px 10px' }}
                  placeholder="输入标签"
                  value={tagInput}
                  maxLength={20}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddTag();
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '6px 12px', fontSize: '13px' }}
                  onClick={handleAddTag}
                >
                  添加
                </button>
              </div>
              {/* 已添加标签 chips */}
              {form.tags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                  {form.tags.map((t) => (
                    <span
                      key={t}
                      className="chip selected"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      {t}
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(t)}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '0',
                          fontSize: '14px',
                          lineHeight: 1,
                          color: 'var(--secondary-foreground)',
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
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

          {/* 19. 短评 (字段#19 — 仅纸样) */}
          {showRating && (
            <div className="input-row">
              <label className="input-label">短评</label>
              <input
                className="input-field"
                placeholder="一句话评价这个纸样"
                value={form.ratingReview}
                maxLength={200}
                onChange={(e) => updateField('ratingReview', e.target.value)}
              />
            </div>
          )}

          {/* 17. 标签 — 面料和辅料下在备注前 (字段#17) */}
          {showTagsBeforeNotes && (
            <div className="input-row">
              <label className="input-label">标签</label>
              <div className="chips-container">
                {currentTagPresets.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`chip ${form.tags.includes(t) ? 'selected' : ''}`}
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        tags: prev.tags.includes(t)
                          ? prev.tags.filter((x) => x !== t)
                          : [...prev.tags, t],
                      }))
                    }
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                <input
                  className="input-field"
                  style={{ flex: 1, fontSize: '13px', padding: '6px 10px' }}
                  placeholder="输入标签"
                  value={tagInput}
                  maxLength={20}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddTag();
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '6px 12px', fontSize: '13px' }}
                  onClick={handleAddTag}
                >
                  添加
                </button>
              </div>
              {/* 已添加标签 chips（与纸样分支 showTagsInPattern 同款，N-2 修复） */}
              {form.tags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                  {form.tags.map((t) => (
                    <span
                      key={t}
                      className="chip selected"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      {t}
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(t)}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '0',
                          fontSize: '14px',
                          lineHeight: 1,
                          color: 'var(--secondary-foreground)',
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
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