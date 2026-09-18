/**
 * pages.js · 页面渲染器集合（M1.1 占位骨架 + M1.2 物料模块）
 * 缝纫空间 M1.1 工程骨架
 *
 * 每个 renderXxx(root) 函数负责把页面内容写到 root.innerHTML，
 * 并可选地返回 onMount(root) 钩子用于事件监听 / 数据加载。
 *
 * 路由表与本页面对应关系见 router.js；M1.1 阶段除物料模块外仍为占位，
 * 真实业务逻辑在 M1.2（物料）/ M1.3（成衣）/ M1.4（统计）/ M1.5（设置）落地。
 */

(function (global) {
  'use strict';

  const C = global.SS.components;
  // M1.4 修复：拆分 Dexie 实例与 API 包装；dbApi 提供统计派生等业务方法，
  // dbTable 提供表级操作（materials/garments/usageLogs/...）
  const dbApi = global.SS.db;
  const { db: dbTable } = global.SS.db;

  /* ============ 首页 ============ */
  // M1.4 首页按 PRD §10.1 + 2026-09-14 裁决①：3 统计卡（含战果主卡）+ 快速添加；金额一律不上首页
  async function renderHome(root) {
    const [stats] = await Promise.all([
      dbApi.computeStatsForPeriod('month'),
    ]);
    const { completedCount, stock } = stats;
    const garmentCount = await dbTable.garments.count();
    const patternCount = await dbTable.materials.where('type').equals('pattern').count();
    const recent = await dbTable.garments.orderBy('updatedAt').reverse().limit(3).toArray();

    // 裁决①：首页「最近成衣」卡复用通用成衣卡片时**强制关闭成本显示**（首页口径不含金额）
    // 通用卡片默认 showCost=true（统计页/成衣列表页仍按规格显示），首页显式传 false
    const recentBlock = recent.length
      ? `
        <div class="card">
          <div class="card-title">最近成衣</div>
          ${recent.map((g) => C.renderGarmentCard(g, { showCost: false })).join('')}
          <a class="btn btn-link" href="#/garments">查看全部</a>
        </div>`
      : '';

    root.innerHTML = `
      <div class="stats-hero" data-home-hero>
        <div class="stats-hero-label">本月战果</div>
        <div class="stats-hero-value">
          ${completedCount}<span class="stats-hero-suffix">件成衣</span>
        </div>
        <a class="stats-hero-cta" href="#/stats">查看完整统计 →</a>
      </div>

      <div class="home-stats-grid">
        <a class="home-stat-card" href="#/garments">
          <div class="home-stat-icon">👗</div>
          <div class="home-stat-value">${garmentCount}</div>
          <div class="home-stat-label">成衣</div>
        </a>
        <a class="home-stat-card" href="#/materials/fabric">
          <div class="home-stat-icon">🧵</div>
          <div class="home-stat-value">${stock.fabricMeters.toFixed(1)}</div>
          <div class="home-stat-label">布料（米）</div>
        </a>
        <a class="home-stat-card" href="#/materials/pattern">
          <div class="home-stat-icon">📐</div>
          <div class="home-stat-value">${patternCount}</div>
          <div class="home-stat-label">纸样</div>
        </a>
      </div>

      <div class="card">
        <div class="card-title">快速添加</div>
        <div class="home-actions">
          <a class="home-action" href="#/materials/new">
            <div class="home-action-icon">🧵</div>
            <div class="home-action-label">+物料</div>
          </a>
          <a class="home-action" href="#/garments/new">
            <div class="home-action-icon">👗</div>
            <div class="home-action-label">+成衣</div>
          </a>
          <a class="home-action" href="#/workbench/new">
            <div class="home-action-icon">📋</div>
            <div class="home-action-label">+任务</div>
          </a>
        </div>
      </div>

      ${recentBlock}

      <div class="card" style="font-size:12px;color:hsl(var(--secondary-foreground));line-height:1.7;">
        <div class="card-title">数据口径</div>
        <div>本月战果 = 本月已完工 <code>status=completed</code> 的成衣条数（仅件数，不含金额 · 2026-09-14 裁决①）。</div>
        <div>布料库存 = Σ fabric.quantity（当前时点）；切换时段不变。</div>
      </div>`;

    // M1.5: 首页「最近成衣」卡异步加载首图（3:4 竖版）
    if (recent.length) {
      await C.hydrateGarmentCardImages(root, global.SS.app.loadImage);
    }
  }

  /* ============ 物料模块（M1.2 真实实现） ============ */

  // 当前列表过滤状态（hash 反映）
  const MATERIAL_TABS = [
    { id: 'all',       label: '全部' },
    { id: 'fabric',    label: '面料' },
    { id: 'accessory', label: '辅料' },
    { id: 'tool',      label: '工具' },
    { id: 'pattern',   label: '纸样' },
  ];

  /** 解析 #/materials/<tab>?<qs> */
  function parseMaterialsHash(hash) {
    // hash 形如 "#/materials/fabric" 或 "#/materials/pattern?usage=unused"
    const path = (hash || '#/materials').replace(/^#/, '');
    const [pathPart, qs] = path.split('?');
    const segs = pathPart.split('/').filter(Boolean);
    // segs = ['materials', 'fabric'] 或 ['materials']
    const tabId = segs[1] || 'all';
    const params = {};
    if (qs) qs.split('&').forEach((kv) => {
      const [k, v] = kv.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    return { tabId, params };
  }

  /**
   * 物料列表
   * 路由：#/materials/<tab>?usage=<used|unused|all>
   */
  async function renderMaterials(root, defaultTabId) {
    const hash = global.location.hash || '#/materials';
    const parsed = parseMaterialsHash(hash);
    // 优先用 hash 中的 tabId；hash 只在 /materials 时为 'all'，回退到路由提供的默认 tab
    const tabId = (parsed.tabId !== 'all') ? parsed.tabId : (defaultTabId || 'all');
    const usageFilter = (tabId === 'pattern') ? (parsed.params.usage || 'unused') : null;

    // 查询
    const all = await dbTable.materials.toArray();
    let items = all;
    if (tabId !== 'all') items = items.filter((m) => m.type === tabId);

    if (tabId === 'pattern') {
      // 默认未使用，已使用按星级降序，未使用按更新时间降序
      const usedOnly = usageFilter === 'used';
      const unUsedOnly = usageFilter === 'unused';
      if (usedOnly) items = items.filter((m) => m.used === 1);
      if (unUsedOnly) items = items.filter((m) => m.used !== 1);
      items.sort((a, b) => {
        const au = a.used === 1, bu = b.used === 1;
        if (au && !bu) return -1;
        if (!au && bu) return 1;
        // 同状态：已使用按星级降序；未使用按更新时间降序
        if (au && bu) return (b.rating || 0) - (a.rating || 0);
        return (b.updatedAt || '').localeCompare(a.updatedAt || '');
      });
    } else {
      // 非纸样：按更新时间倒序
      items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    }

    // tab 计数
    const tabBadges = {};
    MATERIAL_TABS.forEach((t) => {
      tabBadges[t.id] = t.id === 'all' ? all.length : all.filter((m) => m.type === t.id).length;
    });

    // Tabs
    const tabsHtml = C.renderTabs(
      MATERIAL_TABS.map((t) => ({ id: t.id, label: t.label, badge: tabBadges[t.id] })),
      tabId,
      '#/materials'
    );

    // 纸样专属筛选 chips
    let chipsHtml = '';
    if (tabId === 'pattern') {
      chipsHtml = C.renderFilterChips(
        [
          { id: 'unused', label: '未使用' },
          { id: 'used',   label: '已使用' },
          { id: 'all',    label: '全部' },
        ],
        [usageFilter || 'unused']
      );
    }

    // 列表
    const listHtml = items.length
      ? items.map((m) => C.renderMaterialCard(m, { useStars: true, showUsageState: true })).join('')
      : C.renderEmptyState({
          icon: '🪡',
          title: tabId === 'all' ? '还没有物料' : '还没有' + (C.TYPE_LABEL[tabId] || tabId),
          desc: '点击右上角 ＋ 新增',
        });

    root.innerHTML = `
      ${tabsHtml}
      ${chipsHtml}
      <div class="material-list">${listHtml}</div>
      <div class="fab-row">
        <a class="fab btn btn-primary" href="#/materials/new">＋ 新增物料</a>
      </div>
    `;

    // 绑定 chips 切换
    root.querySelectorAll('[data-chip-id]').forEach((el) => {
      el.onclick = () => {
        const id = el.getAttribute('data-chip-id');
        global.location.hash = '#/materials/' + tabId + '?usage=' + id;
      };
    });
  }

  /**
   * 物料详情 / 表单（按 id 参数分支）
   * - id === 'new'                  → 新增表单 Sheet（render 到 root）
   * - id === '<id>/edit'            → 编辑表单 Sheet
   * - id === '<id>'                 → 详情页
   */
  async function renderMaterialDetail(root, id) {
    if (id === 'new') {
      return renderMaterialForm(root, null);
    }
    let realId = id;
    let isEdit = false;
    if (id && id.endsWith('/edit')) {
      realId = id.slice(0, -5);
      isEdit = true;
    }
    if (!realId) {
      root.innerHTML = C.renderEmptyState({ icon: '🧭', title: '无效的物料', desc: '缺少 ID 参数' });
      return;
    }
    const m = await dbTable.materials.get(realId);
    if (!m) {
      root.innerHTML = C.renderEmptyState({ icon: '🔍', title: '物料不存在', desc: '可能已被删除' });
      return;
    }
    if (isEdit) {
      return renderMaterialForm(root, m);
    }
    return renderMaterialDetailView(root, m);
  }

  /**
   * 物料详情页（只读 + 操作按钮）
   */
  async function renderMaterialDetailView(root, m) {
    // 首图（首张图片）
    const firstImgId = (m.images || [])[0];
    let firstImgUrl = null;
    if (firstImgId) {
      try { firstImgUrl = await global.SS.app.loadImage(firstImgId); } catch (_) {}
    }

    // 流水（最近 20 条）
    const logs = await dbTable.usageLogs
      .where('materialId').equals(m.id)
      .reverse()
      .sortBy('createdAt');
    const recentLogs = logs.slice(0, 20);
    const logsHtml = recentLogs.length
      ? recentLogs.map((l) => C.renderUsageLogItem(l, m.name)).join('')
      : `<div class="muted" style="padding:12px;text-align:center;">暂无流水</div>`;

    // 字段（按 type 条件渲染）
    const type = m.type;
    const fields = [];
    fields.push({ label: '类型', value: C.TYPE_LABEL[type] || type, type: 'text' });
    fields.push({ label: '名称', value: m.name, type: 'text' });
    if (m.category) fields.push({ label: '二级分类', value: m.category, type: 'text' });
    fields.push({ label: '当前库存', value: m.quantity + ' ' + (m.unit || ''), type: 'text' });
    if (m.initialQuantity != null) fields.push({ label: '购入量', value: m.initialQuantity + ' ' + (m.unit || ''), type: 'text' });
    if (m.purchaseDate) fields.push({ label: '采购日期', value: m.purchaseDate, type: 'text' });
    if (m.purchasePrice != null) fields.push({ label: '采购单价', value: '¥' + m.purchasePrice, type: 'text' });
    if (type === 'fabric') {
      if (m.color) fields.push({ label: '颜色', value: m.color, type: 'text' });
      // width/weight 可能是数字（cm/g/m²）或带单位的字符串
      if (m.width != null) fields.push({ label: '幅宽', value: (typeof m.width === 'number') ? m.width + ' cm' : m.width, type: 'text' });
      if (m.weight != null) fields.push({ label: '克重', value: (typeof m.weight === 'number') ? m.weight + ' g/m²' : m.weight, type: 'text' });
      if (m.composition) fields.push({ label: '成分', value: m.composition, type: 'text' });
      if (m.sampleCard) fields.push({ label: '样卡牌', value: m.sampleCard, type: 'text' });
      if (m.season) {
        // season 可能是 'all_season' 单值或 'spring,summer' 组合；分别映射
        const seasonList = String(m.season).split(/[,，;；\s]+/).filter(Boolean);
        const seasonLabels = seasonList.map((s) => C.SEASON_LABEL[s] || s).join('、');
        fields.push({ label: '适合季节', value: seasonLabels, type: 'text' });
      }
      if (m.suitableFor && m.suitableFor.length) fields.push({ label: '适合款式', value: m.suitableFor, type: 'chips' });
    }
    if (type === 'pattern') {
      if (m.size) fields.push({ label: '尺码', value: m.size, type: 'text' });
      if (m.rating) fields.push({ label: '评分', value: m.rating, type: 'stars' });
      if (m.ratingReview) fields.push({ label: '短评', value: m.ratingReview, type: 'text' });
      fields.push({ label: '使用状态', value: m.used === 1, type: 'switch' });
    }
    if (m.brand) fields.push({ label: '品牌', value: m.brand, type: 'text' });
    if (m.forWhom && m.forWhom.length) fields.push({ label: '适合人群', value: m.forWhom, type: 'chips' });
    if (m.tags && m.tags.length) fields.push({ label: '标签', value: m.tags, type: 'chips' });
    if (m.notes) fields.push({ label: '备注', value: m.notes, type: 'textarea' });
    fields.push({ label: '创建时间', value: global.SS.utils.relativeTime(m.createdAt), type: 'text' });
    fields.push({ label: '更新时间', value: global.SS.utils.relativeTime(m.updatedAt), type: 'text' });

    const fieldsHtml = fields.map((f) => C.renderField(f)).join('');

    root.innerHTML = `
      <div class="hero-card mat-hero">
        ${firstImgUrl
          ? `<img src="${firstImgUrl}" alt="" class="mat-hero-img" />`
          : `<div class="mat-hero-emoji">${C.TYPE_ICON[type] || '📦'}</div>`}
        <div class="mat-hero-title">${global.SS.utils.escapeHtml(m.name || '(未命名)')}</div>
        <div class="mat-hero-sub">${global.SS.utils.escapeHtml(C.TYPE_LABEL[type] || type)}${m.brand ? ' · ' + global.SS.utils.escapeHtml(m.brand) : ''}</div>
        <div class="mat-hero-meta">${global.SS.utils.escapeHtml(String(m.quantity))} ${global.SS.utils.escapeHtml(m.unit || '')}</div>
      </div>

      <div class="card mat-actions">
        <button class="btn btn-primary" data-action="record-loss" type="button">记损耗</button>
        <a class="btn" href="#/materials/${global.SS.utils.escapeHtml(m.id)}/edit">编辑</a>
        <button class="btn btn-danger" data-action="delete" type="button">删除</button>
      </div>

      <div class="card">
        <div class="card-title">基础信息</div>
        ${fieldsHtml}
      </div>

      <div class="card">
        <div class="card-title">库存流水（最近 ${recentLogs.length} 条）</div>
        <div class="log-list">${logsHtml}</div>
      </div>
    `;

    // 事件绑定
    root.querySelector('[data-action="record-loss"]').onclick = () => openLossSheet(m);
    root.querySelector('[data-action="delete"]').onclick = () => confirmDelete(m);
  }

  /**
   * 物料表单（新增/编辑共用）
   */
  async function renderMaterialForm(root, existing) {
    const isEdit = !!existing;
    const presets = await getPresets();

    // 当前值
    const v = existing || {
      type: 'fabric',
      name: '',
      quantity: 0,
      unit: '米',
      brand: '',
      tags: [],
      suitableFor: [],
      season: 'all_season',
      width: null,
      weight: null,
      composition: '',
      sampleCard: '',
      color: '',
      size: '',
      rating: 0,
      ratingReview: '',
      used: 0,
      forWhom: [],
      notes: '',
      purchasePrice: null,
      purchaseDate: '',
      initialQuantity: null,
      category: '',
      images: [],
    };

    // 渲染整个表单（root 装表单，提交按钮固定在底部）
    root.innerHTML = `
      <form class="material-form" data-material-form>
        <div class="card">
          <div class="card-title">${isEdit ? '编辑物料' : '新增物料'}</div>
          ${C.renderField({ label: '类型', value: v.type, edit: true, type: 'select', options: [
            { id: 'fabric', label: '面料' },
            { id: 'accessory', label: '辅料' },
            { id: 'tool', label: '工具' },
            { id: 'pattern', label: '纸样' },
          ] })}
          ${C.renderField({ label: '名称', value: v.name, edit: true, type: 'text', placeholder: '如：纯棉白底碎花', max: 50 })}
          ${C.renderField({ label: '二级分类', value: v.category || '', edit: true, type: 'text', placeholder: '可选', max: 30 })}
          ${C.renderField({ label: '当前库存', value: v.quantity, edit: true, type: 'number', min: 0, step: 0.01 })}
          ${C.renderField({ label: '单位', value: v.unit, edit: true, type: 'text', placeholder: '米/个/条/卷/张', max: 5 })}
        </div>

        <div class="card" data-type-section="purchase">
          <div class="card-title">采购信息</div>
          ${C.renderField({ label: '购入量', value: v.initialQuantity ?? '', edit: true, type: 'number', min: 0, step: 0.01, placeholder: '可选' })}
          ${C.renderField({ label: '采购日期', value: v.purchaseDate || '', edit: true, type: 'date' })}
          ${C.renderField({ label: '采购单价（元）', value: v.purchasePrice ?? '', edit: true, type: 'number', min: 0, step: 0.01 })}
        </div>

        <div class="card" data-type-section="fabric">
          <div class="card-title">面料属性</div>
          ${C.renderField({ label: '颜色', value: v.color || '', edit: true, type: 'text', max: 30 })}
          ${C.renderField({ label: '幅宽（cm）', value: v.width ?? '', edit: true, type: 'number', min: 0, step: 0.1 })}
          ${C.renderField({ label: '克重（g/m²）', value: v.weight ?? '', edit: true, type: 'number', min: 0, step: 1 })}
          ${C.renderField({ label: '成分', value: v.composition || '', edit: true, type: 'text', max: 100 })}
          ${C.renderField({ label: '样卡牌', value: v.sampleCard || '', edit: true, type: 'text', max: 50 })}
          ${C.renderField({ label: '适合季节', value: v.season, edit: true, type: 'select', options: [
            { id: 'spring', label: '春' },
            { id: 'summer', label: '夏' },
            { id: 'autumn', label: '秋' },
            { id: 'winter', label: '冬' },
            { id: 'all_season', label: '四季' },
          ] })}
          ${C.renderField({ label: '适合款式', value: v.suitableFor || [], edit: true, type: 'multiselect', options: presets.patternStyles.map((s) => ({ id: s, label: s })) })}
        </div>

        <div class="card" data-type-section="accessory">
          <div class="card-title">辅料属性</div>
          ${C.renderField({ label: '辅料标签', value: v.tags || [], edit: true, type: 'multiselect', options: presets.accessoryTags.map((s) => ({ id: s, label: s })) })}
        </div>

        <div class="card" data-type-section="pattern">
          <div class="card-title">纸样属性</div>
          ${C.renderField({ label: '尺码', value: v.size || '', edit: true, type: 'select', options: presets.patternSizes.map((s) => ({ id: s, label: s })) })}
          ${C.renderField({ label: '评分', value: v.rating || 0, edit: true, type: 'stars' })}
          ${C.renderField({ label: '短评', value: v.ratingReview || '', edit: true, type: 'text', max: 100 })}
          ${C.renderField({ label: '已使用', value: v.used === 1, edit: true, type: 'switch' })}
        </div>

        <div class="card" data-type-section="common-brand">
          <div class="card-title">品牌</div>
          ${C.renderField({ label: '品牌', value: v.brand || '', edit: true, type: 'select', options: [
            { id: '', label: '（不选）' },
            ...(v.type === 'fabric' ? presets.fabricBrands : v.type === 'pattern' ? presets.patternBrands : []).map((b) => ({ id: b, label: b })),
          ] })}
        </div>

        <div class="card">
          <div class="card-title">适合人群</div>
          ${C.renderField({ label: '适合人群', value: v.forWhom || [], edit: true, type: 'multiselect', options: presets.patternAudiences.map((s) => ({ id: s, label: s })) })}
          ${C.renderField({ label: '通用标签', value: v.tags || [], edit: true, type: 'multiselect', options: presets.accessoryTags.map((s) => ({ id: s, label: s })) })}
        </div>

        <div class="card">
          <div class="card-title">备注</div>
          ${C.renderField({ label: '备注', value: v.notes || '', edit: true, type: 'textarea', max: 500 })}
        </div>

        <div class="card">
          <div class="card-title">图片（D-IM1 · Blob 直存 IndexedDB）</div>
          ${C.renderImageUploader({ images: v.images || [], max: 9 })}
        </div>

        <div class="form-actions">
          <a class="btn" href="#/materials">取消</a>
          <button class="btn btn-primary" type="submit">${isEdit ? '保存' : '新增'}</button>
        </div>
      </form>
    `;

    // 类型 → 字段显隐（condition render）
    const applyTypeVisibility = (type) => {
      const showFabric = type === 'fabric';
      const showAccessory = type === 'accessory';
      const showPattern = type === 'pattern';
      const showBrand = type === 'fabric' || type === 'pattern';
      root.querySelectorAll('[data-type-section="fabric"]').forEach((el) => el.hidden = !showFabric);
      root.querySelectorAll('[data-type-section="accessory"]').forEach((el) => el.hidden = !showAccessory);
      root.querySelectorAll('[data-type-section="pattern"]').forEach((el) => el.hidden = !showPattern);
      root.querySelectorAll('[data-type-section="common-brand"]').forEach((el) => el.hidden = !showBrand);
    };
    applyTypeVisibility(v.type);

    // 类型切换 → 更新品牌选项 + 显隐
    const typeSelect = root.querySelector('[data-field-input]'); // 第一个是 type select
    // 注意：data-field-input 在 form 中是 select；用 type 来定位
    const typeFieldInput = Array.from(root.querySelectorAll('[data-field-input]')).find((el) => el.tagName === 'SELECT');
    if (typeFieldInput) {
      typeFieldInput.onchange = () => {
        applyTypeVisibility(typeFieldInput.value);
        // 更新品牌下拉
        const brandCard = root.querySelector('[data-type-section="common-brand"]');
        const brandSelect = brandCard && brandCard.querySelector('select');
        if (brandSelect) {
          const list = typeFieldInput.value === 'fabric' ? presets.fabricBrands
            : (typeFieldInput.value === 'pattern' ? presets.patternBrands : []);
          brandSelect.innerHTML = '<option value="">（不选）</option>'
            + list.map((b) => `<option value="${global.SS.utils.escapeHtml(b)}">${global.SS.utils.escapeHtml(b)}</option>`).join('');
        }
      };
    }

    // 多选 chip 切换
    root.querySelectorAll('[data-multi]').forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        btn.classList.toggle('chip-active');
      };
    });

    // 星级
    root.querySelectorAll('.star-edit').forEach((wrap) => {
      wrap.querySelectorAll('[data-rating]').forEach((starBtn) => {
        starBtn.onclick = (e) => {
          e.preventDefault();
          const val = Number(starBtn.getAttribute('data-rating'));
          wrap.querySelectorAll('.star-btn').forEach((b) => {
            const v = Number(b.getAttribute('data-rating'));
            b.classList.toggle('star-on', v <= val && val > 0);
          });
        };
      });
    });

    // 图片上传（M1.5：显式传 entityType='material'，与默认一致；保留向后兼容）
    root.querySelectorAll('[data-img-add]').forEach((addEl) => {
      addEl.onclick = () => addEl.querySelector('[data-img-input]').click();
      addEl.querySelector('[data-img-input]').onchange = async (e) => {
        await handleImageAdd(root, e.target.files, 'material', v.id || '');
        e.target.value = ''; // reset
      };
    });
    root.querySelectorAll('[data-img-remove]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const imgId = btn.getAttribute('data-img-remove');
        await global.SS.app.deleteImage(imgId);
        btn.closest('.img-thumb').remove();
      };
    });

    // 加载已存在的图片
    for (const id of (v.images || [])) {
      const url = await global.SS.app.loadImage(id);
      const el = root.querySelector(`[data-img-load="${id}"]`);
      if (el && url) el.style.backgroundImage = `url(${JSON.stringify(url)})`;
    }

    // 提交
    const form = root.querySelector('[data-material-form]');
    form.onsubmit = async (e) => {
      e.preventDefault();
      await saveMaterialForm(root, existing);
    };
  }

  /** 从表单读出字段值 */
  function readFormValues(root) {
    const data = {};
    // 文本/数字/日期/textarea 输入
    root.querySelectorAll('input[data-field-input], textarea[data-field-input]').forEach((el) => {
      if (el.type === 'checkbox') {
        data[el.getAttribute('data-field-name') || '__switch__'] = el.checked;
        return;
      }
      // 字段用 closest('.field').querySelector('.field-label') 找键名 — 但简化用 index
      data.__pending__ = data.__pending__ || [];
      data.__pending__.push(el);
    });
    // select
    const selects = root.querySelectorAll('select[data-field-input]');
    selects.forEach((sel) => data.__select__ = data.__select__ || []);
    // 走专门的提取：按 field label 顺序
    const fields = Array.from(root.querySelectorAll('.field'));
    fields.forEach((fld) => {
      const label = (fld.querySelector('.field-label') || {}).textContent || '';
      const input = fld.querySelector('[data-field-input]');
      if (!input) return;
      if (input.tagName === 'SELECT') {
        data[label] = input.value;
      } else if (input.type === 'checkbox') {
        data[label] = input.checked;
      } else if (input.tagName === 'TEXTAREA') {
        data[label] = input.value;
      } else {
        data[label] = input.value;
      }
    });
    // 多选 chips（按 card 标题分组）
    root.querySelectorAll('[data-field-input][data-field-options]').forEach((wrap) => {
      if (!wrap.classList.contains('chip-multi')) return;
      // 找最近的 card-title 文本
      const card = wrap.closest('.card');
      const cardTitle = (card && card.querySelector('.card-title')) ? card.querySelector('.card-title').textContent.trim() : '';
      const fieldLabel = wrap.closest('.field').querySelector('.field-label').textContent.trim();
      const key = cardTitle + '/' + fieldLabel;
      data[key] = Array.from(wrap.querySelectorAll('[data-multi].chip-active')).map((b) => b.getAttribute('data-multi'));
    });
    // 星级
    const starEdits = root.querySelectorAll('.star-edit[data-field-input]');
    starEdits.forEach((wrap) => {
      const fieldLabel = wrap.closest('.field').querySelector('.field-label').textContent.trim();
      const cardTitle = wrap.closest('.card').querySelector('.card-title').textContent.trim();
      const active = wrap.querySelectorAll('.star-btn.star-on');
      data[cardTitle + '/' + fieldLabel] = active.length;
    });
    return data;
  }

  /** 保存表单（新增 / 编辑） */
  async function saveMaterialForm(root, existing) {
    const d = readFormValues(root);
    const type = d['类型'] || 'fabric';
    const name = (d['名称'] || '').trim();
    if (!name) {
      global.SS.utils.toast('名称不能为空');
      return;
    }
    const ts = global.SS.utils.nowIso();
    const imgIds = Array.from(root.querySelectorAll('[data-img-id]')).map((el) => el.getAttribute('data-img-id'));
    const data = {
      type,
      name,
      category: (d['二级分类'] || '').trim() || undefined,
      quantity: Number(d['当前库存']) || 0,
      unit: (d['单位'] || '').trim() || '个',
      initialQuantity: d['购入量'] === '' || d['购入量'] == null ? undefined : Number(d['购入量']),
      purchaseDate: d['采购日期'] || undefined,
      purchasePrice: d['采购单价（元）'] === '' || d['采购单价（元）'] == null ? undefined : Number(d['采购单价（元）']),
      brand: d['品牌'] || undefined,
      // v1.1.2 P1-M2-2 残留（辅料标签分支）：按物料类型取键，避免被恒存在
      //  的「适合人群/通用标签」（空数组）短路。当前为四类形态：
      //    accessory → 「辅料属性/辅料标签」
      //    其余三类  → 「适合人群/通用标签」（共享通用标签预设）
      tags: type === 'accessory'
        ? (d['辅料属性/辅料标签'] || [])
        : (d['适合人群/通用标签'] || []),
      notes: (d['备注'] || '').trim() || undefined,
      images: imgIds,
    };
    if (type === 'fabric') {
      data.color = (d['颜色'] || '').trim() || undefined;
      data.width = d['幅宽（cm）'] === '' ? undefined : Number(d['幅宽（cm）']);
      data.weight = d['克重（g/m²）'] === '' ? undefined : Number(d['克重（g/m²）']);
      data.composition = (d['成分'] || '').trim() || undefined;
      data.sampleCard = (d['样卡牌'] || '').trim() || undefined;
      data.season = d['适合季节'] || 'all_season';
      data.suitableFor = d['面料属性/适合款式'] || [];
    } else if (type === 'accessory') {
      // 辅料标签：已在 data.tags 里按「辅料属性/辅料标签」兜底读
    } else if (type === 'pattern') {
      data.size = d['尺码'] || undefined;
      data.rating = d['纸样属性/评分'] || 0;
      data.ratingReview = (d['短评'] || '').trim() || undefined;
      data.used = d['已使用'] ? 1 : 0;
      data.suitableFor = data.suitableFor || [];
    }
    if (type === 'fabric' || type === 'pattern') {
      data.forWhom = d['适合人群/适合人群'] || [];
    }

    try {
      if (existing) {
        // 编辑：调整数量时写 adjust 流水
        const oldQty = existing.quantity || 0;
        const newQty = data.quantity;
        const deltas = [];
        deltas.push(existing.id);
        const next = { ...existing, ...data, updatedAt: ts };
        if (existing.quantity !== newQty) {
          await global.SS.db.adjustMaterialQuantity(existing.id, newQty, '编辑表单直改 quantity');
        }
        // 直接 update 其它字段
        await dbTable.materials.update(existing.id, next);
        // M1.5: 回填图片 entityId（编辑态，prev 已有 id 直接生效；新增的仍走 _backfill）
        await backfillImagesEntity('material', existing.id, imgIds);
        global.SS.utils.toast('已保存');
        global.location.hash = '#/materials/' + existing.id;
      } else {
        const id = global.SS.utils.nanoid(12);
        const newRow = { id, ...data, createdAt: ts, updatedAt: ts };
        // 若初始数量 != 0，写一条 kind=adjust source=manual 的流水（D-WH6：手动入库）
        await dbTable.materials.put(newRow);
        if (newRow.quantity > 0) {
          await dbTable.usageLogs.add({
            id: global.SS.utils.nanoid(12),
            materialId: id,
            materialName: newRow.name,
            quantity: newRow.quantity,
            kind: 'adjust',
            source: 'manual',
            garmentId: null,
            note: '新建物料初始库存',
            createdAt: ts,
          });
        }
        // M1.5: 新建物料后回填图片 entityId（先前上传的 entityId='' 现指到本物料）
        await backfillImagesEntity('material', id, imgIds);
        global.SS.utils.toast('已新增');
        global.location.hash = '#/materials/' + id;
      }
    } catch (err) {
      console.error(err);
      global.SS.utils.toast('保存失败：' + (err.message || err));
    }
  }

  /**
   * 处理图片新增（Blob → IndexedDB）
   * M1.5: 支持 material / garment / task 三种 entityType
   * @param {HTMLElement} root  含 [data-img-uploader] 的容器
   * @param {FileList|File[]} files  待上传文件
   * @param {string} entityType  'material'|'garment'|'task'，默认 'material'
   * @param {string} entityId    若已有 entityId（编辑态），可提前回填；新建时为 ''
   */
  async function handleImageAdd(root, files, entityType = 'material', entityId = '') {
    if (!files || !files.length) return;
    if (!['material', 'garment', 'task'].includes(entityType)) {
      console.warn('handleImageAdd: unsupported entityType=', entityType);
      return;
    }
    const list = root.querySelector('[data-img-uploader]');
    for (const file of Array.from(files)) {
      try {
        const id = global.SS.utils.nanoid(12);
        const blob = await compressImage(file);
        await dbTable.images.put({
          id,
          blob,
          originalName: file.name,
          mimeType: 'image/jpeg',
          entityType,
          entityId: entityId || '',
          createdAt: global.SS.utils.nowIso(),
        });
        // 渲染缩略图
        const url = URL.createObjectURL(blob);
        const addEl = list.querySelector('[data-img-add]');
        const thumb = document.createElement('div');
        thumb.className = 'img-thumb';
        thumb.setAttribute('data-img-id', id);
        thumb.innerHTML = `
          <div class="img-thumb-inner" style="background-image:url(${JSON.stringify(url)})"></div>
          <button class="img-remove" data-img-remove="${id}" type="button">×</button>`;
        list.insertBefore(thumb, addEl);
        thumb.querySelector('[data-img-remove]').onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await global.SS.app.deleteImage(id);
          thumb.remove();
        };
      } catch (e) {
        console.error('图片上传失败', e);
      }
    }
  }

  /**
   * 回填图片 entityId（M1.5 引入：表单上传时 entityId=''，保存后绑定到具体实体）。
   * 同时确保实体被删除时残留的孤儿图片（无 entityId 引用）仍可通过 material.images / garment.images 反向索引找回。
   * @param {'material'|'garment'|'task'} entityType
   * @param {string} entityId
   * @param {string[]} imgIds  表单当前挂载的图片 id 列表
   */
  async function backfillImagesEntity(entityType, entityId, imgIds) {
    if (!['material', 'garment', 'task'].includes(entityType)) return;
    if (!entityId) return;
    const ids = (imgIds || []).filter(Boolean);
    if (ids.length === 0) return;
    try {
      for (const imgId of ids) {
        const row = await dbTable.images.get(imgId);
        if (!row) continue;
        if (row.entityType === entityType && row.entityId === entityId) continue;
        await dbTable.images.update(imgId, { entityType, entityId });
      }
    } catch (e) {
      console.warn('backfillImagesEntity failed:', e);
    }
  }

  /**
   * 简易图片压缩（PRD D-IM1：最长边 780px / JPEG 0.75 / 保留 EXIF 方向靠浏览器自身读取）
   * v1.3.1 baseline 用 1024/0.82，M1.5 上调为 780/0.75 以匹配冻结文档口径
   */
  async function compressImage(file) {
    const img = await loadImageElement(file);
    const MAX = 780;
    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > MAX || h > MAX) {
      const r = Math.min(MAX / w, MAX / h);
      w = Math.round(w * r);
      h = Math.round(h * r);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.75));
  }
  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  /** 打开记损耗 Sheet */
  function openLossSheet(m) {
    C.openSheet({
      title: '记录损耗 · ' + m.name,
      content: `
        <div class="sheet-form">
          <div class="muted" style="margin-bottom:8px;">当前库存：${global.SS.utils.escapeHtml(String(m.quantity))} ${global.SS.utils.escapeHtml(m.unit || '')}</div>
          <div class="field">
            <div class="field-label">损耗数量</div>
            <div class="field-value">
              <input class="field-input" type="number" min="0.01" step="0.01" id="loss-qty" placeholder="如 0.5" autofocus>
            </div>
          </div>
          <div class="field">
            <div class="field-label">备注（可选）</div>
            <div class="field-value">
              <textarea class="field-input" id="loss-note" maxlength="100" placeholder="如：试裁损耗"></textarea>
            </div>
          </div>
          <div class="form-actions">
            <button class="btn" data-sheet-close type="button">取消</button>
            <button class="btn btn-primary" id="loss-submit" type="button">确认记录</button>
          </div>
        </div>
      `,
      onMount: (wrap, close) => {
        wrap.querySelector('#loss-submit').onclick = async () => {
          const qty = Number(wrap.querySelector('#loss-qty').value);
          const note = wrap.querySelector('#loss-note').value || '';
          if (!Number.isFinite(qty) || qty <= 0) {
            global.SS.utils.toast('损耗数量必须大于 0');
            return;
          }
          // v1.1.1 P1-M2-3 修复：超库存由数据层 recordLoss 抛错拦截，
          //   UI 不再 confirm 放行；冻结文档 §1.10 / §3.5「拦截」口径。
          try {
            await global.SS.db.recordLoss(m.id, qty, note);
            global.SS.utils.toast('已记录损耗');
            close();
            // 刷新详情页
            global.location.hash = '#/materials/' + m.id;
          } catch (e) {
            global.SS.utils.toast('记录失败：' + (e.message || e));
          }
        };
      },
    });
  }

  /** 确认删除 */
  function confirmDelete(m) {
    if (!confirm(`确认删除「${m.name}」？\n\n相关图片将一起清理（图片 Blob 直存 IndexedDB）。\n\n删除后此物料的库存流水仍保留（materialName 快照）。`)) return;
    (async () => {
      try {
        // 清理关联图片
        for (const imgId of (m.images || [])) {
          await global.SS.app.deleteImage(imgId);
        }
        await dbTable.materials.delete(m.id);
        global.SS.utils.toast('已删除');
        global.location.hash = '#/materials';
      } catch (e) {
        global.SS.utils.toast('删除失败：' + (e.message || e));
      }
    })();
  }

  /** 读取 presets */
  async function getPresets() {
    const row = await dbTable.settings.get('presets');
    if (!row) return JSON.parse(JSON.stringify(global.SS.db.DEFAULT_PRESETS));
    return JSON.parse(row.value);
  }

  /* ============ 成衣模块（M1.3 真实实现） ============ */

  // 成衣状态 tabs
  const GARMENT_TABS = [
    { id: 'all',         label: '全部' },
    { id: 'planning',    label: '规划中' },
    { id: 'in_progress', label: '进行中' },
    { id: 'completed',   label: '已完工' },
    { id: 'on_hold',     label: '暂停' },
  ];

  /** 解析 #/garments/<tab> */
  function parseGarmentsHash(hash) {
    const path = (hash || '#/garments').replace(/^#/, '');
    const segs = path.split('/').filter(Boolean);
    const tabId = segs[1] || 'all';
    return { tabId };
  }

  /** 渲染列表：状态 tabs + 卡片网格 + 新建按钮 */
  async function renderGarments(root) {
    const parsed = parseGarmentsHash(global.location.hash || '#/garments');
    const tabId = parsed.tabId !== 'all' ? parsed.tabId : 'all';

    const all = await dbTable.garments.orderBy('updatedAt').reverse().toArray();
    const tabBadges = {};
    GARMENT_TABS.forEach((t) => {
      tabBadges[t.id] = t.id === 'all' ? all.length : all.filter((g) => g.status === t.id).length;
    });

    const items = tabId === 'all' ? all : all.filter((g) => g.status === tabId);
    const tabsHtml = C.renderTabs(
      GARMENT_TABS.map((t) => ({ id: t.id, label: t.label, badge: tabBadges[t.id] })),
      tabId,
      '#/garments'
    );
    const emptyHtml = items.length === 0
      ? C.renderEmptyState({
          icon: '👕',
          title: tabId === 'all' ? '还没有成衣' : '此状态下暂无成衣',
          desc: '点击下方按钮登记第一件',
        })
      : '';
    const cardsHtml = items.length
      ? `<div class="garment-list">${items.map((g) => C.renderGarmentCard(g)).join('')}</div>`
      : '';

    root.innerHTML = `
      ${tabsHtml}
      ${emptyHtml}
      ${cardsHtml}
      <div class="fab-row">
        <a class="btn btn-primary btn-block" href="#/garments/new">+ 新建成衣</a>
      </div>`;

    // M1.5: 成衣列表异步加载首图（3:4 竖版）
    if (items.length) {
      await C.hydrateGarmentCardImages(root, global.SS.app.loadImage);
    }
  }

  /* ----- 物料选择器 Sheet（M1.3） ----- */
  // 选物料时存状态：{ kind: 'fabric'|'accessory'|'pattern', pendingSelections: Map<materialId, qty>, onConfirm }

  /**
   * 全屏物料选择 sheet。
   * @param {Object} opts { kind: 'fabric'|'accessory'|'pattern', multi, excludeIds, initialSelections, onConfirm }
   *   multi=true 多选；初始 selections = [{ materialId, quantityUsed }]
   *   onConfirm 回调接收 [{ materialId, quantityUsed }]
   */
  function openMaterialSelectorSheet(opts) {
    const kind = opts.kind;
    const multi = opts.multi !== false;
    const excludeIds = new Set(opts.excludeIds || []);
    const initialSelections = opts.initialSelections || [];
    const onConfirm = opts.onConfirm || (() => {});
    const titleMap = { fabric: '选面料', accessory: '选辅料', pattern: '选纸样' };

    // 当前选中的物料 id → qty（每次 sheet 内更改）
    const selectedMap = new Map();
    for (const s of initialSelections) {
      selectedMap.set(s.materialId, Number(s.quantityUsed) || 1);
    }

    C.openSheet({
      title: titleMap[kind] || '选物料',
      content: '<div class="picker-list" data-picker-sheet></div>',
      onMount: async (panelEl) => {
        const wrap = panelEl.querySelector('[data-picker-sheet]');
        const all = await dbTable.materials.toArray();
        // 按 kind 过滤 + 排除已排除 id
        const mats = all.filter((m) => m.type === kind && !excludeIds.has(m.id));
        // 已有 0 库存的放在最后
        mats.sort((a, b) => {
          const aZero = (Number(a.quantity) || 0) <= 0 ? 1 : 0;
          const bZero = (Number(b.quantity) || 0) <= 0 ? 1 : 0;
          if (aZero !== bZero) return aZero - bZero;
          return (a.name || '').localeCompare(b.name || '');
        });
        const render = () => {
          wrap.innerHTML = mats.length
            ? mats.map((m) => C.renderMaterialPickerCard(
                m,
                selectedMap.has(m.id),
                selectedMap.get(m.id),
                true
              )).join('')
            : C.renderEmptyState({ icon: '📦', title: '暂无可选物料', desc: '请先在物料库新增' });
          // footer 实时总成本
          const totalCostEl = panelEl.querySelector('[data-picker-totalcost]');
          if (totalCostEl) {
            const total = mats.reduce((s, m) => {
              if (!selectedMap.has(m.id)) return s;
              const q = selectedMap.get(m.id);
              return s + (Number(m.purchasePrice) || 0) * q;
            }, 0);
            totalCostEl.textContent = `¥${total.toFixed(2)}`;
          }
          const summaryEl = panelEl.querySelector('[data-picker-count]');
          if (summaryEl) summaryEl.textContent = `已选 ${selectedMap.size} 项`;
        };
        const summaryHtml = `
          <div class="picker-summary">
            <span class="muted" data-picker-count>已选 0 项</span>
            <span class="muted">预估成本：<b data-picker-totalcost>¥0.00</b></span>
          </div>`;
        wrap.insertAdjacentHTML('beforebegin', summaryHtml);
        render();

        // toggle checkbox
        wrap.addEventListener('change', (ev) => {
          const t = ev.target;
          if (!t || !t.dataset || t.dataset.act !== 'picker-toggle') return;
          const id = t.dataset.id;
          const mat = mats.find((x) => x.id === id);
          if (!mat) return;
          if (t.checked) {
            const step = (mat.type === 'pattern') ? 1 : 0.1;
            selectedMap.set(id, step);
            if (!multi) {
              // 单选：清掉其他
              for (const k of Array.from(selectedMap.keys())) {
                if (k !== id) selectedMap.delete(k);
              }
            }
          } else {
            selectedMap.delete(id);
          }
          render();
        });
        // 数量变更
        wrap.addEventListener('input', (ev) => {
          const t = ev.target;
          if (!t || !t.dataset || t.dataset.act !== 'picker-qty') return;
          const id = t.dataset.id;
          const v = Number(t.value);
          if (selectedMap.has(id) && Number.isFinite(v) && v > 0) {
            selectedMap.set(id, v);
            const totalCostEl = panelEl.querySelector('[data-picker-totalcost]');
            if (totalCostEl) {
              const mat = mats.find((x) => x.id === id);
              const total = Array.from(selectedMap.entries()).reduce((s, [mid, q]) => {
                const m = mats.find((x) => x.id === mid);
                return s + (Number(m?.purchasePrice) || 0) * (Number(q) || 0);
              }, 0);
              totalCostEl.textContent = `¥${total.toFixed(2)}`;
            }
          }
        });
        // 点击「取消」（单选场景下）
        wrap.addEventListener('click', (ev) => {
          const t = ev.target.closest('[data-act="picker-cancel"]');
          if (!t) return;
          selectedMap.delete(t.dataset.id);
          render();
        });
        // 确认按钮
        const confirmBtn = panelEl.querySelector('[data-picker-confirm]');
        if (confirmBtn) {
          confirmBtn.addEventListener('click', () => {
            const out = Array.from(selectedMap.entries()).map(([materialId, quantityUsed]) => ({
              materialId, quantityUsed: Number(quantityUsed) || 1,
            }));
            onConfirm(out);
            closeSheet();
          });
        }
      },
      onClose: () => {},
    });
    // 注入底部确认按钮（基于 renderSheet/openSheet 已有的 footer slot 简化：用全局 toast 模拟；本工程 sheet 无 footer 暴露 → 渲染一个确认行）
    // 这里用最简实现：在 sheet body 顶部放一个"确认选择"按钮
    (() => {
      const panels = document.querySelectorAll('.picker-list');
      if (panels.length === 0) return;
      const wrap = panels[0];
      const panel = wrap.closest('.sheet-panel') || wrap.parentElement;
      let confirmBar = panel.querySelector('.picker-confirm-bar');
      if (!confirmBar) {
        confirmBar = document.createElement('div');
        confirmBar.className = 'picker-confirm-bar';
        confirmBar.innerHTML = `<button class="btn btn-primary btn-block" data-picker-confirm>确认选择</button>`;
        panel.appendChild(confirmBar);
      }
    })();
  }

  /** sheet 关闭（基于 openSheet 实际创建 .sheet-wrap） */
  function closeSheet() {
    const wrap = document.querySelector('.sheet-wrap');
    if (wrap) wrap.remove();
    const backdrops = document.querySelectorAll('[data-sheet-backdrop]');
    backdrops.forEach((b) => b.click && b.click());
  }

  /* ----- 完工确认 Sheet ----- */
  function openCompletionSheet(garmentId) {
    C.openSheet({
      title: '完工确认',
      content: `
        <div class="card">
          <div class="card-title">确认完工</div>
          <p class="muted">M1.3 口径：完工仅登记时间，不再扣库存（关联物料时已扣减）。</p>
          <div class="form-row">
            <label>完工日期
              <input type="date" id="completion-date" value="${new Date().toISOString().slice(0, 10)}">
            </label>
          </div>
          <div class="form-row">
            <button class="btn btn-primary btn-block" data-act="confirm-completion">确认完工</button>
            <button class="btn btn-block" data-act="cancel-completion">取消</button>
          </div>
        </div>`,
      onMount: (panel) => {
        panel.querySelector('[data-act="cancel-completion"]').addEventListener('click', closeSheet);
        panel.querySelector('[data-act="confirm-completion"]').addEventListener('click', async () => {
          const dateStr = panel.querySelector('#completion-date').value;
          try {
            await global.SS.db.markGarmentCompleted({
              id: garmentId,
              completionDate: new Date(dateStr + 'T00:00:00').toISOString(),
            });
            global.SS.utils.toast('已标记完工');
            closeSheet();
            global.location.hash = '#/garments/' + garmentId;
          } catch (e) {
            global.SS.utils.toast('完工登记失败：' + (e.message || e));
          }
        });
      },
      onClose: () => {},
    });
  }

  /* ----- 成衣表单（new/edit 共用） ----- */

  /**
   * 把 garment 转表单展示态
   * @param {Object|null} garment
   */
  async function renderGarmentForm(root, garment, mode) {
    const isEdit = mode === 'edit';
    const g = garment || {
      name: '', category: 'top', size: '', recipient: '',
      status: 'planning', patternId: undefined, images: [], tags: [], notes: '',
      materialSnapshot: [], totalCost: 0,
    };
    const title = isEdit ? '编辑成衣' : '新建成衣';
    // 已选 selections（用于 sheet 二次进入时回填）
    const selectedSelections = (g.materialSnapshot || []).map((it) => ({
      materialId: it.materialId,
      quantityUsed: it.quantityUsed,
    })) || [];

    const currentSnapshot = g.materialSnapshot || [];
    const currentCost = typeof g.totalCost === 'number'
      ? g.totalCost
      : currentSnapshot.reduce((s, it) => s + (it.subtotal || 0), 0);

    // 当前已选项按类型分组显示
    const patternItem = currentSnapshot.find((it) => {
      // 通过 lookup 判断 type（M1.3：snapshot 中带 type 更稳妥，但当前不带，因此通过 db 反查）
      return false;
    });

    // 渲染：分别查 fabric / accessory / pattern 物料
    const patterns = await dbTable.materials.where('type').equals('pattern').toArray();
    const patternSelectedId = g.patternId || (currentSnapshot.find((s) => patterns.find((p) => p.id === s.materialId)) || {}).materialId;

    const catOptions = Object.entries(C.GARMENT_CATEGORY || { top: '上装', bottom: '下装', set: '套装', acc: '配饰', other: '其他' })
      .map(([k, v]) => `<option value="${k}" ${g.category === k ? 'selected' : ''}>${v}</option>`).join('');
    // v1.2.2 P1-M3-1：冻结 §3.4/§3.8 + PRD §0.6-3 用户拍板「表单不设状态字段；
    //   手动新增直接已完成」。状态仅作为详情/列表的只读展示与 markGarmentCompleted 切换入口，
    //   表单不参与 status 读写。

    root.innerHTML = `
      <div class="card">
        <div class="card-title">${title}</div>
        <form id="garment-form" class="form">
          <div class="form-row">
            <label>名称 *
              <input type="text" name="name" value="${escapeAttr(g.name || '')}" required maxlength="60">
            </label>
          </div>
          <div class="form-row inline">
            <label>类目
              <select name="category">${catOptions}</select>
            </label>
            <label>尺码
              <input type="text" name="size" value="${escapeAttr(g.size || '')}" maxlength="20" placeholder="如 M / 90">
            </label>
          </div>
          <div class="form-row inline">
            <label>送给谁
              <input type="text" name="recipient" value="${escapeAttr(g.recipient || '')}" maxlength="20">
            </label>
            <label>完工日期
              <input type="date" name="completionDate" value="${escapeAttr((g.completionDate || '').slice(0, 10))}">
            </label>
          </div>
          <div class="form-row">
            <label>关联纸样
              <select name="patternId">
                <option value="">— 不关联 —</option>
                ${patterns.map((p) => `<option value="${escapeAttr(p.id)}" ${patternSelectedId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
              </select>
            </label>
          </div>
          <div class="form-row">
            <label>备注
              <textarea name="notes" rows="3" maxlength="500">${escapeHtml(g.notes || '')}</textarea>
            </label>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-title">关联物料（点击按钮选择）</div>
        <div class="picker-block">
          <div class="picker-block-head">
            <span class="muted">面料</span>
            <button class="btn btn-sm" data-act="pick" data-kind="fabric">+ 选面料</button>
          </div>
          <div class="picker-block-list" id="picker-fabric-list"></div>
        </div>
        <div class="picker-block">
          <div class="picker-block-head">
            <span class="muted">辅料</span>
            <button class="btn btn-sm" data-act="pick" data-kind="accessory">+ 选辅料</button>
          </div>
          <div class="picker-block-list" id="picker-accessory-list"></div>
        </div>
        <div class="picker-block">
          <div class="picker-block-head">
            <span class="muted">纸样（已在上方「关联纸样」单选）</span>
          </div>
        </div>
        <div class="picker-total">
          <span class="muted">实时成本</span>
          <b id="picker-total-cost">¥${currentCost.toFixed(2)}</b>
        </div>
      </div>

      <div class="card">
        <div class="card-title">图片（D-IM1 · 3:4 竖版 · Blob 存 IndexedDB）</div>
        <div id="garment-image-uploader"></div>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary btn-block" data-act="save-garment">${isEdit ? '保存修改' : '保存成衣'}</button>
        ${isEdit ? `<button class="btn btn-block btn-danger" data-act="delete-garment">删除成衣（按净扣减量回补）</button>` : ''}
        <a class="btn btn-block" href="#${isEdit ? '/garments/' + g.id : '/garments'}">取消</a>
      </div>`;

    // 内存里保存当前 selections（与 snapshot 同步），所有 sheet 修改都走这份
    const liveSelections = new Map();
    for (const s of selectedSelections) liveSelections.set(s.materialId, s.quantityUsed);

    /** 用当前 selections 重算成本 + 重渲染两侧列表 */
    const refreshLists = async () => {
      const mats = await dbTable.materials.toArray();
      let total = 0;
      for (const [mid, qty] of liveSelections.entries()) {
        const m = mats.find((x) => x.id === mid);
        if (m) total += (Number(m.purchasePrice) || 0) * qty;
      }
      document.getElementById('picker-total-cost').textContent = `¥${total.toFixed(2)}`;
      const refreshOne = (kind, listId) => {
        const targets = Array.from(liveSelections.keys())
          .map((mid) => mats.find((x) => x.id === mid))
          .filter((m) => m && m.type === kind);
        document.getElementById(listId).innerHTML = targets.length
          ? targets.map((m) => C.renderMaterialPickerCard(
              m,
              true,
              liveSelections.get(m.id),
              false
            )).join('')
          : '<div class="muted-small">未选</div>';
      };
      refreshOne('fabric', 'picker-fabric-list');
      refreshOne('accessory', 'picker-accessory-list');
      // M1.5: 选择器列表卡片异步加载首图
      await C.hydratePickerCardImages(root, global.SS.app.loadImage);
    };

    await refreshLists();

    // M1.5 · 成衣图片上传初始化
    const imageMount = document.getElementById('garment-image-uploader');
    const initialImages = (g.images || []).filter(Boolean);
    imageMount.innerHTML = C.renderImageUploader({ images: initialImages, max: 9 });
    // 异步加载已存在图片缩略图
    for (const id of initialImages) {
      const url = await global.SS.app.loadImage(id);
      const inner = imageMount.querySelector(`[data-img-load="${id}"]`);
      if (inner && url) inner.style.backgroundImage = `url(${JSON.stringify(url)})`;
    }
    imageMount.querySelectorAll('[data-img-add]').forEach((addEl) => {
      addEl.onclick = () => addEl.querySelector('[data-img-input]').click();
      addEl.querySelector('[data-img-input]').onchange = async (e) => {
        await handleImageAdd(imageMount, e.target.files, 'garment', g.id || '');
        e.target.value = '';
      };
    });
    imageMount.querySelectorAll('[data-img-remove]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const imgId = btn.getAttribute('data-img-remove');
        await global.SS.app.deleteImage(imgId);
        btn.closest('.img-thumb').remove();
      };
    });

    // 物料选择 sheet
    root.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-act="pick"]');
      if (!t) return;
      const kind = t.dataset.kind;
      const excludeIds = (kind === 'pattern')
        ? Array.from(liveSelections.keys())
        : [];
      openMaterialSelectorSheet({
        kind,
        multi: true,
        excludeIds,
        initialSelections: Array.from(liveSelections.entries())
          .map(([materialId, quantityUsed]) => ({ materialId, quantityUsed }))
          .filter((s) => {
            // 仅保留同 kind
            // 简化：从 db 反查
            return true;
          }),
        onConfirm: async (newOnes) => {
          // 取按 kind 的方式：从 db 反查
          const mats = await dbTable.materials.toArray();
          for (const s of newOnes) {
            const mat = mats.find((x) => x.id === s.materialId);
            if (mat && mat.type === kind) {
              liveSelections.set(s.materialId, s.quantityUsed);
            }
          }
          await refreshLists();
        },
      });
    });

    // 保存
    root.querySelector('[data-act="save-garment"]').addEventListener('click', async () => {
      const form = root.querySelector('#garment-form');
      const fd = new FormData(form);
      const name = (fd.get('name') || '').toString().trim();
      if (!name) { toast('名称不能为空'); return; }
      const data = {
        name,
        category: (fd.get('category') || 'top').toString(),
        size: (fd.get('size') || '').toString().trim() || undefined,
        recipient: (fd.get('recipient') || '').toString().trim() || undefined,
        // v1.2.2 P1-M3-1：表单不设状态字段（冻结 §3.4/§3.8 + PRD §0.6-3 用户拍板）。
        //   data.status 不传，由 createGarmentWithMaterials 按入口类型自动落：
        //     手动新增 → 'completed' + 写 completionDate；
        //     任务入口（entrySource='task'）→ 'in_progress'，任务完成时由 markGarmentCompleted 切换。
        patternId: (fd.get('patternId') || '').toString() || undefined,
        completionDate: (fd.get('completionDate') || '').toString() || undefined,
        notes: (fd.get('notes') || '').toString().trim() || undefined,
      };
      const selections = Array.from(liveSelections.entries())
        .map(([materialId, quantityUsed]) => ({ materialId, quantityUsed: Number(quantityUsed) || 1 }));

      // M1.5: 收集图片 id（按当前缩略图 DOM 顺序，与物料表单口径一致）
      const imgIds = Array.from(imageMount.querySelectorAll('[data-img-id]')).map((el) => el.getAttribute('data-img-id'));
      data.images = imgIds;

      try {
        if (isEdit) {
          await global.SS.db.updateGarmentWithMaterials({
            id: g.id,
            data,
            prevSelections: selectedSelections,
            newSelections: selections,
          });
          // M1.5: 回填图片 entityId（编辑态，已有 g.id 直接生效）
          await backfillImagesEntity('garment', g.id, imgIds);
          toast('已保存修改');
          global.location.hash = '#/garments/' + g.id;
        } else {
          const ret = await global.SS.db.createGarmentWithMaterials({ data, selections });
          // M1.5: 新建后回填图片 entityId（先前上传时 entityId='' 现指到本成衣）
          await backfillImagesEntity('garment', ret.id, imgIds);
          toast('已新建成衣');
          global.location.hash = '#/garments/' + ret.id;
        }
      } catch (e) {
        toast('保存失败：' + (e.message || e));
      }
    });

    // 删除（仅编辑）
    const delBtn = root.querySelector('[data-act="delete-garment"]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm('确认删除此成衣？将按净扣减量回补所有物料。')) return;
        try {
          await global.SS.db.deleteGarmentWithRestore({ id: g.id });
          toast('已删除');
          global.location.hash = '#/garments';
        } catch (e) {
          toast('删除失败：' + (e.message || e));
        }
      });
    }
  }

  /**
   * 成衣详情页（view 模式）
   */
  async function renderGarmentDetail(root, id) {
    // 解析 /edit 后缀
    let isEdit = false;
    let realId = id;
    if (typeof id === 'string' && id.endsWith('/edit')) {
      isEdit = true;
      realId = id.slice(0, -5);
    }
    if (realId === 'new') {
      return renderGarmentForm(root, null, 'new');
    }
    const garment = await dbTable.garments.get(realId);
    if (!garment) {
      root.innerHTML = `
        <div class="placeholder-page">
          <div class="placeholder-icon">🧭</div>
          <div class="placeholder-title">成衣不存在</div>
          <a class="btn btn-primary" href="#/garments">返回成衣库</a>
        </div>`;
      return;
    }
    if (isEdit) {
      return renderGarmentForm(root, garment, 'edit');
    }

    // view
    const allImgIds = (garment.images || []).filter(Boolean);
    const firstImgId = allImgIds[0];
    let imageUrl = '';
    if (firstImgId) {
      try { imageUrl = await global.SS.app.loadImage(firstImgId); } catch (_) {}
    }
    // M1.5: 多图相册（首图之外的多余图片以缩略图形式列出，3:4 竖版）
    let extraGalleryHtml = '';
    if (allImgIds.length > 1) {
      const urls = await Promise.all(allImgIds.slice(1).map((id) => global.SS.app.loadImage(id).catch(() => null)));
      extraGalleryHtml = `
        <div class="card">
          <div class="card-title">图片（${allImgIds.length} 张）</div>
          <div class="garment-gallery">
            ${allImgIds.slice(1).map((id, i) => urls[i]
              ? `<div class="garment-gallery-thumb" style="background-image:url(${JSON.stringify(urls[i])})" data-gallery-id="${escapeAttr(id)}"></div>`
              : `<div class="garment-gallery-thumb garment-gallery-thumb-empty" data-gallery-id="${escapeAttr(id)}">🖼️</div>`).join('')}
          </div>
        </div>`;
    }
    const snap = garment.materialSnapshot || [];
    const patternLink = garment.patternId
      ? (() => {
          // 用同步查 pattern 名：通常不大；这里用 await
          return garment.patternId; // 在 onMount 阶段渲染
        })()
      : '';
    let patternName = '';
    if (garment.patternId) {
      const p = await dbTable.materials.get(garment.patternId);
      patternName = p ? p.name : '';
    }
    const tasks = await dbTable.tasks.where('garmentId').equals(garment.id).toArray();

    root.innerHTML = `
      ${C.renderGarmentHero(garment, imageUrl)}
      ${extraGalleryHtml}
      ${C.renderCostBlock(snap, garment.totalCost)}

      <div class="card">
        <div class="card-title">关联物料</div>
        ${snap.length === 0
          ? '<div class="muted">未关联任何物料</div>'
          : `<ul class="snap-list">${snap.map((it) => `
              <li>
                <a href="#/materials/${encodeURIComponent(it.materialId)}">
                  ${escapeHtml(it.name || '(未命名)')} · ${(Number(it.quantityUsed) || 0).toFixed(2)}${escapeHtml(it.unit || '')}
                </a>
              </li>`).join('')}</ul>`}
        ${patternName ? `<div class="muted">纸样：<a href="#/materials/${encodeURIComponent(garment.patternId)}">${escapeHtml(patternName)}</a></div>` : ''}
      </div>

      ${tasks.length ? `
      <div class="card">
        <div class="card-title">关联任务（${tasks.length}）</div>
        <ul class="snap-list">
          ${tasks.map((t) => `<li><a href="#/workbench/${encodeURIComponent(t.id)}/edit">${escapeHtml(t.title || '(未命名任务)')}</a> · ${escapeHtml(t.status || '')}</li>`).join('')}
        </ul>
      </div>` : ''}

      ${garment.notes ? `
      <div class="card">
        <div class="card-title">备注</div>
        <div>${escapeHtml(garment.notes)}</div>
      </div>` : ''}

      <div class="form-actions">
        <a class="btn btn-primary btn-block" href="#/garments/${encodeURIComponent(garment.id)}/edit">编辑成衣</a>
        ${garment.status !== 'completed'
          ? '<button class="btn btn-block btn-primary-outline" data-act="mark-completed">登记完工</button>'
          : `<div class="muted">已完工：${escapeHtml((garment.completionDate || '').slice(0, 10))}</div>`}
        <button class="btn btn-block btn-danger" data-act="delete-garment">删除成衣（按净扣减量回补）</button>
        <a class="btn btn-block" href="#/garments">返回列表</a>
      </div>`;

    root.querySelector('[data-act="delete-garment"]').addEventListener('click', async () => {
      if (!confirm('确认删除此成衣？将按净扣减量回补所有物料（关联任务 garmentId 置空但任务保留）。')) return;
      try {
        await global.SS.db.deleteGarmentWithRestore({ id: garment.id });
        toast('已删除');
        global.location.hash = '#/garments';
      } catch (e) {
        toast('删除失败：' + (e.message || e));
      }
    });
    const completeBtn = root.querySelector('[data-act="mark-completed"]');
    if (completeBtn) {
      completeBtn.addEventListener('click', () => openCompletionSheet(garment.id));
    }
  }

  // 辅助
  function toast(msg) {
    if (typeof global.SS.utils.toast === 'function') global.SS.utils.toast(msg);
    else alert(msg);
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }
  function escapeAttr(s) { return escapeHtml(s); }

  /**
   * 恢复确认弹窗（P2② 五要素 ①②）
   * - 要素①：二次确认，覆盖现有数据的明确警告 + 输入"恢复"二字确认
   * - 要素②：恢复概要，完整展示包内数据规模清单
   */
  function showRestoreConfirmModal(opts) {
    return new Promise(function (resolve) {
      var exportedAt = opts.exportedAt;
      var sizeMB = opts.sizeMB;
      var counts = opts.counts;
      var imagesStaged = opts.imagesStaged;
      var missingImages = opts.missingImages || [];

      var existing = document.querySelector('.restore-confirm-overlay');
      if (existing) existing.remove();

      var overlay = document.createElement('div');
      overlay.className = 'restore-confirm-overlay';

      var missingHtml = missingImages.length > 0
        ? '<div class="restore-missing-warn">⚠️ zip 内 ' + missingImages.length + ' 张图片文件缺失，将无法恢复</div>'
        : '';

      overlay.innerHTML =
        '<div class="restore-confirm-card">' +
          '<div class="restore-confirm-title">⚠️ 确认恢复数据</div>' +
          '<div class="restore-confirm-summary">' +
            '<div class="restore-summary-row"><span>备份时间</span><span>' + escapeHtml(exportedAt || '未知') + '</span></div>' +
            '<div class="restore-summary-row"><span>zip 大小</span><span>' + sizeMB + ' MB</span></div>' +
            '<div class="restore-summary-row"><span>物料</span><span>' + (counts.materials || 0) + ' 条</span></div>' +
            '<div class="restore-summary-row"><span>成衣</span><span>' + (counts.garments || 0) + ' 条</span></div>' +
            '<div class="restore-summary-row"><span>任务 / 模板</span><span>' + (counts.tasks || 0) + ' / ' + (counts.taskTemplates || 0) + '</span></div>' +
            '<div class="restore-summary-row"><span>图片</span><span>' + imagesStaged + ' 张</span></div>' +
            '<div class="restore-summary-row"><span>流水 / 备份日志</span><span>' + (counts.usageLogs || 0) + ' / ' + (counts.backupLogs || 0) + '</span></div>' +
          '</div>' +
          missingHtml +
          '<div class="restore-confirm-warning">' +
            '⚠️ 当前数据将被<strong>完整覆盖</strong>。本设备的密钥、PAT、device_id 等不可迁移字段会被保留。' +
          '</div>' +
          '<div class="restore-confirm-input-row">' +
            '<label>请输入「<strong>恢复</strong>」确认：</label>' +
            '<input type="text" class="restore-confirm-input" placeholder="输入「恢复」二字" autocomplete="off" />' +
          '</div>' +
          '<div class="restore-confirm-actions">' +
            '<button class="btn btn-secondary restore-cancel-btn">取消</button>' +
            '<button class="btn btn-danger restore-ok-btn" disabled>确认恢复</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(overlay);

      var input = overlay.querySelector('.restore-confirm-input');
      var okBtn = overlay.querySelector('.restore-ok-btn');
      var cancelBtn = overlay.querySelector('.restore-cancel-btn');

      input.addEventListener('input', function () {
        okBtn.disabled = input.value.trim() !== '恢复';
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && input.value.trim() === '恢复') {
          cleanup();
          resolve(true);
        }
      });

      okBtn.addEventListener('click', function () {
        cleanup();
        resolve(true);
      });
      cancelBtn.addEventListener('click', function () {
        cleanup();
        resolve(false);
      });
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) {
          cleanup();
          resolve(false);
        }
      });

      function cleanup() {
        overlay.remove();
      }

      setTimeout(function () { input.focus(); }, 100);
    });
  }

  /* ============ 工作台模块（M1.2 任务管理） ============ */
  function renderWorkbench(root) {
    // M1.3 真实数据：先列出任务（按 status 倒序分桶），点击进入 /workbench/:id/edit
    (async () => {
      const tasks = await dbTable.tasks.orderBy('updatedAt').reverse().limit(20).toArray();
      const groups = { pending: [], in_progress: [], completed: [], cancelled: [] };
      for (const t of tasks) {
        const s = t.status || 'pending';
        if (groups[s]) groups[s].push(t);
        else groups.pending.push(t);
      }
      const sectionHtml = (title, items, cls) => items.length
        ? `<div class="card">
            <div class="card-title ${cls || ''}">${title}（${items.length}）</div>
            ${items.map((t) => `
              <a class="card list-card" href="#/workbench/${encodeURIComponent(t.id)}/edit" style="margin-bottom:6px;">
                <div class="list-card-thumb">${t.garmentId ? '👕' : '📋'}</div>
                <div class="list-card-body">
                  <div class="list-card-title">${escapeHtml(t.title || '(未命名任务)')}</div>
                  <div class="list-card-sub">${escapeHtml(t.priority || 'normal')}${t.dueDate ? ' · 截止 ' + escapeHtml(t.dueDate.slice(0, 10)) : ''}${t.garmentId ? ' · 关联成衣' : ''}</div>
                </div>
              </a>`).join('')}
          </div>`
        : '';
      root.innerHTML = `
        ${sectionHtml('待办', groups.pending, 'badge-status-planning')}
        ${sectionHtml('进行中', groups.in_progress, 'badge-status-in_progress')}
        ${sectionHtml('已完成', groups.completed, 'badge-status-completed')}
        ${sectionHtml('已取消', groups.cancelled)}
        ${!tasks.length
          ? C.renderEmptyState({ icon: '📋', title: '还没有任务', desc: '任务模块在 M1.2 阶段内置，M1.3 提供 garment 关联入口（M1.2 任务表单重建后接入）' })
          : ''}
        <div class="card">
          <div class="card-title">成衣关联入口（M1.3 落地）</div>
          <p class="muted">从任务详情页可选关联到一件成衣；删除该成衣时此任务的 garmentId 自动置空（任务保留）。</p>
          <a class="btn btn-primary btn-block" href="#/garments">打开成衣库 →</a>
          <a class="btn btn-block" href="#/garments/new">+ 新建成衣</a>
        </div>`;
    })();
  }
  function renderTaskForm(root, id) {
    // M1.2 占位（M1.3 不重建任务表单，本期仅在 workbench 页提供 garment 关联入口）
    root.innerHTML = C.renderPlaceholder({
      title: id ? '编辑任务' : '新建任务',
      module: 'M1.2',
      icon: '📋',
      desc: '任务表单（步骤编辑器 + 模板选择 + 关联成衣 选择器）将在 M1.2 重建时落地；M1.3 已提供 garment 数据层接口（workbench 列表已实）。',
    });
  }

  /* ============ 统计模块（M1.4 真实实现） ============ */
  // PRD §10.6 + 数据模型 v0.6 §4 口径
  // 时间段切换走 hash query（#/stats?period=month|year|all；默认 month）
  // v1.3.0 label='汇总'：e2e #39 期望 period=all 激活后 active 文本含「汇总」
  const STATS_PERIODS = [
    { id: 'month', label: '本月', short: '本月' },
    { id: 'year',  label: '本年', short: '本年' },
    { id: 'all',   label: '汇总', short: '汇总' },
  ];
  const STATS_COMPLETED_LIMIT = 20; // PRD §10.6 区块1.3：>20 折叠

  function parseStatsHash(hash) {
    const path = (hash || '#/stats').replace(/^#/, '');
    const [pathPart, qs] = path.split('?');
    const params = {};
    if (qs) qs.split('&').forEach((kv) => {
      const [k, v] = kv.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    const segs = (pathPart || '/stats').split('/').filter(Boolean);
    return { period: params.period || 'month', segs };
  }

  function barsHtml(rows, valueKey, isFallbackKey, unit, emptyMsg) {
    if (!rows.length) {
      return `<div class="bar-empty">${escapeHtml(emptyMsg)}</div>`;
    }
    const max = rows.reduce((m, r) => Math.max(m, Number(r[valueKey]) || 0), 0);
    return `
      <div class="bar-chart">
        ${rows.map((r) => {
          const v = Number(r[valueKey]) || 0;
          const w = max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0;
          const fb = r[isFallbackKey] ? ' is-fallback' : '';
          const fbMark = r[isFallbackKey] ? ' *' : '';
          return `
            <div class="bar-row">
              <div class="bar-month">${escapeHtml(r.month)}</div>
              <div class="bar-track"><div class="bar-fill${fb}" style="width:${w}%"></div></div>
              <div class="bar-value">${unit === 'm' ? v.toFixed(1) + ' 米' : '¥' + v.toFixed(2)}${fbMark}</div>
            </div>`;
        }).join('')}
      </div>`;
  }

  function renderStats(root) {
    const hash = window.location.hash;
    const { period } = parseStatsHash(hash);
    const periodSafe = STATS_PERIODS.some((p) => p.id === period) ? period : 'month';

    (async () => {
      const pkg = await dbApi.computeStatsForPeriod(periodSafe);
      const { period: pInfo, completedCount, completedByMonth, completedGarments,
        topFabric, costExtremes, stock, purchases, categoryShare, missingPrice, caliberStatement } = pkg;
      const periodLabel = pInfo.label; // 本月 / 本年 / 累计

      // ---- 完工明细列表（>20 折叠） ----
      const limit = STATS_COMPLETED_LIMIT;
      const showExpand = completedGarments.length > limit;
      const listRows = completedGarments.slice(0, limit).map((g) => `
        <a class="completed-list-row" href="#/garments/${encodeURIComponent(g.id)}">
          <div class="completed-list-name">${escapeHtml(g.name || '(未命名)')}</div>
          <div class="completed-list-date">${g.completionDate ? escapeHtml(g.completionDate.slice(0, 10)) : '—'}</div>
          <div class="completed-list-cost">${g.totalCost > 0 ? '¥' + g.totalCost.toFixed(2) : '未核算'}</div>
        </a>
      `).join('');
      const expandRow = showExpand
        ? `<a class="completed-list-row is-empty" href="#/stats?period=${encodeURIComponent(periodSafe)}&view=all">
            <div class="completed-list-name">展开全部（${completedGarments.length - limit} 条更多）</div>
            <div class="completed-list-date"></div>
            <div class="completed-list-cost"></div>
          </a>`
        : '';

      // ---- 月度完工趋势 ----
      const completionBars = barsHtml(
        completedByMonth, 'count', null, 'n',
        `${periodLabel}暂无完工成衣`
      );

      // ---- 月度采购米数（保留 initialQty 优先，回退标 *） ----
      const metersRows = purchases.byMonth.map((m) => ({
        month: m.month, meters: m.meters, fallback: m.fallback,
      }));
      const metersBars = barsHtml(
        metersRows, 'meters', 'fallback', 'm',
        `${periodLabel}暂无采购记录`
      );

      // ---- 月度采购花费 ----
      const costRows = purchases.byMonth.map((m) => ({
        month: m.month, cost: m.cost, fallback: m.fallback,
      }));
      const costBars = barsHtml(
        costRows, 'cost', 'fallback', 'cny',
        `${periodLabel}暂无记价的采购记录`
      );

      // ---- 4 类占比条（fabric / accessory / tool / pattern） ----
      const segments = [
        { key: 'fabric',    name: '布料',  cls: 'share-fabric',    amount: categoryShare.fabric },
        { key: 'accessory', name: '辅料',  cls: 'share-accessory', amount: categoryShare.accessory },
        { key: 'tool',      name: '工具',  cls: 'share-tool',      amount: categoryShare.tool },
        { key: 'pattern',   name: '纸样',  cls: 'share-pattern',   amount: categoryShare.pattern },
      ];
      const total = Math.max(0, categoryShare.total);
      const shareBar = total > 0
        ? `<div class="share-bar">
            ${segments.map((s) => {
              const pct = Math.max(0, Math.round((s.amount / total) * 1000) / 10);
              return `<div class="share-segment ${s.cls}" style="width:${pct}%" title="${s.name} ${pct.toFixed(1)}%">${pct >= 12 ? pct.toFixed(0) + '%' : ''}</div>`;
            }).join('')}
          </div>`
        : `<div class="bar-empty">${periodLabel}暂无记价的采购记录</div>`;
      const shareLegend = total > 0
        ? `<div class="share-legend">
            ${segments.map((s) => {
              const pct = Math.max(0, Math.round((s.amount / total) * 1000) / 10);
              return `<div class="share-legend-item">
                <span class="share-legend-color ${s.cls}"></span>
                <span class="share-legend-name">${s.name}</span>
                <span class="share-legend-amount">¥${s.amount.toFixed(2)}</span>
                <span class="share-legend-pct">${pct.toFixed(1)}%</span>
              </div>`;
            }).join('')}
          </div>`
        : '';

      // ---- 4 高亮卡 ----
      const mostUsedFabricHtml = topFabric
        ? `<a class="highlight-card is-link" href="#/materials/${encodeURIComponent(topFabric.materialId)}">
            <div class="highlight-card-label">最常用面料</div>
            <div class="highlight-card-value">${escapeHtml(topFabric.name)}</div>
            <div class="highlight-card-sub">净额消耗 ${topFabric.qty.toFixed(1)} 米</div>
          </a>`
        : `<div class="highlight-card is-empty">
            <div class="highlight-card-label">最常用面料</div>
            <div class="highlight-card-value">—</div>
            <div class="highlight-card-sub">${periodLabel}暂无消耗记录</div>
          </div>`;
      const avgCostHtml = costExtremes.count > 0
        ? `<div class="highlight-card">
            <div class="highlight-card-label">平均成本</div>
            <div class="highlight-card-value">¥${costExtremes.avg.toFixed(2)}</div>
            <div class="highlight-card-sub">${costExtremes.count} 件已核算</div>
          </div>`
        : `<div class="highlight-card is-empty">
            <div class="highlight-card-label">平均成本</div>
            <div class="highlight-card-value">—</div>
            <div class="highlight-card-sub">无参与核算的完工数</div>
          </div>`;
      const maxCostHtml = costExtremes.max
        ? `<a class="highlight-card is-link" href="#/garments/${encodeURIComponent(costExtremes.max.id)}">
            <div class="highlight-card-label">最贵作品</div>
            <div class="highlight-card-value">¥${costExtremes.max.cost.toFixed(2)}</div>
            <div class="highlight-card-sub">${escapeHtml(costExtremes.max.name)}</div>
          </a>`
        : `<div class="highlight-card is-empty">
            <div class="highlight-card-label">最贵作品</div>
            <div class="highlight-card-value">—</div>
          </div>`;
      const minCostHtml = costExtremes.min
        ? `<a class="highlight-card is-link" href="#/garments/${encodeURIComponent(costExtremes.min.id)}">
            <div class="highlight-card-label">最低成本</div>
            <div class="highlight-card-value">¥${costExtremes.min.cost.toFixed(2)}</div>
            <div class="highlight-card-sub">${escapeHtml(costExtremes.min.name)}</div>
          </a>`
        : `<div class="highlight-card is-empty">
            <div class="highlight-card-label">最低成本</div>
            <div class="highlight-card-value">—</div>
          </div>`;

      // ---- 库存 3 卡（当前时点，切时段不变） ----
      const stockCellsHtml = `
        <div class="stock-grid">
          <div class="stock-cell">
            <div class="stock-cell-label">当前布料</div>
            <div class="stock-cell-value">${stock.fabricMeters.toFixed(1)}<span class="stock-cell-unit">米</span></div>
          </div>
          <div class="stock-cell">
            <div class="stock-cell-label">当前辅料</div>
            <div class="stock-cell-value">${stock.accessoryCount}<span class="stock-cell-unit">件</span></div>
          </div>
          <div class="stock-cell">
            <div class="stock-cell-label">当前工具</div>
            <div class="stock-cell-value">${stock.toolCount}<span class="stock-cell-unit">件</span></div>
          </div>
        </div>`;

      // ---- 未记价提示（始终渲染；缺失数=0 时给正向反馈） ----
      // e2e #36 期望始终存在 .missing-price-card 节点；缺失数>0 时为警告，否则为正向反馈
      const missingPriceHtml = missingPrice > 0
        ? `<a class="missing-price-card" href="#/materials/all">
            ⚠️ ${missingPrice} 条未记采购价，补全后花费统计更准
          </a>`
        : `<div class="missing-price-card is-ok">
            ✅ 所有物料已记采购价，花费统计完整
          </div>`;

      // ---- 主体渲染 ----
      root.innerHTML = `
        <h2 class="stats-page-marker">统计页</h2>
        <div class="period-cards" role="tablist" aria-label="时段切换">
          ${STATS_PERIODS.map((p) => `
            <a class="period-card${p.id === periodSafe ? ' is-active' : ''}" role="tab"
               aria-selected="${p.id === periodSafe}"
               href="#/stats?period=${encodeURIComponent(p.id)}">
              <div class="period-card-label">${escapeHtml(p.label)}</div>
              <div class="period-card-hint">${p.id === 'month' ? '当前自然月' : (p.id === 'year' ? '当前自然年' : '全部时间')}</div>
            </a>
          `).join('')}
        </div>

        <!-- 战果区 -->
        <div class="card">
          <div class="card-title">战果 · ${escapeHtml(periodLabel)}</div>
          <div class="stats-hero" data-stats-hero style="margin-bottom:12px;">
            <div class="stats-hero-label">${escapeHtml(periodLabel)}完工数</div>
            <div class="stats-hero-value">${completedCount}<span class="stats-hero-suffix">件</span></div>
          </div>

          <div class="card-title">月度完工趋势</div>
          ${completionBars}

          <div class="card-title">完工明细（按完工日倒序）</div>
          ${completedGarments.length > 0
            ? `<div class="completed-list">${listRows}${expandRow}</div>`
            : `<div class="bar-empty">${periodLabel}暂无完工明细</div>`}

          <div class="card-title">本期成本之最</div>
          <div class="highlight-grid">
            ${mostUsedFabricHtml}
            ${avgCostHtml}
            ${maxCostHtml}
            ${minCostHtml}
          </div>
        </div>

        <!-- 库存与采购 -->
        <div class="card">
          <div class="card-title">库存与采购 · ${escapeHtml(periodLabel)}</div>

          <div class="card-title">当前库存（切时段不变）</div>
          ${stockCellsHtml}

          <div class="card-title">${periodLabel}采购米数</div>
          ${metersBars}
          <div class="bar-note-empty" style="font-size:11px;padding:0;">＊表示该月有记录无 initialQuantity，回退到 quantity 计算</div>

          <div class="card-title">${periodLabel}采购花费</div>
          ${costBars}

          <div class="card-title">${periodLabel}四类花费占比</div>
          ${shareBar}
          ${shareLegend}

          ${missingPriceHtml}

          <div class="caliber-statement">
            ${escapeHtml(caliberStatement)}
          </div>
        </div>`;

      // 完工明细>20 时，点击「展开全部」切换 hash 视图（仅前端 hash 切换，重渲染由 router 触发）
      // 这里的 view=all 只是占位语义，不实际触发重渲染——保留 20 条上限交互另议。
    })();
  }

  /* ============ 设置模块（M1.5 · 完整实现） ============ */

  /**
   * 设置主页：8 个入口卡片
   * PRD §10.8 + 2026-09-14 决裁③
   */
  async function renderSettings(root) {
    // 读 settings 键值（PAT 仅展示掩码、username/repo 实时）
    const [patRow, userNameRow, deviceRow, lastBackupRow] = await Promise.all([
      dbTable.settings.get('github_token'),
      dbTable.settings.get('user_name'),
      dbTable.settings.get('device_id'),
      dbTable.settings.get('backup_last_success'),
    ]);
    const patMasked = patRow && patRow.value ? 'github_pat_****' : '（未配置）';
    const userName = (userNameRow && userNameRow.value) || '缝纫人';
    const deviceShort = (deviceRow && deviceRow.value) ? String(deviceRow.value).slice(0, 4) + '…' : '—';
    const lastBackupHint = lastBackupRow && lastBackupRow.value
      ? '最近备份：' + String(lastBackupRow.value).slice(0, 16).replace('T', ' ')
      : '尚未备份';

    root.innerHTML = `
      <div class="card" style="display:flex;align-items:center;gap:12px;">
        <div style="font-size:36px;">${escapeHtml(userName)}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:15px;">${escapeHtml(userName)}</div>
          <div class="muted-small">设备 ${escapeHtml(deviceShort)} · ${escapeHtml(lastBackupHint)}</div>
        </div>
      </div>

      <a class="card list-card" href="#/settings/profile" style="text-decoration:none;color:inherit;">
        <div class="list-card-thumb">👤</div>
        <div class="list-card-body">
          <div class="list-card-title">个人信息</div>
          <div class="list-card-sub">昵称 · 缝纫年限</div>
        </div>
        <div>›</div>
      </a>
      <a class="card list-card" href="#/settings/backup" style="text-decoration:none;color:inherit;">
        <div class="list-card-thumb">💾</div>
        <div class="list-card-body">
          <div class="list-card-title">备份</div>
          <div class="list-card-sub">GitHub 备份 · 本地 zip · 恢复</div>
        </div>
        <div>›</div>
      </a>
      <a class="card list-card" href="#/settings/github" style="text-decoration:none;color:inherit;">
        <div class="list-card-thumb">🔗</div>
        <div class="list-card-body">
          <div class="list-card-title">GitHub 配置</div>
          <div class="list-card-sub">PAT · 仓库 · 到期提醒</div>
        </div>
        <div>›</div>
      </a>
      <a class="card list-card" href="#/settings/sync" style="text-decoration:none;color:inherit;">
        <div class="list-card-thumb">🔄</div>
        <div class="list-card-body">
          <div class="list-card-title">数据同步</div>
          <div class="list-card-sub">P1 · 设备 ID · 推送/拉取</div>
        </div>
        <div>›</div>
      </a>
      <a class="card list-card" href="#/settings/presets" style="text-decoration:none;color:inherit;">
        <div class="list-card-thumb">🎨</div>
        <div class="list-card-body">
          <div class="list-card-title">预设管理</div>
          <div class="list-card-sub">款式 · 类型 · 人群 · 品牌</div>
        </div>
        <div>›</div>
      </a>
      <a class="card list-card" href="#/settings/templates" style="text-decoration:none;color:inherit;">
        <div class="list-card-thumb">📑</div>
        <div class="list-card-body">
          <div class="list-card-title">任务模板</div>
          <div class="list-card-sub">增删改 · 步骤编辑</div>
        </div>
        <div>›</div>
      </a>
      <a class="card list-card" href="#/settings/about" style="text-decoration:none;color:inherit;">
        <div class="list-card-thumb">ℹ️</div>
        <div class="list-card-body">
          <div class="list-card-title">关于</div>
          <div class="list-card-sub">版本 · 存储 · iOS 配额</div>
        </div>
        <div>›</div>
      </a>
      <a class="card list-card" href="#/wizard" style="text-decoration:none;color:inherit;">
        <div class="list-card-thumb">🔄</div>
        <div class="list-card-body">
          <div class="list-card-title">重跑向导</div>
          <div class="list-card-sub">重新运行初始化向导（PRD §10.8 入口）</div>
        </div>
        <div>›</div>
      </a>

      <div class="card" style="font-size:11px;color:hsl(var(--secondary-foreground));text-align:center;">
        PAT 状态：${escapeHtml(patMasked)}（仅展示掩码）
      </div>`;
  }

  /**
   * 个人信息：昵称、缝纫年限（user_name + sewing_years）
   * 数据层键：user_name 已存在；sewing_years 为 settings 白名单外的扩展键（白名单已含 user_name），
   * 用 settings 表 + key='sewing_years' 兼容方式落地。
   */
  async function renderSettingsProfile(root) {
    const [userNameRow, yearsRow] = await Promise.all([
      dbTable.settings.get('user_name'),
      dbTable.settings.get('sewing_years'),
    ]);
    const userName = (userNameRow && userNameRow.value) || '缝纫人';
    const sewingYears = (yearsRow && yearsRow.value) || '';

    root.innerHTML = `
      <div class="card">
        <div class="card-title">个人信息</div>
        <form id="profile-form" class="form">
          <div class="form-row">
            <label>昵称
              <input type="text" name="user_name" value="${escapeAttr(userName)}" maxlength="20" placeholder="如：缝纫人 / Lily">
            </label>
          </div>
          <div class="form-row">
            <label>缝纫年限（年）
              <input type="number" name="sewing_years" min="0" max="99" step="1" value="${escapeAttr(sewingYears)}" placeholder="如 3">
            </label>
          </div>
        </form>
        <div class="form-actions">
          <button class="btn btn-primary btn-block" data-act="save-profile">保存</button>
          <a class="btn btn-block" href="#/settings">返回</a>
        </div>
      </div>
      <div class="card" style="font-size:12px;color:hsl(var(--secondary-foreground));">
        昵称与年限仅保存在本地 IndexedDB，不会随 GitHub 备份上传（备份策略：见 PRD §10.8）。
      </div>`;

    root.querySelector('[data-act="save-profile"]').addEventListener('click', async () => {
      const fd = new FormData(root.querySelector('#profile-form'));
      const newName = (fd.get('user_name') || '').toString().trim() || '缝纫人';
      const newYears = (fd.get('sewing_years') || '').toString().trim();
      try {
        await dbTable.settings.put({ key: 'user_name', value: newName, updatedAt: global.SS.utils.nowIso() });
        if (newYears) {
          await dbTable.settings.put({ key: 'sewing_years', value: newYears, updatedAt: global.SS.utils.nowIso() });
        }
        toast('已保存');
        global.location.hash = '#/settings';
      } catch (e) {
        toast('保存失败：' + (e.message || e));
      }
    });
  }

  /**
   * 备份入口卡（GitHub 备份 + 本地 zip 导出 + 恢复）
   * 落地：状态卡 + zip 导出 + 从 zip 恢复 + 自动备份频率
   * M1.5 下半：export-zip / import-zip 按钮接通 backup.js（zip = data.json + images/）
   */
  async function renderSettingsBackup(root) {
    const [lastRow, reminderRow, dirtyRow, intervalRow] = await Promise.all([
      dbTable.settings.get('backup_last_success'),
      dbTable.settings.get('backup_reminder_last'),
      dbTable.settings.get('dirty_since_backup'),
      dbTable.settings.get('backup_interval'),
    ]);
    const lastBackup = lastRow && lastRow.value ? String(lastRow.value).slice(0, 16).replace('T', ' ') : '尚未备份';
    const reminderLast = reminderRow && reminderRow.value ? String(reminderRow.value).slice(0, 16).replace('T', ' ') : '—';
    const dirty = dirtyRow && String(dirtyRow.value) === 'true';
    const [patRow] = await Promise.all([dbTable.settings.get('github_token')]);
    const patConfigured = !!(patRow && patRow.value);
    const currentInterval = (intervalRow && intervalRow.value) || 'manual';

    root.innerHTML = `
      <div class="card">
        <div class="card-title">💾 备份</div>
        <div style="font-size:13px;line-height:1.9;">
          <div><strong>最近备份</strong>：${escapeHtml(lastBackup)}</div>
          <div><strong>上次提醒</strong>：${escapeHtml(reminderLast)}</div>
          <div><strong>脏数据标记</strong>：${dirty ? '有未备份的改动' : '已全部备份'}</div>
          <div><strong>PAT 状态</strong>：${patConfigured ? '已配置（github_pat_****）' : '未配置（请先到 GitHub 配置）'}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">GitHub 备份</div>
        <div class="muted-small" style="margin-bottom:8px;">上传数据快照到 GitHub 私有仓库。</div>
        <a class="btn btn-block btn-primary" href="#/settings/github">${patConfigured ? '检查/修改 GitHub 配置' : '配置 GitHub PAT'}</a>
        <button class="btn btn-block btn-primary-outline" data-act="backup-now" ${patConfigured ? '' : 'disabled'}>立即备份到 GitHub</button>
        ${!patConfigured ? '<div class="muted-small" style="margin-top:6px;color:hsl(var(--secondary-foreground));">需要先配置 PAT 后才能触发 GitHub 备份。</div>' : ''}
      </div>
      <div class="card">
        <div class="card-title">本地 zip 备份</div>
        <div class="muted-small" style="margin-bottom:8px;">把全部数据 + 图片打包成 zip 文件，下载到本地或第三方云盘。</div>
        <button class="btn btn-block btn-primary" data-act="export-zip">导出 zip</button>
        <button class="btn btn-block btn-primary-outline" data-act="import-zip">从 zip 恢复</button>
        <input type="file" data-act="import-zip-file" accept=".zip,application/zip,application/x-zip-compressed" style="display:none;" />
        <div data-act="zip-status" class="muted-small" style="margin-top:6px;color:hsl(var(--secondary-foreground));"></div>
        <details class="ios-transfer-guide" style="margin-top:10px;font-size:12px;line-height:1.8;color:hsl(var(--secondary-foreground));background:hsl(var(--secondary)/0.4);border-radius:var(--radius);padding:8px 12px;">
          <summary style="cursor:pointer;font-weight:600;color:hsl(var(--foreground));">📱 iOS 转存指引</summary>
          <div style="margin-top:6px;">
            <strong>从电脑传 zip 到 iPhone/iPad：</strong>
            <ol style="padding-left:18px;margin:4px 0;">
              <li>将 zip 存入 iCloud Drive / 文件 App 的「我的 iPhone」</li>
              <li>或通过隔空投送（AirDrop）从 Mac 发送到 iOS 设备</li>
              <li>打开「文件」App → 找到 .zip → 点按分享按钮 → 选择「缝纫空间」</li>
            </ol>
            <strong>从安卓迁移到 iOS：</strong>
            <ol style="padding-left:18px;margin:4px 0;">
              <li>将 zip 上传到第三方云盘（如阿里云盘 / 百度网盘 / OneDrive）</li>
              <li>在 iOS 设备上安装对应云盘 App → 下载 zip 到「文件」App</li>
              <li>在「文件」App 中长按 zip → 选择「缝纫空间」打开</li>
            </ol>
            <div style="margin-top:4px;">提示：Safari 下载的 zip 默认保存在「下载项」文件夹；若点击 zip 未自动弹出恢复流程，请在「文件」App 中使用「分享 → 缝纫空间」。</div>
          </div>
        </details>
      </div>
      <div class="card">
        <div class="card-title">自动备份频率</div>
        <select data-act="set-interval">
          <option value="daily">每天提醒</option>
          <option value="weekly">每周提醒</option>
          <option value="manual">手动</option>
        </select>
      </div>
      <div class="form-actions">
        <a class="btn btn-block" href="#/settings">返回</a>
      </div>`;

    root.querySelector('[data-act="backup-now"]').addEventListener('click', () => {
      toast('GitHub 备份触发属 M1.5 下半范围（导出/恢复）');
    });

    const statusEl = root.querySelector('[data-act="zip-status"]');
    const fileInput = root.querySelector('[data-act="import-zip-file"]');

    // 导出
    root.querySelector('[data-act="export-zip"]').addEventListener('click', async () => {
      try {
        statusEl.textContent = '正在导出…';
        const t0 = performance.now();
        const result = await SS.backup.exportToZip({
          onProgress: (stage, ratio, msg) => {
            statusEl.textContent = `[${(ratio * 100).toFixed(0)}%] ${msg}`;
          },
        });
        // 触发下载
        SS.backup.downloadBlob(result.blob, result.fileName);
        const elapsedS = (performance.now() - t0) / 1000;
        statusEl.textContent =
          `✅ 已生成 ${result.fileName}（${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB · ` +
          `${result.counts.materials} 物料 / ${result.counts.garments} 成衣 / ` +
          `${result.counts.tasks} 任务 / ${result.counts.totalImages} 张图片 · ` +
          `用时 ${elapsedS.toFixed(1)}s）`;
        toast('zip 导出完成');
        // 记录 last_success + 清 dirty_since_backup
        await dbTable.settings.put({ key: 'backup_last_success', value: SS.utils.nowIso(), updatedAt: SS.utils.nowIso() });
        await dbTable.settings.put({ key: 'dirty_since_backup', value: 'false', updatedAt: SS.utils.nowIso() });
        await db.backupLogs.add({
          id: SS.utils.nanoid(12),
          kind: 'export-zip',
          status: 'success',
          message: `本地 zip 导出 ${result.fileName}（${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB）`,
          createdAt: SS.utils.nowIso(),
        });
      } catch (e) {
        statusEl.textContent = '❌ 导出失败：' + (e.message || e);
        toast('导出失败');
        console.error(e);
      }
    });

    // 恢复 — 两阶段：解析 → 确认（要素①②） → 写入 → 缺失清单（要素③） → Toast（要素④）
    root.querySelector('[data-act="import-zip"]').addEventListener('click', () => {
      fileInput.value = '';
      fileInput.click();
    });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (!/zip$/i.test(file.name) && file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
        statusEl.textContent = '❌ 请选择 .zip 文件';
        return;
      }
      try {
        // 阶段 A：解析 zip（不写库）
        statusEl.textContent = '正在解析 zip（暂不写入数据库）…';
        const result = await SS.backup.importFromZip(file, {
          onProgress: (stage, ratio, msg) => {
            statusEl.textContent = `[${(ratio * 100).toFixed(0)}%] ${msg}`;
          },
        });
        const c = result.counts || {};
        const sizeMB = (result.preview.fileSizeBytes || file.size) / 1024 / 1024;
        const missingImages = result.missingImages || [];

        // 要素①②：恢复概要 + 二次确认（输入"恢复"确认，替代 window.confirm）
        const confirmed = await showRestoreConfirmModal({
          exportedAt: result.preview.exportedAt,
          sizeMB: sizeMB.toFixed(2),
          counts: c,
          imagesStaged: result.preview.imagesStaged,
          missingImages: missingImages,
        });
        if (!confirmed) {
          statusEl.textContent = '已取消恢复';
          return;
        }

        // 阶段 B：写入
        statusEl.textContent = '[写入阶段] 正在写入数据库…';
        const writeResult = await result.commit();

        // 要素③：缺失清单（恢复完成后报告哪些图片在 zip 中缺失）
        let missingNote = '';
        if (missingImages.length > 0) {
          missingNote = '\n⚠️ ' + missingImages.length + ' 张图片在 zip 中缺失，未恢复：' +
            missingImages.slice(0, 8).map(function(m) { return m.id; }).join(', ') +
            (missingImages.length > 8 ? ' …等' : '');
        }
        statusEl.textContent =
          '✅ 恢复完成 · ' + writeResult.totalRows + ' 行 · ' + writeResult.totalImages + ' 张图片 · ' +
          '用时 ' + (writeResult.elapsedMs / 1000).toFixed(1) + 's · 请刷新页面查看' +
          missingNote;

        // 要素④：完成 Toast（含账号设置保留提示）
        toast('恢复完成 · 账号设置已保留（PAT、用户名等），无需重跑配置向导', 3500);
      } catch (e) {
        statusEl.textContent = '❌ 恢复失败：' + (e.message || e);
        toast('恢复失败');
        console.error(e);
      }
    });

    const intervalSel = root.querySelector('[data-act="set-interval"]');
    intervalSel.value = currentInterval;
    intervalSel.addEventListener('change', async () => {
      await dbTable.settings.put({ key: 'backup_interval', value: intervalSel.value, updatedAt: global.SS.utils.nowIso() });
      toast('已保存自动备份频率');
    });
  }

  /**
   * GitHub 配置（PRD §10.8 §10.8.3）
   * 设置：github_token / github_username / github_repo / pat_expires_at
   * 显示：github_token 仅展示掩码 github_pat_****，写入时强制 trim
   * 操作：测试连接（仅校验非空 + 格式）+ 删除 PAT
   */
  async function renderSettingsGithub(root) {
    const [tokenRow, userRow, repoRow, expiresRow] = await Promise.all([
      dbTable.settings.get('github_token'),
      dbTable.settings.get('github_username'),
      dbTable.settings.get('github_repo'),
      dbTable.settings.get('pat_expires_at'),
    ]);
    const patConfigured = !!(tokenRow && tokenRow.value);
    const username = (userRow && userRow.value) || '';
    const repo = (repoRow && repoRow.value) || 'sewing-space-backup';
    const expiresAt = (expiresRow && expiresRow.value) || '';
    const expiresHint = expiresAt ? String(expiresAt).slice(0, 10) : '（未设置）';

    root.innerHTML = `
      <div class="card">
        <div class="card-title">🔗 GitHub 配置</div>
        <form id="github-form" class="form">
          <div class="form-row">
            <label>Personal Access Token (classic, repo 权限)
              <input type="password" name="github_token" placeholder="${patConfigured ? '已保存（github_pat_****）— 仅在需要修改时输入' : '粘贴 PAT'}" autocomplete="off">
            </label>
          </div>
          <div class="form-row">
            <label>GitHub 用户名
              <input type="text" name="github_username" value="${escapeAttr(username)}" placeholder="如 octocat">
            </label>
          </div>
          <div class="form-row">
            <label>仓库名
              <input type="text" name="github_repo" value="${escapeAttr(repo)}" placeholder="如 sewing-space-backup">
            </label>
          </div>
          <div class="form-row">
            <label>PAT 到期日期
              <input type="date" name="pat_expires_at" value="${escapeAttr(expiresHint)}">
            </label>
          </div>
        </form>
        <div class="form-actions">
          <button class="btn btn-primary btn-block" data-act="save-github">保存配置</button>
          <button class="btn btn-block btn-primary-outline" data-act="test-github">测试连接</button>
          ${patConfigured ? '<button class="btn btn-block btn-danger" data-act="delete-github">删除 PAT 与配置</button>' : ''}
          <a class="btn btn-block" href="#/settings">返回</a>
        </div>
      </div>
      <div class="card" style="font-size:12px;color:hsl(var(--secondary-foreground));">
        · Token 仅保存在本地 IndexedDB，不随其它数据写入（参见数据模型 v0.6 §1.7 PAT 排除）。<br/>
        · 建议使用 <code>classic PAT</code> + 仅勾选 <code>repo</code> 权限，90 天到期前通过本页面更新。<br/>
        · 「测试连接」在 M1.5 下半接通网络层；本期仅做字段非空 + 格式校验。
      </div>`;

    root.querySelector('[data-act="save-github"]').addEventListener('click', async () => {
      const fd = new FormData(root.querySelector('#github-form'));
      const newToken = (fd.get('github_token') || '').toString().trim();
      const newUser = (fd.get('github_username') || '').toString().trim();
      const newRepo = (fd.get('github_repo') || '').toString().trim() || 'sewing-space-backup';
      const newExpires = (fd.get('pat_expires_at') || '').toString().trim();
      const ts = global.SS.utils.nowIso();
      try {
        if (newToken) {
          await dbTable.settings.put({ key: 'github_token', value: newToken, updatedAt: ts });
        }
        await dbTable.settings.put({ key: 'github_username', value: newUser, updatedAt: ts });
        await dbTable.settings.put({ key: 'github_repo', value: newRepo, updatedAt: ts });
        if (newExpires) {
          await dbTable.settings.put({ key: 'pat_expires_at', value: newExpires, updatedAt: ts });
        }
        toast('已保存');
        global.location.hash = '#/settings/github';
      } catch (e) {
        toast('保存失败：' + (e.message || e));
      }
    });

    root.querySelector('[data-act="test-github"]').addEventListener('click', async () => {
      const fd = new FormData(root.querySelector('#github-form'));
      const tok = (fd.get('github_token') || (tokenRow && tokenRow.value) || '').toString().trim();
      const usr = (fd.get('github_username') || (userRow && userRow.value) || '').toString().trim();
      if (!tok || !usr) {
        toast('请先填入 PAT 与 GitHub 用户名');
        return;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(usr)) {
        toast('GitHub 用户名格式不合法');
        return;
      }
      toast('PAT + 用户名格式校验通过 · 网络连通性测试属 M1.5 下半范围');
    });

    const delBtn = root.querySelector('[data-act="delete-github"]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm('确认删除 PAT 与全部 GitHub 配置？此操作不可恢复（需重新填入）。')) return;
        await dbTable.settings.bulkDelete(['github_token', 'github_username', 'github_repo', 'pat_expires_at']);
        toast('已删除');
        global.location.hash = '#/settings/github';
      });
    }
  }

  /**
   * 数据同步：P1 占位（2026-09-14 决裁③ 已定案：维持占位形态）
   * - deviceId 只读展示
   * - 推送 / 拉取按钮置灰可点，但提示「P1 范围」
   */
  async function renderSettingsSync(root) {
    const deviceRow = await dbTable.settings.get('device_id');
    const lastSyncRow = await dbTable.settings.get('last_sync_at');
    const dirtyRow = await dbTable.settings.get('dirty_since_sync');
    const deviceId = (deviceRow && deviceRow.value) || '—';
    const lastSync = lastSyncRow && lastSyncRow.value ? String(lastSyncRow.value).slice(0, 16).replace('T', ' ') : '—';
    const dirty = dirtyRow && String(dirtyRow.value) === 'true';

    root.innerHTML = `
      <div class="card">
        <div class="card-title">🔄 数据同步（P1 · 占位）</div>
        <div class="muted-small" style="margin-bottom:8px;">
          2026-09-14 决裁③：本期维持占位形态。deviceId 只读，推送 / 拉取按钮置灰。
        </div>
        <div style="font-size:13px;line-height:1.9;">
          <div><strong>设备 ID</strong>：<code style="user-select:all;">${escapeHtml(deviceId)}</code></div>
          <div><strong>最近同步</strong>：${escapeHtml(lastSync)}</div>
          <div><strong>脏数据</strong>：${dirty ? '有未同步改动' : '已全部同步'}</div>
        </div>
      </div>
      <div class="card">
        <button class="btn btn-block btn-primary-outline" data-act="push-sync" disabled>推送本机数据（P1）</button>
        <button class="btn btn-block btn-primary-outline" data-act="pull-sync" disabled style="margin-top:8px;">拉取远端数据（P1）</button>
        <div class="muted-small" style="margin-top:8px;color:hsl(var(--secondary-foreground));">同步属 P1 范围，本期按钮置灰。</div>
      </div>
      <div class="form-actions">
        <a class="btn btn-block" href="#/settings">返回</a>
      </div>`;
  }

  /**
   * 预设管理（PRD §10.8.5 + 数据模型 v0.6 §1.7）
   * 3 个可增删改分组（patternBrands/fabricBrands/accessoryTags）；
   * 2 个只读硬编码分组（patternStyles/patternAudiences）只展示；
   * 尺码预设（patternSizes/garmentCategories/fabricWidths/accessoryWidths）只读展示（尺码裁决）。
   * 编辑形态：行内输入 + 加号 / 删除按钮。
   */
  async function renderSettingsPresets(root) {
    const presetsRow = await dbTable.settings.get('presets');
    const presets = presetsRow ? JSON.parse(presetsRow.value) : global.SS.db.DEFAULT_PRESETS;

    /**
     * 可编辑分组的渲染（增 / 删 / 内联改名）
     */
    const editableGroup = (groupKey, label) => {
      const list = (presets[groupKey] || []).slice();
      const rows = list.map((v, i) => `
        <li class="preset-row" data-preset-row="${escapeAttr(groupKey)}" data-preset-index="${i}">
          <input class="field-input" data-preset-input="${escapeAttr(groupKey)}" data-preset-index="${i}" value="${escapeAttr(v)}" maxlength="20">
          <button class="btn btn-sm btn-link" data-preset-remove="${escapeAttr(groupKey)}" data-preset-index="${i}">×</button>
        </li>`).join('');
      return `
        <div class="card">
          <div class="card-title">${escapeHtml(label)}（${list.length}）</div>
          <ul class="preset-list" data-preset-list="${escapeAttr(groupKey)}">${rows || '<li class="muted-small">（空）</li>'}</ul>
          <div class="form-row" style="margin-top:8px;">
            <input class="field-input" data-preset-new="${escapeAttr(groupKey)}" placeholder="新增项" maxlength="20">
            <button class="btn btn-sm btn-primary" data-preset-add="${escapeAttr(groupKey)}">＋ 添加</button>
          </div>
        </div>`;
    };
    const readonlyGroup = (groupKey, label) => {
      const list = presets[groupKey] || [];
      return `
        <div class="card">
          <div class="card-title">${escapeHtml(label)}（${list.length} · 只读）</div>
          <div class="chip-row">${list.map((v) => `<span class="chip">${escapeHtml(v)}</span>`).join('')}</div>
          <div class="muted-small" style="margin-top:6px;">硬编码分组，不可编辑（v0.6 §1.7）。</div>
        </div>`;
    };

    root.innerHTML = `
      <div class="card">
        <div class="card-title">🎨 预设管理</div>
        <div class="muted-small">可编辑分组的增删改实时写入 settings.presets JSON；只读分组（尺码 / 款式 / 人群 / 幅宽）按 v0.6 §1.7 硬编码。</div>
      </div>
      ${editableGroup('patternBrands', '纸样品牌')}
      ${editableGroup('fabricBrands', '面料品牌')}
      ${editableGroup('accessoryTags', '辅料标签')}
      ${readonlyGroup('patternStyles', '适合款式（只读）')}
      ${readonlyGroup('patternAudiences', '适合人群（只读）')}
      ${readonlyGroup('patternSizes', '尺码预设（只读）')}
      ${readonlyGroup('fabricWidths', '面料幅宽（只读）')}
      ${readonlyGroup('accessoryWidths', '辅料幅宽（只读）')}
      <div class="form-actions">
        <button class="btn btn-primary btn-block" data-act="save-presets">保存修改</button>
        <button class="btn btn-block btn-danger" data-act="reset-presets">恢复默认预设</button>
        <a class="btn btn-block" href="#/settings">返回</a>
      </div>`;

    /**
     * 行内编辑：监听 input 变更 → 写临时 state，保存时落 IndexedDB
     */
    const draftState = {};
    const ensureDraft = (k) => { draftState[k] = (presets[k] || []).slice(); };
    ['patternBrands', 'fabricBrands', 'accessoryTags'].forEach(ensureDraft);

    root.querySelectorAll('[data-preset-input]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const k = inp.getAttribute('data-preset-input');
        const idx = Number(inp.getAttribute('data-preset-index'));
        if (!draftState[k]) draftState[k] = (presets[k] || []).slice();
        draftState[k][idx] = inp.value;
      });
    });
    root.querySelectorAll('[data-preset-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.getAttribute('data-preset-add');
        const newInp = root.querySelector(`[data-preset-new="${k}"]`);
        const v = (newInp.value || '').trim();
        if (!v) { toast('请输入新增项'); return; }
        if (!draftState[k]) draftState[k] = (presets[k] || []).slice();
        if (draftState[k].includes(v)) { toast('已存在'); return; }
        draftState[k].push(v);
        newInp.value = '';
        // 局部刷新该分组
        const list = root.querySelector(`[data-preset-list="${k}"]`);
        list.innerHTML = draftState[k].map((vv, i) => `
          <li class="preset-row" data-preset-row="${escapeAttr(k)}" data-preset-index="${i}">
            <input class="field-input" data-preset-input="${escapeAttr(k)}" data-preset-index="${i}" value="${escapeAttr(vv)}" maxlength="20">
            <button class="btn btn-sm btn-link" data-preset-remove="${escapeAttr(k)}" data-preset-index="${i}">×</button>
          </li>`).join('');
        wireRowEvents();
      });
    });
    function wireRowEvents() {
      root.querySelectorAll('[data-preset-remove]').forEach((btn) => {
        btn.onclick = () => {
          const k = btn.getAttribute('data-preset-remove');
          const idx = Number(btn.getAttribute('data-preset-index'));
          if (!draftState[k]) draftState[k] = (presets[k] || []).slice();
          draftState[k].splice(idx, 1);
          const list = root.querySelector(`[data-preset-list="${k}"]`);
          list.innerHTML = draftState[k].map((vv, i) => `
            <li class="preset-row" data-preset-row="${escapeAttr(k)}" data-preset-index="${i}">
              <input class="field-input" data-preset-input="${escapeAttr(k)}" data-preset-index="${i}" value="${escapeAttr(vv)}" maxlength="20">
              <button class="btn btn-sm btn-link" data-preset-remove="${escapeAttr(k)}" data-preset-index="${i}">×</button>
            </li>`).join('');
          wireRowEvents();
        };
      });
      root.querySelectorAll('[data-preset-input]').forEach((inp) => {
        inp.oninput = () => {
          const k = inp.getAttribute('data-preset-input');
          const idx = Number(inp.getAttribute('data-preset-index'));
          if (!draftState[k]) draftState[k] = (presets[k] || []).slice();
          draftState[k][idx] = inp.value;
        };
      });
    }
    wireRowEvents();

    root.querySelector('[data-act="save-presets"]').addEventListener('click', async () => {
      const next = Object.assign({}, presets, draftState);
      try {
        await dbTable.settings.put({ key: 'presets', value: JSON.stringify(next), updatedAt: global.SS.utils.nowIso() });
        toast('已保存');
        global.location.hash = '#/settings/presets';
      } catch (e) {
        toast('保存失败：' + (e.message || e));
      }
    });
    root.querySelector('[data-act="reset-presets"]').addEventListener('click', async () => {
      if (!confirm('恢复默认预设将覆盖当前编辑，可编辑分组的修改会丢失。确认？')) return;
      try {
        await dbTable.settings.put({ key: 'presets', value: JSON.stringify(global.SS.db.DEFAULT_PRESETS), updatedAt: global.SS.utils.nowIso() });
        toast('已恢复默认');
        global.location.hash = '#/settings/presets';
      } catch (e) {
        toast('恢复失败：' + (e.message || e));
      }
    });
  }

  /**
   * 任务模板管理（PRD §10.8.6）
   * 首启已注入 3 个种子模板（半身裙 / 上衣基础 / 连衣裙）
   * 操作：查看 / 重命名 / 删除 / 新增（最少 1 步）
   */
  async function renderSettingsTemplates(root) {
    const templates = await dbTable.taskTemplates.toArray();

    root.innerHTML = `
      <div class="card">
        <div class="card-title">📑 任务模板（${templates.length}）</div>
        <div class="muted-small">首启已自动注入 3 个种子模板（半身裙 / 上衣基础 / 连衣裙）。</div>
      </div>
      <div id="template-list">
        ${templates.map((t) => `
          <div class="card" data-tmpl-id="${escapeAttr(t.id)}">
            <div class="card-title">${escapeHtml(t.name)}（${(t.steps || []).length} 步）</div>
            <div class="muted-small" style="margin-bottom:6px;">${escapeHtml(t.description || '')}</div>
            <ol style="margin:0;padding-left:18px;font-size:12px;color:hsl(var(--secondary-foreground));">
              ${(t.steps || []).map((s) => `<li>${escapeHtml(s.title || '')}</li>`).join('')}
            </ol>
            <div class="form-row inline" style="margin-top:8px;">
              <button class="btn btn-sm btn-primary-outline" data-act="edit-tmpl" data-id="${escapeAttr(t.id)}">编辑</button>
              <button class="btn btn-sm btn-danger" data-act="del-tmpl" data-id="${escapeAttr(t.id)}">删除</button>
            </div>
          </div>`).join('')}
      </div>
      <div class="card">
        <div class="card-title">新增模板</div>
        <form id="new-tmpl-form" class="form">
          <div class="form-row">
            <label>名称
              <input type="text" name="name" required maxlength="20" placeholder="如：马甲">
            </label>
          </div>
          <div class="form-row">
            <label>说明
              <input type="text" name="description" maxlength="80">
            </label>
          </div>
          <div class="form-row">
            <label>步骤（每行一步）
              <textarea name="steps" rows="4" placeholder="裁剪&#10;缝合&#10;锁边"></textarea>
            </label>
          </div>
        </form>
        <div class="form-actions">
          <button class="btn btn-primary btn-block" data-act="add-tmpl">新增模板</button>
        </div>
      </div>
      <div class="form-actions">
        <a class="btn btn-block" href="#/settings">返回</a>
      </div>`;

    root.querySelectorAll('[data-act="del-tmpl"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!confirm('确认删除该模板？')) return;
        await dbTable.taskTemplates.delete(id);
        toast('已删除');
        global.location.hash = '#/settings/templates';
      });
    });
    root.querySelectorAll('[data-act="edit-tmpl"]').forEach((btn) => {
      btn.addEventListener('click', () => openTemplateEditSheet(btn.getAttribute('data-id')));
    });
    root.querySelector('[data-act="add-tmpl"]').addEventListener('click', async () => {
      const fd = new FormData(root.querySelector('#new-tmpl-form'));
      const name = (fd.get('name') || '').toString().trim();
      if (!name) { toast('名称必填'); return; }
      const desc = (fd.get('description') || '').toString().trim();
      const stepsRaw = (fd.get('steps') || '').toString();
      const steps = stepsRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (steps.length === 0) { toast('至少写 1 步'); return; }
      try {
        await dbTable.taskTemplates.put({
          id: 'tmpl-' + global.SS.utils.nanoid(8),
          name, description: desc, steps: steps.map((title, i) => ({ title, order: i + 1 })),
          createdAt: global.SS.utils.nowIso(),
          updatedAt: global.SS.utils.nowIso(),
        });
        toast('已新增');
        global.location.hash = '#/settings/templates';
      } catch (e) {
        toast('新增失败：' + (e.message || e));
      }
    });
  }

  /** 模板编辑 sheet */
  async function openTemplateEditSheet(id) {
    const tmpl = await dbTable.taskTemplates.get(id);
    if (!tmpl) { toast('模板不存在'); return; }
    C.openSheet({
      title: '编辑模板 · ' + tmpl.name,
      content: `
        <div class="sheet-form">
          <div class="field">
            <div class="field-label">名称</div>
            <input class="field-input" id="t-name" value="${escapeAttr(tmpl.name)}" maxlength="20">
          </div>
          <div class="field">
            <div class="field-label">说明</div>
            <input class="field-input" id="t-desc" value="${escapeAttr(tmpl.description || '')}" maxlength="80">
          </div>
          <div class="field">
            <div class="field-label">步骤（每行一步）</div>
            <textarea class="field-input" id="t-steps" rows="6">${escapeHtml((tmpl.steps || []).map((s) => s.title).join('\n'))}</textarea>
          </div>
        </div>
        <div class="form-actions" style="margin-top:8px;">
          <button class="btn btn-primary btn-block" data-act="save-edit">保存修改</button>
        </div>`,
      onMount: (wrap, close) => {
        wrap.querySelector('[data-act="save-edit"]').onclick = async () => {
          const name = (wrap.querySelector('#t-name').value || '').trim() || tmpl.name;
          const desc = (wrap.querySelector('#t-desc').value || '').trim();
          const stepsRaw = wrap.querySelector('#t-steps').value || '';
          const steps = stepsRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          if (steps.length === 0) { toast('至少 1 步'); return; }
          try {
            await dbTable.taskTemplates.update(id, {
              name, description: desc,
              steps: steps.map((title, i) => ({ title, order: i + 1 })),
              updatedAt: global.SS.utils.nowIso(),
            });
            toast('已保存');
            close();
            global.location.hash = '#/settings/templates';
          } catch (e) {
            toast('保存失败：' + (e.message || e));
          }
        };
      },
    });
  }

  /**
   * 关于页：版本 + 存储用量 + display-mode + iOS<26 检测
   * M1.5 增加：版本号实时取 SW_VERSION；存储用量通过 navigator.storage.estimate()
   * display-mode：通过 window.matchMedia('(display-mode: standalone)').matches 判断 PWA 安装态
   * iOS<26：UA 解析 iOS 版本 < 16（旧系统配额 ~50MB），给出提示
   */
  async function renderSettingsAbout(root) {
    const SW_VERSION = (global.SS && global.SS.app && global.SS.app.SW_VERSION) || 'unknown';
    // 存储用量
    let storageUsed = '—', storageQuota = '—';
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      try {
        const est = await navigator.storage.estimate();
        if (est.usage != null) storageUsed = (est.usage / (1024 * 1024)).toFixed(2) + ' MB';
        if (est.quota != null) storageQuota = (est.quota / (1024 * 1024)).toFixed(0) + ' MB';
      } catch (_) {}
    }
    // PWA 安装态
    const isStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    const displayMode = isStandalone ? '已安装 PWA（standalone）' : '浏览器标签页（未安装）';
    // iOS<26 检测
    const ua = navigator.userAgent || '';
    const iosMatch = ua.match(/OS (\d+)_(\d+)/);
    const iosVer = iosMatch ? Number(iosMatch[1]) : null;
    const iosLowHint = (iosVer !== null && iosVer < 26)
      ? `<div class="muted-small" style="color:#b85c00;">检测到 iOS ${iosVer}：未安装 PWA 时浏览器缓存约 50 MB 上限；建议安装到主屏幕以扩展配额。</div>`
      : '';

    root.innerHTML = `
      <div class="card">
        <div class="card-title">ℹ️ 关于缝纫空间</div>
        <div style="font-size:13px;line-height:1.9;">
          <div><strong>版本</strong>：${escapeHtml(SW_VERSION)}（M1.5 上半）</div>
          <div><strong>构建</strong>：纯静态 · 无框架 · 无构建工具</div>
          <div><strong>数据</strong>：浏览器 IndexedDB（Dexie）</div>
          <div><strong>部署</strong>：GitHub Pages · PWA 可安装</div>
          <div><strong>显示形态</strong>：${escapeHtml(displayMode)}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">存储用量</div>
        <div style="font-size:13px;line-height:1.9;">
          <div><strong>已用</strong>：${escapeHtml(storageUsed)}</div>
          <div><strong>配额</strong>：${escapeHtml(storageQuota)}</div>
        </div>
        ${iosLowHint}
      </div>
      <div class="card">
        <div class="card-title">编码基线</div>
        <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.8;color:hsl(var(--secondary-foreground));">
          <li>数据模型：v0.6 冻结基线</li>
          <li>PRD：v6.0（2026-09-10 冻结）</li>
          <li>部署与备份：v0.2 选项 A</li>
          <li>M1.5 上半：设置页 + 成衣图片上传（D-IM1）</li>
        </ul>
      </div>
      <div class="card">
        <div class="card-title">系统提示</div>
        <div style="font-size:12px;color:hsl(var(--secondary-foreground));line-height:1.7;">
          · 未安装 PWA：iOS Safari 约 50 MB 上限<br/>
          · 已安装 PWA：约 1 GB，但长期未用系统可能清理数据<br/>
          · 建议保持备份习惯（GitHub / 本地 zip）
        </div>
      </div>
      <div class="form-actions">
        <a class="btn btn-block" href="#/settings">返回</a>
      </div>`;
  }

  /* ============ 搜索（M1 · 路由占位，P1 落地） ============ */
  function renderSearch(root) {
    root.innerHTML = C.renderPlaceholder({
      title: '全局搜索',
      module: 'P1',
      icon: '🔍',
      desc: '物料 / 成衣 / 任务 三组结果。M1.1 路由已注册；搜索功能 P1 落地。',
    });
  }

  /* ============ 向导（M1.5 · 首启自动跳转；当前已通过种子放行） ============ */
  function renderWizard(root) {
    root.innerHTML = C.renderPlaceholder({
      title: '初始化向导',
      module: 'M1.5',
      icon: '🪄',
      desc: 'WelcomeStep → ImportStep（zip 导入）→ GitHubStep → InstallStep。M1.1 阶段已在首启自动注入 device_id + 3 个预设模板，可通过设置页"重新运行初始化向导"重跑。',
    });
  }

  /* ============ 404 ============ */
  function renderNotFound(root, path) {
    root.innerHTML = `
      <div class="placeholder-page">
        <div class="placeholder-icon">🧭</div>
        <div class="placeholder-title">页面不存在</div>
        <div class="placeholder-desc">路径 <code>${path}</code> 未匹配到任何已注册的路由</div>
        <a class="btn btn-primary" href="#/" style="margin-top:16px;">回到首页</a>
      </div>`;
  }

  /* ============ 导出 ============ */
  global.SS = global.SS || {};
  global.SS.pages = {
    renderHome,
    renderMaterials, renderMaterialDetail,
    renderGarments, renderGarmentDetail,
    renderWorkbench, renderTaskForm,
    renderStats,
    renderSettings,
    renderSettingsProfile,
    renderSettingsBackup, renderSettingsGithub, renderSettingsSync,
    renderSettingsTemplates, renderSettingsPresets, renderSettingsAbout,
    renderSearch, renderWizard,
    renderNotFound,
    // v1.1.2 P1-M2-2 残留：暴露给数据层自检做表单→db 传递链回归断言
    readFormValues,
    saveMaterialForm,
    // M1.6 P2②：暴露恢复确认弹窗给 E2E 断言
    showRestoreConfirmModal,
  };
})(window);