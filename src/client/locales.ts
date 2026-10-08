/**
 * Copy for the dsh-margin surfaces. Chinese-only by design (same as
 * dsh-trilium's settings card), so `en` mirrors `zh`.
 */

/** Every key the surfaces translate. */
export type MarginKey =
  | 'list.title'
  | 'list.empty'
  | 'list.notConfigured'
  | 'list.loading'
  | 'list.retry'
  | 'list.searchPlaceholder'
  | 'list.allSources'
  | 'list.total'
  | 'list.openSource'
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

/** Chinese dictionary (the source of truth). */
export const zh: Record<MarginKey, string> = {
  'list.title': '待读',
  'list.empty': '没有符合条件的条目',
  'list.notConfigured': '尚未配置 Margin：请在 设置 → Margin 中填写地址与 token',
  'list.loading': '加载中…',
  'list.retry': '重试',
  'list.searchPlaceholder': '搜索标题 / 域名 / 标签',
  'list.allSources': '全部来源',
  'list.total': '共 {total} 条',
  'list.openSource': '打开原文',
  'list.noSummary': '（没有摘要）',
  'list.status.unprocessed': '未读',
  'list.status.read': '已读',
  'list.status.processing': '处理中',
  'list.status.error': '失败',
  'settings.title': 'Margin',
  'settings.description': '阅读内容仓：RSS / 微信 / 视频 / 手动导入的文章。任务账本仍在 Trilium，本插件只读取这里的内容。',
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
}
