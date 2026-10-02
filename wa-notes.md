# W-A 棒验收记录：备份恢复 Load failed 排查 + 设置5/设置7 取证回答

基线：sewing-space-v-ios.zip（file-token HXfkbaxIIo1PWWxpJGjcPUIonEK），自测基线 1162 条全绿。
本棒改动文件（对基线 diff 逐字节核实）：仅 `src/services/githubService.ts`、`scripts/test-services.ts` 两个文件；`package.json` 与基线逐字节一致。V 系改动未触碰 backup 模块（diff 核实：V-D 只改 HomePage.tsx，V-IOS 只改图标）。

---

## 设置2【疑似真 bug】：备份页「从 GitHub 恢复」提示 Load failed —— 已复现、已修复

### 结论

**真 bug，已复现并修复。** 根因：Safari 的网络层错误（fetch 及 `res.json()` / `res.arrayBuffer()` 读取响应体失败）抛出的是 `TypeError: Load failed`；基线代码只对 `fetch()` 调用本身做了 `.catch(classifyNetworkError)` 包裹，**响应体读取这一步没有被包裹**。iOS Safari 在弱网/切后台/代理环境下经常出现「响应头已到、body 中途断流」，此时恢复流程在读取备份 zip 二进制（`downloadBackupZip` 的 `res.arrayBuffer()`）或读取仓库信息 JSON 时抛出裸 `TypeError`，一路穿透到设置页 toast，用户看到的正是直出的英文原文「导入失败：Load failed」。

### 复现证据（诊断脚本 wa-repro.ts，仅本地诊断用、未随包交付）

在基线代码上模拟 3 种 Safari 断流场景（拉取① GET /repos body 读 JSON 断流；拉取② 下载 zip 的 arrayBuffer 中途断流；fetch 本身失败对照组），均得到：

- UI toast 文案 = `导入失败：Load failed`（英文原文直出，复现用户截图文案）
- backupLogs = `Github 拉取失败（未知）：Load failed`（说明异常被 backupService 的「未知异常」兜底分支捕获，未经分类）

修复后同一脚本重跑：三场景全部变为中文提示「网络连接中断，请检查网络后重试」、日志归入网络中断类，英文文案零泄漏。

### 修复内容（githubService.ts）

1. **新增两个响应体安全读取包装**：
   - `readJsonSafe(res, context, verb)`：body 读 JSON 失败时，`TypeError`/`AbortError` 归 `classifyNetworkError`（网络中断中文提示），其他解析错误归「GitHub 返回了无法解析的响应，请稍后重试」（可重试）。
   - `readArrayBufferSafe(res, verb)`：zip 二进制读取失败统一归 `classifyNetworkError`。
2. **堵住全部 5 处泄漏点**：推送路径 2 处（查询仓库、PUT 201 后读 sha）+ 拉取路径 3 处（listRemoteBackups 列备份、readDefaultBranchOf 查仓库、downloadBackupZip 读 zip 二进制 ← 用户最可能踩中的路径）。
3. **顺带修正日志动词**：拉取路径的网络失败日志原来误写成「Github 推送失败」，现按路径区分为「拉取」。
4. **顺带检查项结论**：用户可见文案现在全部保证为中文——所有响应体读取失败都会被转成 `GithubServiceError`（含中文 userMessage），设置页 `err instanceof GithubServiceError` 分支正常走中文提示；不会再有原生英文直出。

### 回归自测

test-services.ts 新增 W-A 段共 **20 条断言**（设置2 归类 7 项 + 设置5 全路径 13 项），全套 `npm run test:services` **1182/1182 全绿**（基线 1162，只增不减）。

---

## 设置5【疑问】：预设管理删除品牌并备份后，下次这个品牌还会出现吗

### 一句话答案

**不会。** 删除品牌 → 备份 → 换设备/刷新后恢复，已删除的品牌不会重新出现——唯一例外是恢复「删除之前」生成的旧备份，那属于备份恢复的「时间机器」语义（整包覆盖回当时状态），是有意设计。

### 机制说明（四点均有测试断言覆盖）

