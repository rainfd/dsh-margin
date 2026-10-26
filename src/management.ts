/**
 * Pure projections for the source/credential surface.
 *
 * Margin returns the whole RSS `config` dict (user-writable, may contain feed
 * URLs with tokens) and, on some error paths, raw exception text. Nothing here
 * is a pass-through: every field is rebuilt from an allowlist, and URLs are
 * reduced to a bare origin because path/query/userinfo can carry credentials.
 */

import type { MarginCredentialMeta, MarginSchedulerMeta, MarginSourceMeta } from './protocol.ts'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown, max = 255): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''

const iso = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 64) return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

/** Origins only. Anything unparseable, credentialed or non-HTTP yields null. */
export function safeOrigin(value: unknown): string | null {
  // WHATWG URL strips leading/trailing tabs and newlines, so reject them first.
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return null
  if (value.trim() !== value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username !== '' || url.password !== '') return null
    return url.origin
  } catch {
    return null
  }
}

const SOURCE_STATUSES = new Set(['active', 'paused', 'error'])

/**
 * Rebuild one source. `feedOrigin` deliberately drops path and query: a feed
 * URL is exactly the kind of place a private token gets embedded.
 */
export function toSourceMeta(raw: unknown): MarginSourceMeta | undefined {
  if (!record(raw)) return undefined
  const id = raw['id']
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined
  const config = record(raw['config']) ? raw['config'] : {}
  const status = SOURCE_STATUSES.has(String(raw['status'])) ? String(raw['status']) as MarginSourceMeta['status'] : 'unknown'
  const interval = raw['poll_interval_minutes']
  const failures = raw['consecutive_failures']
  return {
    id,
    sourceType: text(raw['source_type'], 32) || 'unknown',
    label: text(raw['label'], 200) || `#${id}`,
    status,
    feedOrigin: safeOrigin(config['feed_url']) ?? '未验证',
    pollIntervalMinutes: typeof interval === 'number' && Number.isFinite(interval) ? interval : 0,
    consecutiveFailures: typeof failures === 'number' && Number.isFinite(failures) ? failures : 0,
    // Presence only: error text can quote a URL that embeds a token.
    hasError: typeof raw['last_error_message'] === 'string' && raw['last_error_message'].trim() !== '',
    lastErrorAt: iso(raw['last_error_at']),
    // Written by the backend only after a fetch, but user-editable in config.
    recordedFetchAt: iso(config['last_fetched_at']),
  }
}

/**
 * Domains the current backend actually consumes. Storing other keys succeeds
 * upstream but does nothing, so the host refuses to promise support for them.
 */
export const SUPPORTED_CREDENTIAL_DOMAINS = ['mp.weixin.qq.com', 'zhihu.com'] as const

/** Lowercase, host-only, no scheme/port/path; undefined when unusable. */
export function canonicalDomain(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '' || trimmed.length > 255 || /[\s/\\@?#:]/.test(trimmed)) return undefined
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(trimmed) || trimmed.includes('..')) return undefined
  return trimmed
}

export function credentialSupported(domain: string): boolean {
  return (SUPPORTED_CREDENTIAL_DOMAINS as readonly string[]).includes(domain)
}

export function toCredentialMeta(raw: unknown): MarginCredentialMeta | undefined {
  if (!record(raw)) return undefined
  const id = raw['id']
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined
  const domain = canonicalDomain(raw['domain'])
  if (domain === undefined) return undefined
  return {
    id,
    domain,
    configured: raw['cookie_configured'] === true,
    supported: credentialSupported(domain),
    createdAt: iso(raw['created_at']),
    updatedAt: iso(raw['updated_at']),
  }
}

export function toSchedulerMeta(raw: unknown): MarginSchedulerMeta {
  const empty: MarginSchedulerMeta = { running: false, sourcePollJobs: 0, jobs: [] }
  if (!record(raw)) return empty
  const jobs: MarginSchedulerMeta['jobs'] = []
  const list = Array.isArray(raw['jobs']) ? raw['jobs'] : []
  for (const job of list.slice(0, 200)) {
    if (!record(job)) continue
    const id = job['content_source_id']
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue
    const interval = job['poll_interval_minutes']
    jobs.push({
      sourceId: id,
      nextRunTime: iso(job['next_run_time']),
      intervalMinutes: typeof interval === 'number' && Number.isFinite(interval) ? interval : null,
    })
  }
  const declared = raw['total_active_jobs']
  return {
    running: raw['scheduler_running'] === true,
    sourcePollJobs: typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 0 ? declared : jobs.length,
    jobs,
  }
}

/** Cookie input checks happen before the secret leaves the browser. */
export function cookieProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return 'Cookie 不能为空'
  if (value.length > 8192) return 'Cookie 过长'
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'Cookie 含控制字符'
  if (!value.includes('=')) return 'Cookie 需为 name=value 形式'
  return undefined
}

/** Fixed wording for upstream failures: never relay backend messages. */
export function safeUpstreamMessage(status: number): { code: string; message: string } {
  if (status === 401 || status === 403) return { code: 'margin_unauthorized', message: 'Margin 拒绝凭据（401），请检查 token' }
  if (status === 404) return { code: 'margin_not_found', message: '目标不存在或已删除' }
  if (status === 422) return { code: 'margin_rejected', message: 'Margin 拒绝了该值（可能是重复域名或格式问题）' }
  if (status === 409) return { code: 'margin_conflict', message: 'Margin 报告冲突或重复' }
  if (status === 504 || status === 0) return { code: 'margin_timeout', message: '结果不确定：请求可能已生效，请重新只读核对' }
  if (status >= 500) return { code: 'margin_upstream_error', message: 'Margin 内部错误；详情未转发（可能含敏感参数）' }
  return { code: 'margin_request_failed', message: `Margin 请求失败（HTTP ${status}）` }
}
