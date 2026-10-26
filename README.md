# dsh-margin

把 **Margin**（阅读内容仓）接入 DSH —— 待读列表、单条详情，以及设置页配置卡。

**当前阶段：默认只读的阅读工作台。** 列表内点击「阅读」按需加载 Markdown 正文，缺失时降级为纯文本；支持状态、来源、搜索和分页。打开文章不会自动标记已读。仅显式启用写能力后，界面和 agent 才可按用户动作设为已读/未读；URL/PDF 导入另需各自开关，202 仅表示已接受。保存到 Trilium 是唯一的 Trilium 写入路径，由 Margin 自己的保存接口执行，默认关闭。

## 分阶段迁移

迁移按独立 spec 推进，依赖、验收标准和进展见 [实施路线](docs/specs/README.md)。保留 Margin 后端作为内容与阅读状态唯一真源，先统一 DSH 内的使用入口，不重写采集引擎或迁移数据库。

第一阶段只实现正文阅读；已读操作、导入、订阅管理、AI、Trilium 沉淀、划线批注和阅读进度各自独立验收。

## 它解决什么

原来的架构里，内容在 Margin、任务在 Trilium，两边互不知道，所以需要一个跨系统对账器事后猜状态。
这个插件把 Margin 的**读**能力搬进 DSH：会话里可以直接问「我有什么待读的」，侧边栏能看到队列，
不用切应用。**已读/未读写能力默认关闭；自动建任务尚未实现。**

## 双半结构

| 半 | 位置 | 职责 |
|---|---|---|
| host（Node） | `src/index.ts`、`margin.ts`、`routes.ts`、`store.ts`、`tools.ts` | Margin HTTP 客户端、`/api/dsh-margin/*` 路由、`margin_*` agent 工具 |
| client（浏览器） | `src/client/*` | 侧边栏「待读」面板 + 插件详情页配置卡 |

参照 dsh-trilium 的既有模式：精确路由由 DSH Connection 校验 Host/Origin 与浏览器会话，支持已认证的远程 GUI；`~/.dsh/dsh-margin.json`（0600）存凭据，浏览器侧永远看不到 token（只看到 `tokenSet`）。

## 配置

`~/.dsh/dsh-margin.json`（0600，也可在 设置 → Margin 里改）：

```json
{
  "baseUrl": "http://8.134.185.171:3000",
  "token": "<sha256(AUTH_PASSWORD)>",
  "timeoutMs": 20000
}
```

`token` 是 **sha256(AUTH_PASSWORD)**，请求以 `X-Auth-Token` 头发送。不同 Margin 实例的 token 不可混用。

cordis 层的开关（`cordis.yml`）：

| 开关 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `allowWrites` | **false** | 打开后注册已读/未读工具并允许显式状态写接口；关闭时写接口返回 403，旧工具引用也拒绝执行 |
| `allowUrlImports` | **false** | URL 导入独立开关，同时要求 `allowWrites=true` |
| `allowPdfImports` | **false** | PDF 上传独立开关，同时要求 `allowWrites=true`；受后端任务可观测性限制，保持灰度 |
| `allowSourceWrites` | **false** | RSS 来源增删/启停/抓取；同时要求 `allowWrites=true` |
| `allowCredentialWrites` | **false** | 域名 Cookie 写入/删除；同时要求 `allowWrites=true`，仅支持后端真正消费的两个域名 |
| `allowTriliumSave` | **false** | 单篇文章保存到 Trilium；走 Margin 自己的保存接口，先查后写 |
| `allowHighlightWrites` | **false** | 高亮创建/解绑/删除；偏移由服务端在 `content_text` 中重新定位 |
| `allowNoteWrites` | **false** | 笔记创建/整体更新/删除 |
| `allowAi` | **false** | 可选阅读助手；模型服务缺失时不影响纯阅读 |
| `aiProvider` / `aiModel` | `` | 可选模型目标；留空则用第一个可用模型 |
| 阅读进度 | 无需开关 | 只写本地 `~/.dsh/dsh-margin-progress.json`（0600，500 条/TTL 180 天），含进度条与目录；不触 Margin，也不表示已读 |
| `announceToAgent` | true | 向 agent 注入能力边界说明 |

