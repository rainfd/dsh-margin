/**
 * Pure state for the optional AI reading assistant (spec 005).
 *
 * Boundaries this module exists to enforce:
 *  1. Exactly one run at a time. Starting, cancelling, unmounting, changing the
 *     article or changing the Margin instance invalidates every earlier run, and
 *     a superseded completion is dropped instead of being displayed.
 *  2. Input is validated before it is sent: a question is required for `qa`, and
 *     an oversized selection is refused rather than silently truncated (a
 *     client-side cut would make the host's coverage label claim full text).
 *  3. Nothing is stored or saved. The output is a value in memory; the run can
 *     never change reading status, write Margin or write Trilium.
 *  4. Failures map to fixed locale keys. An upstream message is never relayed.
 *
 * No React import: this file is used headlessly by tests and by AiPanel.
 */

import type { MarginKey } from './locales.ts'
import { MarginApiError } from './api.ts'
import { safeMarginUrl } from './readerModel.ts'

export type AiMode = 'qa' | 'translate' | 'summary'

/** Mirrors GET /ai-capability. Provider/model ids are configuration labels. */
export interface AiCapability {
  enabled: boolean
  modelAvailable: boolean
  target: { provider: string; model: string } | null
  limits: { selectionChars: number; maxOutputTokens: number }
}

/** Mirrors the POST /ai-run body. */
export interface AiRunRequest {
  candidateId: number
  mode: AiMode
  question?: string
  selection?: string
  instanceUrl: string
}

/** Mirrors the host-built coverage record; `label` is shown verbatim. */
export interface AiCoverage {
  mode: AiMode
  scope: 'selection' | 'article'
  sentChars: number
  totalChars: number
  truncated: boolean
  label: string
}

/** Mirrors a 200 from POST /ai-run. `generated: true` marks model output. */
export interface AiRunResult {
  instanceUrl: string
  candidateId: number
  mode: AiMode
  provider: string
  model: string
  text: string
  coverage: AiCoverage
  generated: true
}

/** Client-side mirror of the host question ceiling (aiContext.AI_MAX_QUESTION_CHARS). */
export const AI_QUESTION_MAX = 1_000

/** Where the panel is: loading, hidden, blocked, idle, running, done, failed. */
export type AiStatus = 'loading' | 'hidden' | 'unavailable' | 'ready' | 'running' | 'done' | 'failed'

/** Why a submit would be refused; rendered through `aiBlockKey`. */
export type AiBlockReason =
  | 'loading'
  | 'disabled'
  | 'noModel'
  | 'running'
  | 'questionRequired'
  | 'questionTooLong'
  | 'selectionTooLong'
  | 'noInstance'

/** Props the reader passes to the injected panel component. */
export interface AiPanelProps {
  api: AiApi
  candidateId: number
  /**
   * The reader URL of the article being read. The configured Margin origin is
   * derived from it (`readerInstance`) rather than asked for a second time.
   */
  marginUrl: string
  /**
   * Snapshot of the current in-article selection, or undefined when there is
   * none. ArticleReader supplies this so this module never touches the DOM.
   */
  readSelection?: () => string | undefined
  t: (key: MarginKey) => string
}

/**
 * A component typed without React so this module stays framework-free. AiPanel
 * (which returns a React element) is assignable to it; ArticleReader casts it
 * back to a renderable component type at the JSX boundary.
 */
export type AiPanelComponent = (props: AiPanelProps) => unknown

/**
 * The AI surface handed to ArticleReader. `Panel` is supplied by the shell so
 * the reader never imports the AI UI: without it, nothing renders at all.
 */
export interface AiApi {
  loadCapability(): Promise<AiCapability>
  run(request: AiRunRequest, signal?: AbortSignal): Promise<AiRunResult>
  Panel?: AiPanelComponent
}

/**
 * Recover the configured Margin origin from a reader URL.
 *
 * The host builds `<baseUrl>/reader/<id>`, and POST /ai-run requires exactly the
 * configured base URL (minus trailing slashes). Deriving it from the URL the
 * same response carried avoids a second request and never invents an instance.
 */
export function readerInstance(marginUrl: string): string | null {
  const safe = safeMarginUrl(marginUrl)
  if (safe === null) return null
  let url: URL
  try { url = new URL(safe) } catch { return null }
  const match = /^(.*)\/(?:reader|candidate)\/\d+\/?$/.exec(url.pathname)
  if (match === null) return null
  const prefix = (match[1] ?? '').replace(/\/+$/, '')
  return (url.origin + prefix).replace(/\/+$/, '')
}

