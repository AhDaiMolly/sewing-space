# AJ-A 反馈修复说明（Q1 大包推送 401 · P0 / Q2 导入兼容包装目录 · P1）

对应任务：AJ-A。基线：AI-A 包（sewing-space-ai-a.zip）。本文所有结论均对应本包内源码实测，命令与退出码见 §8。

---

## Q1（P0）新令牌仍偶发 401 Bad credentials —— 大包推送机制改造

### 1.1 根因收敛过程

用户反馈：换新令牌后推送仍偶发 401 Bad credentials，同一时段重试也失败。诊断截图（AJ-Q1推送401诊断截图.jpg）实锤了关键事实：

- 同一推送序列里，**前置的 GET（查仓库）用同一令牌成功返回 200**；
- 紧接着的 **38.4MB 备份包 PUT 上传返回 401 Bad credentials**；
- 11:16 / 11:17 连续两次推送均失败，重试无效。

核实代码：当时的推送实现是 REST Contents API（`PUT /repos/{owner}/{repo}/contents/backups/<file>`）单文件整包上传——38.4MB 的 zip 经 base64 编码后请求体约 51MB。GitHub 官方文档明确建议超过 1MB 的内容走 Git Data API（blob → tree → commit → ref）。50MB 级单请求在 GitHub 边缘节点 / 网络中间层被偶发拒绝时，会统一以 401 Bad credentials 的形式返回——**这不是令牌问题**（真无效的令牌在第一步查仓库就会 401），证据链与现场截图完全吻合。

AI-A Q3 已做过「症状缓解」（401 落在后段 + 前步已成功 → 文案改写为「疑似大包上传的偶发拒绝，请直接重试」），但只要 50MB 单请求还在，偶发拒绝本身就还在。AJ-A 做机制性修复。

### 1.2 Git Data API 推送改造（机制性修复）

推送写路径整体重写为 Git Data API 流程（src/services/githubService.ts）：

1. **查仓库**（GET /repos/{o}/{r}，读 default_branch，不变）；
2. **同名冲突检查**（双路径）：对每个候选名同时检查 `backups/<name>` 与 `backups/<name>.part001`（新分片组第一片）——任一存在即视为占用，防止仓库里出现「旧单文件 zip 与新分片组同名并列」的歧义；
3. **分片上传 blob**：`shardZipBytes()` 把 zip 字节切成 ≤10MB 的分片（`GH_SHARD_BYTES = 10 * 1024 * 1024`），每片单独 `POST /git/blobs`（content=base64）。**单请求体从 51MB 降到 ≤13.7MB**（10MB × 1.37 base64 膨胀）。blob 按内容寻址幂等：同一片重传返回同一 sha；
4. **组 tree**：`POST /git/trees`，带 `base_tree` = 基线 commit 的 tree sha（**必须显式带上**，不指定会整树替换、丢掉仓库里其余文件），tree 条目为 `backups/<name>.part001 … .partNNN`（三位零填充，按序）；
5. **建 commit**：`POST /git/commits`，message / tree / parents=[基线 commit]——快进链不断，GitHub Pages 部署不受影响；
6. **更新 ref**：`PATCH /git/refs/heads/<branch>`；返回 422/409（non-fast-forward，并发推送冲突）时重读 ref 重建 tree/commit 再更新，最多 3 轮（**blob 不必重传**——冲突重试的成本大幅降低）。

分片口径：80MB 备份上限最多 8 片；空包落 1 个空片（不落 0 片）。测试断言了 10MB 恰整除 → 1 片、10MB+5 字节 → 2 片（尾片 5 字节）、80MB → 8 片、各片按序拼接还原原字节。

### 1.3 恢复侧同步改造（兼容旧格式）

- **列表聚合**（listRemoteBackups）：仓库里的 `backups/<name>.partNNN` 按 `<name>` 聚合成一条（name=组名、size=各片之和、sha=part001、parts=片数）；分片必须从 001 连续到 N 才入列，缺号的组跳过（按序拼接必得坏包，宁可少列也不给必然失败的条目）；**旧单文件 zip 原样保留（parts 缺省），旧仓库无缝兼容**；
- **分片下载拼接**（downloadBackupZip）：parts > 1 时逐片按序下载、内存拼接成完整 zip 再走原校验门；parts 缺省（旧格式）仍单文件整包下载；
- **拉取编排**（fetchLatestGithubBackup）：透传 parts 给下载侧。

