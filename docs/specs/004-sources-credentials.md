# 004 RSS、来源与凭据设置

**状态：只读来源/凭据元数据与受控管理代码已实现；待 GUI 验收，全部写开关默认关闭。**

## 实施记录

验证：`npm run typecheck`、`npm run build`、`npm test` 通过；管理投影 8/8、管理路由安全 8/8。

已静态核验本机 Margin 当前源码（非历史文档）：

- RSS：`GET /api/content-sources` 全量列表（无分页）；`POST` 201 单对象；`PATCH /{id}` 200 单对象，只改传入字段；`DELETE /{id}` 204；`POST /{id}/fetch` 200 `{content_source_id,new_candidates_count,message}`；`GET /api/scheduler/status`。**没有** RSS 校验/试抓/单条读取/调度启停接口。
- 凭据：`GET /api/domain-credentials`、`POST` 201 单对象、`DELETE /{id}` 204。**没有** 更新、按域名清除、有效期、校验或检测接口；重复域名 422，无法 upsert。
- 真实消费 Cookie 的代码只有 `mp.weixin.qq.com` 与 `zhihu.com`；其他域名能存但不生效。
- 调度状态只统计 `content_source_*` 轮询任务，不含聚合/摘要任务；`next_run_time` 由 `isoformat()+'Z'` 生成，可能带偏移再加 Z，插件解析失败时显示空，不伪造时间。

### 已确认的上游风险（插件边界内已处理）

- `config` 是共享的嵌套字段，会被整体读回；`feed_url`、`last_etag`、用户自填 `last_fetched_at` 都可能含秘密或伪造状态。插件只投影 `URL.origin`，不转发整个 config。
- `last_error_message` 与抓取异常文本可能引用带 token 的 URL，因此只暴露“是否有错误”，不暴露文本。
- 凭据创建失败时后端会 `str(exc)`，全局 422 处理器会序列化 `validation_errors`（含输入值），**两条路径都可能回显 Cookie**。插件丢弃全部上游 message/detail，只按状态码给出固定文案。
- RSS `feedparser.parse(feed_url)` 未调用其已导入的 `validate_url`/私网检查；任意 config 值都会被接受。插件在 host 侧限制为公共 HTTP(S) 并拒绝常见私网字面量，但这不是完整 SSRF 防护，故**不提供**“任意 feed 试抓”入口，只做显式新增 + 后端既有调度抓取。

### 插件实现

- 新增 `GET /api/dsh-margin/management`（只读，三路并发：来源、凭据、调度，全部走白名单投影）。
- 写路径：`source-create`/`source-update`/`source-fetch`/`source-delete`、`credential-create`/`credential-delete`，各有独立开关且要求主写闸门；读取请求体前后各复查一次。
- 来源只允许改 `status`（active/paused）。标签与 `config` 不可改：前端历史实现曾用“仅 feed_url + aggregation”重建 config，会清掉 `last_etag`/`last_modified`/`last_fetched_at` 并触发冷启动重抓，此路径不暴露。
- 删除需提交与**实时重读**结果一致的 `feedOrigin`；删除只断开关联，保留文章（响应显式 `articlesRetained: true`）。
- 凭据只允许 `mp.weixin.qq.com` / `zhihu.com`；Cookie 仅走 `credential-create` 一次，校验非空、≤8192、无控制字符、含 `name=value`；响应绝不回显 Cookie（含前缀）。删除需 id + 域名与实时列表一致。
- 全部写响应回 `instanceUrl`；实例不匹配 409 并丢弃输入。

### 真实实例只读核验

`GET` 三路成功：来源 5 条（1 paused、4 error）、凭据 2 条（均为受支持域名）、调度器运行中而来源轮询任务 0（与 0 个 active 来源相符）。投影中无 `feed_url`/`last_etag`/`aggregation`/cookie/token。以上为采样时观测，不是长期结论；**4 个来源处于 error 属于现状问题，插件只展示不自动修复**。

### 未完成

GUI 实际渲染/可访问性、真实写入与 401 行为、日志落盘检查（未读取运行日志）、上游错误回显在生产实例上的实测均待授权验收。Trilium 全局设置不纳入本规格（其 PUT 必须重填 token，没有“留空保留”，且属于 Margin→Trilium 而非本插件凭据）。


## 前置条件

核验当前 DSH 设置 slot、连接鉴权和 Margin 来源/调度/凭据管理能力；修复设置入口需依据当前宿主契约，不能仅套用历史 key 结论。

## 范围与非目标

- 分开呈现 DSH→Margin 连接设置、RSS 来源及轮询状态、域名抓取凭据；先只读状态，再逐项开放明确的新增/修改/禁用操作。
- RSS 抓取与调度仍在 Margin，不在 DSH 新建同一组定时任务。状态展示最近成功/失败及实际采样时间，不用历史运行数据冒充实时。
- 密钥仅由 host/后端保存；浏览器读取只获得是否已设置/脱敏元数据。用户输入只经受保护写通道提交，保存后清空输入，不回读明文。
- 未填写密钥表示不修改，清除必须明确动作；更换实例不得把旧实例 token/Cookie 自动发送到新地址，需明确确认/重新配置并隔离身份。
- token、Cookie、带密钥 URL 不进入 agent 参数/工具输出、日志、错误、localStorage 或普通缓存；上游错误需脱敏。沿用并核验 DSH session/Host/Origin 防护。
- 当前源码配置为 host 侧权限受限文件，不能声称已迁移 `ctx.credentials`。若改用凭据服务，先验证可用性并设计安全迁移，不同时维护两个有效真源。
- 不展示 Cookie 内容，不搬迁所有来源数据，不替换后端 scheduler，不默认停源/清库。

## API 核验需要

已核验（见上方实施记录）：来源、调度、凭据的当前路由与返回形状，以及不带 Cookie 的成功响应。仍待授权实测：真实写操作、401 与网络失败区分、日志/错误回显的可观察行为。**没有** RSS 试抓、凭据更新、凭据校验接口，插件不得提供看似支持的动作。

## 验收与测试

已自动覆盖：默认拒绝全部写操作且不触达上游；主闸门与两类开关独立、读请求体后撤权生效；实例变更 409 且不转发；来源创建/状态/抓取/删除的输入校验与确认一致性；凭据域名白名单、Cookie 形态校验；**响应与错误中均不出现 Cookie/token/feed 路径/etag/上游异常文本**；上游 401/404/422/500 只映射固定文案；调度时间不可解析时置空。

仍待人工验收：当前 GUI 正常出现、可读性/焦点/键盘、真实 401 与网络失败区分、写入后后端重读确认、浏览器持久化检查、真实日志无密钥。

## 本轮补强（2026-10-26）

- 写入后的重读不再只校验实例：必须观察到预期增量（新增来源存在、状态一致、删除后缺席、凭据新增/缺席），否则显示 `errUnconfirmed` 并标记 `stale`，禁止继续写入。
- `credential-create` 只回显已校验的请求域名，忽略上游返回的 `domain`，避免上游把 Cookie 回显到响应。
- 新增“上游 422 回显 Cookie 不转发”的写路径测试。

## 发布与回退

先连接设置与只读来源，再开放单项管理能力。关闭新设置动作后仍由 Margin 继续轮询；凭据迁移若实施需预先备份且不在日志暴露，回退只能恢复单一凭据归属，不恢复明文到浏览器。
