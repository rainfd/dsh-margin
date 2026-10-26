/**
 * Copy for the dsh-margin surfaces. Chinese-only by design (same as
 * dsh-trilium's settings card), so `en` mirrors `zh`.
 */

/** Every key the surfaces translate. */
export type MarginKey =
  | 'list.read'
  | 'list.statusLabel'
  | 'list.partial'
  | 'list.pagination'
  | 'list.previous'
  | 'list.next'
  | 'list.page'
  | 'reader.markRead'
  | 'reader.markUnread'
  | 'reader.saving'
  | 'reader.readOnly'
  | 'reader.reload'
  | 'reader.writeFailed'
  | 'reader.writeUncertain'
  | 'reader.title'
  | 'reader.navigation'
  | 'reader.back'
  | 'reader.loading'
  | 'reader.notFound'
  | 'reader.loadFailed'
  | 'reader.unauthorized'
  | 'reader.timeout'
  | 'reader.instanceChanged'
  | 'reader.remoteImages'
  | 'reader.fetchFailed'
  | 'reader.noBody'
  | 'reader.summary'
  | 'reader.body'
  | 'reader.copy'
  | 'reader.copied'
  | 'reader.footnotes'
  | 'list.title'
  | 'list.description'
  | 'list.refresh'
  | 'list.loadFailed'
  | 'list.empty'
  | 'list.notConfigured'
  | 'list.loading'
  | 'list.retry'
  | 'list.searchPlaceholder'
  | 'list.allSources'
  | 'list.total'
  | 'list.openMargin'
  | 'list.noSummary'
  | 'list.status.unprocessed'
  | 'list.status.read'
  | 'list.status.processing'
  | 'list.status.error'
  | 'settings.title'
  | 'settings.description'
  | 'settings.baseUrl'
  | 'settings.token'
  | 'settings.tokenSet'
  | 'settings.tokenUnset'
  | 'settings.tokenHint'
  | 'settings.timeout'
  | 'settings.save'
  | 'settings.saving'
  | 'settings.saved'
  | 'settings.test'
  | 'settings.testing'
  | 'settings.baseUrlHint'
  // 来源与凭据（spec004）。独立分组，reading/import 既有文案不变。
  | 'sources.title'
  | 'sources.open'
  | 'sources.close'
  | 'sources.intro'
  | 'sources.loading'
  | 'sources.observedAt'
  | 'sources.instance'
  | 'sources.refresh'
  | 'sources.busy'
  | 'sources.refreshNeeded'
  | 'sources.gateSourceOff'
  | 'sources.gateCredentialOff'
  | 'sources.section.sources'
  | 'sources.section.credentials'
  | 'sources.section.scheduler'
  | 'sources.scheduler.scope'
  | 'sources.scheduler.running'
  | 'sources.scheduler.stopped'
  | 'sources.scheduler.jobs'
  | 'sources.scheduler.nextRun'
  | 'sources.scheduler.noNextRun'
  | 'sources.scheduler.interval'
  | 'sources.scheduler.empty'
  | 'sources.noSources'
  | 'sources.noCredentials'
  | 'sources.source.origin'
  | 'sources.source.interval'
  | 'sources.source.failures'
  | 'sources.source.error'
  | 'sources.source.noError'
  | 'sources.source.fetchedAt'
  | 'sources.source.notFetched'
  | 'sources.source.lastErrorAt'
  | 'sources.status.active'
  | 'sources.status.paused'
  | 'sources.status.error'
  | 'sources.status.unknown'
  | 'sources.action.pause'
  | 'sources.action.resume'
  | 'sources.action.fetch'
  | 'sources.action.delete'
  | 'sources.action.deleteCredential'
  | 'sources.fetchHint'
  | 'sources.pauseHint'
  | 'sources.confirm.label'
  | 'sources.confirm.placeholder'
  | 'sources.confirm.retained'
  | 'sources.create.label'
  | 'sources.create.feedUrl'
  | 'sources.create.name'
  | 'sources.create.interval'
  | 'sources.create.submit'
  | 'sources.create.hint'
  | 'sources.createCredential.label'
  | 'sources.createCredential.domain'
  | 'sources.createCredential.cookie'
  | 'sources.createCredential.submit'
  | 'sources.createCredential.hint'
  | 'sources.credential.configured'
  | 'sources.credential.unconfigured'
  | 'sources.credential.supported'
  | 'sources.credential.unsupported'
  | 'sources.credential.unsupportedNote'
  | 'sources.credential.supportedList'
  | 'sources.credential.neverEcho'
  | 'sources.noteCreated'
  | 'sources.notePaused'
  | 'sources.noteResumed'
  | 'sources.noteFetched'
  | 'sources.noteDeleted'
  | 'sources.noteCredentialCreated'
  | 'sources.noteCredentialDeleted'
  | 'sources.errWritesDisabled'
  | 'sources.errInstanceChanged'
  | 'sources.errNotConfigured'
  | 'sources.errUnsupportedDomain'
  | 'sources.errConfirmRequired'
  | 'sources.errConfirmMismatch'
  | 'sources.errInvalidFeedUrl'
  | 'sources.errInvalidLabel'
  | 'sources.errInvalidInterval'
  | 'sources.errInvalidDomain'
  | 'sources.errCookieInvalid'
  | 'sources.errUnauthorized'
  | 'sources.errNotFound'
  | 'sources.errRejected'
  | 'sources.errConflict'
  | 'sources.errTimeout'
  | 'sources.errUpstream'
  | 'sources.errRequest'
  | 'sources.errNetwork'
  | 'sources.errUnconfirmed'
  | 'sources.errNoSnapshot'
  | 'sources.errSourceMissing'
  | 'sources.errCredentialMissing'
  | 'sources.errFetchNotAllowed'
  // 可选 AI 助手（spec005）。关闭时面板不渲染，与阅读路径完全无关。
  | 'ai.title'
  | 'ai.expand'
  | 'ai.collapse'
  | 'ai.noModel'
  | 'ai.model'
  | 'ai.modelUnknown'
  | 'ai.boundary'
  | 'ai.mode'
  | 'ai.mode.qa'
  | 'ai.mode.translate'
  | 'ai.mode.summary'
  | 'ai.question'
  | 'ai.questionPlaceholder'
  | 'ai.scope'
  | 'ai.scope.article'
  | 'ai.scope.selection'
  | 'ai.run'
  | 'ai.running'
  | 'ai.cancel'
  | 'ai.generated'
  | 'ai.resultNotice'
  | 'ai.cancelled'
  | 'ai.block.loading'
  | 'ai.block.disabled'
  | 'ai.block.noModel'
  | 'ai.block.running'
  | 'ai.block.questionRequired'
  | 'ai.block.questionTooLong'
  | 'ai.block.selectionTooLong'
  | 'ai.block.noInstance'
  | 'ai.error.disabled'
  | 'ai.error.noModel'
  | 'ai.error.notConfigured'
  | 'ai.error.instanceChanged'
  | 'ai.error.invalid'
  | 'ai.error.empty'
  | 'ai.error.notFound'
  | 'ai.error.margin'
  | 'ai.error.failed'
  | 'ai.error.timeout'
  | 'ai.error.cancelled'
  | 'ai.error.unknown'
  // 高亮与笔记（spec007 客户端）。只读优先；写入默认关闭，失败只显示固定文案。
  | 'annotations.title'
  | 'annotations.expand'
  | 'annotations.collapse'
  | 'annotations.counts'
  | 'annotations.loading'
  | 'annotations.retry'
  | 'annotations.readOnly'
  | 'annotations.stale'
  | 'annotations.busy'
  | 'annotations.unlinked'
  | 'annotations.linkedTo'
  | 'annotations.offsetsUnavailable'
  | 'annotations.notes'
  | 'annotations.noNotes'
  | 'annotations.note.createdAt'
  | 'annotations.note.updatedAt'
  | 'annotations.note.create'
  | 'annotations.note.placeholder'
  | 'annotations.note.save'
  | 'annotations.note.counter'
  | 'annotations.note.created'
  | 'annotations.note.edit'
  | 'annotations.note.editSave'
  | 'annotations.note.cancel'
  | 'annotations.note.updated'
  | 'annotations.note.delete'
  | 'annotations.note.deleteConfirm'
  | 'annotations.note.fill'
  | 'annotations.note.deleted'
  | 'annotations.note.emptyProof'
  | 'annotations.note.truncated'
  | 'annotations.highlights'
  | 'annotations.noHighlights'
  | 'annotations.highlight.linkTo'
  | 'annotations.highlight.noLink'
  | 'annotations.highlight.link'
  | 'annotations.highlight.linked'
  | 'annotations.highlight.unlinked'
  | 'annotations.highlight.delete'
  | 'annotations.highlight.deleteConfirm'
  | 'annotations.highlight.fill'
  | 'annotations.highlight.deleted'
  | 'annotations.highlight.deleteNote'
  | 'annotations.highlight.ambiguous'
  | 'annotations.highlight.ambiguousUnknown'
  | 'annotations.highlight.occurrence'
  | 'annotations.highlight.occurrenceOption'
  | 'annotations.highlight.resubmit'
  | 'annotations.highlight.cancel'
  | 'annotations.highlight.created'
  | 'annotations.selection.title'
  | 'annotations.selection.current'
  | 'annotations.selection.none'
  | 'annotations.selection.refresh'
  | 'annotations.selection.create'
  | 'annotations.selection.previewTruncated'
  | 'annotations.error.writesDisabled'
  | 'annotations.error.notConfigured'
  | 'annotations.error.instanceChanged'
  | 'annotations.error.instanceUnknown'
  | 'annotations.error.offsetsUnavailable'
  | 'annotations.error.emptySelection'
  | 'annotations.error.selectionNotFound'
  | 'annotations.error.ambiguous'
  | 'annotations.error.occurrenceRequired'
  | 'annotations.error.selectionTooLong'
  | 'annotations.error.emptyContent'
  | 'annotations.error.contentTooLong'
  | 'annotations.error.invalid'
  | 'annotations.error.invalidContent'
  | 'annotations.error.confirmRequired'
  | 'annotations.error.confirmMismatch'
  | 'annotations.error.unauthorized'
  | 'annotations.error.notFound'
  | 'annotations.error.rejected'
  | 'annotations.error.conflict'
  | 'annotations.error.upstream'
  | 'annotations.error.request'
  | 'annotations.error.network'
  | 'annotations.error.unconfirmed'
  | 'annotations.error.noteTruncated'
  | 'annotations.error.unknown'
  // 保存到 Trilium（spec006）。只有显式点击才写，且由 Margin 单一写入。
  | 'save.title'
  | 'save.boundary'
  | 'save.saved'
  | 'save.savedAt'
  | 'save.externalRef'
  | 'save.unconfirmed'
  | 'save.needsTask'
  | 'save.button'
  | 'save.saving'
  | 'save.disabled'
  | 'save.recheck'
  | 'save.error.disabled'
  | 'save.error.alreadySaved'
  | 'save.error.conflict'
  | 'save.error.uncertain'
  | 'save.error.notConfigured'
  | 'save.error.notFound'
  | 'save.error.unauthorized'
  | 'save.error.failed'
  | 'save.error.network'
  | 'save.error.request'
  | 'save.error.instanceChanged'
  // 本地阅读位置（spec008 客户端）。只观测滚动位置，绝不表示已读。
  | 'progress.position'
  | 'progress.saveFailed'
  | 'progress.restoredApproximate'
  | 'progress.toc'
  | 'progress.tocApproximate'

