# AD-C 成衣库（成衣1-6）交付说明

输入基线：AD-B（sewing-space-ad-b.zip）。本棒范围：成衣库 6 项，不碰 PRD/数据模型/架构三份文档。

验证环境：沙箱 2C4G，Node + npm ci（中断后 `npm install --prefer-offline` 补齐），Chromium（Puppeteer 四视口 390/500/900/1280）。

- typecheck：`tsc -b` 退出码 0
- lint：`eslint . --max-warnings 0` 退出码 0，0 警告
- build：`vite build` 退出码 0（precache 19 entries）
- test:services：**1726 / 1726 全绿**（AD-B 基线 1695，净增 31 条断言，只增不减）

改动文件（与 AD-B 基线精确 diff，全量清单）：
`src/pages/GarmentsPage.tsx`、`src/pages/GarmentForm.tsx`、`src/pages/pickers/MaterialPickerPage.tsx`、`src/services/garmentService.ts`、`src/styles/styles.css`、`scripts/test-services.ts`。package.json 与基线逐字一致（cmp 通过）。

复现方法：Puppeteer harness（本地 http 静态服务器托管 dist + 页内 raw IndexedDB 种子注入：4 张 1×1 PNG（Uint8Array 落库形态）、4 个物料（含图红色面料 / 零库存蓝色面料 / 绿色纽扣 / M 码紫色纸样）、2 件成衣（completed ¥128.5 完工日期 2026-09-20 / in_progress）、presets 含 patternStyles:['马面裙','汉服']），四视口截图 + DOM 断言。修复前 before 10/10 按预期复现，修复后 after 6 项 bug 断言全部反转 + 4 项正向检查全过。

---

## 逐项：复现 → 根因 → 修复 → 验证

### 成衣1【需求】列表卡片不再展示成本

- **复现**：390/500/900/1280 视口成衣库列表，已完工卡片展示 `¥128.50`（garment-cost 块），未完工展示「未核算」。
- **根因**：GarmentCard 的 garment-info 内固定渲染成本块（totalCost != null → fmtCurrency；null → 「未核算」兜底），列表与详情都展示成本。
- **修复**：删除 GarmentCard 成本块与「未核算」兜底、页内 fmtCurrency 函数、styles.css 的 .garment-cost 规则。成本只在成衣详情（GarmentDetail 总成本区块）展示。
- **验证**：after 四视口截图卡片无 ¥ 符号（DOM 断言 costTexts 无 128.50）；测试断言 `!garmentsSrc.includes('garment-cost')` 等 2 条 + 详情仍展示 1 条。

### 成衣2【需求】去掉「已完工的成衣状态不能改为未完工」提示

- **复现**：编辑已完工成衣（#/garments/{id}/edit），状态只读 chip 下方出现提示文本，hint=true。
- **根因**：GarmentForm 状态区 `status === 'completed' && <p>…不能改回未完工</p>`——AA-E 已放开已完工编辑后该提示与实际行为矛盾。
- **修复**：删除该提示块。状态控件只读、状态机、P11 完工登记唯一状态变更入口等口径全部不动（AA-E 成衣编辑口径零回归）。
- **验证**：after 编辑页 hint=false；测试断言提示文本不存在 + STATUS_LABEL 只读 chip 仍在（2 条）。

### 成衣3【需求】新增/编辑成衣补「完工日期」

- **复现**：新增与编辑表单均无 date 输入、无「完工日期」标签（dateInputs=0）；编辑已完工成衣无法看到/修改完工日期。
- **根因**：GarmentForm 从未提供完工日期控件（S3 期注释明确「本版不提供完工日期控件」）；服务层 create/update 均将 completionDate 设为旁路防护键。
- **修复**：
  - 表单：新增「完工日期」date 输入，新增默认当天（todayIsoDate），编辑回填 g.completionDate；已完工成衣必填（空值提交拦截 + 出错聚焦）；可见口径：新增恒展示（保存即 completed，V-C 成衣Q3），编辑仅已完工成衣展示——未完工成衣的完工日期仍由完工登记 P11 写入，不在表单制造「未完工却有完工日期」的混合态。
  - 服务层：create/updateGarmentWithMaterials 各新增**独立可选参数** `completionDate`（不进 data 键，data 键旁路护栏语义原样保留，S5A2 断言未改）。校验复用 P11 口径：YYYY-MM-DD 格式 + 日历真实性（'2026-02-30' 拒绝）+ ISO 串截断取日期部分。create：completed + 显式日期落表单值，缺省仍服务层补当天（V-C 成衣Q3 口径不变）；非 completed 拒收非空值。update：仅 completed 成衣接受（未完工拒收、completed 空值拒）；**仅信息字段——不触发库存重算/快照重写/成本重算**（铁律4），AA-E completed 编辑的回滚重扣与成本重算仍由用料差集驱动。
- **验证**：数据级 7 组断言全过（显式日期落库 / 缺省补当天 / 未完工拒 / 非法日期拒 / 改日期成功且库存与 totalCost 逐值不变 / 清空拒 / 统计区间归属）；after 浏览器 dateInputs=1 且值正确；**排序与统计口径不回归**：列表排序比较器原样保留（AA-E 成衣2 断言未动全过），listCompletedGarmentsInRange 改期后 9 月区间含 / 10 月区间不含。

### 成衣4【bug】物料选择页图片全部加载不出来