/** Trimmed selection, or undefined so the host receives no `selection` key. */
export function selectionOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Everything `submitBlocked` needs, all of it local state. */
export interface AiSubmitState {
  status: AiStatus
  capability: AiCapability | null
  mode: AiMode
  question: string
  selection: string | undefined
  instanceUrl: string
}

/**
 * Why this submit must not be sent, or undefined when it may go.
 *
 * Pure and total: the panel uses it to disable the button, the session uses it
 * again before it builds a request, so a captured handler cannot bypass it.
 */
export function submitBlocked(state: AiSubmitState): AiBlockReason | undefined {
  const { capability } = state
  if (state.status === 'loading') return 'loading'
  if (state.status === 'hidden' || capability === null || capability.enabled !== true) return 'disabled'
  if (capability.modelAvailable !== true) return 'noModel'
  if (state.instanceUrl.trim() === '') return 'noInstance'
  if (state.status === 'running') return 'running'
  if (state.mode === 'qa') {
    const question = state.question.trim()
    if (question === '') return 'questionRequired'
    if (question.length > AI_QUESTION_MAX) return 'questionTooLong'
  }
  // Mirror the host exactly: `selection_too_long` is only raised for the
  // transform modes. For `qa` the host truncates and reports it in the coverage
  // label, so refusing here would be a false block.
  const selection = selectionOf(state.selection)
  const limit = capability.limits.selectionChars
  if (state.mode !== 'qa' && selection !== undefined && limit > 0 && selection.length > limit) return 'selectionTooLong'
  return undefined
}

/** Locale key for a refused submit. */
export function aiBlockKey(reason: AiBlockReason): MarginKey {
  switch (reason) {
    case 'loading': return 'ai.block.loading'
    case 'disabled': return 'ai.block.disabled'
    case 'noModel': return 'ai.block.noModel'
    case 'running': return 'ai.block.running'
    case 'questionRequired': return 'ai.block.questionRequired'
    case 'questionTooLong': return 'ai.block.questionTooLong'
    case 'selectionTooLong': return 'ai.block.selectionTooLong'
    case 'noInstance': return 'ai.block.noInstance'
  }
}

/**
 * Fixed locale key per failure class. Codes win; the HTTP status is only a
 * fallback. `error.message` is deliberately never read, so no response body can
 * reach the UI even if the host wording changes.
 */
export function aiErrorKey(error: unknown): MarginKey {
  const code = error instanceof MarginApiError ? error.code : undefined
  const status = error instanceof MarginApiError ? error.status : undefined
  switch (code) {
    case 'ai_disabled': return 'ai.error.disabled'
    case 'model_unavailable': return 'ai.error.noModel'
    case 'not_configured': return 'ai.error.notConfigured'
    case 'instance_changed': return 'ai.error.instanceChanged'
    case 'invalid_mode':
    case 'invalid_id':
    case 'missing_question':
    case 'question_too_long':
    case 'selection_too_long':
    case 'bad_body': return 'ai.error.invalid'
    case 'empty_content': return 'ai.error.empty'
    case 'not_found': return 'ai.error.notFound'
    case 'margin_unavailable': return 'ai.error.margin'
    case 'ai_failed': return 'ai.error.failed'
    case 'ai_timeout': return 'ai.error.timeout'
    default: break
  }
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError') return 'ai.error.cancelled'
  switch (status) {
    case 403: return 'ai.error.disabled'
    case 404: return 'ai.error.notFound'
    case 422: return 'ai.error.empty'
    case 502: return 'ai.error.failed'
    case 503: return 'ai.error.noModel'
    case 504: return 'ai.error.timeout'
    default: return 'ai.error.unknown'
  }
}

/**
 * One article's AI session. Owns the in-flight request, its AbortSignal and the
 * generation counter that makes every superseded completion inert.
 *
 * The panel recreates this object when the candidate or instance changes, so a
 * stale result can never be written into the new article's view.
 */
export class AiSession {
  status: AiStatus = 'loading'
  capability: AiCapability | null = null
  result: AiRunResult | null = null
  /** Fixed locale key for the last failure, or null. */
  errorKey: MarginKey | null = null
  /** Fixed locale key reason for the last refused submit, or null. */
  blocked: AiBlockReason | null = null
  /** True after an explicit cancel, so the panel can say so without a result. */
  cancelled = false

  private stopped = false
  private token = 0
  private controller: AbortController | undefined