/** Chinese dictionary (the source of truth). */
export const zh: Record<MarginKey, string> = {
  'list.read': '阅读',
  'list.statusLabel': '阅读状态',
  'list.partial': '结果不完整：已扫描 {scanned} / {upstream} 条，仅显示扫描范围内的匹配结果。',
  'list.pagination': '阅读列表分页',
  'list.previous': '上一页',
  'list.next': '下一页',
  'list.page': '第 {page} / {pages} 页',
  'reader.markRead': '标为已读',
  'reader.markUnread': '设为未读',
  'reader.saving': '提交中…',
  'reader.readOnly': '只读模式：未允许状态写入',
  'reader.reload': '重新读取状态',
  'reader.writeFailed': '状态提交失败，结果未确认。可再次点击状态按钮重试，或先重新读取状态；不会自动重发。',
  'reader.writeUncertain': '状态更新已获确认，但详情刷新失败；未回滚。当前显示可能过期，请重新读取状态后再操作。',
  'reader.title': '文章阅读器',
  'reader.navigation': '阅读导航',
  'reader.back': '返回待读列表',
  'reader.loading': '正文加载中…',
  'reader.notFound': '文章不存在或已被移除（404）',
  'reader.loadFailed': '正文加载失败，请重试或在 Margin 中打开',
  'reader.unauthorized': '阅读请求未获授权（401/403），请检查 DSH 登录状态及 Margin 连接配置',
  'reader.timeout': 'Margin 读取超时，请重试',
  'reader.instanceChanged': 'Margin 实例或文章身份已变化，请返回并刷新列表后重新打开',
  'reader.remoteImages': '正文中的远程图片会直接从图片站点加载，可能向其暴露访问记录。',
  'reader.fetchFailed': 'Margin 抓取正文失败；下方仅展示已保存的内容（如有）',
  'reader.noBody': '没有可用正文；摘要不代表文章全文，可在 Margin 中打开查看',
  'reader.summary': '摘要 / 摘录（非正文）',
  'reader.body': '文章正文',
  'reader.copy': '复制代码',
  'reader.copied': '已复制',
  'reader.footnotes': '脚注',
  'list.title': '待读',
  'list.description': '浏览 Margin 阅读内容，阅读状态仅在明确点击后更新',
  'list.refresh': '刷新',
  'list.loadFailed': '加载失败',
  'list.empty': '没有符合条件的条目',
  'list.notConfigured': '尚未配置 Margin：请在 插件 → dsh-margin 中填写地址与 token',
  'list.loading': '加载中…',
  'list.retry': '重试',
  'list.searchPlaceholder': '搜索标题 / 域名 / 标签',
  'list.allSources': '全部来源',
  'list.total': '已观测匹配 {total} 条',
  'list.openMargin': '在 Margin 中打开',
  'list.noSummary': '（没有摘要）',
  'list.status.unprocessed': '未读',
  'list.status.read': '已读',
  'list.status.processing': '处理中',
  'list.status.error': '失败',
  'settings.title': 'Margin',
  'settings.description': '阅读内容仓：RSS / 微信 / 视频 / 手动导入的文章。任务账本仍在 Trilium，允许写入时可明确更新阅读状态。',
  'settings.baseUrl': 'Margin 地址',
  'settings.token': 'X-Auth-Token',
  'settings.tokenSet': '已设置',
  'settings.tokenUnset': '未设置',
  'settings.tokenHint': '留空表示不修改当前 token；填新值则覆盖。该值应为 sha256(AUTH_PASSWORD)。',
  'settings.timeout': '超时（毫秒）',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.saved': '已保存',
  'settings.test': '测试连接',
  'settings.testing': '测试中…',
  'settings.baseUrlHint': '只填到主机端口，例如 http://127.0.0.1:3000，不要带路径。',

  // ── 来源与凭据（spec004）────────────────────────────────────────────
  'sources.title': '来源与凭据',
  'sources.open': '来源与凭据',
  'sources.close': '返回阅读（来源仍在后台轮询）',
  'sources.intro': '只读优先：先展示 Margin 已保存的来源、凭据与调度状态；新增、启停、抓取、删除都需要服务端当前允许写入。文章与凭据都由 Margin 保存。',
  'sources.loading': '正在读取来源与凭据…',
  'sources.observedAt': '检查时间=observedAt：{time}',
  'sources.instance': '实例：{instance}',
  'sources.refresh': '重新只读读取',
  'sources.busy': '提交中：已禁用其他操作，待服务端重读确认',
  'sources.refreshNeeded': '当前没有可信快照（读取失败或写入结果未确认），操作已全部禁用，请先重新只读读取。',
  'sources.gateSourceOff': '来源写入未启用：可完整查看来源与调度状态，但新增、启停、抓取、删除全部禁用。需要时在插件配置中开启 allowSourceWrites。',
  'sources.gateCredentialOff': '凭据写入未启用：可查看已配置的域名与支持情况，但新增与删除全部禁用。需要时在插件配置中开启 allowCredentialWrites。',
  'sources.section.sources': 'RSS 来源',
  'sources.section.credentials': '域名抓取凭据',
  'sources.section.scheduler': '调度状态',
  'sources.scheduler.scope': '仅来源轮询任务，不含聚合任务',
  'sources.scheduler.running': '调度器：运行中',
  'sources.scheduler.stopped': '调度器：未运行',
  'sources.scheduler.jobs': '来源轮询任务数：{count}',
  'sources.scheduler.nextRun': '下次运行：{time}',
  'sources.scheduler.noNextRun': '下次运行：后端未提供可解析时间',
  'sources.scheduler.interval': '间隔 {minutes} 分钟',
  'sources.scheduler.empty': '后端没有报告任何来源轮询任务。',
  'sources.noSources': '后端没有返回任何来源。',
  'sources.noCredentials': '后端没有返回任何已保存的凭据。',
  'sources.source.origin': '来源域：{origin}',
  'sources.source.interval': '轮询间隔：{minutes} 分钟',
  'sources.source.failures': '连续失败：{count}',
  'sources.source.error': '存在错误记录（错误正文不展示，可能包含敏感参数）',
  'sources.source.noError': '没有错误记录',
  'sources.source.fetchedAt': '记录的抓取时间：{time}',
  'sources.source.notFetched': '记录的抓取时间：无（不能据此推断从未抓取）',
  'sources.source.lastErrorAt': '最近错误：{time}',
  'sources.status.active': '启用中',
  'sources.status.paused': '已暂停',
  'sources.status.error': '有错误',
  'sources.status.unknown': '未知（需核实）',
  'sources.action.pause': '暂停',
  'sources.action.resume': '恢复',
  'sources.action.fetch': '手工抓取',
  'sources.action.delete': '删除来源（保留已抓取文章）',
  'sources.action.deleteCredential': '删除凭据',
  'sources.fetchHint': '手工抓取只触发一次后端请求；返回 200 表示请求已结束，newCandidates 可能为 0，也不代表产生了新文章。抓取后会重新只读读取状态。',
  'sources.pauseHint': '暂停只停止后续轮询：已抓取文章保留，也不会取消正在进行中的抓取。',
  'sources.confirm.label': '删除确认：请原样输入该来源域 {origin}',
  'sources.confirm.placeholder': '原样输入来源域',
  'sources.confirm.retained': '删除来源不会删除文章：已抓取的文章继续保留在 Margin 中。',
  'sources.create.label': '新增 RSS 来源',
  'sources.create.feedUrl': '订阅地址（公共 HTTP(S)，不含账号密码）',
  'sources.create.name': '显示名称（1–120 字符）',
  'sources.create.interval': '轮询间隔（分钟，5–10080）',
  'sources.create.submit': '新增来源',
  'sources.create.hint': '新增由你点击提交；重复点击不会创建第二个调度，成功后以服务端重读结果为准。',
  'sources.createCredential.label': '新增域名 Cookie',
  'sources.createCredential.domain': '域名（仅支持列出的域名）',
  'sources.createCredential.cookie': 'Cookie（仅提交给后端，不回读、不回显）',
  'sources.createCredential.submit': '保存 Cookie',
  'sources.createCredential.hint': 'Cookie 只在提交时发送给宿主机后端；保存后清空输入，不写入 localStorage/sessionStorage，也不进入 URL 或日志。',
  'sources.credential.configured': '已配置',
  'sources.credential.unconfigured': '未配置',
  'sources.credential.supported': '后端支持',
  'sources.credential.unsupported': '后端不支持',
  'sources.credential.unsupportedNote': '当前后端没有这些域名的 Cookie 消费逻辑：保存后不会生效，也不影响任何抓取。',
  'sources.credential.supportedList': '当前支持的域名：{domains}',
  'sources.credential.neverEcho': 'Cookie 内容从不展示，连前缀也不展示；这里只有是否已配置。',
  'sources.noteCreated': '已提交新增来源；已按服务端重读结果确认。',
  'sources.notePaused': '已提交暂停；已按服务端重读结果确认。',
  'sources.noteResumed': '已提交恢复；已按服务端重读结果确认。',
  'sources.noteFetched': '抓取请求已结束（200），newCandidates = {count}。0 表示本次未新增文章，状态已重新只读读取。',
  'sources.noteDeleted': '来源已删除；文章保留。已按服务端重读结果确认。',
  'sources.noteCredentialCreated': 'Cookie 已保存；已按服务端重读结果确认，输入已清空。',
  'sources.noteCredentialDeleted': '凭据已删除；已按服务端重读结果确认。',
  'sources.errWritesDisabled': '服务端当前未允许该类写入，操作未执行。',
  'sources.errInstanceChanged': '实例已变更，已丢弃输入',
  'sources.errNotConfigured': '尚未配置 Margin 地址或 token，请先完成连接配置。',
  'sources.errUnsupportedDomain': '当前后端不支持该域名，已拒绝提交。',
  'sources.errConfirmRequired': '删除需要先原样输入该来源的来源域。',
  'sources.errConfirmMismatch': '输入与当前来源域不一致，未发送删除请求。',
  'sources.errInvalidFeedUrl': '请输入不含账号密码的公共 HTTP(S) 订阅地址。',
  'sources.errInvalidLabel': '名称需为 1–120 个可见字符。',
  'sources.errInvalidInterval': '轮询间隔需为 5–10080 之间的整数分钟。',
  'sources.errInvalidDomain': '域名需为小写主机名，不含协议、端口或路径。',
  'sources.errCookieInvalid': 'Cookie 需为非空的 name=value 形式，且不含控制字符。',
  'sources.errUnauthorized': 'Margin 拒绝凭据（401/403），请检查 token 配置。',
  'sources.errNotFound': '目标不存在或已变化，请重新只读读取。',
  'sources.errRejected': 'Margin 拒绝了该值（可能是重复域名或格式问题）。',
  'sources.errConflict': 'Margin 报告冲突或重复，请重新只读读取后再决定。',
  'sources.errTimeout': '结果不确定：请求可能已生效，请重新只读核对，不要直接重试。',
  'sources.errUpstream': 'Margin 内部错误；详情未转发（可能含敏感参数）。',
  'sources.errRequest': '请求被拒绝或格式不合法，未做任何修改。',
  'sources.errNetwork': '网络请求失败，结果未知；请重新只读读取，不要直接重试。',
  'sources.errUnconfirmed': '写入已提交但重读确认失败：当前状态未知，已禁用操作，请重新只读读取。',
  'sources.errNoSnapshot': '没有可信的服务端快照，操作已禁用，请先重新只读读取。',
  'sources.errSourceMissing': '该来源已不在最近一次读取结果中，请重新只读读取。',
  'sources.errCredentialMissing': '该凭据已不在最近一次读取结果中，请重新只读读取。',
  'sources.errFetchNotAllowed': '只有启用中或出错的来源可以手工抓取；已暂停的来源请先恢复。',
  'ai.title': 'AI 助手（可选）',
  'ai.expand': '展开 AI 助手',
  'ai.collapse': '收起 AI 助手',
  'ai.noModel': '无可用的 DSH 模型：AI 助手暂不可用，阅读不受影响。',
  'ai.model': '模型：{model}',
  'ai.modelUnknown': '模型：未知（未配置）',
  'ai.boundary': '正文会发送给所选模型；结果不写入 Margin/Trilium；文章内容视为不可信数据。',
  'ai.mode': '处理方式',
  'ai.mode.qa': '提问',
  'ai.mode.translate': '翻译',
  'ai.mode.summary': '摘要',
  'ai.question': '问题（必填）',
  'ai.questionPlaceholder': '仅根据本文回答问题',
  'ai.scope': '发送范围',
  'ai.scope.article': '整篇文章（未检测到选段）',
  'ai.scope.selection': '当前选段',
  'ai.run': '发送给模型',
  'ai.running': '生成中…',
  'ai.cancel': '取消',
  'ai.generated': 'AI 生成（非原文，未保存）',
  'ai.resultNotice': '结果只显示在此处；不会写入 Margin、Trilium，也不会改变已读状态。',
  'ai.cancelled': '已取消生成；未保留部分结果。',
  'ai.block.loading': '正在读取 AI 能力…',
  'ai.block.disabled': 'AI 助手未启用。',
  'ai.block.noModel': '无可用的 DSH 模型。',
  'ai.block.running': '已有请求在进行中，请先取消或等待完成。',
  'ai.block.questionRequired': '请先输入问题。',
  'ai.block.questionTooLong': '问题最多 1000 字符。',
  'ai.block.selectionTooLong': '选段超过长度上限，请缩短选择后再发送。',
  'ai.block.noInstance': '无法确认 Margin 实例，请返回列表重新打开该文章。',
  'ai.error.disabled': 'AI 功能未启用。',
  'ai.error.noModel': '没有可用的 DSH 模型；阅读不受影响。',
  'ai.error.notConfigured': '尚未配置 Margin 地址或 token，请先完成连接配置。',
  'ai.error.instanceChanged': 'Margin 实例或文章已变化，结果已丢弃；请重新打开该文章。',
  'ai.error.invalid': '请求未通过校验（问题或选段不合法），未调用模型。',
  'ai.error.empty': '该文章没有可读正文；不会凭空生成。',
  'ai.error.notFound': 'Margin 中不存在该文章。',
  'ai.error.margin': '无法从 Margin 读取正文；本次未调用模型。',
  'ai.error.failed': '模型调用失败；未保留部分结果，也未写入任何数据。',
  'ai.error.timeout': '模型调用超时或被中断；未保留部分结果。',
  'ai.error.cancelled': '已取消生成。',
  'ai.error.unknown': 'AI 请求失败；未写入任何数据。',

  // ── 高亮与笔记（spec007 客户端）─────────────────────────────────────
  'annotations.title': '高亮与笔记',
  'annotations.expand': '展开高亮与笔记',
  'annotations.collapse': '收起高亮与笔记',
  'annotations.counts': '笔记 {notes} 条，高亮 {highlights} 条',
  'annotations.loading': '正在读取高亮与笔记…',
  'annotations.retry': '重新读取标注',
  'annotations.readOnly': '标注写入未启用：以下内容只读，创建、编辑、关联与删除全部不可用。',
  'annotations.stale': '当前没有可信的标注快照（读取失败、写入后重读失败或内容冲突）；写入已禁用，请先重新读取。',
  'annotations.busy': '提交中：已禁用其他操作，等待服务端重读确认。',
  'annotations.unlinked': '未关联笔记',
  'annotations.linkedTo': '已关联笔记 #{id}',
  'annotations.offsetsUnavailable': '该文章没有纯文本正文，无法按偏移定位高亮；高亮创建已禁用，笔记仍可正常读写。',
  'annotations.notes': '笔记',
  'annotations.noNotes': '还没有笔记。',
  'annotations.note.createdAt': '创建：{time}',
  'annotations.note.updatedAt': '更新：{time}',
  'annotations.note.create': '新增笔记',
  'annotations.note.placeholder': '写下与本文相关的笔记（只保存在 Margin，不写入 Trilium）',
  'annotations.note.save': '保存笔记',
  'annotations.note.counter': '已输入 {length} / {max} 字符',
  'annotations.note.created': '笔记已创建；状态以重新读取的结果为准。',
  'annotations.note.edit': '编辑笔记',
  'annotations.note.editSave': '保存修改（整体替换）',
  'annotations.note.cancel': '取消',
  'annotations.note.updated': '笔记内容已整体替换；状态以重新读取的结果为准。',
  'annotations.note.delete': '删除笔记',
  'annotations.note.deleteConfirm': '删除确认：请原样输入该笔记的完整内容',
  'annotations.note.fill': '填入当前内容',
  'annotations.note.deleted': '笔记已删除；受影响的高亮以重新读取的结果为准。',
  'annotations.note.emptyProof': '该笔记内容为空，无法作为删除凭据；请在 Margin 中删除。',
  'annotations.note.truncated': '笔记超过插件可安全处理的长度，仅显示前 20000 字符；编辑与删除已禁用，请在 Margin 中处理。',
  'annotations.highlights': '高亮',
  'annotations.noHighlights': '还没有高亮。',
  'annotations.highlight.linkTo': '关联到笔记',
  'annotations.highlight.noLink': '不关联',
  'annotations.highlight.link': '保存关联',
  'annotations.highlight.linked': '高亮已关联笔记；状态以重新读取的结果为准。',
  'annotations.highlight.unlinked': '高亮已解除关联；状态以重新读取的结果为准。',
  'annotations.highlight.delete': '删除高亮',
  'annotations.highlight.deleteConfirm': '删除确认：请原样输入该高亮的所选文字',
  'annotations.highlight.fill': '填入所选文字',
  'annotations.highlight.deleted': '高亮已删除；关联笔记保留。状态以重新读取的结果为准。',
  'annotations.highlight.deleteNote': '删除高亮不会删除关联笔记。',
  'annotations.highlight.ambiguous': '所选文字在正文中出现 {count} 次；请明确指定第几处后再创建，不会自动取第一处。',
  'annotations.highlight.ambiguousUnknown': '所选文字在正文中出现多次；请明确指定第几处后再创建，不会自动取第一处。',
  'annotations.highlight.occurrence': '第几处',
  'annotations.highlight.occurrenceOption': '第 {n} 处',
  'annotations.highlight.resubmit': '按所选处重新创建',
  'annotations.highlight.cancel': '取消这次选择',
  'annotations.highlight.created': '高亮已创建；状态以重新读取的结果为准。',
  'annotations.selection.title': '当前选区',
  'annotations.selection.current': '将提交的选段（已去除首尾空白）：',
  'annotations.selection.none': '未检测到选段；请先在正文中选择文字。',
  'annotations.selection.refresh': '重新读取选区',
  'annotations.selection.create': '用当前选区创建高亮',
  'annotations.selection.previewTruncated': '预览只显示前 {limit} 字符；创建时发送的是完整选段（仍受长度上限约束）。',
  'annotations.error.writesDisabled': '服务端当前未允许标注写入，操作未执行。',
  'annotations.error.notConfigured': '尚未配置 Margin 地址或 token，请先完成连接配置。',
  'annotations.error.instanceChanged': 'Margin 实例已变化，标注结果已丢弃；请刷新文章后重试。',
  'annotations.error.instanceUnknown': '无法从阅读链接确认 Margin 实例；标注不可用。',
  'annotations.error.offsetsUnavailable': '该文章没有纯文本正文，无法按偏移保存高亮。',
  'annotations.error.emptySelection': '请先在正文中选择要保存的文字。',
  'annotations.error.selectionNotFound': '在正文中找不到所选文字，请重新选择。',
  'annotations.error.ambiguous': '所选文字在正文中出现多次，需要明确指定第几处。',
  'annotations.error.occurrenceRequired': '请先指定这是第几处，再重新创建。',
  'annotations.error.selectionTooLong': '选段超过长度上限，未提交。',
  'annotations.error.emptyContent': '笔记内容不能为空。',
  'annotations.error.contentTooLong': '笔记最多 20000 字符。',
  'annotations.error.invalid': '请求未通过校验，未做任何修改。',
  'annotations.error.invalidContent': '笔记内容不合法，未提交。',
  'annotations.error.confirmRequired': '删除需要先原样输入当前内容。',
  'annotations.error.confirmMismatch': '输入与当前内容不一致，未提交删除。',
  'annotations.error.unauthorized': 'Margin 拒绝凭据（401），请检查 token 配置。',
  'annotations.error.notFound': '目标不存在或已变化，请重新读取。',
  'annotations.error.rejected': 'Margin 拒绝了该内容（偏移或字段不合法），未做任何修改。',
  'annotations.error.conflict': 'Margin 报告冲突或内容已变化，请重新读取后再决定。',
  'annotations.error.upstream': 'Margin 内部错误；详情未转发（可能包含笔记正文）。',
  'annotations.error.request': '请求被拒绝或格式不合法，未做任何修改。',
  'annotations.error.network': '网络请求失败，结果未知；请重新读取，不要直接重试。',
  'annotations.error.unconfirmed': '写入已提交但重读确认失败：当前状态未知，写入已禁用；请重新读取。',
  'annotations.error.noteTruncated': '笔记超过 20000 字符，插件无法用投影内容安全更新或删除；请在 Margin 中处理。',
  'annotations.error.unknown': '标注请求失败，未做任何修改。',
  'save.title': '保存到 Trilium',
  'save.boundary': '保存由 Margin 写入它自己配置的 Trilium 父笔记；不会创建任务，也不会改变已读状态。',
  'save.saved': '已保存到 Trilium',
  'save.savedAt': '（{time}）',
  'save.externalRef': 'Trilium note id：{ref}',
  'save.unconfirmed': '已按 Margin 状态确认保存，但回执未完整返回；没有重复提交。',
  'save.needsTask': '这不是任务；如需任务请在 Trilium 另行建立关联。',
  'save.button': '保存到 Trilium',
  'save.saving': '保存中…',
  'save.disabled': '保存未启用（需要 allowWrites 与 allowTriliumSave）',
  'save.recheck': '重新读取保存状态',
  'save.error.disabled': '保存未启用。',
  'save.error.alreadySaved': '该文章已保存到 Trilium，未重复创建。',
  'save.error.conflict': '该文章正在保存或已保存；请重新读取状态后再决定，勿重复提交。',
  'save.error.uncertain': '结果不确定：保存可能已生效；已尝试只读核对，请刷新后确认，勿直接重试。',
  'save.error.notConfigured': 'Margin 尚未配置 Trilium（或目标父笔记不是 Book）。',
  'save.error.notFound': 'Margin 中不存在该文章。',
  'save.error.unauthorized': 'Margin 拒绝凭据（401），请检查 token。',
  'save.error.failed': '保存失败；上游详情未转发（可能包含笔记内容）。',
  'save.error.network': '网络请求失败，结果未知；请只读重新核对，不要直接重试。',
  'save.error.request': '保存请求未通过校验，未做任何修改。',
  'save.error.instanceChanged': 'Margin 实例已变化，保存结果已丢弃；请刷新文章。',
  'progress.position': '阅读位置',
  'progress.saveFailed': '位置未保存（仅本页有效，不会自动重试）',
  'progress.restoredApproximate': '已恢复上次位置（估算，可能不准确）',
  'progress.toc': '目录',
  'progress.tocApproximate': '目录定位为估算：未找到对应标题，已按原文字符比例跳转',
}
