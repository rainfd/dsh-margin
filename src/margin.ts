/**
 * Margin HTTP client. Thin, credential-aware wrapper over Margin's REST API —
 * the counterpart of dsh-trilium's ETAPI client.
 *
 * Two rules this file exists to enforce:
 *  1. The token is sent as `X-Auth-Token` (Margin expects
 *     sha256(AUTH_PASSWORD); the caller stores the already-derived value) and
 *     is never echoed into a message, log line or error detail.
 *  2. A failed request is reported as a typed error with Margin's own
 *     category, so routes can map it to a status code without guessing.
 */

import type { MarginCandidate, MarginCandidatePage, MarginCandidateStatus } from './protocol.ts'

/** Margin rejected our credentials. */
export class MarginAuthError extends Error {
  constructor(message = 'Margin 拒绝凭据（401）') {
    super(message)
    this.name = 'MarginAuthError'
  }
}

/** Margin answered, but not with a shape we understand. */
export class MarginShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarginShapeError'
  }
}

/** Network / timeout / non-2xx that is not an auth failure. */
export class MarginRequestError extends Error {
  readonly status: number
  readonly category: string | undefined
  constructor(message: string, status: number, category?: string) {
    super(message)
    this.name = 'MarginRequestError'
    this.status = status
    this.category = category
  }
}

/** Connection settings this client needs. */
export interface MarginClientOptions {
  baseUrl: string
  token: string
  timeoutMs: number
}

/** Query knobs for the reading list. */
export interface MarginListOptions {
  status?: MarginCandidateStatus
  /** Server-side filter, when Margin supports it (`source_type`). */
  sourceType?: string
  /** Free-text filter applied client-side over title/domain/tags. */
  query?: string
  page?: number
  pageSize?: number
  /** Hard cap on how many items the caller wants back. */
  limit?: number
}

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 200

/** Trim a trailing slash so path joins never double up. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * Margin's candidate payload → our narrower shape. Missing optional fields
 * degrade to safe defaults instead of throwing: one odd row must not blank
 * the whole reading list.
 */
function toCandidate(raw: Record<string, unknown>): MarginCandidate {
  const tags = Array.isArray(raw['tags']) ? raw['tags'].filter((t): t is string => typeof t === 'string') : []
  return {
    id: Number(raw['id']),
    title: String(raw['title'] ?? ''),
    sourceUrl: String(raw['source_url'] ?? ''),
    sourceDomain: String(raw['source_domain'] ?? ''),
    status: (raw['status'] as MarginCandidateStatus) ?? 'unprocessed',
    sourceType: String(raw['source_type'] ?? 'unknown'),
    category: raw['category'] === null || raw['category'] === undefined ? null : String(raw['category']),
    tags,
    author: raw['author'] === null || raw['author'] === undefined ? null : String(raw['author']),
    summaryText: String(raw['summary_text'] ?? ''),
    summary: String(raw['summary'] ?? ''),
    isSavedToTrilium: raw['is_saved_to_trilium'] === true,
    createdAt: String(raw['created_at'] ?? ''),
    updatedAt: String(raw['updated_at'] ?? ''),
  }
}

