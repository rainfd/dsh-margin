/**
 * Host HTTP routes: the /api/dsh-margin family the browser half calls.
 * Exact plugin routes use DSH Connection's Host/Origin and browser-session checks,
 * matching other DSH plugins while allowing authenticated remote GUI access.
 *
 * Read paths plus an explicit state-assignment endpoint. Writes fail closed
 * unless a live host permission callback grants them; nothing writes Trilium.
 *
 * Note on shape: WebRoute carries no method field, so a path that answers
 * several verbs (config: GET/PUT) dispatches on req.method itself.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import {
  MARGIN_API,
  type MarginApiErrorBody,
  type MarginCandidateStatus,
  type MarginConfigPatch,
  type MarginConfigView,
  type MarginTestResult,
} from './protocol.ts'
import { MarginAuthError, MarginClient, MarginRequestError, MarginShapeError } from './margin.ts'
import { patchConfig, readConfig, toView, validatePatch, writeConfig } from './store.ts'
import { makeImportRoutes, type ImportPermissions } from './importRoutes.ts'
import { makeManagementRoutes, type ManagementPermissions } from './managementRoutes.ts'
import { makeAiRoutes, type AiConfig, type AiPermissions } from './aiRoutes.ts'
import type { LlmLike } from './aiContext.ts'
import { makeSaveRoutes, type SavePermissions } from './saveRoutes.ts'
import { makeAnnotationRoutes, type AnnotationPermissions } from './annotationRoutes.ts'
import { makeProgressRoutes } from './progressRoutes.ts'

const MAX_JSON_BODY_BYTES = 1 << 20

/** Default page size for the reading list. */
const DEFAULT_LIMIT = 60

/** DSH Connection gate used to authenticate remote browser sessions and enforce Host/Origin. */
type ConnectionGate = Pick<HostConnectionHandle, 'requestRejection'>

/** Re-evaluated on every request: a mounted endpoint is not a write grant. */
export interface RoutePermissions extends ImportPermissions, ManagementPermissions, AiPermissions, SavePermissions, AnnotationPermissions {
  allowWrites?: () => boolean
}

function mayWrite(permissions: RoutePermissions): boolean {
  return permissions.allowWrites?.() === true
}

/** Reject requests unless DSH Connection confirms the session and request origin. */
function rejectUntrustedRequest(
  req: IncomingMessage,
  res: ServerResponse,
  connection: ConnectionGate | undefined,
): boolean {
  // Fail closed when the host service was not injected.
  const status = connection?.requestRejection(req) ?? (connection === undefined ? 403 : undefined)
  if (status === undefined) return false
  writeJson(res, status, { error: status === 401 ? 'unauthorized' : 'forbidden: same-origin request required' })
  return true
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** One error response, always in the same envelope. */
function writeError(res: ServerResponse, status: number, code: string, message: string, category?: string, count?: number): void {
  const body: MarginApiErrorBody = {
    error: { code, message, ...(category === undefined ? {} : { category }), ...(count === undefined ? {} : { count }) },
  }
  writeJson(res, status, body)
}

/**
 * Map a client failure to an HTTP status. Bad credentials get their own code
 * so the settings card can say "token rejected" rather than "network error".
 */
function mapClientError(res: ServerResponse, error: unknown): void {
  if (error instanceof MarginAuthError) {
    writeError(res, 401, 'margin_unauthorized', 'Margin 拒绝凭据（401）。请检查 token 是否与实例匹配。')
    return
  }
  if (error instanceof MarginShapeError) {
    writeError(res, 502, 'margin_bad_shape', error.message)
    return
  }
  if (error instanceof MarginRequestError) {
    const status = error.status === 0 ? 504 : (error.status >= 400 && error.status < 600 ? error.status : 502)
    writeError(res, status, 'margin_request_failed', error.message, error.category)
    return
  }
  writeError(res, 500, 'internal_error', '插件内部错误')
}

/** Read and parse a JSON body with a size ceiling. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** Build a client from the current config, or undefined when unconfigured. */
function currentClient(): MarginClient | undefined {
  const config = readConfig()
  if (config.baseUrl === '' || config.token === '') return undefined
  return new MarginClient(config)
}

/** Coerce a query parameter to a known candidate status. */
function parseStatus(raw: string | null): MarginCandidateStatus {
  return raw === 'read' || raw === 'processing' || raw === 'error' ? raw : 'unprocessed'
}

/** Narrow an optional free-text filter. */
function parseOptional(raw: string | null): string | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/** GET/PUT /config. */
async function configRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  if (method === 'GET') {
    writeJson(res, 200, toView(readConfig()) satisfies MarginConfigView)
    return
  }
  if (method !== 'PUT') return writeError(res, 405, 'method_not_allowed', '仅支持 GET / PUT')
  let patch: MarginConfigPatch
  try {
    patch = (await readJsonBody(req)) as MarginConfigPatch
  } catch (error) {
    writeError(res, 400, 'bad_body', error instanceof Error ? error.message : '请求体不合法')
    return
  }
  const problem = validatePatch(patch)
  if (problem !== undefined) {
    writeError(res, 400, 'invalid_config', problem)
    return
  }
  const next = patchConfig(readConfig(), patch)
  writeConfig(next)
  writeJson(res, 200, toView(next) satisfies MarginConfigView)
}