## 路由（DSH Connection 会话校验）

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/dsh-margin/config` | GET / PUT | 读写配置（响应不含 token） |
| `/api/dsh-margin/test` | POST | 连接自检；失败返回 `ok:false` 而非抛错 |
| `/api/dsh-margin/candidates` | GET | 有界扫描与本地过滤分页（`status` / `sourceType` / `q` / `limit` / `page`），返回统计精度及实时写权限 |
| `/api/dsh-margin/candidate` | GET | 单条详情含 Markdown/纯文本正文（`id`），无原始 HTML |
| `/api/dsh-margin/candidate-status` | PATCH | 显式 `{id,status,marginUrl}`；仅 read/unprocessed，实时写权限与实例匹配校验 |
| `/api/dsh-margin/imports` | GET | 最近 20 条导入元数据与两类导入权限 |
| `/api/dsh-margin/import-task` | GET | 实例绑定的 candidate 任务状态复查；缺席不表示完成 |
| `/api/dsh-margin/import-url` | POST | JSON `{url,instanceUrl}`；202 只表示已接受 |
| `/api/dsh-margin/import-pdf` | POST | multipart `file` + `instanceUrl`；10 MiB、签名/类型/部件/流读取上限；不使用客户端路径 |
| `/api/dsh-margin/management` | GET | 来源、域名凭据、调度器状态的只读白名单投影 |
| `/api/dsh-margin/source-create` | POST | 新增 RSS 来源；公开 HTTP(S)，间隔 5–10080 分钟 |
| `/api/dsh-margin/source-update` | POST | 仅 active/paused，不改 label/config（避免清掉 etag） |
| `/api/dsh-margin/source-fetch` | POST | 手工抓取；200 只表示请求完成，不保证有新文章 |
| `/api/dsh-margin/source-delete` | POST | 需确认实时 `feedOrigin`；保留文章 |
| `/api/dsh-margin/credential-create` | POST | 仅 mp.weixin.qq.com / zhihu.com；Cookie 不回显 |
| `/api/dsh-margin/credential-delete` | POST | 需 id + 域名与实时列表一致 |
| `/api/dsh-margin/ai-capability` | GET | 是否启用、模型是否可用、限额 |
| `/api/dsh-margin/ai-run` | POST | 问答/翻译/摘要；正文围栏为不可信数据，返回覆盖率标注 |
| `/api/dsh-margin/save-state` | GET | 只读保存状态（布尔值，无 note id 接口） |
| `/api/dsh-margin/save-trilium` | POST | 先查后写，重复保存拒绝；不直接写 ETAPI |
| `/api/dsh-margin/annotations` | GET | 笔记与高亮只读快照 + 偏移可用性 |
| `/api/dsh-margin/highlight-create` | POST | 服务端在 `content_text` 重新定位偏移，歧义拒绝 |
| `/api/dsh-margin/highlight-link` | POST | 绑定/解绑笔记（`null` 解绑） |
| `/api/dsh-margin/highlight-delete` | POST | 需 candidateId + 所选文字，比对实时高亮后删；保留笔记 |
| `/api/dsh-margin/note-create` | POST | 新笔记，≤20000 字符 |
| `/api/dsh-margin/note-update` | POST | 整体替换（Margin 只有 PUT） |
| `/api/dsh-margin/note-delete` | POST | 需 candidateId + 当前内容，服务端比对实时内容后才删 |
| `/api/dsh-margin/progress` | GET / POST | 本地有界阅读进度；不需要写开关，不触 Margin。界面有进度条、目录与近似恢复 |
| `/api/dsh-margin/progress-clear` | POST | 只清本地行 |

## agent 工具

| 工具 | 说明 |
|---|---|
| `margin_list_candidates` | 列待读/已读，可按 `sourceType`、自由文本、条数过滤 |
| `margin_get_candidate` | 单条详情：标题、链接、来源、分类、标签、Margin 自己的摘要与摘录 |
| `margin_mark_read` | **仅当 `allowWrites=true` 时注册**；显式设 `read`，不是 toggle |
| `margin_mark_unread` | **仅当 `allowWrites=true` 时注册**；显式设 `unprocessed`，不重开 Trilium 任务 |

## 开发

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # tsc -> lib/ + tsdown -> lib/client.js
npm test              # node --test，321 项
node probes/margin_readonly_probe.mjs   # 对真实实例只读验证
```

