/**
 * 应用版本号（AA-B 设置4-c，用户 2026-09-30 验收口径；AF-A Q1 起构建期自动注入）。
 *
 * ┌─ 版本号规则（AF-A Q1 机制性修订）────────────────────────────────────────┐
 * │ 格式：发布日期 + 构建序号，形如 2026.10.01.7                              │
 * │   - 前三段：发布日期（年.月.日，月/日不足两位补零，东八区）                │
 * │   - 第四段：构建序号（GitHub Actions run_number，全局单调递增，           │
 * │     每次部署必然不同）；本地 / 无 CI 环境回落「日期.HHMM」时间戳          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * AF-A Q1 机制性修复：此前版本号是本文件的独立常量，靠人工每次部署前手改，
 * AE 系发布忘 bump → 关于页版本号不变 → 用户无法分辨部署是否成功。现改为
 * **构建期自动注入**：
 *   - .github/workflows/deploy.yml 在构建前把
 *     `SEWING_VERSION=<日期>.<github.run_number>` 写入环境变量；
 *   - vite.config.ts 用 `define` 把 `__SEWING_BUILD_VERSION__` 全局常量替换
 *     为该值（esbuild define 对 `typeof` 守卫同样生效，本地 tsx 直跑时
 *     `typeof 未声明变量` 安全返回 'undefined'，回落下方字面量）；
 *   - 本文件的字面量只作无构建步骤场景（tsx 直跑测试 / 本地 vite dev 未设
 *     env）的回落值，**不再需要每次部署手改**。改动涉及 vite.config.ts 与
 *     deploy.yml（package.json 未动），口径变更见 af-a-notes.md。
 *
 * 使用处：src/pages/SettingsPage.tsx（AboutSettings 版本行、设置主列表
 * 「关于」项 subtitle、设置页脚 settings-version）。
 */

/** 构建期注入的全局常量（vite define 替换；非构建环境为 undefined）。 */
declare const __SEWING_BUILD_VERSION__: string | undefined;

/** 构建期注入的版本号；无构建步骤时为 undefined（回落本地常量）。 */
const injectedVersion: string | undefined =
  typeof __SEWING_BUILD_VERSION__ !== 'undefined'
    ? __SEWING_BUILD_VERSION__
    : undefined;

/** 当前应用版本号：构建期注入优先；回落常量 = AF-A 发布日期（2026-10-01）。 */
export const APP_VERSION: string = injectedVersion || '2026.10.01.1';