/** POST /test — a failed probe is a 200 with ok:false, not a transport error. */
async function testRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const client = currentClient()
  if (client === undefined) {
    writeJson(res, 200, { ok: false, detail: '未配置 Margin 地址或 token' } satisfies MarginTestResult)
    return
  }
  try {
    const counts = await client.probe()
    writeJson(res, 200, {
      ok: true,
      detail: `连接正常：未读 ${counts.unprocessed} 条、已读 ${counts.read} 条`,
      counts,
    } satisfies MarginTestResult)
  } catch (error) {
    if (error instanceof MarginAuthError) {
      writeJson(res, 200, {
        ok: false,
        detail: 'Margin 拒绝凭据（401）。token 可能属于别的实例。',
      } satisfies MarginTestResult)
      return
    }
    const detail = error instanceof Error ? error.message : '连接失败'
    writeJson(res, 200, { ok: false, detail } satisfies MarginTestResult)
  }
}

/** GET /candidates — the reading list. */
async function candidatesRoute(req: IncomingMessage, res: ServerResponse, permissions: RoutePermissions): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return writeError(res, 405, 'method_not_allowed', '仅支持 GET')
  const client = currentClient()
  if (client === undefined) {
    writeError(res, 409, 'not_configured', '尚未配置 Margin 地址或 token')
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const rawStatus = url.searchParams.get('status')
  if (rawStatus !== null && !['unprocessed', 'read', 'processing', 'error'].includes(rawStatus)) {
    return writeError(res, 400, 'invalid_status', '未知阅读状态')
  }
  const status = parseStatus(rawStatus)
  const sourceType = parseOptional(url.searchParams.get('sourceType'))
  const query = parseOptional(url.searchParams.get('q'))
  const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : DEFAULT_LIMIT
  const rawPage = Number(url.searchParams.get('page') ?? 1)
  if (!Number.isSafeInteger(rawPage) || rawPage <= 0) return writeError(res, 400, 'invalid_page', 'page 必须是正整数')
  try {
    const view = await client.queryReadingList({
      status,
      sourceType: sourceType ?? undefined,
      query: query ?? undefined,
      page: rawPage,
      limit,
    })
    writeJson(res, 200, { ...view, writesAllowed: mayWrite(permissions) })
  } catch (error) {
    mapClientError(res, error)
  }
}

/** GET /candidate?id=N — one candidate. */
async function candidateRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return writeError(res, 405, 'method_not_allowed', '仅支持 GET')
  const client = currentClient()
  if (client === undefined) {
    writeError(res, 409, 'not_configured', '尚未配置 Margin 地址或 token')
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const id = Number(url.searchParams.get('id'))
  if (!Number.isSafeInteger(id) || id <= 0) {
    writeError(res, 400, 'invalid_id', 'id 必须是正整数')
    return
  }
  try {
    const candidate = await client.getCandidate(id)
    if (candidate === undefined) {
      writeError(res, 404, 'not_found', `Margin 中不存在 candidate ${id}`)
      return
    }
    writeJson(res, 200, candidate)
  } catch (error) {
    mapClientError(res, error)
  }
}