### 测试覆盖（321 项）

界面覆盖：阅读器（正文安全渲染、进度条/目录/近似恢复）、导入面板（202 不代表完成、未知任务不判成功）、来源与凭据面板（默认拒绝、Cookie 不回显）、AI 面板（单飞/取消/迟到结果不落地/覆盖率原样展示）、注解面板（先读后写、歧义需显式选择、删除需实时证据）。

新增覆盖：阅读器写失败后的只读复核、列表滚动位置恢复、非 JSON 404 状态区分、带凭据 baseUrl 拒绝；注解偏移按 Unicode 码点换算并拒绝超长笔记的整体覆盖/删除；AI 正文围栏标记防注入、客户端断开中止模型流、qa 选段上限；导入轮询超时与 401 分类、来源/凭据写入按重读增量确认、上游 domain 回显不转发；保存回执丢失后的只读核验与阅读器保存区。

原有覆盖：URL/PDF 202 协议、真实二进制 multipart、超限/伪造类型/部件/流读取限制、导入独立授权与实例绑定、只读轮询/未知/超时不重提；正文/工具隔离、跨页过滤与真实总数、扫描截断/去重、部分状态确认、实时写闸门及实例校验、显式读写按钮/重复点击/失败/不确定状态、筛选与分页。

安全相关覆盖：来源/凭据只读投影剥离 `config`/`etag`/错误原文，上游 5xx/422 只映射固定文案（`INSERT`/Cookie/token canary 不出现在响应）；凭据仅允许后端真正消费的两个域名且不回显值；高亮偏移在 `content_text` 内重新定位（歧义拒绝而非取第一处）；保存走 Margin 单一写入方并先查后写；AI 正文被围栏标记为不可信数据、缺 `finish` 判为不完整、结果不写任何系统；本地进度不含读状态、上限 500 条/TTL 180 天/`0600`。

组件测试为 hooks/JSX 行为测试，真实 GUI/DOM/Markdown 渲染、布局与焦点验收另行记录。

- **store（12 项）**：默认值、损坏文件回退、0600 权限、`toView` 不含 token、补丁合并语义
  （省略 token ≠ 清除）、URL/超时校验、夹取上限。
- **client（16 项）**：分页参数与解析、`X-Auth-Token` 发送、401/403 → `MarginAuthError`、
  错误信封透传、结构错误不静默、非 JSON、连接失败、超时、客户端过滤、404 → `undefined`、
  显式 PATCH、跨页分布累加、缺字段降级、末尾斜杠归一化。
- **routes**：`config` 只回三个字段、非法补丁不改磁盘、401 透传、`not_configured` 409、
  id 校验、405、精确路由表；所有路由都委托 DSH Connection 做会话与来源校验。

完整能力矩阵（含未实现项与旧 Web 替代路径）：[docs/capability-matrix.md](docs/capability-matrix.md)

## 安全边界

- API 路由使用 DSH Connection 的 Host/Origin 与浏览器会话校验；登录后的远程 GUI 请求可访问，不单独限制 loopback。
- token 不返回浏览器、不进错误信息、不进日志；探针输出经过泄漏断言。
- 默认写闸门关闭；只有明确启用并显式操作才会写阅读状态，不自动写 Trilium。列表扫描最多 20 页，部分结果明确提示，不能把已扫描匹配数当完整总数。

## 下一步（未实现）

1. **按来源自动建任务**：新文章入库时在 Trilium 建 `#task`，可按 `sourceType` 设闸门
   （如实测 88 条未读中 rss 38 / wechat 23 / manual_url 15 / github_research 8 / video 4）。
2. **每日上限**：避免一次性灌爆任务账本。
3. **去重水位线**：以 `sourceUrl` / `marginCandidateId` 判重，避免重复建任务。