  constructor(
    private readonly api: AiApi,
    private readonly target: { candidateId: number; instanceUrl: string },
    private readonly changed: () => void,
  ) {}

  /**
   * GET the capability. Failure hides the panel; reading is untouched.
   *
   * Re-entrant on purpose: an effect cleanup followed by a re-run (React's
   * strict-mode double invocation, or a remount that reuses this session) must
   * revive the session rather than leave it permanently stopped.
   */
  async start(): Promise<void> {
    this.stopped = false
    this.token++
    this.status = 'loading'
    this.notify()
    let capability: AiCapability
    try {
      capability = await this.api.loadCapability()
    } catch {
      if (this.stopped) return
      this.capability = null
      this.status = 'hidden'
      this.notify()
      return
    }
    if (this.stopped) return
    this.capability = capability
    this.restore()
    this.notify()
  }

  /** Unmount: abort, forget, and never notify again. */
  stop(): void {
    this.stopped = true
    this.token++
    this.controller?.abort()
    this.controller = undefined
    this.result = null
    this.errorKey = null
    this.blocked = null
    this.cancelled = false
  }

  /** Explicit cancel: abort the fetch, drop any partial state. */
  cancel(): void {
    if (this.status !== 'running') return
    this.token++
    this.controller?.abort()
    this.controller = undefined
    this.result = null
    this.errorKey = null
    this.blocked = null
    this.cancelled = true
    this.restore()
    this.notify()
  }

  /** Drop a refusal message as soon as the user changes the inputs. */
  clearBlocked(): void {
    if (this.blocked === null) return
    this.blocked = null
    this.notify()
  }

  /**
   * Start one run. A second call while running is ignored (single flight); the
   * input is re-validated here so a stale captured handler cannot submit.
   */
  async run(input: { mode: AiMode; question: string; selection?: string }): Promise<void> {
    // A stopped session is detached from the UI: it must not send anything, even
    // if a captured handler fires after unmount.
    if (this.stopped) return
    const refusal = submitBlocked({
      status: this.status,
      capability: this.capability,
      mode: input.mode,
      question: input.question,
      selection: input.selection,
      instanceUrl: this.target.instanceUrl,
    })
    if (refusal !== undefined) {
      if (refusal !== 'running' && refusal !== 'loading') {
        this.blocked = refusal
        this.notify()
      }
      return
    }
    const token = ++this.token
    const controller = new AbortController()
    this.controller = controller
    this.status = 'running'
    this.result = null
    this.errorKey = null
    this.blocked = null
    this.cancelled = false
    this.notify()
    const question = input.mode === 'qa' ? input.question.trim() : undefined
    const selection = selectionOf(input.selection)
    const request: AiRunRequest = {
      candidateId: this.target.candidateId,
      mode: input.mode,
      instanceUrl: this.target.instanceUrl,
      ...(question === undefined ? {} : { question }),
      ...(selection === undefined ? {} : { selection }),
    }
    let failure: MarginKey | undefined
    let outcome: AiRunResult | undefined
    try {
      const result = await this.api.run(request, controller.signal)
      // A superseded, cancelled or aborted run must not paint anything.
      if (!this.current(token, controller)) return
      if (result.candidateId !== request.candidateId || trimSlash(result.instanceUrl) !== trimSlash(request.instanceUrl)) {
        // IDs are instance-local; never show another article's answer.
        failure = 'ai.error.instanceChanged'
      } else if (result.text.trim() === '') {
        failure = 'ai.error.failed'
      } else {
        outcome = result
      }
    } catch (error) {
      if (!this.current(token, controller)) return
      failure = aiErrorKey(error)
    }
    if (this.controller === controller) this.controller = undefined
    if (outcome === undefined) {
      this.errorKey = failure ?? 'ai.error.unknown'
      this.status = 'failed'
    } else {
      this.result = outcome
      this.status = 'done'
    }
    this.notify()
  }

  /** True only for the run that still owns the session. */
  private current(token: number, controller: AbortController): boolean {
    return !this.stopped && token === this.token && !controller.signal.aborted
  }

  /** Return to the state the capability alone justifies. */
  private restore(): void {
    const capability = this.capability
    this.status = capability === null ? 'loading'
      : capability.enabled !== true ? 'hidden'
        : capability.modelAvailable !== true ? 'unavailable' : 'ready'
  }

  private notify(): void {
    if (this.stopped) return
    this.changed()
  }
}

/** Compare instance URLs without letting a trailing slash claim a mismatch. */
function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