- **复现**：新增成衣 → 去添加面料 → 物料 Picker 卡片仅占位图标，含图红色面料 0 张 blob 图渲染（blobImg=0）；**同一种子数据下纸样 Picker 图片正常**（img=1 loaded=1）。
- **根因（证据链）**：任务提示优先怀疑 AC 系 imageStorage 适配层（images 表 Uint8Array 落库）在 Picker 页读取路径的回归——**实证排除**：纸样 Picker 与物料 Picker 走同一 dbcore 适配层读取路径（db.images.get → imageRowFromStored 还原 Blob → URL.createObjectURL），真 Chromium 中纸样图片正常加载，证明适配层无回归。真正根因：**MaterialPickerPage 卡片缩略图只渲染占位图标 IconComp，从未实现图片渲染逻辑**（对照：物料库 MaterialCard 与 PatternPickerPage 均有 useLiveQuery + createObjectURL 图片实现，唯独本页缺失）。
- **修复**：为 MaterialPickerPage 补 useBlobUrl hook + MaterialPickerThumb 组件（有图渲染 `<img>` blob URL + objectFit cover，无图回落占位图标），与 PatternPickerPage/MaterialCard 同构。
- **验证**：after 物料 Picker blobImg=1 且 loaded=1（图片真实渲染）；纸样 Picker 一并复验正常；四视口截图对比。防回归断言（铁律5）3 条源码级断言随 test-services.ts 交付：useBlobUrl/createObjectURL 存在、MaterialPickerThumb 渲染调用、cover 填充。

### 成衣5【需求】款式下拉读预设

- **复现**：种子 presets patternStyles 含「马面裙」「汉服」，表单款式 chips 仍为代码预置 12 项（连衣裙/衬衫/…），不含「马面裙」。
- **根因**：GarmentForm 使用模块级常量 STYLE_PRESETS，未读设置。
- **修复**：款式 chips 改读 settings 单 'presets' 键 JSON 的 patternStyles 子键（与 MaterialForm AD-A 物料6 同源同口径，V-A Q7 键位口径）；空预设 / JSON 解析失败兜底代码预置清单 STYLE_PRESETS（与纸样侧兜底口径一致）。
- **验证**：after chips = ['马面裙','汉服']（预设生效）；测试断言读预设 + 兜底 2 条。

### 成衣6【需求】关联纸样自动回填尺码

- **复现**：选择 M 码紫色纸样后表单尺码输入框为空（size=''，patternSelected=true）。
- **根因**：handlePatternPickerSelect 仅 setPatternId，未回填尺码。
- **修复**：选中纸样时若纸样 size 非空则 setSize 回填；用户可再改（输入框仍可编辑）。
- **口径（notes 记录）**：本表单为**单纸样关联**（patternId 单值），「多纸样」场景不存在于本表单——更换纸样按新纸样尺码回填；纸样无尺码不覆盖当前值；清除纸样不清空已填尺码（用户已确认/已改的值不丢）。
- **验证**：after 选纸样后 size=M；测试断言回填逻辑 1 条。

---

## 同类问题修复清单（顺手修复，铁律2）

- **styles.css .garment-cost 规则**：随成衣1 成本块一并移除（死样式清理，同文件同类）。
- **GarmentForm 模块级 fmtCurrency**：仅被成本试算区使用，成衣1 不涉及本文件——未动（非同类，本文件 fmtCurrency 仍被成本统计区使用）。
- **test-services.ts 终局计数缺口**：发现 AD-A / AD-B / ADC 段在中途汇总（第 7965 行）之后执行，中途之后的失败不影响退出码（历史缺陷）。顺手在文件末尾补终局计数 + process.exit(1)——属测试基础设施修复，铁律5「全绿判定」依赖此行。

## 同类问题候选（超范围，不动）

- GarmentDetail 编辑入口无「完工日期」直达编辑（用户需进表单改）——详情页字段展示已存在，编辑入口属详情页改版范畴。
- PatternPickerPage 搜索含尺码维度而 MaterialPickerPage 不含（各有口径依据，PRD §8.8 / AA-D 口径，非缺陷）。

## 口径变更记录（铁律3，三份文档不动）

- **update/createGarmentWithMaterials 签名**：新增独立可选参数 completionDate（受控通道）。data 键三护栏（status/completionDate/totalCost 拒收）语义不变，S5A2 相关断言原样通过。与 DM §5.2「completionDate 只能由 P11 写入」的出入：本棒用户需求明确要求表单可编辑完工日期，通道隔离（独立参数 vs data 键）保持了旁路防护的原始语义。
- **编辑表单完工日期可见口径**：仅已完工成衣展示（新增恒展示）。未完工成衣仍走 P11 完工登记写入，避免制造混合态。
- 测试断言更新：AAE 段 1 条（「不能改回未完工」提示断言改为反向 + 只读双保险）——口径随成衣2 需求变更，非删减（总数 1695→1726 只增不减）。

## 测试基线

AD-B 基线 1695 → 本棒 **1726**（+31：ADC 段源码级 19 条 + 数据级 12 条/组，其中含成衣4 防回归断言 3 条）。中途汇总 1609/1610 计数不变；终局计数 1726/1726 全绿，退出码 0。

## 未验证项

- 真机 iOS/Android 浏览器（沙箱无真机）：图片渲染路径与桌面 Chromium 同构（blob URL），适配层已在 AC-A 真机验证过，风险低。
- GitHub Pages 实际部署（沙箱无法部署）：包结构（index.html + .github/workflows/deploy.yml + base '/sewing-space/'）与 AD-B 一致，构建产物 dist 本地四视口验证通过。
