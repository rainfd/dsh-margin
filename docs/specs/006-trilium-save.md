# 006 Trilium 保存：文章、任务与去重

**状态：保存状态读取与受控保存后端已实现（默认关闭）；UI 与真实实例验收待完成。**

## 实施记录

### 已核验的 Margin 保存契约

- `POST /api/trilium/save`，请求体仅 `{candidate_id:int>0}`（`extra: forbid`），200 返回 `{status:'success',candidate_id,save_record_id,external_ref,saved_at,candidate_status,message}`；`external_ref` 是 Trilium note id。
- 失败映射：404 candidate 不存在；409 `save_in_progress`（仅检查待处理记录，**不**包含“已保存”）；422 `trilium_config_error`（未配置或父笔记非 Book）；502 网络/鉴权/保存失败；504 服务不可用。
- 去重现状：`has_pending_save` 只挡并发；**已成功保存的重复调用后端不会拒绝**，只能靠调用方先查 `is_saved_to_trilium`。插件因此强制先读后写。
- 保存状态来源：candidate 的 `is_saved_to_trilium` 由 SaveRecord 左连接计算，是权威布尔值；但**没有**读取 SaveRecord 明细/external_ref 的接口，`GET` 无法拿到 note id。
- 保存内容由后端 `save_to_trilium` 组装（AI 摘要、笔记、高亮引用、五字段），目标父笔记来自 Margin 设置；插件不直接调 ETAPI。

### 关键设计决定

插件**不在 Trilium 侧另写一份**。理由：`dsh-trilium` 没有导出可复用的服务（只有 `apply`），若插件自己走 ETAPI 会与 Margin 的保存内容/父目录/SaveRecord 分叉，制造双写和去重歧义。因此：

- 唯一写入方是 Margin 自己的 `/api/trilium/save`，插件只做“权限 + 实例绑定 + 先查后写 + 拒绝重复”。
- 去重键是 Margin 实例 + candidate id；跨实例同 ID 视为不同文章（`marginUrl` 必须与当前实例严格匹配）。
- AI 内容默认落 `Agent笔记` 的规则由 `dsh-trilium` 自己负责；本插件不新增记忆写入路径，也不把普通文章当任务加 `#task`。

### 实现

- `GET /api/dsh-margin/save-state?id=&instanceUrl=`：只读，返回 `{saved, saveAllowed, saveRecordId:null, externalRef:null, savedAt:null}`。空值是有意的：没有明细接口就不编造 note id。
- `POST /api/dsh-margin/save-trilium`：需独立 `allowTriliumSave`（默认 false，且要求主写闸门）；校验实例、`marginUrl` 与 candidateId 三者一致；读取请求体前后复查权限；先 `getCandidate` 断言未保存，再调用一次保存；回执缺 `save_record_id` 判为 `save_unconfirmed`（502）而非成功。
- 上游错误只映射固定文案；409 明确说明“可能已保存或正在保存，请重新核对”，不自动重试。504 明确“结果不确定”。
- 保存成功**不**改变阅读状态的假设：`candidate_status` 由后端返回，插件不另行 patch；也不自动重开任何 Trilium 任务。

### 测试

`tests/save.test.mjs` 9/9：回执投影丢弃 `message` 与 token、非 success 不算成功、坏 ID 置空；默认拒绝且不触达上游；只读状态页不含正文；成功路径只发一次 `POST /api/trilium/save` 且 body 仅 `{candidate_id}`；已保存文章零写入并 409；实例/marginUrl/字段校验；权限在读完 body 后撤销仍拒绝；409/422/504/502/401 分类且不含正文或 token；不完整回执判未确认；candidate 404 时不保存。

### 未完成

- UI、真实保存一次（会真实创建 Trilium 笔记，需授权与测试目标）未执行；未验证 Margin 侧 Trilium 是否已配置。
- 没有 SaveRecord 明细接口 → 无法展示历史失败记录或 external_ref；这不是插件遗漏，是后端能力缺口。
- 并发两个标签页同时保存仍可能都通过预检，最终依赖后端 `has_pending_save`；插件不做跨进程锁，也不声称原子。


## 前置条件

核验 dsh-trilium 可用性、目标实例身份、默认记忆目录配置与既有任务约定；核验 Margin 保存记录。优先复用已有集成，不另写 ETAPI 客户端。

## 范围与非目标

- 独立的「保存文章/结论」与「创建/关联任务」显式动作；展示目标、内容和语义，未选择任务动作不得给文章自动加 `#task`。
- AI 生成内容默认放已配置 Agent笔记记忆目录；不假定根目录或硬编码 noteId。用户明确指定其他位置时才改变；配置缺失须询问/停止，不随意落库。
- 保存正文/摘录/AI 结论范围需明确；完成阅读、生成摘要或打开文章均不触发保存，也不自动标已读。
- 去重键至少含 Margin 实例身份 + candidate ID，辅以规范 URL、Trilium 实例与已保存 external ref；跨实例相同 ID 不视为同文章。复用有效文章引用，不把普通文章自动转成任务。
- 先查再写并防并发重复；超时后先核验是否已成功。部分成功应报告实际笔记和待处理关联，可重试但不得重复建文章/任务。外部引用丢失或含义不明时交由用户确认。
- 保留文章与任务关系，不默认同步两个系统全部数据；未读动作不自动重开已完成任务。Margin 保存入口与 dsh-trilium 写入需明确责任，不能未经确认停掉旧写入方或制造双写。
- 不删除既有笔记、不重命名全部历史文章、不默认迁移全部库。

## API 核验需要

Margin 保存状态、SaveRecord/external ref 读取及回写能力 **TBD**；不能仅依赖 `isSavedToTrilium` 布尔值进行去重。Trilium 搜索标签/关系、任务 schema、创建/追加/更新能力与默认目录须按当前实例核验；正文更新使用 ETAPI 支持的 content PUT，不臆造 PATCH content。新增插件保存动作的路由与返回契约 **TBD**。

## 验收与测试

- 同文章重复保存、并发保存、重定向 URL、不同实例同 ID、已有文章再建任务均不误合并/重复。
- 普通文章无任务标签；任务按已核验约定建立并链接文章；AI 内容默认 Agent笔记，其他目录需明确选择。
- Trilium 不可用、保存成功但回执丢失、Margin 关联失败可恢复；不得把部分成功报全成功。
- 未授权不写；正文/敏感信息范围可预览；已读/未读与任务终态不暗中联动。

## 本轮补强（2026-10-26）

### 阅读器保存区（UI）

- 新增折叠式保存区（`SavePanel` + `SaveSession`），由 shell 通过注入面提供；未注入时阅读器不加载该模块、不发保存请求。
- 打开文章只发一次只读 `/save-state`；只有显式点击才发一次 `/save-trilium`。默认关闭或已保存时不渲染可写按钮。
- 回执成功但缺少 `save_record_id`、超时、5xx 或解析失败时，先只读重读 `is_saved_to_trilium`：已保存则返回 200 并标 `needsVerification`，否则返回 504 `save_unconfirmed` 或原分类；绝不自动重发。
- 实例/文章/candidate 三者不匹配时丢弃回执；关闭或换文章后迟到结果不落地。
- 仍未实现：在 Trilium 侧创建/关联任务（没有可复用的 dsh-trilium 服务，且会与 Margin 的单一写入方产生双写），真实保存一次仍未授权执行。

## 发布与回退

先单篇文章保存，再任务关联，最后考虑授权对账；测试目标与生产分离。关闭新保存动作即可回退原路径；保留已建笔记及引用，任何删除/合并由用户另行确认，不自动撤销业务数据。