### 1.4 日志展示优化

备份记录列表里长错误文案（含【诊断 …】串）此前截断显示不全。现改为：

- 列表行内**一行摘要**（CSS `text-overflow: ellipsis` 单行截断）；
- 超过 48 字符或含【诊断串】的条目出现「展开」开关，**展开看完整诊断全文**（`pre-wrap` 保留换行），附**一键复制**按钮（navigator.clipboard，复制失败有 toast 提示）；
- 推送成功日志新格式：`已推送到 main：sewing-space-backup-xxxx.zip（N 片，commit abc123）`——分片数与 6 位 commit 都可见。

### 1.5 长期方案（只列建议，未实施）

- **增量备份**方向：当前每次全量 zip（图片占大头）。可行路径是按「图片按内容 hash 寻址、只在首次上传时传 blob（blob 幂等天然去重），data.json 仍每次全量但只有几十 KB」改造——仓库里永不重复存图片，推送量从 38MB 级降到 KB 级。涉及备份文件布局与恢复协议的双端改造，建议作为独立需求排期；
- Git Data API 的 blob 内容寻址特性是增量方案的天然基础（本次改造已把分片落成 blob，后续演进不用再动上传层）。

---

## Q2（P1）手动改包后导入报「备份文件里没有 data.json」

### 2.1 根因

用户从 GitHub 下载备份包、手动改 data.json 字段、重新压缩后导入失败。核实用户实际提供的包（39.7MB、267 个条目）：整个内容被包了一层顶层目录 `sewing-space-backup-20261009-0326/`（macOS Finder「压缩」默认行为）。旧实现只认 zip 根目录的 `data.json`，定位不到即报「没有 data.json」——文案与真实原因（多包了一层目录）不符。

### 2.2 修复（parseBackup 第 2 道门重写）

- **递归定位唯一的 data.json**（不限层级）：收集 zip 内所有名为 data.json 的文件条目（排除目录条目）；
- **0 个** → 报错写明 zip 顶层实际结构（最多 5 项）+ 期望形态：「备份文件里没有 data.json（zip 顶层是：xxx、yyy/；期望 data.json 直接在 zip 根目录或唯一子目录里。如果你是从 GitHub 下载或手动重新压缩的，请检查是否多包了一层目录，或压缩时选错了层级）」——用户能对照自查；
- **多个** → 报数量与全部路径：「备份文件里有 2 个 data.json（data.json、sub/data.json），无法判断该用哪个——请删掉多余的一个再导入」；
- **唯一** → 采用之，`images/` 目录相对 data.json 所在目录解析（根目录包行为与旧版完全一致）；
- **JSON 改坏** → 报「data.json 不是合法的 JSON」（指向解析错误），不再误报「没有 data.json」。

### 2.3 用户包全链路实测（scripts/aj-a-user-pkg-test.ts）

用用户提供的真实备份包跑 `importBackupFile` 全链路 + 幂等二跑，**全部通过**（详见 §8 命令 4）：

- 导入成功，行数与包内一致：materials 236 / garments 39 / tasks 5 / taskTemplates 2 / usageLogs 235 / images 265；
- backupLogs 按产品口径为本机独有、不随包恢复（每导入一次追加 1 条本次 restore 日志，二跑后 2 条）；
- 幂等二跑：业务表行数与首跑完全一致，无重复落库；
- 用户手改的 data.json 为合法 JSON，每一行都通过了 zod 行级校验并落库（无参照版本可比对改的是哪个字段，但全量校验通过 = 改后的值合法入库）。

---

## 同类问题修复清单

| 问题 | 位置 | 修复 |
| --- | --- | --- |
| 诊断串源码断言用旧字面量「【诊断」导致测试误报 | test-services.ts AJA-Q1-6 | 改为断言 `` `诊断 ${hhmmss}` `` 拼装处 |
| ⑤-4 段 commit sha 读取重复消费 Response body 的隐患 | githubService.ts ⑤-4 | readJsonSafe 一次读取后从 body.sha 取值，删除二次读取路径 |

