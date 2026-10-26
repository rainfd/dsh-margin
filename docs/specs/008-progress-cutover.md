# 008 阅读进度、历史、缓存与运维切换

**状态：本地有界阅读进度/历史（宿主 + 界面）已实现；正文缓存与入口切换明确未实现（有意不做半成品）。**

## 前置条件

- 001 阅读器稳定可用（已实现）。
- 核验 DSH 持久化能力：已确认 `dsh-base` 默认挂载 `dsh-storage` / `dsh-storage-json` / `dsh-storage-domain`（见实施记录）。
- 明确进度只是观测增量，不得成为已读真源；Margin 的 `status` 仍由用户显式动作改变。

## 范围与非目标

范围：

- 阅读位置（滚动比例 / `scrollTop` / 章节提示）与“最近打开”，按 `实例 + candidate + 正文版本` 保存，有界、可清理。
- 目录从本次实际渲染的正文派生；进度条与回到原位置。
- 用户可明确清理本地历史；不清 Margin 数据。

非目标：

- **不实现正文缓存**（会把正文落盘，缺经确认的保留策略）。
- 不把滚动到底、打开文章、生成 AI 结果算作“已读”。
- 不停止 Margin 后端 / RSS 调度 / 采集队列 / 旧 Web；不做入口切换。
- 不采集延迟/命中率等运行指标，不把历史 232 篇等旧数据当现状。
- 不跨设备、不跨旧 Web 同步，不新增已读真源。

## API 核验需要

- 已核验：`ctx.storage`/`storage-domain` 是否存在（存在，但本插件不改依赖，理由见实施记录）；Margin candidate 详情是否暴露正文与更新时间（`content_md`/`content_text`/`updated_at` 存在，但 `updated_at` 会随状态变更而变，**不能**当正文版本）。
- 未核验 / 不做：Margin 是否提供正文 ETag 或版本号（没有）；断网缓存来源与时效（不实现缓存）。

## 验收与测试

已由自动化覆盖（`tests/progress.test.mjs` 11 项 + `tests/progress-ui.test.mjs`）：

- 键隔离：换实例、换正文版本、换 candidate 均不复用旧位置。
- `ratio: 1` 不产生任何读状态字段，进度路由模块不引用 Margin 写入能力。
- 上限 500 条、TTL 180 天、最旧淘汰、损坏/异形文件不产生假数据、`0600`。
- 单条与全量清理只影响本地；`marginUntouched: true`。
- 界面：正文改版后不套用旧位置；标签不宣称“已读完”；无 DOM 环境下阅读器仍可渲染。
- 清理：设置卡可一键清除本地进度，清除后已读状态与文章不受影响。
- 恢复只读取最近 100 行（宿主最多存 500），更早的位置不会被恢复——这是有意的查询上限。

未验收：真实浏览器滚动恢复精度、目录 TreeWalker 命中率、进度条布局与主题观感（测试环境无 DOM）。

## 实施记录

### 已核验的持久化前提

- DSH `@deepseek-ai/dsh-base` bundle 默认挂载 `dsh-storage` + `dsh-storage-json`（`root: ~/.dsh/storages`）+ `dsh-storage-domain`（`backend: json`）。因此宿主侧持久化能力存在，且**无需新增依赖**。
- `storage-domain` 的 `defineDomain` 需要 zod 记录 schema 与版本号；本插件已依赖 `zod`（经 `@deepseek-ai/schemastery` 的 peer 链可见），但没有为此新增包。
- **本规格没有采用 `ctx.storageDomain`**：见下方“为什么用文件而非 storage-domain”。

### 为什么用受限文件而不是 storage-domain

1. 进度是**可丢弃的派生观测**，不是需要 schema 迁移的业务数据；引入 domain 版本号会把“可丢弃”变成“必须迁移”。
2. domain 打开需要 `ctx.storageDomain` 为硬依赖，而进度功能必须能在 storage 未挂载的组合里静默降级——本实现正好如此（文件不存在即视为无进度）。
3. 文件路径可通过 `DSH_MARGIN_PROGRESS` 覆盖，测试无需真实 home；domain 的隔离域在测试中更难无副作用。

若将来需要跨进程一致性与 schema 升级，再迁移到 `storage-domain` 是可行的，届时进度数据可直接丢弃重建。

### 实现（`src/progress.ts` + `src/progressRoutes.ts`）

