# AC-A 恢复/导入图片写入失败排查修复（sewing-space bug 修复 AC 系第 1 棒）

- 基线：sewing-space-ab-a.zip（AB 系最终包）
- 现场：09-30 11:15 电脑推送备份到 GitHub 成功；iPhone（iOS 26.x）「从 GitHub 恢复」/手动导入报
  「恢复未完成，请重新导入（images.bulkPut(): 246 of 246 operations failed. Errors: UnknownError: Error prep…）」；
  数据只导入一部分（无 Blob 的表全部成功），图片 246/246 全部失败。
- 交付：sewing-space-ac-a.zip（本包）

## 1. 复现

- 解包用户真实备份包 sewing-space-backup-20260930-0312.zip：data.json formatVersion 4，
  materials 221 / garments 35 / tasks 0 / taskTemplates 0 / usageLogs 160 / images 246 行，
  images/ 下 246 个独立图片文件（jpg）。**包内数据形态无恙，不是导出侧问题。**
- 沙箱（Node + fake-indexeddb，非 WebKit 引擎）用同一备份包走同一导入路径
  （parseBackup → applyRestore → images.clear() + bulkPut）：**246/246 全部成功**，
  字节级完整性 checked=246 / mismatch=0，重复导入幂等。
- 报错截断复算：`images.bulkPut(): 246 of 246 operations failed. Errors: ` 恰 60 字符，
  `UnknownError: Error preparing Blob/File data to be stored in object store` 是 WebKit
  IndexedDB 写 Blob 的标准错误全文；旧代码 `reason.slice(0, 80)` 截断后得到
  「…UnknownError: Error prep」——与用户报错**逐字一致**（测试段已锚定该断言）。

## 2. 根因（证据链）

**iOS WebKit IndexedDB 写入 Blob 的引擎缺陷（WebKit Bug 188438 / 268037）**，触发条件是
「记录含 Blob 且写入量较大」，报错固定出现在「Error preparing Blob/File data」阶段。证据链：

1. **失败面 = 唯一含 Blob 的表**：materials/garments/usageLogs 等无 Blob 的表全部成功，
   images 表（唯一 Blob 列）246/246 全失败——排除数据内容、Schema 校验、zip 解析问题。
2. **同一包在非 WebKit 引擎全部成功**：排除备份包编码形态、Dexie 结构化克隆、配额问题
   （配额错误是 QuotaExceededError，非 UnknownError）。
3. **报错全文与截断点逐字吻合**（见上）：UnknownError + "Error preparing Blob/File data"
   是 WebKit 在「准备 Blob 数据」（落临时文件/跨进程传数据）阶段的固定报错。
4. **WebKit 已知行为**：Bug 188438/268037 长期存在，iOS 26.x 仍有社区报告（2026-07），
   影响「向 IndexedDB 写含 Blob 的记录」。

不确定性说明：沙箱无法运行 iOS Safari，未在真机直接复现引擎级报错；根因由
「包内数据形态 + 导入代码路径 + 报错文本逐字复算 + WebKit 已知行为」四重证据锁定。
修复原理（改为不经过 Blob 路径的写入形态）与该根因一一对应。

## 3. 修复

### 3.1 核心修复：images 表落库形态改为字节（绕开 WebKit Blob 路径）

- 新增 `src/db/imageStorage.ts`：Dexie dbcore 中间件（level 50），仅作用于 images 表——
  - **写入**（mutate: add/put）：`blob: Blob` → `Uint8Array`（内联序列化，结构化克隆不经过
    WebKit 的 Blob 临时文件/网络进程路径）；
  - **读出**（get/getMany/query）：`Uint8Array` → 还原 `new Blob([bytes], { type: mimeType })`，
    全部既有消费方（URL.createObjectURL / arrayBuffer）零改动；
  - **存量兼容**：读出遇到 Blob 形态旧行原样透传（不报错、不丢数据）。
- `src/db/schema.ts` 构造器安装适配层。**适配层在 db 实例层生效，images 表所有写入路径
  全部受益**：恢复/手动导入（applyRestore）、拍照/选图新增（imageService.addImage）、
  legacy 迁移（db/migrations/import.ts）——同根因一次修复，非范围外改动。
- 事务原子性实证（诊断实验 + fake-indexeddb + Dexie 4.4.6）：中间件内的原生异步
  （Blob.arrayBuffer()）不破坏 db.transaction 原子性，put 在前/在后两向验证均原子。

