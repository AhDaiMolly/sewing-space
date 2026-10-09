# sewing-space

面向个人裁缝/手作小团队的多人共编物料库 + 成衣记录 PWA（Progressive Web App）。
数据全部本地（IndexedDB），无需后端即可保存面料/辅料/工具/纸样 4 类物料，
记录成衣用料与成本，并对被使用的纸样做双向匹配推荐。

## 本地启动

```bash
npm install
npm run dev       # vite 本地服务（默认 5173；PWA base 在 vite.config.ts）
```

## 验证（CI 同款六道门槛）

```bash
npm run typecheck       # tsc -b（项目引用，0 错 0 警）
npm run lint            # eslint . --max-warnings 0
npm run build           # tsc -b + vite build → dist/
npm run schema:check    # tsx scripts/schema-check.ts → "schema ok"
npm run test:services   # tsx scripts/test-services.ts → "通过 N / N"
```

## 工程交付记录

- S2-FIX-1：物料库首轮修复（P0×3 全闭合、回归无回归）。
- S2-FIX-2：图片渲染基线、P1 修复与服务层补强。
- S2-FIX-3：图片 useRef→useState、ToastContainer 挂载、面料/辅料自定义标签展示。详见 `S2-FIX-3 修复说明.md`。