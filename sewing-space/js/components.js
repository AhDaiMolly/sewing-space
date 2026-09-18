/**
 * components.js · 共享 UI 组件
 * 缝纫空间 M1.1 工程骨架 + M1.2 物料模块扩展
 *
 * 组件以纯函数形式暴露，每个组件接收 (root, props)，
 * 渲染内容直接写到 root.innerHTML 并返回必要的 cleanup 函数。
 * 不引任何虚拟 DOM 框架，原生 DOM 操作。
 */

(function (global) {
  'use strict';

  const { escapeHtml, on, emit } = global.SS.utils;

  /* ============ 底部导航 ============ */
  // 5 标签：首页 / 物料 / 成衣 / 工作台 / 我的
  // PRD v6.0 §5.3 + 原型：5 标签底部导航（设置入口放右下"我的"）
  const NAV_TABS = [
    { id: 'home',       path: '#/',            icon: '🏠', label: '首页' },
    { id: 'materials',  path: '#/materials',   icon: '🧵', label: '物料' },
    { id: 'garments',   path: '#/garments',    icon: '👕', label: '成衣' },
    { id: 'workbench',  path: '#/workbench',   icon: '📋', label: '工作台' },
    { id: 'settings',   path: '#/settings',    icon: '⚙️', label: '我的' },
  ];

  /** 渲染底部导航到指定元素 */
  function renderBottomNav(container, activePath) {
    const html = NAV_TABS.map((tab) => {
      const active = activePath === tab.path || activePath.startsWith(tab.path + '/');
      return `
        <a class="bottom-nav-item" href="${escapeHtml(tab.path)}"
           data-tab="${tab.id}" aria-current="${active ? 'page' : 'false'}">
          <span class="bottom-nav-icon" aria-hidden="true">${tab.icon}</span>
          <span class="bottom-nav-label">${escapeHtml(tab.label)}</span>
        </a>`;
    }).join('');
    container.innerHTML = html;
    container.hidden = false;
  }

  /* ============ 顶部导航 ============ */
  /** 更新顶部标题与返回按钮 */
  function updateHeader({ title, showBack = false }) {
    const header = document.getElementById('app-header');
    const titleEl = document.getElementById('page-title');
    const backBtn = document.getElementById('back-btn');
    if (titleEl) titleEl.textContent = title || '';
    if (backBtn) backBtn.hidden = !showBack;
    if (header) header.hidden = false;
  }

  /** 绑定返回按钮（默认行为：history.back()） */
  function bindBackButton(handler) {
    const btn = document.getElementById('back-btn');
    if (!btn) return;
    btn.onclick = (e) => {
      e.preventDefault();
      handler ? handler() : history.back();
    };
  }

  /* ============ M1.2 物料模块组件 ============ */

  /**
   * 类型图标（4 类物料 emoji）
   */
  const TYPE_ICON = {
    fabric: '🧶',
    accessory: '🪡',
    tool: '✂️',
    pattern: '📐',
  };

  const TYPE_LABEL = {
    fabric: '面料',
    accessory: '辅料',
    tool: '工具',
    pattern: '纸样',
  };

  const SEASON_LABEL = {
    spring: '春',
    summer: '夏',
    autumn: '秋',
    winter: '冬',
    all_season: '四季',
  };

  /**
   * Tabs（横向 5 标签切换）
   * @param {Array<{id:string, label:string, badge?:number}>} tabs
   * @param {string} activeId
   * @param {string} baseHash 切换 hash 基础路径（不含 tab id）
   * @returns {string} HTML 字符串
   */
  function renderTabs(tabs, activeId, baseHash) {
    return `
      <div class="tabs">
        ${tabs.map((t) => {
          const active = t.id === activeId;
          return `<a class="tab ${active ? 'tab-active' : ''}" href="${escapeHtml(baseHash + '/' + t.id)}" data-tab-id="${escapeHtml(t.id)}">
            ${escapeHtml(t.label)}
            ${t.badge != null ? `<span class="tab-badge">${escapeHtml(String(t.badge))}</span>` : ''}
          </a>`;
        }).join('')}
      </div>`;
  }

  /**
   * Filter Chips（横向 chip 列表）
   * @param {Array<{id:string, label:string}>} chips
   * @param {string[]} activeIds
   * @returns {string}
   */
  function renderFilterChips(chips, activeIds) {
    return `
      <div class="chip-row">
        ${chips.map((c) => {
          const active = activeIds.includes(c.id);
          return `<button class="chip ${active ? 'chip-active' : ''}" data-chip-id="${escapeHtml(c.id)}" type="button">
            ${escapeHtml(c.label)}
          </button>`;
        }).join('')}
      </div>`;
  }

  /**
   * 星级渲染
   */
  function renderStars(rating) {
    const r = Number(rating) || 0;
    let s = '';
    for (let i = 1; i <= 5; i++) {
      s += `<span class="star ${i <= r ? 'star-on' : 'star-off'}">★</span>`;
    }
    return `<span class="stars">${s}</span>`;
  }

  /**
   * 物料列表卡片
   * @param {Object} m Material 实体
   * @param {Object} opts { useStars, showUsageState, showThumb }
   */
  function renderMaterialCard(m, opts = {}) {
    const icon = TYPE_ICON[m.type] || '📦';
    const label = TYPE_LABEL[m.type] || '物料';
    const lowStock = (m.quantity === 0)
      ? '<span class="badge badge-danger">空</span>'
      : (m.quantity <= 1 ? '<span class="badge badge-warn">低</span>' : '');
    const brandLine = m.brand ? `<span class="muted">· ${escapeHtml(m.brand)}</span>` : '';
    const starsLine = opts.useStars && m.rating
      ? `<div class="mat-card-meta">${renderStars(m.rating)}${m.used ? '<span class="badge badge-used">已用</span>' : ''}</div>`
      : (m.used ? '<span class="badge badge-used">已用</span>' : '');
    const sub = `${label}${brandLine} · ${m.quantity}${escapeHtml(m.unit || '')} ${lowStock}`;
    return `
      <a class="mat-card" href="#/materials/${escapeHtml(m.id)}">
        <div class="mat-card-thumb">${icon}</div>
        <div class="mat-card-body">
          <div class="mat-card-title">${escapeHtml(m.name || '(未命名)')}</div>
          <div class="mat-card-sub">${sub}</div>
          ${starsLine}
        </div>
        <div class="mat-card-arrow">›</div>
      </a>`;
  }

  /**
   * 字段展示行（详情页 / 表单通用）
   * @param {Object} opts
   *   label, value, edit (boolean, 表示可编辑),
   *   type ('text'|'number'|'date'|'textarea'|'select'|'stars'|'chips'|'switch'|'multiselect'|'image'),
   *   options (Array<{id,label}> for select/multiselect),
   *   placeholder, max, min, step
   * @returns {string} HTML
   */
  function renderField(opts) {
    const { label = '', value, edit = false, type = 'text', options = [], placeholder = '', min, max, step } = opts;
    if (!edit) {
      // 只读展示
      let display = '';
      if (type === 'stars') display = renderStars(value);
      else if (type === 'multiselect' || type === 'chips') {
        // 容错：CSV 字符串、空值、非数组都规范化
        const list = Array.isArray(value) ? value
          : (typeof value === 'string' && value.trim()) ? value.split(/[,，;；\s]+/).filter(Boolean)
          : [];
        display = list.map((v) => `<span class="tag">${escapeHtml(v)}</span>`).join(' ') || '<span class="muted">—</span>';
      }
      else if (type === 'switch') display = value ? '<span class="badge badge-on">是</span>' : '<span class="badge">否</span>';
      else if (type === 'image') display = '<span class="muted">（图片下方独立渲染）</span>';
      else display = (value != null && value !== '') ? escapeHtml(String(value)) : '<span class="muted">—</span>';
      return `
        <div class="field field-readonly">
          <div class="field-label">${escapeHtml(label)}</div>
          <div class="field-value">${display}</div>
        </div>`;
    }
    // 可编辑
    let input = '';
    const id = 'fld-' + Math.random().toString(36).slice(2, 8);
    if (type === 'textarea') {
      input = `<textarea class="field-input" data-field-input id="${id}" placeholder="${escapeHtml(placeholder)}" maxlength="${max || 1000}">${escapeHtml(value || '')}</textarea>`;
    } else if (type === 'select') {
      input = `<select class="field-input" data-field-input id="${id}" data-field-options='${escapeHtml(JSON.stringify(options))}'>
        ${options.map((o) => `<option value="${escapeHtml(o.id)}" ${String(value) === String(o.id) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
      </select>`;
    } else if (type === 'multiselect') {
      const arr = value || [];
      input = `<div class="chip-multi" data-field-input data-field-options='${escapeHtml(JSON.stringify(options))}'>
        ${options.map((o) => {
          const active = arr.includes(o.id);
          return `<button type="button" class="chip ${active ? 'chip-active' : ''}" data-multi="${escapeHtml(o.id)}">${escapeHtml(o.label)}</button>`;
        }).join('')}
      </div>`;
    } else if (type === 'stars') {
      const cur = Number(value) || 0;
      input = `<div class="star-edit" data-field-input>
        ${[1, 2, 3, 4, 5].map((i) => `<button type="button" class="star-btn ${i <= cur ? 'star-on' : ''}" data-rating="${i}">★</button>`).join('')}
        <button type="button" class="star-clear" data-rating="0">×</button>
      </div>`;
    } else if (type === 'switch') {
      input = `<label class="switch"><input type="checkbox" data-field-input ${value ? 'checked' : ''}><span class="switch-slider"></span></label>`;
    } else {
      input = `<input class="field-input" data-field-input id="${id}" type="${escapeHtml(type)}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder)}" ${min != null ? `min="${min}"` : ''} ${max != null ? `max="${max}"` : ''} ${step != null ? `step="${step}"` : ''}>`;
    }
    return `
      <div class="field">
        <div class="field-label">${escapeHtml(label)}</div>
        <div class="field-value">${input}</div>
      </div>`;
  }

  /**
   * Sheet（底部抽屉 / 弹窗）
   * @param {Object} opts { title, content, onClose }
   */
  function renderSheet({ title, content }) {
    return `
      <div class="sheet-backdrop" data-sheet-backdrop></div>
      <div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <div class="sheet-title">${escapeHtml(title)}</div>
          <button class="sheet-close" data-sheet-close type="button">×</button>
        </div>
        <div class="sheet-body">${content}</div>
      </div>`;
  }

  /**
   * 打开 Sheet（挂到 body，关闭时移除）
   * @param {Object} opts { title, content, onClose, onMount }
   */
  function openSheet({ title, content, onMount, onClose }) {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = renderSheet({ title, content });
    document.body.appendChild(wrap);
    // 关闭
    const close = () => {
      wrap.remove();
      onClose && onClose();
    };
    wrap.querySelector('[data-sheet-backdrop]').onclick = close;
    wrap.querySelector('[data-sheet-close]').onclick = close;
    onMount && onMount(wrap, close);
    return { close, wrap };
  }

  /**
   * 流水列表项
   */
  function renderUsageLogItem(log, materialName) {
    const kindLabel = {
      consume: '扣减',
      revert: '回补',
      adjust: '调整',
      'delete-garment': '删成衣回补',
    }[log.kind] || log.kind;
    const sign = log.kind === 'revert' || log.kind === 'delete-garment' ? '+' : (log.kind === 'consume' ? '−' : '±');
    const sourceLabel = (log.source || '').startsWith('garment:')
      ? '成衣关联'
      : (log.source === 'manual:loss' ? '手动记损耗' : (log.source === 'manual' ? '手动调整' : (log.source || '')));
    return `
      <div class="log-item">
        <div class="log-icon">${sign}</div>
        <div class="log-body">
          <div class="log-row1">
            <span class="log-kind">${escapeHtml(kindLabel)}</span>
            <span class="log-qty">${sign}${escapeHtml(String(log.quantity))}</span>
          </div>
          <div class="log-row2">
            <span class="muted">${escapeHtml(sourceLabel)}</span>
            <span class="muted">${escapeHtml(global.SS.utils.relativeTime(log.createdAt))}</span>
          </div>
          ${log.note ? `<div class="log-note">${escapeHtml(log.note)}</div>` : ''}
        </div>
      </div>`;
  }

  /**
   * 图片上传组件（CSS-only，含 input[type=file]）
   * @param {Object} opts { images: string[], max }
   */
  function renderImageUploader({ images = [], max = 9 } = {}) {
    const list = images.map((id, i) => `
      <div class="img-thumb" data-img-id="${escapeHtml(id)}" data-img-index="${i}">
        <div class="img-thumb-inner" data-img-load="${escapeHtml(id)}"></div>
        <button class="img-remove" data-img-remove="${escapeHtml(id)}" type="button">×</button>
      </div>`).join('');
    const add = images.length < max
      ? `<div class="img-add" data-img-add>
           <input type="file" accept="image/*" multiple data-img-input hidden>
           <span>＋</span>
         </div>`
      : '';
    return `<div class="img-uploader" data-img-uploader>${list}${add}</div>`;
  }

  /* ============ 空状态 ============ */
  function renderEmptyState({ icon = '📭', title = '还没有内容', desc = '' } = {}) {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">${escapeHtml(icon)}</div>
        <div>${escapeHtml(title)}</div>
        ${desc ? `<div style="margin-top:6px;font-size:12px;">${escapeHtml(desc)}</div>` : ''}
      </div>`;
  }

  /* ============ 占位页面（M1.2 - M1.5 业务功能待办） ============ */
  /**
   * 通用占位页：标明对应 M1.x 模块 + 后续交付清单
   * @param {Object} opts
   * @param {string} opts.title - 模块标题
   * @param {string} opts.module - 模块标识（M1.2 / M1.3 / ...）
   * @param {string} opts.icon - 顶部 emoji
   * @param {string} opts.desc - 业务说明
   * @param {string[]} [opts.todos] - 后续模块要做的事（点列）
   */
  function renderPlaceholder({ title, module, icon, desc, todos = [] }) {
    return `
      <div class="placeholder-page">
        <div class="placeholder-icon">${escapeHtml(icon)}</div>
        <div class="placeholder-title">${escapeHtml(title)}</div>
        <div class="placeholder-desc">${escapeHtml(desc)}</div>
        <span class="module-badge">${escapeHtml(module)} · 计划中</span>
        ${todos.length ? `
          <div class="card" style="text-align:left;margin-top:24px;">
            <div class="card-title">本模块要做的事（占位 · 后续 Sprint 落地）</div>
            <ul style="margin:0;padding-left:18px;font-size:13px;color:hsl(var(--secondary-foreground));line-height:1.8;">
              ${todos.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}
            </ul>
          </div>` : ''}
      </div>`;
  }

  /* ============ 主卡（首页战果卡占位） ============ */
  function renderHeroCard({ title, value, unit = '' }) {
    return `
      <div class="hero-card">
        <div class="hero-card-title">${escapeHtml(title)}</div>
        <div class="hero-card-value">${escapeHtml(String(value))}${unit ? `<span style="font-size:14px;color:hsl(var(--secondary-foreground));"> ${escapeHtml(unit)}</span>` : ''}</div>
      </div>`;
  }

  /* ============ 列表卡片 ============ */
  function renderListCard({ thumb = '📦', title, sub = '', href = '#' }) {
    return `
      <a class="list-card" href="${escapeHtml(href)}">
        <div class="list-card-thumb">${escapeHtml(thumb)}</div>
        <div class="list-card-body">
          <div class="list-card-title">${escapeHtml(title)}</div>
          ${sub ? `<div class="list-card-sub">${escapeHtml(sub)}</div>` : ''}
        </div>
        <div style="color:hsl(var(--secondary-foreground));">›</div>
      </a>`;
  }

  /* ============ 自检结果渲染 ============ */
  function renderTestResults({ passed, failed, results }) {
    const items = results.map((r) => {
      const cls = r.ok ? 'pass' : 'fail';
      const mark = r.ok ? '✓' : '✗';
      const detail = r.detail ? ` — ${escapeHtml(r.detail)}` : '';
      return `<div class="test-result ${cls}">[${mark}] ${escapeHtml(r.name)}${detail}</div>`;
    }).join('');
    const total = passed + failed;
    const summaryCls = failed === 0 ? 'all-pass' : 'has-fail';
    const summaryText = failed === 0
      ? `全部通过 ${passed}/${total}`
      : `失败 ${failed} 项 · 通过 ${passed}/${total}`;
    return `
      <div>${items}</div>
      <div class="test-summary ${summaryCls}">${escapeHtml(summaryText)}</div>`;
  }

  /* ============ M1.3 成衣模块组件 ============ */

  // 成衣状态：planning / in_progress / completed / on_hold
  const GARMENT_STATUS = {
    planning:    { label: '规划中',  badge: 'badge-status-planning'    },
    in_progress: { label: '进行中',  badge: 'badge-status-in_progress' },
    completed:   { label: '已完工',  badge: 'badge-status-completed'   },
    on_hold:     { label: '暂停',    badge: 'badge-status-on_hold'     },
  };

  // 类目
  const GARMENT_CATEGORY = {
    top:    '上装',
    bottom: '下装',
    set:    '套装',
    acc:    '配饰',
    other:  '其他',
  };

  /** 状态徽章 */
  function renderStatusBadge(status) {
    const s = GARMENT_STATUS[status] || { label: status || '未分类', badge: 'badge-status-planning' };
    return `<span class="badge ${s.badge}">${escapeHtml(s.label)}</span>`;
  }

  /** 类目中文 */
  function renderCategoryLabel(cat) {
    return GARMENT_CATEGORY[cat] || cat || '未分类';
  }

  /** 列表卡片
   * M1.5: 增加首图渲染（3:4 竖版）。渲染为同步（占位 + data-img-id），首图 URL 由调用方在挂载后异步加载。
   * 用法：调用 renderGarmentCard 后，遍历卡片上的 [data-garment-cover-img] 元素，loadImage 第一张图片后写入 background-image。
   * @param {Object} garment
   * @param {Object} opts { showStatus, showCost, coverImageId }
   *   coverImageId: 可显式传入；不传则取 garment.images[0]
   */
  function renderGarmentCard(garment, opts = {}) {
    const showStatus = opts.showStatus !== false;
    const showCost = opts.showCost !== false;
    const coverHref = `#/garments/${escapeHtml(garment.id || '')}`;
    const snap = Array.isArray(garment.materialSnapshot) ? garment.materialSnapshot : [];
    const matCount = snap.length;
    const totalCost = typeof garment.totalCost === 'number'
      ? garment.totalCost
      : snap.reduce((s, it) => s + (it.subtotal || 0), 0);
    const imgs = Array.isArray(garment.images) ? garment.images.filter(Boolean) : [];
    const coverId = opts.coverImageId || imgs[0] || '';
    const coverEl = coverId
      ? `<div class="garment-card-cover" data-garment-cover-img="${escapeHtml(coverId)}" data-garment-id="${escapeHtml(garment.id || '')}" aria-hidden="true"></div>`
      : `<div class="garment-card-cover garment-card-cover-empty" aria-hidden="true">👕</div>`;
    return `
      <a class="card garment-card" href="${coverHref}" data-id="${escapeHtml(garment.id || '')}">
        <div class="garment-card-cover-wrap">${coverEl}</div>
        <div class="garment-card-body">
          <div class="garment-card-head">
            <div class="garment-card-title">${escapeHtml(garment.name || '(未命名成衣)')}</div>
            ${showStatus ? renderStatusBadge(garment.status) : ''}
          </div>
          <div class="garment-card-meta">
            <span class="muted">${renderCategoryLabel(garment.category)}</span>
            ${garment.size ? `<span class="muted"> · ${escapeHtml(garment.size)}</span>` : ''}
            ${garment.recipient ? `<span class="muted"> · ${escapeHtml(garment.recipient)}</span>` : ''}
          </div>
          <div class="garment-card-foot">
            <span class="muted-small">关联物料 ${matCount} 项</span>
            ${imgs.length > 1 ? `<span class="muted-small">· ${imgs.length} 图</span>` : ''}
            ${showCost ? `<span class="muted-small">成本 ¥${(totalCost || 0).toFixed(2)}</span>` : ''}
          </div>
        </div>
      </a>`;
  }

  /**
   * 异步把成衣卡片的首图加载到 DOM。列表渲染后批量调用一次。
   * @param {HTMLElement} rootEl  列表容器
   * @param {(imageId: string) => Promise<string|null>} loadImageFn  app.loadImage
   */
  async function hydrateGarmentCardImages(rootEl, loadImageFn) {
    if (!rootEl || typeof loadImageFn !== 'function') return;
    const placeholders = Array.from(rootEl.querySelectorAll('[data-garment-cover-img]'));
    await Promise.all(placeholders.map(async (el) => {
      const imgId = el.getAttribute('data-garment-cover-img');
      if (!imgId) return;
      try {
        const url = await loadImageFn(imgId);
        if (url) el.style.backgroundImage = `url(${JSON.stringify(url)})`;
      } catch (_) {}
    }));
  }

  /** Hero */
  function renderGarmentHero(garment, imageUrl) {
    const status = garment.status || 'planning';
    const imgStyle = imageUrl ? `background-image:url('${imageUrl}');` : '';
    return `
      <div class="garment-hero">
        <div class="garment-hero-img" style="${imgStyle}">
          ${imageUrl ? '' : '<div class="garment-hero-img-empty">👕</div>'}
        </div>
        <div class="garment-hero-body">
          <div class="garment-hero-title">${escapeHtml(garment.name || '(未命名成衣)')}</div>
          <div class="garment-hero-meta">
            ${renderStatusBadge(status)}
            <span class="muted">${renderCategoryLabel(garment.category)}</span>
            ${garment.size ? `<span class="muted"> · ${escapeHtml(garment.size)}</span>` : ''}
            ${garment.recipient ? `<span class="muted"> · ${escapeHtml(garment.recipient)}</span>` : ''}
          </div>
          ${garment.completionDate ? `<div class="garment-hero-sub">完工：${escapeHtml(garment.completionDate.slice(0, 10))}</div>` : ''}
        </div>
      </div>`;
  }

  /** 成本区块 */
  function renderCostBlock(snapshot, totalCost) {
    const items = Array.isArray(snapshot) ? snapshot : [];
    if (!items.length) {
      return `
        <div class="card">
          <div class="card-title">成本</div>
          <div class="muted">未关联任何物料</div>
        </div>`;
    }
    const cost = typeof totalCost === 'number'
      ? totalCost
      : items.reduce((s, it) => s + (it.subtotal || 0), 0);
    const rows = items.map((it) => `
      <tr>
        <td>${escapeHtml(it.name || '')}</td>
        <td class="num">${(Number(it.quantityUsed) || 0).toFixed(2)}</td>
        <td class="muted">${escapeHtml(it.unit || '')}</td>
        <td class="num">¥${(Number(it.priceSnapshot) || 0).toFixed(2)}</td>
        <td class="num">¥${(Number(it.subtotal) || 0).toFixed(2)}</td>
      </tr>`).join('');
    return `
      <div class="card">
        <div class="card-title">成本明细（M1.3 关联快照，下单即时定格）</div>
        <table class="cost-table">
          <thead><tr><th>物料</th><th class="num">用量</th><th>单位</th><th class="num">单价</th><th class="num">小计</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td colspan="4" class="num"><b>合计</b></td><td class="num"><b>¥${cost.toFixed(2)}</b></td></tr></tfoot>
        </table>
      </div>`;
  }

  /**
   * 物料选择器卡片
   * M1.5: 同步渲染时附首图占位，async hydrate 后由调用方写入 background-image。
   * @param {Object} material 物料记录
   * @param {boolean} selected
   * @param {number} qty
   * @param {boolean} inSelector
   */
  function renderMaterialPickerCard(material, selected, qty, inSelector) {
    const minQty = (material.type === 'pattern') ? 1 : 0;
    const stock = Number(material.quantity) || 0;
    const step = (material.type === 'pattern') ? 1 : 0.1;
    const stepAttr = `step="${step}"`;
    const stockHint = stock <= minQty
      ? `<span class="badge badge-warn">库存 ${stock.toFixed(2)}${escapeHtml(material.unit || '')}</span>`
      : `<span class="muted-small">库存 ${stock.toFixed(2)}${escapeHtml(material.unit || '')}</span>`;
    const cardCls = `picker-card ${selected ? 'picker-card-selected' : ''} ${stock <= minQty ? 'picker-card-low' : ''}`;
    const safeId = escapeHtml(material.id);
    const safeName = escapeHtml(material.name || '');
    const note = inSelector
      ? `<button class="btn btn-sm btn-link" data-act="picker-cancel" data-id="${safeId}">取消</button>`
      : '';
    const imgs = Array.isArray(material.images) ? material.images.filter(Boolean) : [];
    const coverId = imgs[0] || '';
    const coverEl = coverId
      ? `<div class="picker-card-thumb" data-picker-thumb="${escapeHtml(coverId)}" aria-hidden="true"></div>`
      : `<div class="picker-card-thumb picker-card-thumb-empty" aria-hidden="true">📦</div>`;
    return `
      <div class="${cardCls}" data-picker-id="${safeId}" data-picker-type="${escapeHtml(material.type)}">
        <div class="picker-card-head">
          ${coverEl}
          <label class="picker-check">
            <input type="checkbox" data-act="picker-toggle" data-id="${safeId}" ${selected ? 'checked' : ''} ${stock <= minQty && !selected ? 'disabled' : ''}>
            <span class="picker-name">${safeName}</span>
          </label>
          ${stockHint}
        </div>
        ${selected ? `
        <div class="picker-card-body">
          <label>用量
            <input type="number" data-act="picker-qty" data-id="${safeId}" min="${minQty}" ${stepAttr}
                   value="${(Number(qty) || step).toFixed(2)}" ${stock <= 0 ? 'disabled' : ''}>
            <span class="muted">${escapeHtml(material.unit || '')}</span>
          </label>
          ${note}
        </div>` : ''}
      </div>`;
  }

  /**
   * 异步把物料选择器卡片的首图加载到 DOM。
   * @param {HTMLElement} rootEl  选择器容器
   * @param {(imageId: string) => Promise<string|null>} loadImageFn  app.loadImage
   */
  async function hydratePickerCardImages(rootEl, loadImageFn) {
    if (!rootEl || typeof loadImageFn !== 'function') return;
    const placeholders = Array.from(rootEl.querySelectorAll('[data-picker-thumb]'));
    await Promise.all(placeholders.map(async (el) => {
      const imgId = el.getAttribute('data-picker-thumb');
      if (!imgId) return;
      try {
        const url = await loadImageFn(imgId);
        if (url) el.style.backgroundImage = `url(${JSON.stringify(url)})`;
      } catch (_) {}
    }));
  }

  /* ============ 导出 ============ */
  global.SS = global.SS || {};
  global.SS.components = {
    NAV_TABS,
    TYPE_ICON, TYPE_LABEL, SEASON_LABEL,
    GARMENT_STATUS, GARMENT_CATEGORY,
    renderBottomNav,
    updateHeader,
    bindBackButton,
    // M1.2 物料组件
    renderTabs,
    renderFilterChips,
    renderStars,
    renderMaterialCard,
    renderField,
    renderSheet,
    openSheet,
    renderUsageLogItem,
    renderImageUploader,
    // M1.1 占位
    renderEmptyState,
    renderPlaceholder,
    renderHeroCard,
    renderListCard,
    renderTestResults,
    // M1.3 成衣组件
    renderStatusBadge,
    renderCategoryLabel,
    renderGarmentCard,
    renderGarmentHero,
    renderCostBlock,
    renderMaterialPickerCard,
    // M1.5 新增
    hydrateGarmentCardImages,
    hydratePickerCardImages,
  };
})(window);