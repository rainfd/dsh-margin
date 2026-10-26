/**
 * Wire contract shared by the host routes, the agent tools and the browser
 * half. Everything the browser can see is defined here — no credential ever
 * crosses this boundary (see MarginConfigView).
 */

/** Route family owned by this plugin (loopback-only, same trust model as dsh-trilium). */
export const MARGIN_API = '/api/dsh-margin'

/** Margin candidate lifecycle states, as reported by GET /api/candidates. */
export type MarginCandidateStatus = 'unprocessed' | 'processing' | 'read' | 'error'

/** Where a candidate came from, as reported by Margin. */
export type MarginSourceType = 'manual_url' | 'rss' | 'wechat' | 'github_research' | 'video'

/**
 * One reading item. `summaryText` is Margin's own AI summary (may be empty
 * when summarization has not finished); `summary` is the extracted excerpt.
 */
export interface MarginCandidate {
  id: number
  title: string
  sourceUrl: string
  /** Reader URL in the configured Margin instance (never the original source). */
  marginUrl: string
  sourceDomain: string
  status: MarginCandidateStatus
  sourceType: MarginSourceType | string
  category: string | null
  tags: string[]
  author: string | null
  summaryText: string
  summary: string
  isSavedToTrilium: boolean
  createdAt: string
  updatedAt: string
}

/** Full body is fetched on demand for the GUI, never included in list rows. */
export interface MarginCandidateDetail extends MarginCandidate {
  contentMd: string
  contentText: string
  contentFetchFailed: boolean
}

/** One page of candidates plus the server-reported totals. */
export interface MarginCandidatePage {
  items: MarginCandidate[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/** Only explicit user-facing reading transitions are writable. */
export type MarginReadStatus = 'read' | 'unprocessed'

/** PATCH returns a partial acknowledgement, never a full article. */
export interface MarginStatusUpdate {
  id: number
  status: MarginReadStatus
  isSavedToTrilium: boolean
  updatedAt: string
}

/** Per-source-type tally for the reading-list header. */
export interface MarginSourceBreakdown {
  sourceType: string
  count: number
}

/** The reading-list view the sidebar renders. */
export interface MarginReadingView {
  items: MarginCandidate[]
  /** Query-filtered scanned rows, before source selection; never just this page. */
  breakdown: MarginSourceBreakdown[]
  /** Matching rows in the bounded scan, not an unfiltered server count. */
  total: number
  page: number
  pageSize: number
  totalPages: number
  scannedTotal: number
  upstreamTotal: number
  totalExact: boolean
  truncated: boolean
  /** Live host authorization snapshot; host rechecks on every mutation. */
  writesAllowed: boolean
  /** Echo of the filters actually applied, so the UI never shows a stale label. */
  applied: {
    status: MarginCandidateStatus
    sourceType: string | null
    query: string | null
    limit: number
  }
}

/** Plugin configuration as the browser is allowed to see it. */
export interface MarginConfigView {
  baseUrl: string
  /** Whether a token is stored — never the token itself. */
  tokenSet: boolean
  timeoutMs: number
}

/** Candidate-backed async import task, not a separate invented job ID. */
export interface MarginImportTask {
  id: number
  title: string
  sourceUrl: string
  sourceType: string
  status: MarginCandidateStatus | 'unknown'
  marginUrl: string
  errorMessage: string | null
  createdAt: string
}

export interface MarginImportView {
  instanceUrl: string
  urlAllowed: boolean
  pdfAllowed: boolean
  maxPdfBytes: number
  /** Backend exposes only the most recent 20; absence never means success. */
  recentLimit: number
  tasks: MarginImportTask[]
}

export interface MarginImportReceipt {
  instanceUrl: string
  task: MarginImportTask
}

/** Conservative host limit; backend applies its own PDF limits too. */
export const MARGIN_MAX_PDF_BYTES = 10 * 1024 * 1024

export interface MarginSourceMeta {
  id: number
  sourceType: string
  label: string
  status: 'active' | 'paused' | 'error' | 'unknown'
  feedOrigin: string
  pollIntervalMinutes: number
  consecutiveFailures: number
  hasError: boolean
  lastErrorAt: string | null
  /** Backend config is user-writable; this is not proof of successful polling. */
  recordedFetchAt: string | null
}

export interface MarginCredentialMeta {
  id: number
  domain: string
  configured: boolean
  supported: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface MarginSchedulerMeta {
  running: boolean
  /** Source polling jobs only; excludes aggregation and digest jobs. */
  sourcePollJobs: number
  jobs: { sourceId: number; nextRunTime: string | null; intervalMinutes: number | null }[]
}

export interface MarginManagementView {
  instanceUrl: string
  observedAt: string
  sourceWritesAllowed: boolean
  credentialWritesAllowed: boolean
  sources: MarginSourceMeta[]
  credentials: MarginCredentialMeta[]
  scheduler: MarginSchedulerMeta
}

export interface MarginNote {
  id: number
  candidateId: number
  content: string
  /** True when the projection is shorter than the stored note (edit/delete blocked). */
  contentTruncated: boolean
  /** Length of the stored content in UTF-16 code units, before projection. */
  contentLength: number
  createdAt: string
  updatedAt: string
}

export interface MarginHighlight {
  id: number
  candidateId: number
  noteId: number | null
  start: number
  end: number
  selectedText: string
  color: string
  fingerprint: string
  createdAt: string
}

/** Read-only highlight/note snapshot for one candidate. */
export interface MarginAnnotationView {
  instanceUrl: string
  candidateId: number
  marginUrl: string
  writesAllowed: boolean
  /** True when content_text exists; without it no offset can be trusted. */
  offsetsAvailable: boolean
  notes: MarginNote[]
  highlights: MarginHighlight[]
}

/** Save-to-Trilium state (spec 006). `saveRecordId`/`externalRef` are null when unobserved. */
export interface MarginSaveState {
  instanceUrl: string
  candidateId: number
  marginUrl: string
  saved: boolean
  saveRecordId: number | null
  externalRef: string | null
  savedAt: string | null
  /** True when the write happened but its receipt/state was verified indirectly. */
  needsVerification: boolean
}

/** Read-only save view; `saveAllowed` is the live write-gate snapshot. */
export interface MarginSaveView extends MarginSaveState {
  saveAllowed: boolean
}

/** Local reading progress: an observation, never a read-state source of truth. */
export interface MarginProgressEntry {
  key: string
  instanceUrl: string
  candidateId: number
  contentVersion: string
  title: string
  /** Fraction scrolled (0–1). 1 does NOT mean finished. */
  ratio: number
  scrollTop: number
  anchor: string
  openedAt: string
  updatedAt: string
}

export interface MarginProgressView {
  observedAt: string
  maxEntries: number
  ttlDays: number
  total: number
  entries: MarginProgressEntry[]
}

/** Accepted patch shape for PUT /config. */
export interface MarginConfigPatch {
  baseUrl?: string
  token?: string
  timeoutMs?: number
}

/** Uniform error body every route returns on failure. */
export interface MarginApiErrorBody {
  error: {
    code: string
    message: string
    /** Margin's own error category, when the upstream supplied one. */
    category?: string
    /**
     * Machine-readable count for `ambiguous_selection`, so the client never has
     * to parse a human sentence (and never touches free-form message text).
     */
    count?: number
  }
}

/** Connection self-test result. */
export interface MarginTestResult {
  ok: boolean
  /** Human-readable detail; never contains the token. */
  detail: string
  /** Candidate totals when the probe succeeded. */
  counts?: { unprocessed: number; read: number }
}
