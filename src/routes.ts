/**
 * Host HTTP routes: the /api/dsh-margin family the browser half calls.
 * Loopback-only (identical trust model to dsh-trilium) — the config endpoint
 * handles the Margin credential, so it must never be reachable cross-origin.
 *
 * Read-only in this stage: config, test, reading list and single candidate.
 * No route writes to Margin or Trilium.
 *
 * Note on shape: WebRoute carries no method field, so a path that answers
 * several verbs (config: GET/PUT) dispatches on req.method itself.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  MARGIN_API,
  type MarginApiErrorBody,
  type MarginCandidateStatus,
  type MarginConfigPatch,
  type MarginConfigView,
  type MarginReadingView,
  type MarginTestResult,
} from './protocol.ts'
import { MarginAuthError, MarginClient, MarginRequestError, MarginShapeError } from './margin.ts'
import { patchConfig, readConfig, toView, validatePatch, writeConfig } from './store.ts'

const MAX_JSON_BODY_BYTES = 1 << 20

/** Default page size for the reading list. */
const DEFAULT_LIMIT = 60

/**
 * Same-origin + loopback guard. The remote address must be loopback (dsh web
 * binds loopback; a reverse proxy therefore lands here as 127.0.0.1), and a
 * browser request must be same-origin and not cross-site. Host itself need not
 * be localhost, because the GUI is commonly served behind a proxy.
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin !== undefined && host !== undefined) {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
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
function writeError(res: ServerResponse, status: number, code: string, message: string, category?: string): void {
  const body: MarginApiErrorBody = { error: { code, message, ...(category === undefined ? {} : { category }) } }
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
  if (!isLoopbackRequest(req)) return writeError(res, 403, 'forbidden', 'forbidden: loopback-only')
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
  if (!isLoopbackRequest(req)) return writeError(res, 403, 'forbidden', 'forbidden: loopback-only')
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
async function candidatesRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopbackRequest(req)) return writeError(res, 403, 'forbidden', 'forbidden: loopback-only')
  if ((req.method ?? 'GET') !== 'GET') return writeError(res, 405, 'method_not_allowed', '仅支持 GET')
  const client = currentClient()
  if (client === undefined) {
    writeError(res, 409, 'not_configured', '尚未配置 Margin 地址或 token')
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const status = parseStatus(url.searchParams.get('status'))
  const sourceType = parseOptional(url.searchParams.get('sourceType'))
  const query = parseOptional(url.searchParams.get('q'))
  const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : DEFAULT_LIMIT
  try {
    const page = await client.listCandidates({
      status,
      sourceType: sourceType ?? undefined,
      query: query ?? undefined,
      limit,
    })
    // The breakdown describes the whole result set, so it is read without the
    // free-text filter applied — it answers "what is in my backlog", not
    // "what is on screen".
    const tally = await client.tallyBySource(status)
    const view: MarginReadingView = {
      items: page.items,
      breakdown: [...tally.counts.entries()]
        .map(([sourceType, count]) => ({ sourceType, count }))
        .sort((a, b) => b.count - a.count),
      total: page.total,
      page: page.page,
      totalPages: page.totalPages,
      applied: { status, sourceType, query, limit: page.items.length },
    }
    writeJson(res, 200, view)
  } catch (error) {
    mapClientError(res, error)
  }
}

/** GET /candidate?id=N — one candidate. */
async function candidateRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopbackRequest(req)) return writeError(res, 403, 'forbidden', 'forbidden: loopback-only')
  if ((req.method ?? 'GET') !== 'GET') return writeError(res, 405, 'method_not_allowed', '仅支持 GET')
  const client = currentClient()
  if (client === undefined) {
    writeError(res, 409, 'not_configured', '尚未配置 Margin 地址或 token')
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const id = Number(url.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) {
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

/** The route family. */
export function makeRoutes(): WebRoute[] {
  return [
    { kind: 'exact', path: `${MARGIN_API}/config`, handler: configRoute },
    { kind: 'exact', path: `${MARGIN_API}/test`, handler: testRoute },
    { kind: 'exact', path: `${MARGIN_API}/candidates`, handler: candidatesRoute },
    { kind: 'exact', path: `${MARGIN_API}/candidate`, handler: candidateRoute },
  ]
}
