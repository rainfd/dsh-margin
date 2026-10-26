/**
 * Browser-side API client for the /api/dsh-margin route family. The only data
 * access path the reading-list panel and settings card use — plain fetch,
 * same origin (loopback).
 */

import {
  MARGIN_API,
  type MarginAnnotationView,
  type MarginApiErrorBody,
  type MarginImportView,
  type MarginImportReceipt,
  type MarginCandidateDetail,
  type MarginConfigPatch,
  type MarginConfigView,
  type MarginManagementView,
  type MarginProgressView,
  type MarginReadingView,
  type MarginReadStatus,
  type MarginSaveState,
  type MarginSaveView,
  type MarginSourceMeta,
  type MarginStatusUpdate,
  type MarginTestResult,
} from '../protocol.ts'
// Type-only: the AI wire shapes live with the client model so the host half and
// its tests keep their own contract module. `api.ts` only transports them.
import type { AiCapability, AiRunRequest, AiRunResult } from './aiModel.ts'
// Type-only: progress shapes stay with the pure progress model. These routes
// only ever touch the local progress file, never Margin status or content.
import type { ProgressClearReply, ProgressSaveInput, ProgressSaveReply } from './progressModel.ts'
// Type-only: annotation wire shapes stay with the pure annotation model, so the
// transport module adds no runtime edge to the panel.
import type {
  HighlightCreateInput,
  HighlightDeleteInput,
  HighlightDeleteReply,
  HighlightReply,
  NoteDeleteReply,
  NoteReply,
} from './annotationModel.ts'

/** Error carrying the route's JSON error message. */
export class MarginApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string, readonly count?: number) {
    super(message)
    this.name = 'MarginApiError'
  }
}

/* ------------------------------------------------------------------ *
 * Source / credential reply shapes.
 *
 * These mirror the host routes exactly; the host already replaces every
 * upstream message with fixed wording, so `message` is display-safe but is
 * still never the final state — every mutation is followed by a re-read.
 * ------------------------------------------------------------------ */

/** 201 from /source-create. */
export interface MarginSourceCreateReply {
  instanceUrl: string
  source: MarginSourceMeta
}

/** 200 from /source-update (status toggle only). */
export interface MarginSourceUpdateReply {
  instanceUrl: string
  source: MarginSourceMeta
}

/** 200 from /source-fetch. A finished request, not proof of new articles. */
export interface MarginSourceFetchReply {
  instanceUrl: string
  id: number
  newCandidates: number
  message: string
}

/** 200 from /source-delete; deleting a source keeps its articles. */
export interface MarginSourceDeleteReply {
  instanceUrl: string
  deletedId: number
  articlesRetained: boolean
}

/** 201 from /credential-create; the cookie is never echoed, not even a prefix. */
export interface MarginCredentialCreateReply {
  instanceUrl: string
  credential: { id: number; domain: string; configured: boolean }
}

/** 200 from /credential-delete. */
export interface MarginCredentialDeleteReply {
  instanceUrl: string
  deletedId: number
  domain: string
}

/** Parse a JSON response or throw a MarginApiError with the route's message. */
async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new MarginApiError('HTTP ' + response.status + '：响应不是合法 JSON', response.status)
  }
  if (!response.ok) {
    const envelope = body as MarginApiErrorBody
    const message = typeof envelope?.error?.message === 'string'
      ? envelope.error.message
      : 'HTTP ' + response.status
    throw new MarginApiError(
      message,
      response.status,
      typeof envelope?.error?.code === 'string' ? envelope.error.code : undefined,
      // Structured only; free-form message text is never parsed.
      typeof envelope?.error?.count === 'number' && Number.isSafeInteger(envelope.error.count) && envelope.error.count > 0
        ? envelope.error.count
        : undefined,
    )
  }
  return body as T
}

/**
 * A hung import GET must not leave the panel "checking" forever: the poll
 * controller can only schedule its next attempt after the current one settles.
 * 20 s is far above a normal queue read while still bounded.
 */
const IMPORT_REQUEST_TIMEOUT_MS = 20_000

async function boundedFetch(input: string, init: RequestInit = {}, timeoutMs = IMPORT_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Query-string helper. */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : '?' + text
}

/** The /api/dsh-margin client. */
export class MarginApi {
  /** Read the connection config (token presence only — never the token). */
  async loadConfig(): Promise<MarginConfigView> {
    return readJson<MarginConfigView>(await fetch(MARGIN_API + '/config'))
  }

