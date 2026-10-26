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

import { MARGIN_MAX_PDF_BYTES } from './protocol.ts'
import type { MarginCandidate, MarginCandidateDetail, MarginCandidatePage, MarginCandidateStatus, MarginImportTask, MarginReadingView, MarginReadStatus, MarginStatusUpdate } from './protocol.ts'

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
  /** Exact source-type filter applied locally (unsupported upstream). */
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
const MAX_PAGE_SIZE = 100

/** Normalize untrusted numeric knobs without ever producing NaN/Infinity. */
function boundedInteger(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.min(max, Math.max(1, value))
    : fallback
}

function matchesQuery(candidate: MarginCandidate, query: string): boolean {
  return candidate.title.toLowerCase().includes(query)
    || candidate.sourceDomain.toLowerCase().includes(query)
    || candidate.tags.some(tag => tag.toLowerCase().includes(query))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trim a trailing slash so path joins never double up. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * Margin's candidate payload → our narrower shape. Missing optional fields
 * degrade to safe defaults instead of throwing: one odd row must not blank
 * the whole reading list.
 */
function toCandidate(raw: Record<string, unknown>, baseUrl: string): MarginCandidate {
  const tags = Array.isArray(raw['tags']) ? raw['tags'].filter((t): t is string => typeof t === 'string') : []
  return {
    id: Number(raw['id']),
    title: String(raw['title'] ?? ''),
    sourceUrl: String(raw['source_url'] ?? ''),
    marginUrl: `${baseUrl}/reader/${Number(raw['id'])}`,
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

  private scrub(value: string): string {
    return this.token === '' ? value : value.split(this.token).join('[redacted]')
  }

  /** Authorized JSON/multipart request; the deadline includes reading the body. */
  private async request<T>(path: string, init?: { method?: string; body?: unknown; expectedStatus?: number }): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (this.token !== '') headers['X-Auth-Token'] = this.token
      const multipart = init?.body instanceof FormData
      if (init?.body !== undefined && !multipart) headers['content-type'] = 'application/json'
      const response = await fetch(this.baseUrl + path, {
        method: init?.method ?? 'GET',
        headers,
        body: init?.body === undefined ? undefined : multipart ? init.body as FormData : JSON.stringify(init.body),
        signal: controller.signal,
      })
      if (response.status === 401 || response.status === 403) throw new MarginAuthError()
      if (response.ok && init?.expectedStatus !== undefined && response.status !== init.expectedStatus) {
        throw new MarginShapeError(`Margin 返回了非预期状态（HTTP ${response.status}）`)
      }
      const text = await response.text()
      let parsed: unknown
      try {
        parsed = text === '' ? {} : JSON.parse(text)
      } catch {
        // A proxy/HTML error page must keep its status class: a non-JSON 404 is
        // a missing article, not a malformed success response.
        if (!response.ok) throw new MarginRequestError(this.scrub(`Margin 返回了非 JSON 错误响应（HTTP ${response.status}）`), response.status)
        throw new MarginShapeError(`Margin 返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!response.ok) {
        // FastAPI may nest the same error envelope under detail.
        const envelope = isRecord(parsed) && isRecord(parsed['error']) ? parsed['error']
          : isRecord(parsed) && isRecord(parsed['detail']) && isRecord(parsed['detail']['error']) ? parsed['detail']['error'] : undefined
        const message = typeof envelope?.['message'] === 'string' ? envelope['message'] : `Margin 返回 HTTP ${response.status}`
        const category = typeof envelope?.['category'] === 'string' ? this.scrub(envelope['category']) : undefined
        throw new MarginRequestError(this.scrub(message), response.status, category)
      }
      return parsed as T
    } catch (error) {
      if (error instanceof MarginAuthError || error instanceof MarginShapeError || error instanceof MarginRequestError) throw error
      const reason = controller.signal.aborted ? `请求超时（${this.timeoutMs}ms）` : '无法连接 Margin'
      throw new MarginRequestError(this.scrub(reason), 0)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Import views deliberately allow only bounded metadata, never article bodies. */
  private toImportTask(raw: unknown): MarginImportTask {
    if (!isRecord(raw) || typeof raw['id'] !== 'number' || !Number.isSafeInteger(raw['id']) || raw['id'] <= 0) {
      throw new MarginShapeError('Margin 导入任务 ID 不合法')
    }
    const text = (value: unknown, max: number): string => typeof value === 'string'
      ? this.scrub(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : ''
    let sourceUrl = text(raw['source_url'], 8192)
    try {
      const url = new URL(sourceUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) sourceUrl = ''
    } catch { sourceUrl = '' }
    const status = raw['status']
    return {
      id: raw['id'],
      title: text(raw['title'], 512),
      sourceUrl,
      sourceType: text(raw['source_type'], 64),
      status: status === 'unprocessed' || status === 'processing' || status === 'read' || status === 'error' ? status : 'unknown',
      marginUrl: `${this.baseUrl}/reader/${raw['id']}`,
      errorMessage: typeof raw['error_message'] === 'string' ? text(raw['error_message'], 1024) : null,
      createdAt: text(raw['created_at'], 128),
    }
  }

  async listImportQueue(): Promise<MarginImportTask[]> {
    const raw = await this.request<unknown>('/api/imports/queue?limit=20')
    if (!Array.isArray(raw)) throw new MarginShapeError('Margin 导入队列响应缺少数组')
    return raw.slice(0, 20).map(row => this.toImportTask(row))
  }

  async getImportTask(id: number): Promise<MarginImportTask | undefined> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new MarginShapeError('Margin 导入任务 ID 不合法')
    try {
      const task = this.toImportTask(await this.request<unknown>(`/api/candidates/${id}`))
      if (task.id !== id) throw new MarginShapeError('Margin 导入任务 ID 不匹配')
      return task
    } catch (error) {
      if (error instanceof MarginRequestError && error.status === 404) return undefined
      throw error
    }
  }

  private async submitImport(path: string, body: unknown): Promise<MarginImportTask> {
    const task = this.toImportTask(await this.request<unknown>(path, { method: 'POST', body, expectedStatus: 202 }))
    if (task.status !== 'processing') throw new MarginShapeError('Margin 导入确认状态不合法')
    return task
  }

  async importUrl(url: string): Promise<MarginImportTask> {
    if (typeof url !== 'string' || url.length > 8192) throw new MarginShapeError('Margin 导入 URL 不合法')
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error()
    } catch { throw new MarginShapeError('Margin 导入 URL 不合法') }
    return this.submitImport('/api/imports', { url })
  }

  async importPdf(bytes: Uint8Array, filename: string): Promise<MarginImportTask> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MARGIN_MAX_PDF_BYTES
      || ![0x25, 0x50, 0x44, 0x46, 0x2d].every((byte, index) => bytes[index] === byte)) {
      throw new MarginShapeError('Margin PDF 文件大小或格式不合法')
    }
    if (typeof filename !== 'string') throw new MarginShapeError('Margin PDF 文件名不合法')
    const basename = (filename.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f";]/g, '').trim()
    if (!/^.+\.pdf$/i.test(basename) || basename === '..pdf') throw new MarginShapeError('Margin PDF 文件名不合法')
    const safeName = basename.slice(0, -4).slice(0, 124) + '.pdf'
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), safeName)
    return this.submitImport('/api/imports/pdf', form)
  }

  /**
   * Raw source rows. Only management.ts projects them; the whole `config` dict
   * is never returned to the browser.
   */
  async listContentSources(): Promise<unknown[]> {
    const raw = await this.request<unknown>('/api/content-sources')
    if (!isRecord(raw) || !Array.isArray(raw['items'])) throw new MarginShapeError('Margin 来源列表响应缺少 items')
    return raw['items'].slice(0, 500)
  }

  /** Create one RSS source; returns the raw row for the caller's projection. */
  async createContentSource(feedUrl: string, label: string, intervalMinutes: number): Promise<unknown> {
    return this.request<unknown>('/api/content-sources', {
      method: 'POST',
      body: { source_type: 'rss', label, poll_interval_minutes: intervalMinutes, config: { feed_url: feedUrl } },
      expectedStatus: 201,
    })
  }

  /** Only status is mutable from the plugin: label/config edits can wipe secrets. */
  async setContentSourceStatus(id: number, status: 'active' | 'paused'): Promise<unknown> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new MarginShapeError('Margin 来源 ID 不合法')
    return this.request<unknown>(`/api/content-sources/${id}`, { method: 'PATCH', body: { status } })
  }

  async deleteContentSource(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new MarginShapeError('Margin 来源 ID 不合法')
    await this.request<unknown>(`/api/content-sources/${id}`, { method: 'DELETE', expectedStatus: 204 })
  }

  /** Manual fetch; a 200 does not prove new articles were produced. */
  async fetchContentSource(id: number): Promise<{ newCandidates: number; message: string }> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new MarginShapeError('Margin 来源 ID 不合法')
    const raw = await this.request<unknown>(`/api/content-sources/${id}/fetch`, { method: 'POST' })
    if (!isRecord(raw) || raw['content_source_id'] !== id) throw new MarginShapeError('Margin 抓取确认不匹配')
    const count = raw['new_candidates_count']
    return {
      newCandidates: typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0,
      message: '已请求抓取；结果以后续状态与列表为准',
    }
  }

  async listDomainCredentials(): Promise<unknown[]> {
    const raw = await this.request<unknown>('/api/domain-credentials')
    if (!isRecord(raw) || !Array.isArray(raw['items'])) throw new MarginShapeError('Margin 凭据列表响应缺少 items')
    return raw['items'].slice(0, 200)
  }

  /** Write-only secret path. The response body is discarded except for the id. */
  async createDomainCredential(domain: string, cookie: string): Promise<{ id: number; domain: string }> {
    const raw = await this.request<unknown>('/api/domain-credentials', {
      method: 'POST',
      body: { domain, cookie_string: cookie },
      expectedStatus: 201,
    })
    if (!isRecord(raw) || typeof raw['id'] !== 'number' || !Number.isSafeInteger(raw['id']) || raw['id'] <= 0) {
      throw new MarginShapeError('Margin 凭据创建确认不合法')
    }
    return { id: raw['id'], domain: typeof raw['domain'] === 'string' ? raw['domain'] : domain }
  }

  async deleteDomainCredential(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new MarginShapeError('Margin 凭据 ID 不合法')
    await this.request<unknown>(`/api/domain-credentials/${id}`, { method: 'DELETE', expectedStatus: 204 })
  }

  async schedulerStatus(): Promise<unknown> {
    return this.request<unknown>('/api/scheduler/status')
  }

  /**
   * Save one candidate to Trilium through Margin's own save endpoint.
   *
   * The plugin deliberately does not call ETAPI itself: Margin owns the target
   * parent note, the assembled content and the SaveRecord, so there is exactly
   * one writer. A 409 here is genuinely ambiguous (already saved vs in-flight),
   * so the caller must re-read state rather than assume failure.
   */
  async saveToTrilium(candidateId: number): Promise<unknown> {
    if (!Number.isSafeInteger(candidateId) || candidateId <= 0) throw new MarginShapeError('Margin candidate ID 不合法')
    return this.request<unknown>('/api/trilium/save', { method: 'POST', body: { candidate_id: candidateId } })
  }

  /** Notes for one candidate; Margin returns them oldest first. */
  async listNotes(candidateId: number): Promise<unknown[]> {
    if (!Number.isSafeInteger(candidateId) || candidateId <= 0) throw new MarginShapeError('Margin candidate ID 不合法')
    const raw = await this.request<unknown>(`/api/candidates/${candidateId}/notes`)
    if (!isRecord(raw) || !Array.isArray(raw['notes'])) throw new MarginShapeError('Margin 笔记响应缺少 notes')
    return raw['notes'].slice(0, 500)
  }

  async createNote(candidateId: number, content: string): Promise<unknown> {
    if (!Number.isSafeInteger(candidateId) || candidateId <= 0) throw new MarginShapeError('Margin candidate ID 不合法')
    return this.request<unknown>(`/api/candidates/${candidateId}/notes`, {
      method: 'POST', body: { content }, expectedStatus: 201,
    })
  }

  /** Whole-content update via PUT; Margin has no partial patch for notes. */
  async updateNote(noteId: number, content: string): Promise<unknown> {
    if (!Number.isSafeInteger(noteId) || noteId <= 0) throw new MarginShapeError('Margin 笔记 ID 不合法')
    return this.request<unknown>(`/api/notes/${noteId}`, { method: 'PUT', body: { content } })
  }

  async deleteNote(noteId: number): Promise<void> {
    if (!Number.isSafeInteger(noteId) || noteId <= 0) throw new MarginShapeError('Margin 笔记 ID 不合法')
    await this.request<unknown>(`/api/notes/${noteId}`, { method: 'DELETE', expectedStatus: 204 })
  }

  async listHighlights(candidateId: number): Promise<unknown[]> {
    if (!Number.isSafeInteger(candidateId) || candidateId <= 0) throw new MarginShapeError('Margin candidate ID 不合法')
    const raw = await this.request<unknown>(`/api/candidates/${candidateId}/highlights`)
    if (!Array.isArray(raw)) throw new MarginShapeError('Margin 高亮响应不是数组')
    return raw.slice(0, 500)
  }

  async createHighlight(candidateId: number, body: { start: number; end: number; selectedText: string; fingerprint: string; noteId?: number }): Promise<unknown> {
    if (!Number.isSafeInteger(candidateId) || candidateId <= 0) throw new MarginShapeError('Margin candidate ID 不合法')
    return this.request<unknown>(`/api/candidates/${candidateId}/highlights`, {
      method: 'POST',
      body: {
        start_offset: body.start,
        end_offset: body.end,
        selected_text: body.selectedText,
        text_fingerprint: body.fingerprint,
        ...(body.noteId === undefined ? {} : { note_id: body.noteId }),
      },
      expectedStatus: 201,
    })
  }

  /** Link or unlink a highlight; `null` detaches without deleting either side. */
  async linkHighlight(highlightId: number, noteId: number | null): Promise<unknown> {
    if (!Number.isSafeInteger(highlightId) || highlightId <= 0) throw new MarginShapeError('Margin 高亮 ID 不合法')
    return this.request<unknown>(`/api/highlights/${highlightId}`, { method: 'PATCH', body: { note_id: noteId } })
  }

  async deleteHighlight(highlightId: number): Promise<void> {
    if (!Number.isSafeInteger(highlightId) || highlightId <= 0) throw new MarginShapeError('Margin 高亮 ID 不合法')
    await this.request<unknown>(`/api/highlights/${highlightId}`, { method: 'DELETE', expectedStatus: 204 })
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
    const pageSize = boundedInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    const params = new URLSearchParams({
      status,
      page: String(Math.max(1, options.page ?? 1)),
      page_size: String(pageSize),
    })

    const raw = await this.request<Record<string, unknown>>(`/api/candidates?${params.toString()}`)
    const rawItems = Array.isArray(raw['items']) ? raw['items'] : []
    if (!Array.isArray(raw['items'])) throw new MarginShapeError('Margin 响应缺少 items 数组')

    let items = rawItems.map(row => toCandidate(row as Record<string, unknown>, this.baseUrl))
    const query = options.query?.trim().toLowerCase() ?? ''
    if (query !== '') items = items.filter(candidate => matchesQuery(candidate, query))
    if (options.sourceType !== undefined && options.sourceType !== '') {
      items = items.filter(candidate => candidate.sourceType === options.sourceType)
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

  /** Scan a bounded upstream snapshot, then filter and paginate it locally. */
  async queryReadingList(options: MarginListOptions = {}, maxPages = 20): Promise<MarginReadingView> {
    const status = options.status ?? 'unprocessed'
    const sourceType = options.sourceType?.trim() || null
    const query = options.query?.trim() || null
    const pageSize = boundedInteger(options.limit ?? options.pageSize, 60, MAX_PAGE_SIZE)
    const requestLimit = boundedInteger(maxPages, 20, 20)
    const scanned = new Map<number, MarginCandidate>()
    let upstreamTotal = 0
    let previousTotal: number | undefined
    let totalExact = true
    let truncated = false

    for (let upstreamPage = 1; upstreamPage <= requestLimit; upstreamPage += 1) {
      const params = new URLSearchParams({ status, page: String(upstreamPage), page_size: String(MAX_PAGE_SIZE) })
      const raw = await this.request<unknown>(`/api/candidates?${params.toString()}`)
      if (!isRecord(raw) || !Array.isArray(raw['items']) || !isRecord(raw['pagination'])) {
        throw new MarginShapeError('Margin 列表分页响应结构不合法')
      }
      const pagination = raw['pagination']
      const page = pagination['page']
      const size = pagination['page_size']
      const total = pagination['total']
      const totalPages = pagination['total_pages']
      if (typeof page !== 'number' || !Number.isSafeInteger(page) || page !== upstreamPage
        || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_PAGE_SIZE
        || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0
        || typeof totalPages !== 'number' || !Number.isSafeInteger(totalPages) || totalPages < 0
        || (total > 0 && totalPages < 1)) {
        throw new MarginShapeError('Margin 列表分页响应结构不合法')
      }
      if (previousTotal !== undefined && total !== previousTotal) totalExact = false
      previousTotal = total
      upstreamTotal = total
      for (const row of raw['items']) {
        if (!isRecord(row) || typeof row['id'] !== 'number' || !Number.isSafeInteger(row['id']) || row['id'] <= 0) {
          throw new MarginShapeError('Margin 列表候选 ID 不合法')
        }
        const candidate = toCandidate(row, this.baseUrl)
        if (scanned.has(candidate.id)) totalExact = false
        else scanned.set(candidate.id, candidate)
      }
      const lastPage = upstreamPage >= totalPages
      if (raw['items'].length === 0 || lastPage) {
        // An empty/last page can still be incomplete during upstream mutation.
        truncated = (!lastPage && raw['items'].length === 0) || scanned.size < upstreamTotal
        if (truncated) totalExact = false
        break
      }
      if (upstreamPage === requestLimit) {
        truncated = true
        totalExact = false
      }
    }
    if (scanned.size !== upstreamTotal) totalExact = false
    const queryMatches = [...scanned.values()].filter(candidate => !query || matchesQuery(candidate, query.toLowerCase()))
    const counts = new Map<string, number>()
    for (const item of queryMatches) counts.set(item.sourceType, (counts.get(item.sourceType) ?? 0) + 1)
    const matches = sourceType ? queryMatches.filter(candidate => candidate.sourceType === sourceType) : queryMatches
    const totalPages = Math.max(1, Math.ceil(matches.length / pageSize))
    const page = Math.min(totalPages, boundedInteger(options.page, 1, Number.MAX_SAFE_INTEGER))
    return {
      items: matches.slice((page - 1) * pageSize, page * pageSize),
      breakdown: [...counts].map(([sourceType, count]) => ({ sourceType, count })),
      total: matches.length,
      page,
      pageSize,
      totalPages,
      scannedTotal: scanned.size,
      upstreamTotal,
      totalExact,
      truncated,
      writesAllowed: false,
      applied: { status, sourceType, query, limit: pageSize },
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
  async getCandidate(id: number): Promise<MarginCandidateDetail | undefined> {
    try {
      const raw = await this.request<Record<string, unknown>>(`/api/candidates/${id}`)
      return {
        ...toCandidate(raw, this.baseUrl),
        // Only detail requests retain full body. Raw HTML is intentionally not
        // exposed: the GUI renders untrusted Markdown or escaped plain text.
        contentMd: typeof raw['content_md'] === 'string' ? raw['content_md'] : '',
        contentText: typeof raw['content_text'] === 'string' ? raw['content_text'] : '',
        contentFetchFailed: raw['content_fetch_failed'] === true,
      }
    } catch (error) {
      if (error instanceof MarginRequestError && error.status === 404) return undefined
      throw error
    }
  }

  /** Mark a candidate read/unread. Explicit value — never a toggle. */
  async setCandidateStatus(id: number, status: MarginReadStatus): Promise<MarginStatusUpdate> {
    if (!Number.isSafeInteger(id) || id <= 0 || (status !== 'read' && status !== 'unprocessed')) {
      throw new MarginShapeError('Margin 状态更新参数不合法')
    }
    const raw = await this.request<unknown>(`/api/candidates/${id}/status`, {
      method: 'PATCH',
      body: { status },
    })
    if (!isRecord(raw) || raw['id'] !== id || raw['status'] !== status) {
      throw new MarginShapeError('Margin 状态更新确认不匹配')
    }
    return {
      id,
      status,
      isSavedToTrilium: raw['is_saved_to_trilium'] === true,
      updatedAt: typeof raw['updated_at'] === 'string' ? raw['updated_at'] : '',
    }
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