/** PATCH /candidate-status: explicit value plus instance-bound article identity. */
async function candidateStatusRoute(req: IncomingMessage, res: ServerResponse, permissions: RoutePermissions): Promise<void> {
  if (req.method !== 'PATCH') return writeError(res, 405, 'method_not_allowed', '仅支持 PATCH')
  if (!mayWrite(permissions)) return writeError(res, 403, 'writes_disabled', 'Margin 写能力未启用')
  let body: unknown
  try { body = await readJsonBody(req) } catch {
    return writeError(res, 400, 'bad_body', '请求体不是合法或大小合适的 JSON')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
  const args = body as Record<string, unknown>
  if (Object.keys(args).some(key => !['id', 'status', 'marginUrl'].includes(key))) return writeError(res, 400, 'bad_body', '包含未知字段')
  const { id, status, marginUrl } = args
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return writeError(res, 400, 'invalid_id', 'id 必须是正整数')
  if (status !== 'read' && status !== 'unprocessed') return writeError(res, 400, 'invalid_status', '只支持 read / unprocessed')
  const config = readConfig()
  if (config.baseUrl === '' || config.token === '') return writeError(res, 409, 'not_configured', '尚未配置 Margin 地址或 token')
  const expectedUrl = `${config.baseUrl.replace(/\/+$/, '')}/reader/${id}`
  if (marginUrl !== expectedUrl) return writeError(res, 409, 'instance_changed', 'Margin 实例已变化，请刷新列表')
  // Authorization may have changed while the request body was being read.
  if (!mayWrite(permissions)) return writeError(res, 403, 'writes_disabled', 'Margin 写能力未启用')
  try {
    const updated = await new MarginClient(config).setCandidateStatus(id, status)
    writeJson(res, 200, updated)
  } catch (error) {
    mapClientError(res, error)
  }
}

/** Every exact route is guarded by DSH Connection's session/origin policy. */
export function makeRoutes(
  connection?: ConnectionGate,
  permissions: RoutePermissions = {},
  ai: { config?: AiConfig; llm?: () => LlmLike | undefined } = {},
): WebRoute[] {
  const routes: WebRoute[] = [
    { kind: 'exact', path: `${MARGIN_API}/config`, handler: configRoute },
    { kind: 'exact', path: `${MARGIN_API}/test`, handler: testRoute },
    { kind: 'exact', path: `${MARGIN_API}/candidates`, handler: (req, res) => candidatesRoute(req, res, permissions) },
    { kind: 'exact', path: `${MARGIN_API}/candidate`, handler: candidateRoute },
    { kind: 'exact', path: `${MARGIN_API}/candidate-status`, handler: (req, res) => candidateStatusRoute(req, res, permissions) },
    ...makeImportRoutes(permissions, { writeJson, writeError, mapClientError, readJsonBody }),
    ...makeManagementRoutes(permissions, { writeJson, writeError, readJsonBody }),
    ...makeAiRoutes(permissions, ai.config ?? {}, { writeJson, writeError, readJsonBody }, ai.llm ?? (() => undefined)),
    ...makeSaveRoutes(permissions, { writeJson, writeError, readJsonBody }),
    ...makeAnnotationRoutes(permissions, { writeJson, writeError, readJsonBody }),
    // Progress is local-only: it needs no content write permission and never
    // touches Margin, so it stays available with every write gate closed.
    ...makeProgressRoutes({ writeJson, writeError, readJsonBody }),
  ]
  return routes.map(route => ({
    ...route,
    handler: (req, res) => {
      if (!rejectUntrustedRequest(req, res, connection)) void route.handler(req, res)
    },
  }))
}
