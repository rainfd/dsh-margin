/**
 * Source / credential management routes.
 *
 * Everything upstream-side is treated as hostile: `config` dicts, feed URLs,
 * error strings and validation details can all carry secrets. Responses are
 * rebuilt from management.ts projections, and upstream messages are replaced
 * with fixed wording. Credential input goes browser → host → Margin exactly
 * once and is never read back, logged, or echoed.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { MarginAuthError, MarginClient } from './margin.ts'
import {
  canonicalDomain, cookieProblem, credentialSupported, safeUpstreamMessage,
  toCredentialMeta, toSchedulerMeta, toSourceMeta,
} from './management.ts'
import { MARGIN_API, type MarginManagementView } from './protocol.ts'
import { readConfig, type MarginConfig } from './store.ts'
import { validImportUrl } from './importRoutes.ts'

export interface ManagementPermissions {
  allowSourceWrites?: () => boolean
  allowCredentialWrites?: () => boolean
}

interface Responses {
  writeJson: (res: ServerResponse, status: number, body: unknown) => void
  writeError: (res: ServerResponse, status: number, code: string, message: string, category?: string, count?: number) => void
  readJsonBody: (req: IncomingMessage) => Promise<unknown>
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const instanceOf = (config: MarginConfig): string => config.baseUrl.replace(/\/+$/, '')

/** Status for a failed upstream call, with a message that cannot leak a body. */
function fail(res: ServerResponse, writeError: Responses['writeError'], error: unknown): void {
  if (error instanceof MarginAuthError) {
    writeError(res, 401, 'margin_unauthorized', 'Margin 拒绝凭据（401），请检查 token')
    return
  }
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number' && status !== 0 && (status < 400 || status > 599)) {
    writeError(res, 502, 'margin_bad_shape', 'Margin 返回了无法解析的数据')
    return
  }
  const mapped = safeUpstreamMessage(typeof status === 'number' ? status : 0)
  writeError(res, typeof status === 'number' && status >= 400 && status < 600 ? status : 504, mapped.code, mapped.message)
}

/** Every mutation body must name the instance it was rendered from. */
const INSTANCE_FIELDS = ['instanceUrl'] as const

function bodyProblem(args: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  if (Object.keys(args).some(key => !allowed.includes(key) && !(INSTANCE_FIELDS as readonly string[]).includes(key))) {
    return '请求包含未知字段'
  }
  return undefined
}

