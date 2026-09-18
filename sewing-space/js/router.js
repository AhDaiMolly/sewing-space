/**
 * router.js · Hash-based 路由
 * 缝纫空间 M1.1 工程骨架
 *
 * 路由表与 PRD v6.0 §5.1 完全对齐（16 条路由）；
 * 模式匹配：'static' | 'param'（:id 单段参数）。
 *
 * 工作机制：
 *   1. 监听 hashchange + 拦截 <a href="#/..."> 点击；
 *   2. 解析当前 hash → 命中路由 → 调用对应 pages.renderXxx(root, params)；
 *   3. 同步更新顶部导航（标题 + 返回按钮）+ 底部导航高亮；
 *   4. 默认重定向到 `#/`，并对未命中路由走 404。
 */

(function (global) {
  'use strict';

  const P = global.SS.pages;
  const C = global.SS.components;
  const { log } = global.SS.utils;

  /* ============ 路由表 ============ */
  const routes = [
    { path: '/',                          handler: (r) => P.renderHome(r),         header: { title: '缝纫空间', showBack: false } },
    { path: '/materials',                 handler: (r) => P.renderMaterials(r, 'all'),    header: { title: '物料', showBack: false } },
    { path: '/materials/fabric',          handler: (r) => P.renderMaterials(r, 'fabric'), header: { title: '物料', showBack: false } },
    { path: '/materials/accessory',       handler: (r) => P.renderMaterials(r, 'accessory'), header: { title: '物料', showBack: false } },
    { path: '/materials/tool',            handler: (r) => P.renderMaterials(r, 'tool'),  header: { title: '物料', showBack: false } },
    { path: '/materials/pattern',         handler: (r) => P.renderMaterials(r, 'pattern'), header: { title: '物料', showBack: false } },
    { path: '/materials/new',             handler: (r) => P.renderMaterialDetail(r, 'new'), header: { title: '新增物料', showBack: true } },
    { path: '/materials/:id',             handler: (r, p) => P.renderMaterialDetail(r, p.id), header: { title: '物料详情', showBack: true } },
    { path: '/materials/:id/edit',        handler: (r, p) => P.renderMaterialDetail(r, p.id + '/edit'), header: { title: '编辑物料', showBack: true } },
    { path: '/garments',                  handler: (r) => P.renderGarments(r),     header: { title: '成衣', showBack: false } },
    { path: '/garments/new',              handler: (r) => P.renderGarmentDetail(r, 'new'), header: { title: '新增成衣', showBack: true } },
    { path: '/garments/:id',              handler: (r, p) => P.renderGarmentDetail(r, p.id), header: { title: '成衣详情', showBack: true } },
    { path: '/garments/:id/edit',         handler: (r, p) => P.renderGarmentDetail(r, p.id + '/edit'), header: { title: '编辑成衣', showBack: true } },
    { path: '/workbench',                 handler: (r) => P.renderWorkbench(r),    header: { title: '工作台', showBack: false } },
    { path: '/workbench/new',             handler: (r) => P.renderTaskForm(r, null),header: { title: '新建任务', showBack: true } },
    { path: '/workbench/:id/edit',        handler: (r, p) => P.renderTaskForm(r, p.id), header: { title: '编辑任务', showBack: true } },
    { path: '/stats',                     handler: (r) => P.renderStats(r),        header: { title: '统计', showBack: false } },
    { path: '/search',                    handler: (r) => P.renderSearch(r),       header: { title: '搜索', showBack: false } },
    { path: '/settings',                  handler: (r) => P.renderSettings(r),     header: { title: '我的', showBack: false } },
    { path: '/settings/profile',          handler: (r) => P.renderSettingsProfile(r),  header: { title: '个人信息', showBack: true } },
    { path: '/settings/backup',           handler: (r) => P.renderSettingsBackup(r),   header: { title: '备份', showBack: true } },
    { path: '/settings/github',           handler: (r) => P.renderSettingsGithub(r),   header: { title: 'GitHub', showBack: true } },
    { path: '/settings/sync',             handler: (r) => P.renderSettingsSync(r),     header: { title: '数据同步', showBack: true } },
    { path: '/settings/templates',        handler: (r) => P.renderSettingsTemplates(r),header: { title: '任务模板', showBack: true } },
    { path: '/settings/presets',          handler: (r) => P.renderSettingsPresets(r),  header: { title: '预设管理', showBack: true } },
    { path: '/settings/about',            handler: (r) => P.renderSettingsAbout(r),    header: { title: '关于', showBack: true } },
    { path: '/wizard',                    handler: (r) => P.renderWizard(r),       header: { title: '初始化向导', showBack: false } },
  ];

  /* ============ 路由匹配 ============ */
  function parsePath(pathname) {
    const segments = pathname.split('/').filter(Boolean);
    return segments;
  }

  function matchRoute(pathname) {
    const segs = parsePath(pathname);
    for (const route of routes) {
      const routeSegs = route.path.split('/').filter(Boolean);
      if (routeSegs.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < routeSegs.length; i++) {
        const r = routeSegs[i];
        const s = segs[i];
        if (r.startsWith(':')) {
          params[r.slice(1)] = s;
        } else if (r !== s) {
          ok = false; break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  /* ============ 渲染分发 ============ */
  async function renderCurrent() {
    const hash = global.location.hash || '#/';
    const pathname = hash.startsWith('#') ? hash.slice(1) : hash;
    // 路由匹配按 path 段进行，必须先剥掉 query（v1.1.1 P1-M2-1 修复）：
    //   如 #/materials/pattern?usage=used 不剥 query 会被错误匹配到 /materials/:id
    const path = (pathname.split('?')[0]) || '/';
    const matched = matchRoute(path);

    const root = document.getElementById('page-root');
    const nav = document.getElementById('bottom-nav');

    if (!matched) {
      C.updateHeader({ title: '404', showBack: true });
      C.bindBackButton(() => { global.location.hash = '#/'; });
      C.renderBottomNav(nav, '#/');
      P.renderNotFound(root, path);
      return;
    }

    const { route, params } = matched;
    log('路由命中', path, params);

    // 头部 + 底部导航
    C.updateHeader(route.header);
    C.bindBackButton();
    C.renderBottomNav(nav, '#' + path);

    // 渲染页面
    try {
      await route.handler(root, params);
      // 滚动到顶部
      root.scrollTop = 0;
    } catch (e) {
      console.error('渲染失败：', path, e);
      root.innerHTML = `
        <div class="placeholder-page">
          <div class="placeholder-icon">⚠️</div>
          <div class="placeholder-title">页面加载失败</div>
          <div class="placeholder-desc">${e.message || e}</div>
          <a class="btn btn-primary" href="#/" style="margin-top:16px;">回到首页</a>
        </div>`;
    }
  }

  /* ============ 启动 ============ */
  function start() {
    // 拦截所有内部 <a href="#/..."> 点击
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#/"]');
      if (a && a.getAttribute('href').startsWith('#/')) {
        // 浏览器原生 hash 跳转已经会触发 hashchange；无需 preventDefault
        // 但关闭"双击放大"体验
      }
    });
    window.addEventListener('hashchange', renderCurrent);

    // 兜底：若没有 hash，默认跳到 #
    if (!global.location.hash) {
      global.location.hash = '#/';
    } else {
      renderCurrent();
    }
  }

  global.SS = global.SS || {};
  global.SS.router = { start, renderCurrent, routes, matchRoute };
})(window);