/** The Margin API client. */
export class MarginClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(options: MarginClientOptions) {
    this.baseUrl = normalizeBase(options.baseUrl)
    this.token = options.token
    this.timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  }

  /** One authorized JSON request. Never surfaces the token in an error. */
  private async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (this.token !== '') headers['X-Auth-Token'] = this.token
      if (init?.body !== undefined) headers['content-type'] = 'application/json'
      response = await fetch(this.baseUrl + path, {
        method: init?.method ?? 'GET',
        headers,
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      })
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError'
        ? `请求超时（${this.timeoutMs}ms）`
        : '无法连接 Margin'
      throw new MarginRequestError(reason, 0)
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 401 || response.status === 403) throw new MarginAuthError()

    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text === '' ? {} : JSON.parse(text)
    } catch {
      throw new MarginShapeError(`Margin 返回了非 JSON 响应（HTTP ${response.status}）`)
    }

    if (!response.ok) {
      // Margin's error envelope: {"error":{"code","category","message",...}}
      const envelope = parsed as { error?: { message?: unknown; category?: unknown } }
      const message = typeof envelope.error?.message === 'string' ? envelope.error.message : `Margin 返回 HTTP ${response.status}`
      const category = typeof envelope.error?.category === 'string' ? envelope.error.category : undefined
      throw new MarginRequestError(message, response.status, category)
    }
    return parsed as T
  }

  /**
   * Read one page of candidates.
   *
   * `query` is filtered client-side: Margin's list endpoint has no documented
   * free-text parameter, and inventing one would silently return everything.
   * The breakdown tally is therefore computed over the rows we actually hold.
   */
  async listCandidates(options: MarginListOptions = {}): Promise<MarginCandidatePage> {
    const status = options.status ?? 'unprocessed'
    const pageSize = Math.min(Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)
    const params = new URLSearchParams({
      status,
      page: String(Math.max(1, options.page ?? 1)),
      page_size: String(pageSize),
    })
    if (options.sourceType !== undefined && options.sourceType !== '') params.set('source_type', options.sourceType)

    const raw = await this.request<Record<string, unknown>>(`/api/candidates?${params.toString()}`)
    const rawItems = Array.isArray(raw['items']) ? raw['items'] : []
    if (!Array.isArray(raw['items'])) throw new MarginShapeError('Margin 响应缺少 items 数组')

    let items = rawItems.map(row => toCandidate(row as Record<string, unknown>))
    const query = options.query?.trim().toLowerCase() ?? ''
    if (query !== '') {
      items = items.filter(candidate =>
        candidate.title.toLowerCase().includes(query)
        || candidate.sourceDomain.toLowerCase().includes(query)
        || candidate.tags.some(tag => tag.toLowerCase().includes(query)),
      )
    }
    if (options.limit !== undefined && options.limit >= 0) items = items.slice(0, options.limit)

    const pagination = (raw['pagination'] ?? {}) as Record<string, unknown>
    return {
      items,
      page: Number(pagination['page'] ?? 1),
      pageSize: Number(pagination['page_size'] ?? pageSize),
      total: Number(pagination['total'] ?? items.length),
      totalPages: Number(pagination['total_pages'] ?? 1),
    }
  }

  /**
   * Read every page of candidates with the given status and tally them by
   * source type. Used by the reading-list header; bounded so a pathological
   * result set cannot spin forever.
   */
  async tallyBySource(status: MarginCandidateStatus = 'unprocessed', maxPages = 20): Promise<{
    counts: Map<string, number>
    total: number
    truncated: boolean
  }> {
    const counts = new Map<string, number>()
    let page = 1
    let total = 0
    let totalPages = 1
    let truncated = false
    for (;;) {
      const result = await this.listCandidates({ status, page, pageSize: DEFAULT_PAGE_SIZE })
      total = result.total
      totalPages = result.totalPages
      for (const item of result.items) counts.set(item.sourceType, (counts.get(item.sourceType) ?? 0) + 1)
      if (page >= totalPages) break
      if (page >= maxPages) {
        truncated = true
        break
      }
      page += 1
    }
    return { counts, total, truncated }
  }

  /** Read one candidate by id; undefined when Margin has no such row (404). */
  async getCandidate(id: number): Promise<MarginCandidate | undefined> {
    try {
      const raw = await this.request<Record<string, unknown>>(`/api/candidates/${id}`)
      return toCandidate(raw)
    } catch (error) {
      if (error instanceof MarginRequestError && error.status === 404) return undefined
      throw error
    }
  }

  /** Mark a candidate read/unread. Explicit value — never a toggle. */
  async setCandidateStatus(id: number, status: MarginCandidateStatus): Promise<MarginCandidate> {
    const raw = await this.request<Record<string, unknown>>(`/api/candidates/${id}/status`, {
      method: 'PATCH',
      body: { status },
    })
    return toCandidate(raw)
  }

  /** Counts for the connection self-test. */
  async probe(): Promise<{ unprocessed: number; read: number }> {
    const [unprocessed, read] = await Promise.all([
      this.listCandidates({ status: 'unprocessed', pageSize: 1 }),
      this.listCandidates({ status: 'read', pageSize: 1 }),
    ])
    return { unprocessed: unprocessed.total, read: read.total }
  }
}