export function makeManagementRoutes(permissions: ManagementPermissions, responses: Responses): WebRoute[] {
  const { writeJson, writeError, readJsonBody } = responses
  const allowed = (kind: 'source' | 'credential'): boolean =>
    (kind === 'source' ? permissions.allowSourceWrites?.() : permissions.allowCredentialWrites?.()) === true

  /** Read config or answer 409; undefined means the response is already sent. */
  const configured = (res: ServerResponse): MarginConfig | undefined => {
    const config = readConfig()
    if (config.baseUrl === '' || config.token === '') {
      writeError(res, 409, 'not_configured', '尚未配置 Margin 地址或 token')
      return undefined
    }
    return config
  }

  const sameInstance = (res: ServerResponse, config: MarginConfig, value: unknown): boolean => {
    if (value === instanceOf(config)) return true
    writeError(res, 409, 'instance_changed', 'Margin 实例已变化，请刷新来源面板')
    return false
  }

  const grant = (res: ServerResponse, kind: 'source' | 'credential'): boolean => {
    if (allowed(kind)) return true
    writeError(res, 403, 'writes_disabled', kind === 'source' ? '来源管理未启用' : '凭据管理未启用')
    return false
  }

  return [
    { kind: 'exact', path: `${MARGIN_API}/management`, async handler(req, res) {
      if ((req.method ?? 'GET') !== 'GET') return writeError(res, 405, 'method_not_allowed', '仅支持 GET')
      const config = configured(res); if (!config) return
      const client = new MarginClient(config)
      try {
        const [rawSources, rawCredentials, scheduler] = await Promise.all([
          client.listContentSources(),
          client.listDomainCredentials(),
          client.schedulerStatus(),
        ])
        const sources = rawSources.map(toSourceMeta).filter(value => value !== undefined)
        const credentials = rawCredentials.map(toCredentialMeta).filter(value => value !== undefined)
        writeJson(res, 200, {
          instanceUrl: instanceOf(config),
          observedAt: new Date().toISOString(),
          sourceWritesAllowed: allowed('source'),
          credentialWritesAllowed: allowed('credential'),
          sources,
          credentials,
          scheduler: toSchedulerMeta(scheduler),
        } satisfies MarginManagementView)
      } catch (error) { fail(res, writeError, error) }
    } },

    { kind: 'exact', path: `${MARGIN_API}/source-create`, async handler(req, res) {
      if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
      if (!grant(res, 'source')) return
      let body: unknown
      try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
      if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
      const problem = bodyProblem(body, ['feedUrl', 'label', 'intervalMinutes'])
      if (problem) return writeError(res, 400, 'bad_body', problem)
      const { feedUrl, label, intervalMinutes } = body
      if (!validImportUrl(feedUrl)) return writeError(res, 400, 'invalid_feed_url', '请输入不含凭据的公共 HTTP(S) 订阅地址')
      if (typeof label !== 'string' || label.trim() === '' || label.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(label)) {
        return writeError(res, 400, 'invalid_label', '名称需为 1–120 个可见字符')
      }
      if (!Number.isSafeInteger(intervalMinutes) || (intervalMinutes as number) < 5 || (intervalMinutes as number) > 10080) {
        return writeError(res, 400, 'invalid_interval', '轮询间隔需为 5–10080 分钟')
      }
      const config = configured(res); if (!config || !sameInstance(res, config, body.instanceUrl) || !grant(res, 'source')) return
      try {
        const raw = await new MarginClient(config).createContentSource(feedUrl, label.trim(), intervalMinutes as number)
        const source = toSourceMeta(raw)
        if (source === undefined) return writeError(res, 502, 'margin_bad_shape', 'Margin 返回了无法解析的来源')
        writeJson(res, 201, { instanceUrl: instanceOf(config), source })
      } catch (error) { fail(res, writeError, error) }
    } },

    { kind: 'exact', path: `${MARGIN_API}/source-update`, async handler(req, res) {
      if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
      if (!grant(res, 'source')) return
      let body: unknown
      try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
      if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
      const problem = bodyProblem(body, ['id', 'status'])
      if (problem) return writeError(res, 400, 'bad_body', problem)
      const { id, status } = body
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return writeError(res, 400, 'invalid_id', 'id 必须是正整数')
      if (status !== 'active' && status !== 'paused') return writeError(res, 400, 'invalid_status', '只支持 active / paused')
      const config = configured(res); if (!config || !sameInstance(res, config, body.instanceUrl) || !grant(res, 'source')) return
      try {
        const source = toSourceMeta(await new MarginClient(config).setContentSourceStatus(id, status))
        if (source === undefined) return writeError(res, 502, 'margin_bad_shape', 'Margin 返回了无法解析的来源')
        writeJson(res, 200, { instanceUrl: instanceOf(config), source })
      } catch (error) { fail(res, writeError, error) }
    } },

    { kind: 'exact', path: `${MARGIN_API}/source-fetch`, async handler(req, res) {
      if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
      if (!grant(res, 'source')) return
      let body: unknown
      try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
      if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
      const problem = bodyProblem(body, ['id'])
      if (problem) return writeError(res, 400, 'bad_body', problem)
      const id = body.id
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return writeError(res, 400, 'invalid_id', 'id 必须是正整数')
      const config = configured(res); if (!config || !sameInstance(res, config, body.instanceUrl) || !grant(res, 'source')) return
      try {
        const result = await new MarginClient(config).fetchContentSource(id)
        // 200 means the request finished upstream; newCandidates may still be 0.
        writeJson(res, 200, { instanceUrl: instanceOf(config), id, newCandidates: result.newCandidates, message: result.message })
      } catch (error) { fail(res, writeError, error) }
    } },

    { kind: 'exact', path: `${MARGIN_API}/source-delete`, async handler(req, res) {
      if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
      if (!grant(res, 'source')) return
      let body: unknown
      try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
      if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
      const problem = bodyProblem(body, ['id', 'confirmOrigin'])
      if (problem) return writeError(res, 400, 'bad_body', problem)
      const { id, confirmOrigin } = body
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return writeError(res, 400, 'invalid_id', 'id 必须是正整数')
      if (typeof confirmOrigin !== 'string' || confirmOrigin === '') return writeError(res, 400, 'confirm_required', '删除需确认来源标识')
      const config = configured(res); if (!config || !sameInstance(res, config, body.instanceUrl) || !grant(res, 'source')) return
      try {
        const client = new MarginClient(config)
        // Re-read before deleting: the confirmation must match live state.
        const sources = await client.listContentSources()
        const target = sources.map(toSourceMeta).find(source => source?.id === id)
        if (target === undefined) return writeError(res, 404, 'not_found', '来源不存在或已变化')
        if (target.feedOrigin !== confirmOrigin) return writeError(res, 409, 'confirmation_mismatch', '确认信息与当前来源不符，请刷新后重试')
        await client.deleteContentSource(id)
        // Deleting a source never deletes its articles, so say so plainly.
        writeJson(res, 200, { instanceUrl: instanceOf(config), deletedId: id, articlesRetained: true })
      } catch (error) { fail(res, writeError, error) }
    } },

    { kind: 'exact', path: `${MARGIN_API}/credential-create`, async handler(req, res) {
      if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
      if (!grant(res, 'credential')) return
      let body: unknown
      try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
      if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
      const problem = bodyProblem(body, ['domain', 'cookie'])
      if (problem) return writeError(res, 400, 'bad_body', problem)
      const domain = canonicalDomain(body.domain)
      if (domain === undefined) return writeError(res, 400, 'invalid_domain', '域名需为小写主机名，不含协议、端口或路径')
      if (!credentialSupported(domain)) {
        return writeError(res, 400, 'unsupported_domain', '当前后端没有该域名的 Cookie 消费逻辑；支持 mp.weixin.qq.com 与 zhihu.com')
      }
      const cookieIssue = cookieProblem(body.cookie)
      if (cookieIssue !== undefined) return writeError(res, 400, 'invalid_cookie', cookieIssue)
      const config = configured(res); if (!config || !sameInstance(res, config, body.instanceUrl) || !grant(res, 'credential')) return
      try {
        const created = await new MarginClient(config).createDomainCredential(domain, body.cookie as string)
        // Never echo the submitted cookie, not even a prefix.
        writeJson(res, 201, { instanceUrl: instanceOf(config), credential: { id: created.id, domain, configured: true } })
      } catch (error) { fail(res, writeError, error) }
    } },

    { kind: 'exact', path: `${MARGIN_API}/credential-delete`, async handler(req, res) {
      if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
      if (!grant(res, 'credential')) return
      let body: unknown
      try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
      if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
      const problem = bodyProblem(body, ['id', 'domain'])
      if (problem) return writeError(res, 400, 'bad_body', problem)
      const { id } = body
      const domain = canonicalDomain(body.domain)
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return writeError(res, 400, 'invalid_id', 'id 必须是正整数')
      if (domain === undefined) return writeError(res, 400, 'invalid_domain', '域名不合法')
      const config = configured(res); if (!config || !sameInstance(res, config, body.instanceUrl) || !grant(res, 'credential')) return
      try {
        const client = new MarginClient(config)
        const live = (await client.listDomainCredentials()).map(toCredentialMeta)
          .find(credential => credential?.id === id)
        if (live === undefined || live.domain !== domain) return writeError(res, 404, 'not_found', '凭据不存在或已变化')
        await client.deleteDomainCredential(id)
        writeJson(res, 200, { instanceUrl: instanceOf(config), deletedId: id, domain })
      } catch (error) { fail(res, writeError, error) }
    } },

  ]
}