## 口径变更记录

| 口径 | 旧 | 新 | 依据 |
| --- | --- | --- | --- |
| 推送写路径 | Contents API 单文件整包 PUT | Git Data API：分片 blob → tree(base_tree) → commit → PATCH ref | AJ-A Q1.2（>1MB 走 Git Data API 为 GitHub 官方建议） |
| 备份在仓库内的落点 | `backups/<name>.zip` 单文件 | `backups/<name>.zip.part001 … .partNNN`（≤10MB/片） | 同上 |
| 推送成功日志格式 | `已推送到 main：xxx.zip（commit abc123）` | `已推送到 main：xxx.zip（N 片，commit abc123）` | 日志含分片数便于核对 |
| 并发冲突形态 | Contents PUT 409 | PATCH ref 422/409（non-fast-forward），整段重试 ≤3 轮且 blob 不重传 | Git Data API 语义 |
| parseBackup 第 2 道门 | 只认 zip 根目录 data.json | 递归定位唯一 data.json，images/ 相对其所在目录解析 | AJ-A Q2.2 |

数据模型（W23…）、PRD（A3gu…）、架构（TyXT…）未改动。

---

## 实测命令与退出码（本包内源码）

| # | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| 1 | `npx tsc --noEmit -p tsconfig.json` | 无错误 | 0 |
| 2 | `npx tsx scripts/test-services.ts` | 通过 2011 / 2011（基线 1947，+64，只增不减） | 0 |
| 3 | `npm run build`（tsc -b && vite build） | 构建成功，dist 产物完整 | 0 |
| 4 | `npx tsx scripts/aj-a-user-pkg-test.ts <用户包.zip>` | 用户包全链路导入 + 幂等二跑全部通过 | 0 |
| 5 | 最终 zip 解压新目录复跑 1/2/3 | 全绿 | 0 |
| 6 | `grep -rE '(ghp_\|github_pat_)[A-Za-z0-9]{20,}'`（全包，排除 node_modules/package-lock.json） | 零命中 | 1（无匹配） |
| 7 | `diff package.json <基线 package.json>` | 逐字一致 | 0 |

测试新增 42 条（AJA-Q1/Q2 前缀）：分片口径单元（空包/整除/非整除/80MB→8片/拼接完整性）、多分片推送（blob 次数=片数、tree 条目按序 part001→002、base_tree 保留既有文件）、Git Data API 失败分类（blob 401/403、tree 403、commit 404、PATCH 422 重试 blob 不重传、PATCH 409×3 用尽、GET ref 404、blob 422 too_large）、恢复侧聚合（分片组/缺号组跳过/旧格式并存/同名取分片组/降序）、分片下载拼接还原原字节、fetchLatestGithubBackup 透传 parts、日志展开组件源码断言、Q2 三形态（包装目录成功/多 data.json 拒绝/无 data.json 新文案/JSON 改坏指解析错误）、包装目录全链路导入图片落库。

## 真机验证建议

1. **大包推送**：真机产生 >10MB 的备份（拍十几张照片即可），推送后到 GitHub 仓库确认 `backups/` 下出现 `.part001/.part002…` 分片文件，且历史 commit 链连续（parents 指向前一提交，Pages 部署正常）；
2. **恢复闭环**：在另一台设备（或清缓存后）拉取恢复，确认分片列表聚合为一条、恢复后数据与图片完整；
3. **旧仓库兼容**：若仓库里还有旧格式单文件 zip 备份，确认列表正常显示（无 parts 标记）且能正常下载恢复；
4. **日志展开**：设置页备份记录里找一条长错误文案，点「展开」看完整诊断、点复制后到输入框粘贴核对全文；
5. **手动改包导入**：从 GitHub 下载 zip → 解压 → 改 data.json 某字段 → Finder 右键压缩（会产生包装目录）→ 导入，应成功。

---

AJ-A 交付物：sewing-space-aj-a.zip（本包）+ 本说明（aj-a-notes.md）。