- 键为 `instance | candidateId | contentVersion`：换实例或正文改版都视为不同行，**不复用旧位置**。
- `contentVersion` 由调用方提供且不透明：插件不根据标题/长度自行编造版本，因为那会把旧位置静默套到新正文上。
- 记录字段：`ratio`（0–1 滚动比例）、`scrollTop`、`anchor`（章节提示）、`title`（≤300）、`openedAt`（首次打开）、`updatedAt`。**没有 `read`/`status` 字段**，`ratio: 1` 只表示滚到底，不表示读完。
- 有界：最多 500 条、TTL 180 天、单条标题/锚点裁剪；超出按 `updatedAt` 淘汰最旧。
- 原子写 + `0600`（标题是用户内容）；损坏/异形文件视为空，不“修复”出假数据；`ratio: 42`、负 `scrollTop`、非法 id、`bad` 时间戳均丢弃。
- 路由：`GET /api/dsh-margin/progress?limit=`、`POST /progress`、`POST /progress-clear`。**不需要任何写开关**，因为它不触碰 Margin；这不是权限漏洞，而是本地观测与内容写入的刻意分离。
- `progress-clear` 只删本地行，响应显式 `marginUntouched: true`。
- 进度路由模块**不导入 Margin 客户端**，测试断言其源码不含 `MarginClient`/`setCandidateStatus`，因此结构上不可能把“滚到底”写成已读。

### 测试

`tests/progress.test.mjs` 11/11：键隔离（实例/版本/id）、首次打开时间保留与位置更新、重启读取、`ratio:1` 不含读状态、换版不串位置、500 条上限与最旧淘汰、TTL 过期、损坏/异形文件、恶意字段裁剪、`0600`、单条与全量清理、路由参数校验与默认可用（无写权限）。

### 界面实现（`src/client/progressModel.ts` + `ArticleReader`）

- `contentVersion` 由正文（类型 + 长度 + 前 4096 字符）+ 标题算 FNV-1a 短串，**明确不是密码学摘要**；同长度且改动落在前 4096 字符之后的编辑检测不到，这是已知取舍。
- `tocFromMarkdown` 从 Markdown 源派生目录（ATX/setext，忽略围栏代码与行内代码，最多 200 条）；`index` 表示源字符偏移。
- `restorePlan` 只在版本一致、比例 > 0 时恢复，且始终标记为**近似**；版本不一致直接不恢复，绝不把旧位置套到改版正文上。
- 进度条在非文末最高显示 99%，到达文末时文案是“已到文末（未标记为已读）”，不会出现“已读完/已完成/100%”。
- 滚动保存经 `shouldPersist` 节流（默认 1%、5 秒），返回/卸载强制保存一次；保存失败只显示一次“位置未保存（仅本页有效，不会自动重试）”，不重试、不打日志。
- 目录点击用 `createTreeWalker` 在渲染容器中按 `h1..h6` 文本匹配后滚动；匹配不到则按源字符偏移等比滚动，并显式标注“近似”。所有 DOM 访问都有守卫，无 `document`/`window` 时阅读器仍可渲染。

`tests/progress-ui.test.mjs` 19/19：版本稳定性与变更、目录围栏/行内代码/上限、比例夹取与“一屏放得下”、节流规则、恢复拒绝条件与近似标记、标签不含完成字样、无 storage/URL、API 报文、无 DOM 与无 progress 面时渲染、只恢复一次且恢复不触发保存、节流保存载荷（实例+版本+比例+scrollTop）、版本不匹配不套用、保存失败只提示一次、目录折叠与近似回退、TreeWalker 命中、面只暴露三个方法。

### 明确未实现（不是遗漏）

1. **正文缓存**：会把文章正文落盘，属于隐私与保留策略决定；本规格要求“敏感内容遵循存储与保留策略”，目前没有经用户确认的策略，因此**不做**。断网时阅读器显示失败而不会展示陈旧正文，这比展示过期内容更诚实。
2. ~~进度清理 UI~~：已在插件设置卡提供“清除本地阅读进度”（显示当前条数、清除后说明 Margin 未受影响）。
3. **运维入口切换**：未停止 Margin 后端、RSS scheduler、采集队列或旧 Web；未修改任何运行中的 profile 配置。本插件新增入口并存，关闭即回退。
4. **能力矩阵**已补：[能力矩阵](../capability-matrix.md) 逐项列出可用/受控/默认关闭/未实现与旧 Web 替代路径。**运行指标**（延迟、失败率、缓存命中）仍未采集；不引用历史 232 篇/延迟/PID 等数据作为现状。
5. **跨设备同步**：进度仅本机文件，不跨旧 Web、不跨设备，也不作为已读真源。

### 回退

删除 `~/.dsh/dsh-margin-progress.json` 或关闭插件即彻底回退；不影响 Margin 文章、已读状态、高亮、笔记或 Trilium。无后端数据迁移，无 schema 升级。