### 3.2 健壮性：分片 + 降级 + 中文提示（backupService.ts）

- 新增 `putImageRowsResilient`：分片 bulkPut（`IMAGE_PUT_CHUNK_SIZE = 25`）控制单事务体量；
  整批失败 → 逐条 put 降级；逐条仍失败 → 记入 failedIds，**只跳过不拖垮**。
- `RestoreReport` 新增 `failedImages`；`failedImages > 0 → status 'partial'`，
  restore 日志 message：「…N 张图片保存失败，已跳过，可重新导入」。
- 新增 `describeRestoreFailure`：WebKit Blob 错误 →「当前浏览器无法把图片写入本地数据库
  （iOS Safari 的已知兼容问题），请退出无痕模式或完全重启浏览器后重试；仍失败时请改用电脑导入」；
  配额 →「存储空间不足，请清理浏览器网站数据后重试」；其余保留原始信息（截断 120 字）。
  `importBackupFile` 失败提示改用该转述（不再只暴露英文底层错误）。
- `SettingsPage.tsx` 恢复 toast 对部分失败给出中文警告（含可重新导入指引）。

## 4. 验证

- **测试全绿：1609 / 1609**（基线 1561 + 新增 48，只增不减）；typecheck、lint（--max-warnings 0）通过。
- 新增断言 5 组（test-services.ts AC-A 段）：
  0) 证据链锚定（用户截断报错逐字复现）；
  1) 存储形态（原生 IndexedDB 直读落库为 Uint8Array、字节一致；get/where/bulkGet 读出还原
     Blob；put 覆盖路径同样转换）；
  2) 存量兼容（Blob 形态旧行读出透传、字节一致）；
  3) 用户同形态备份包（v4 + images/ 文件，jpg/png/webp）：解析 3/3、全链路恢复 3/3、幂等、
     重新导出 images/ 字节一致、data.json 图片行不含 blob/syncedAt 键（**导出格式不变**）；
  4) 降级路径（注入引擎级失败中间件，模拟 WebKit 同款错误）：导入不抛错、3 成功 +
     2 failedImages + partial + images 表恰 3 行 + restore 日志含中文警告；卸载注入后
     重新导入 5/5（「可重新导入」承诺成立）；
  5) 常量与文案（分片区间、describeRestoreFailure 三分支、imageRowFromStored 三形态、
     空数组、UI/源码级断言）。
- **真实备份包全链路复跑**（修复后）：246/246 落库、status success、failedImages 0、
  字节完整性 246/246（mismatch=0）、重复导入幂等（仍 246 行不重复）。

## 5. 同类问题候选（仅记录，未改动）

- iOS Safari 上「下载备份导出文件」（Blob → a[download]）与「分享」路径的兼容性未验证，
  与本根因同属 WebKit Blob 处理域。
- 拍照/选图新增路径虽已随适配层修复，但 iOS 相机大图（>10MB）的内存峰值未测量。
- GitHub 拉取（restoreFromGithub）与手动导入共用 applyRestore，已随本修复受益；但
  iOS 上 zip Blob 的解包内存占用未测量。

## 6. 口径变更记录

- **images 表物理落库形态：Blob → Uint8Array**（逻辑类型 `ImageRecord.blob: Blob` 不变，
  读出仍为 Blob；导出格式不变；旧包/旧行 Blob 形态读出透传兼容）。属实现层序列化形态
  调整，三份文档（PRD/数据模型/架构）未改；数据模型文档如需注明「物理存储为字节」，
  留待下一棒决定。
- 其余无口径出入。

## 7. 测试基线数

- 基线（AB-A 交付）：1561 条 → 本包：**1609 条**（新增 48，全绿）。

## 8. 未验证项

- **iOS 真机验证（最重要）**：沙箱无法运行 iOS Safari/WebKit，引擎级修复效果未在真机
  验证。请用户在 iPhone 上复验「从 GitHub 恢复」或手动导入 sewing-space-backup-20260930-0312.zip，
  预期：246 张图片全部恢复、status success；若个别失败应看到中文警告且可重新导入。
- Safari 桌面版（同 WebKit 内核）未实测。
- iOS 无痕模式下 IndexedDB 持久性行为（文案已给出指引，但未实测）。