  /** Store a config patch. */
  async saveConfig(patch: MarginConfigPatch): Promise<MarginConfigView> {
    return readJson<MarginConfigView>(await fetch(MARGIN_API + '/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }))
  }

  /** Probe the connection; a rejection comes back as ok:false, not a throw. */
  async test(): Promise<MarginTestResult> {
    return readJson<MarginTestResult>(await fetch(MARGIN_API + '/test', { method: 'POST' }))
  }

  /** Read the reading list. */
  async loadReadingList(options: {
    status?: string
    sourceType?: string
    q?: string
    limit?: number
    page?: number
  } = {}): Promise<MarginReadingView> {
    return readJson<MarginReadingView>(await fetch(MARGIN_API + '/candidates' + query(options)))
  }

  /** Set an explicit, idempotent reading target after a user action. */
  async setCandidateStatus(id: number, status: MarginReadStatus, marginUrl: string): Promise<MarginStatusUpdate> {
    return readJson<MarginStatusUpdate>(await fetch(MARGIN_API + '/candidate-status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, status, marginUrl }),
    }))
  }

  async loadImports(): Promise<MarginImportView> {
    return readJson<MarginImportView>(await boundedFetch(MARGIN_API + '/imports'))
  }

  private async accepted(response: Response): Promise<MarginImportReceipt> {
    const receipt = await readJson<MarginImportReceipt>(response)
    if (response.status !== 202) throw new MarginApiError('未收到 202 接受确认；请只读检查队列，不要重复提交', 504)
    return receipt
  }

  async importUrl(url: string, instanceUrl: string): Promise<MarginImportReceipt> {
    return this.accepted(await boundedFetch(MARGIN_API + '/import-url', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, instanceUrl }),
    }))
  }

  async importPdf(file: File, instanceUrl: string): Promise<MarginImportReceipt> {
    const body = new FormData()
    body.append('file', file)
    body.append('instanceUrl', instanceUrl)
    return this.accepted(await boundedFetch(MARGIN_API + '/import-pdf', { method: 'POST', body }))
  }

  async loadImportTask(id: number, instanceUrl: string): Promise<MarginImportReceipt> {
    return readJson<MarginImportReceipt>(await boundedFetch(MARGIN_API + '/import-task' + query({ id, instanceUrl })))
  }

  /** POST a JSON body to one of the management routes. */
  private async postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return readJson<T>(await fetch(MARGIN_API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
  }

  /** Read-only source/credential/scheduler snapshot (gated writes are reported, not attempted). */
  async loadManagement(): Promise<MarginManagementView> {
    return readJson<MarginManagementView>(await fetch(MARGIN_API + '/management'))
  }

  /** Add one RSS source. `instanceUrl` must come from the last successful read. */
  async createSource(feedUrl: string, label: string, intervalMinutes: number, instanceUrl: string): Promise<MarginSourceCreateReply> {
    return this.postJson<MarginSourceCreateReply>('/source-create', { feedUrl, label, intervalMinutes, instanceUrl })
  }

  /** Pause or resume one source. Articles and in-flight work are not affected. */
  async setSourceStatus(id: number, status: 'active' | 'paused', instanceUrl: string): Promise<MarginSourceUpdateReply> {
    return this.postJson<MarginSourceUpdateReply>('/source-update', { id, status, instanceUrl })
  }

  /** Ask Margin to poll once now. A 200 only means the request finished. */
  async fetchSource(id: number, instanceUrl: string): Promise<MarginSourceFetchReply> {
    return this.postJson<MarginSourceFetchReply>('/source-fetch', { id, instanceUrl })
  }

  /** Delete one source after confirming its exact feed origin; articles are retained. */
  async deleteSource(id: number, confirmOrigin: string, instanceUrl: string): Promise<MarginSourceDeleteReply> {
    return this.postJson<MarginSourceDeleteReply>('/source-delete', { id, confirmOrigin, instanceUrl })
  }

  /** Store one domain cookie. The value is write-only and never read back. */
  async createCredential(domain: string, cookie: string, instanceUrl: string): Promise<MarginCredentialCreateReply> {
    return this.postJson<MarginCredentialCreateReply>('/credential-create', { domain, cookie, instanceUrl })
  }

  /** Remove one stored domain cookie. */
  async deleteCredential(id: number, domain: string, instanceUrl: string): Promise<MarginCredentialDeleteReply> {
    return this.postJson<MarginCredentialDeleteReply>('/credential-delete', { id, domain, instanceUrl })
  }

  /** Read one candidate. */
  async loadCandidate(id: number): Promise<MarginCandidateDetail> {
    return readJson<MarginCandidateDetail>(await fetch(MARGIN_API + '/candidate' + query({ id })))
  }

  /**
   * Read recent local scroll positions. This is an observation of the reading
   * viewport, not a read state: entries never change Margin.
   */
  async loadProgress(limit = 20): Promise<MarginProgressView> {
    return readJson<MarginProgressView>(await fetch(MARGIN_API + '/progress' + query({ limit })))
  }

  /** Store one scroll position locally. Never writes status or article content. */
  async saveProgress(input: ProgressSaveInput): Promise<ProgressSaveReply> {
    return readJson<ProgressSaveReply>(await fetch(MARGIN_API + '/progress', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }))
  }

  /** Forget one local position (or all). The host answers `marginUntouched: true`. */
  async clearProgress(key?: string): Promise<ProgressClearReply> {
    return readJson<ProgressClearReply>(await fetch(MARGIN_API + '/progress-clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(key === undefined ? {} : { key }),
    }))
  }

  /* ------------------------------------------------------------------ *
   * Highlights and notes (spec 007). One read plus six explicit mutations.
   *
   * The client never sends offsets or fingerprints: the host re-locates the
   * selected text inside `content_text`. Every reply is only an
   * acknowledgement; `AnnotationSession` re-reads before trusting it.
   * ------------------------------------------------------------------ */

  /** Read the read-only annotation snapshot for one candidate. */
  async loadAnnotations(id: number, instanceUrl: string): Promise<MarginAnnotationView> {
    return readJson<MarginAnnotationView>(await fetch(MARGIN_API + '/annotations' + query({ id, instanceUrl })))
  }

  /** Ask the host to locate `selectedText` and create one highlight. */
  async createHighlight(input: HighlightCreateInput): Promise<HighlightReply> {
    return this.postJson<HighlightReply>('/highlight-create', {
      candidateId: input.candidateId,
      instanceUrl: input.instanceUrl,
      selectedText: input.selectedText,
      // Omitted entirely means "unspecified": the host refuses an ambiguous
      // phrase instead of anchoring the first match.
      ...(input.occurrence === undefined ? {} : { occurrence: input.occurrence }),
    })
  }

  /** Attach one highlight to a note, or detach it with `null`. */
  async linkHighlight(highlightId: number, noteId: number | null, instanceUrl: string): Promise<HighlightReply> {
    return this.postJson<HighlightReply>('/highlight-link', { highlightId, noteId, instanceUrl })
  }

  /** Delete one highlight; `selectedText` is the host's live-state proof. */
  async deleteHighlight(input: HighlightDeleteInput): Promise<HighlightDeleteReply> {
    return this.postJson<HighlightDeleteReply>('/highlight-delete', {
      highlightId: input.highlightId,
      candidateId: input.candidateId,
      selectedText: input.selectedText,
      instanceUrl: input.instanceUrl,
    })
  }

  /** Create one note from explicit user content. */
  async createNote(candidateId: number, content: string, instanceUrl: string): Promise<NoteReply> {
    return this.postJson<NoteReply>('/note-create', { candidateId, content, instanceUrl })
  }

  /** Replace a note's whole content (Margin has no PATCH), with its precondition. */
  async updateNote(candidateId: number, noteId: number, content: string, expectedContent: string, instanceUrl: string): Promise<NoteReply> {
    return this.postJson<NoteReply>('/note-update', { candidateId, noteId, content, expectedContent, instanceUrl })
  }

  /** Delete one note; `content` is the explicit proof the panel collected. */
  async deleteNote(candidateId: number, noteId: number, content: string, instanceUrl: string): Promise<NoteDeleteReply> {
    return this.postJson<NoteDeleteReply>('/note-delete', { candidateId, noteId, content, instanceUrl })
  }

  /**
   * Read the AI capability snapshot. A GET only: it never starts a model run and
   * never sends article text, so it is safe to call when the reader opens.
   */
  async loadAiCapability(): Promise<AiCapability> {
    return readJson<AiCapability>(await fetch(MARGIN_API + '/ai-capability'))
  }

  /**
   * Start one explicit AI run. The caller owns the AbortSignal: passing it into
   * `fetch` is what makes 取消 actually abort the request (and the host's
   * `req.once('close')` then cancels the model stream). A body larger than the
   * host's ceiling is refused by the host; nothing here truncates silently.
   */
  async runAi(request: AiRunRequest, signal?: AbortSignal): Promise<AiRunResult> {
    return readJson<AiRunResult>(await fetch(MARGIN_API + '/ai-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    }))
  }
  /**
   * Read the save state. A GET only: opening the reader never saves anything.
   * `saveAllowed` is a live snapshot; the host rechecks before the POST.
   */
  async loadSaveState(id: number, instanceUrl: string): Promise<MarginSaveView> {
    return readJson<MarginSaveView>(await fetch(MARGIN_API + '/save-state' + query({ id, instanceUrl })))
  }

  /** One explicit save through Margin's own writer (host pre-checks first). */
  async saveToTrilium(candidateId: number, instanceUrl: string, marginUrl: string): Promise<MarginSaveState> {
    return this.postJson<MarginSaveState>('/save-trilium', { candidateId, instanceUrl, marginUrl })
  }

}
