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

/** One page of candidates plus the server-reported totals. */
export interface MarginCandidatePage {
  items: MarginCandidate[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/** Per-source-type tally for the reading-list header. */
export interface MarginSourceBreakdown {
  sourceType: string
  count: number
}

/** The reading-list view the sidebar renders. */
export interface MarginReadingView {
  items: MarginCandidate[]
  /** Tally over the *whole* filtered result set, not just this page. */
  breakdown: MarginSourceBreakdown[]
  total: number
  page: number
  totalPages: number
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