1. **备份包含 presets 当前状态**：`exportBackup` 导出的 settings 里带 `presets` 键，内容是导出时刻的预设现状（已删品牌不在其中），测试断言了导出 zip 的 presets 中已无该品牌。
2. **恢复是覆盖不是合并**：`presets` 属于 `RESTORE_FROM_ZIP_KEYS`，恢复时用备份值直接 `put` 覆盖本机值——本机残留的默认预设不会把品牌合回来。
3. **seed 不会复活已删品牌**：`seedIfFirstRun` 只在 `onboarding_completed` 缺失（真正首次启动）时才写预设；该键属于 `RESTORE_PRESERVE_KEYS`，恢复流程不会动它。所以「恢复过数据的设备」永远不是首启，刷新页面 seed 零写入。测试实测：删除品牌 → 恢复备份 → 再跑一次 seedIfFirstRun → 品牌仍未复活。
4. **旧备份恢复例外属预期**：恢复「删除前」的备份会把品牌带回（实测确认），这是备份恢复作为时间机器的正确语义——用户换设备时用旧包恢复，回到的是生成那份备份时的习惯配置。PRD 对备份恢复的定位即整包状态搬运。

---

## 设置7【疑问，文档取证】：关于页「数据同步：同步功能开发中」是做什么的

### 回答要点（供主 AD 回复用户，不改代码、不改文档）

1. **功能定位**：这是一个**有意的占位功能**（PRD §12.5「数据同步（占位）」）。作用是在关于页明确告诉用户：本产品规划了多设备数据同步能力，同时如实告知现在还没有上线——避免用户误以为已支持而踩坑。
2. **和 S6 GitHub 备份恢复的区别**：备份/导出是**用户手动、单向、整包**的数据搬运（下载 zip / 推到 GitHub 仓库，恢复时整包覆盖）；「数据同步」规划的是**多设备间自动/双向**的数据一致性。在零账号、零自建服务端的架构约束下（PRD §1.5 明确「手动同步（跨设备）」属于本版出界项），跨设备同步本版明确不做，数据搬运现阶段完全靠 S6 的备份/导出手动完成。
3. **后续计划**：PRD 未排期。代码里保留了三个占位 settings 键（`last_sync_at` / `last_sync_remote` / `dirty_since_sync`）但当前没有任何写入路径，是给未来同步功能预留的状态位。
4. **既有实现偏差（记录供裁决，未改动）**：当前关于页实现展示了「上次同步时间 / 上次同步目标」两行 + 按钮「同步功能开发中…」，与 PRD §12.5 描述的「设备标识一行 + 固定说明文案」存在口径偏差；两行展示的值在无写入路径的情况下永远为空，建议后续迭代对齐 PRD 或修订 PRD 口径。

---

## 口径变更记录

1. **错误提示统一中文**（设置2 顺带检查项，已落实）：iOS Safari 网络层原生文案（如 `Load failed`）不再直出用户，统一转为中文用户可懂提示（「网络连接中断，请检查网络后重试」等）。S6-C 原八类错误处理不变，本次只是补上「响应体读取失败」这一漏网类别。
2. **日志动词修正**：拉取（恢复）路径的网络失败日志由误标「推送」改为「拉取」，便于线上按路径排查。
3. **待裁决偏差**：关于页数据同步卡片展示形态与 PRD §12.5 的偏差（见设置7 第 4 点），本棒未改动。

---

## 自测与门槛数据

| 项 | 结果 |
| --- | --- |
| typecheck | 0 错误 |
| lint | 0 错误 0 警告 |
| schema:check | 通过 |
| build | 成功（PWA 预缓存 19 项） |
| test:services | **1182/1182 全绿**（基线 1162，新增 20，只增不减） |
| 改动面 diff | 仅 githubService.ts + test-services.ts，package.json 与基线逐字节一致 |
| PAT 扫描 | 随包文件按既往口径全量扫描，无任何真实凭据字样（命中项仅为既往棒 notes 中对扫描规则本身的文字引用，与 V-IOS 基线包一致） |

**本棒有代码改动：下游请改用 sewing-space-w-a.zip 作为新基线。**
