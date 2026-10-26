# 007 高亮、笔记与旧锚点兼容迁移

**状态：注解后端 + 阅读器内面板已实现（默认关闭）；真实内容写入与浏览器交互验收待完成。**

## 实施记录

### 已核验的 Margin 注解契约

- 高亮：`POST/GET /api/candidates/{id}/highlights`，`PATCH/DELETE /api/highlights/{id}`。创建体 `{start_offset,end_offset,selected_text,text_fingerprint(16),note_id?,color?}`，`extra: forbid`；成功 201。列表按 `created_at asc`。
- 偏移校验对象是 **`candidate.feed_entry.content_text`**，不是渲染后的 HTML/Markdown：`start>=0`、`start<end`、`end<=len(content_text)`，否则 422 `INVALID_OFFSET`。
- `text_fingerprint` 为 16 位 hex；Margin 前端实现是 `SHA-256(selectedText)` 前 8 字节，本次以该实现为准并写了固定值测试。
- 笔记：`GET/POST /api/candidates/{id}/notes`、`PUT /api/notes/{id}`、`DELETE /api/notes/{id}`；**PUT 是整体替换内容**，没有 PATCH。删除笔记 204 硬删除。
- 删除高亮保留关联笔记（`ON DELETE SET NULL`）；`PATCH` 只改 `note_id`，可置 `null` 解绑。

### 关键设计决定：偏移绝不来自渲染视图

本插件渲染 `content_md`（缺失时退 `content_text`）。若按渲染结果计算偏移，存进 Margin 后与 `content_text` 对不上，历史高亮会漂移到别的句子。因此：

- 只接受用户选中的**文字**，在 `content_text` 内重新定位，得到权威偏移；用 `content_text.slice()` 作为 `selected_text`。
- 同一文字出现多次时**默认拒绝**并回报出现次数，由用户明确指定第几处（`occurrence`），不静默取第一处。
- `content_text` 为空（纯富文本/图片文章）时返回 `offsets_unavailable`，不猜偏移。

### 实现

- `GET /api/dsh-margin/annotations?id=&instanceUrl=`：并发读 candidate 详情、笔记、高亮；返回 `offsetsAvailable`、`writesAllowed`、白名单投影的笔记与高亮。
- `highlight-create` / `highlight-link` / `highlight-delete`、`note-create` / `note-update` / `note-delete`，各有独立开关（`allowHighlightWrites`、`allowNoteWrites`，默认 false，且需主写闸门）。全部实例绑定并在读完 body 后复查权限。
- 删除需确认：高亮要求提交与**实时重读**一致的所选文字；笔记要求提交当前内容。删除笔记响应说明高亮会被解绑。
- 笔记内容上限 20000 字符，高亮所选文字上限 12000；`start/end` 不接受客户端输入（服务端推导）。
- 上游 5xx 不回传 message（可能引用笔记正文），统一固定文案。

### 测试

`tests/annotations.test.mjs` 9/9：SHA-256 指纹固定值；选段在 `content_text` 定位（含不存在/空/多次歧义/指定第几处）；投影裁剪与非法行拒绝；只读快照实例绑定且不含 token；默认拒绝全部 6 个写接口且零上游写；创建高亮推导偏移并发送 Margin 字段名；歧义/缺失/超长/非法 occurrence 拒绝；笔记创建/PUT 整体更新/删除需确认/无高亮权限被拒/实例变更；高亮删除需文字一致、解绑与绑定显式。

### 面板（UI）

- 折叠区在正文之后、AI 区之前；阅读器通过注入的 `Panel` 渲染，本文件（`ArticleReader.tsx`）只做类型导入，运行期模块图不变。
- 先读后写：打开只读一次 `/annotations`；每次写操作都是 POST → 校验 `instanceUrl` 与快照一致 → 重读 → 才采纳新状态。关闭/卸载/换文章/换实例使在途结果失效。
- 默认拒绝：`writesAllowed=false` 时全部编辑控件禁用，列表仍可读；`offsetsAvailable=false` 时明确说明该文无纯文本正文、高亮无法锚定，但笔记仍可用。
- 删除需证据：笔记要求**当前内容**（含复制按钮填值），高亮要求**当前所选文字**；两个谓词都在会话侧用最新快照复核后才提交。
- 歧义不猜：`ambiguous_selection` 时展示出现次数并提供 occurrence 选择（UI 1-based，提交 occurrence-1）后重新提交。
- 当前选区预览显示将要提交的文本（裁剪、显示上限 2000 并注明），完整选区上限 12000，超限本地拒绝。
- 用户内容一律按纯文本渲染，无 `dangerouslySetInnerHTML`；错误只按 code/HTTP 状态映射固定文案。

