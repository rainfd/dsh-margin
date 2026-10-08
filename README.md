# dsh-margin

把 **Margin**（阅读内容仓）接入 DSH —— 待读列表、单条详情，以及设置页配置卡。

**当前阶段：只读。** 不写 Margin，也不写 Trilium。

## 它解决什么

原来的架构里，内容在 Margin、任务在 Trilium，两边互不知道，所以需要一个跨系统对账器事后猜状态。
这个插件把 Margin 的**读**能力搬进 DSH：会话里可以直接问「我有什么待读的」，侧边栏能看到队列，
不用切应用。**写能力（标记已读、自动建任务）是第二步，默认关闭。**

## 双半结构

| 半 | 位置 | 职责 |
|---|---|---|
| host（Node） | `src/index.ts`、`margin.ts`、`routes.ts`、`store.ts`、`tools.ts` | Margin HTTP 客户端、`/api/dsh-margin/*` 路由、`margin_*` agent 工具 |
| client（浏览器） | `src/client/*` | 侧边栏「待读」面板 + 插件详情页配置卡 |

参照 dsh-trilium 的既有模式：loopback-only 路由、`~/.dsh/dsh-margin.json`（0600）存凭据、
浏览器侧永远看不到 token（只看到 `tokenSet`）。

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
| `allowWrites` | **false** | 打开后才注册 `margin_mark_read`；关闭时不存在任何写路径 |
| `announceToAgent` | true | 向 agent 注入能力边界说明 |

## 路由（loopback-only）

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/dsh-margin/config` | GET / PUT | 读写配置（响应不含 token） |
| `/api/dsh-margin/test` | POST | 连接自检；失败返回 `ok:false` 而非抛错 |
| `/api/dsh-margin/candidates` | GET | 待读列表 + 来源分布（`status` / `sourceType` / `q` / `limit`） |
| `/api/dsh-margin/candidate` | GET | 单条详情（`id`） |

## agent 工具

| 工具 | 说明 |
|---|---|
| `margin_list_candidates` | 列待读/已读，可按 `sourceType`、自由文本、条数过滤 |
| `margin_get_candidate` | 单条详情：标题、链接、来源、分类、标签、Margin 自己的摘要与摘录 |
| `margin_mark_read` | **仅当 `allowWrites=true` 时注册**；显式设 `read`，不是 toggle |

## 开发

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # tsc -> lib/ + tsdown -> lib/client.js
npm test              # node --test，43 项
node probes/margin_readonly_probe.mjs   # 对真实实例只读验证
```

### 测试覆盖（43 项）

- **store（12 项）**：默认值、损坏文件回退、0600 权限、`toView` 不含 token、补丁合并语义
  （省略 token ≠ 清除）、URL/超时校验、夹取上限。
- **client（16 项）**：分页参数与解析、`X-Auth-Token` 发送、401/403 → `MarginAuthError`、
  错误信封透传、结构错误不静默、非 JSON、连接失败、超时、客户端过滤、404 → `undefined`、
  显式 PATCH、跨页分布累加、缺字段降级、末尾斜杠归一化。
- **routes（15 项）**：`config` 只回三个字段、非法补丁不改磁盘、401 透传、`not_configured` 409、
  id 校验、405、精确路由表、**cross-site / 跨源 Origin 全部 403**、同源放行。

## 安全边界

- 路由仅接受 loopback 来源（`remoteAddress` + 同源 + 非 cross-site），与 dsh-trilium 同款守卫。
- token 不返回浏览器、不进错误信息、不进日志；探针输出经过泄漏断言。
- 只读阶段没有任何代码路径会修改 Margin 或 Trilium。

## 下一步（未实现）

1. **按来源自动建任务**：新文章入库时在 Trilium 建 `#task`，可按 `sourceType` 设闸门
   （如实测 88 条未读中 rss 38 / wechat 23 / manual_url 15 / github_research 8 / video 4）。
2. **每日上限**：避免一次性灌爆任务账本。
3. **去重水位线**：以 `sourceUrl` / `marginCandidateId` 判重，避免重复建任务。