`tests/annotation-ui.test.mjs` 30 项覆盖：默认拒绝、内容不以 HTML 注入、`SECRET NOTE BODY token=abc` canary 不出现在渲染树、歧义需显式选择、删除证据（前缀/空白被拒、复制按钮填精确值）、实例变更丢弃草稿、关闭/卸载后迟到结果不落地、无 storage/URL、注入面不含状态/保存/导入/AI 方法、`offsetsAvailable=false` 时笔记仍可用。

### 本轮补强（宿主侧）

- **歧义计数改为结构化字段**：`ambiguous_selection` 现在在错误信封里返回 `count`，客户端不再解析中文句子（原先的实现是从 `error.message` 里正则取数字，属于“永不读 message”原则的例外，已删除）。
- **笔记删除改为服务端复核**：`note-delete` 现在要求 `candidateId`，并在删除前比对实时内容，不一致返回 409 `confirmation_mismatch`；此前只有客户端在把关。

### 未完成

- 真实高亮/笔记写入（会产生真实数据）未执行；未在真实浏览器验证选区、焦点与布局。
- 渲染层尚不能把已存偏移映射回 Markdown 视图；这需要独立对齐设计，当前只提供列表视图。
- 历史高亮若基于旧版 `content_text`，偏移可能已漂移；插件不自动修复，也不删除。
- 单一 `writesAllowed` 是笔记/高亮两个开关的“或”，因此单独关闭其一只能以固定 403 文案体现。

## 前置条件

001 的稳定渲染及内容版本定义；获得旧高亮/笔记脱敏样本和后端实现/契约验证。历史记录提示 offset、TreeWalker、KaTeX 顺序及指纹算法耦合，但必须在当前版本复核。

## 范围与非目标

- 先只读审计/显示既有高亮和笔记，无法可靠定位时列出摘录与“未定位”状态，提供 Margin 原阅读入口；不得盲目按 DSH DOM offset 回填。
- 对比旧 `start_offset/end_offset/selected_text/text_fingerprint` 的单位、规范文本、换行、Unicode 与指纹算法。Markdown 与 HTML、数学/代码渲染不同，不能假定可见文本一致。
- 方案需评审后确定：兼容旧规范文本映射，或引入带版本的选文+前后文/位置提示锚点。新字段及迁移格式尚未确定，均为设计候选，不当作后端已支持。
- 原数据保留；迁移先 dry-run 生成匹配/歧义/失效报告，再经授权分批增量写入。重复选文需上下文消歧，低置信度拒绝自动落点；内容更新后重新定位，不静默移到错误段落。
- 新建/编辑/删除高亮或笔记需单独写闸门与明确动作；草稿、失败重试、并发冲突、笔记与高亮关联的删除语义需定义后再上线。
- 不覆盖旧 offset、不删除旧指纹、不把 Trilium 结论笔记冒充 Margin 锚定笔记，不在 001 中提前开放批注。

## API 核验需要

高亮/笔记 CRUD、选区校验、内容版本、删除关联、并发控制、锚点字段与迁移接口均 **TBD**。核验旧服务端是否按规范文本长度校验，指纹 SHA-256/djb2 分支及非安全上下文行为；旧资料不能替代契约测试。无兼容 API 时只读/旧 Web 降级，不能在插件另造第二份永久高亮库。

## 验收与测试

- 样本覆盖中文、emoji/组合字符、重复段落、换行、表格、代码、图片替代文本、公式及内容修订。
- 旧高亮只在精确/高置信度时回填；歧义不误标，失效仍能查看摘录和原笔记。
- 迁移重复执行幂等、可中断续跑、可核对旧数据未变；新旧阅读器兼容结果有记录。
- 删除关联、并发编辑、离线草稿、保存失败均不丢笔记；未经授权零写入。

## 本轮补强（2026-10-26）

- 偏移单位：JS 按 UTF-16 定位，发送前换算为 Unicode 码点，匹配 Python 的 `content_text` 契约；新增 emoji 前置的固定值测试。
- 并发更新：`note-update` 现在要求 `candidateId` + 编辑前的 `expectedContent`，服务端重读实时笔记并比对，不一致返回 409 `confirmation_mismatch`，不再静默覆盖。
- 截断保护：笔记投影增加 `contentTruncated`/`contentLength`；超过 20000 字符的笔记禁止整体更新和删除，面板显示截断说明并禁用编辑/删除/复制凭据。
- 空白笔记在 host 侧也拒绝；歧义计数不再截断在 51 次。
- 仍未做：把已存偏移渲染叠加回 Markdown 视图（需要独立的文本对齐设计）。

## 发布与回退

只读兼容→样本 dry-run→授权小批迁移→新写入；任一步不满足就保留 Margin Web。回退关闭新写入并恢复旧定位路径；新增版本数据保留或按已审计备份恢复，禁止破坏式全量重算覆盖旧锚点。
