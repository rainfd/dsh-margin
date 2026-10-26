/**
 * Pure state for the highlights/notes panel (spec 007, browser half).
 *
 * Boundaries this module exists to enforce:
 *
 *  1. One `/annotations` read per open. Every mutation is POST → reply
 *     instance check → re-read; the POST reply is never adopted as final state.
 *  2. One epoch guards every async path. Close, unmount, candidate change or
 *     instance change invalidates whatever is still in flight, and a late
 *     settle cannot write state.
 *  3. The pending note draft is a single string held in this object's memory.
 *     It is never persisted to browser storage, a URL or a log, and it is
 *     dropped on close and on an instance change.
 *  4. Failures become fixed locale keys from `error.code` then the HTTP status.
 *     `error.message` is never used for classification and never rendered. The
 *     including ambiguity counts, which arrive as a structured field.
 *  5. An ambiguous selection is never resolved by guessing: the user must pick
 *     an occurrence (the 0-based `occurrence` field) before a resubmit.
 *  6. Deletions are explicit and proven: `canDeleteNote` / `canDeleteHighlight`
 *     require the exact current content / selected text, and the session
 *     re-checks the predicate against its latest snapshot before posting.
 *
 * No React import, no DOM and no storage: tests drive this module headlessly.
 */

import type { MarginAnnotationView, MarginHighlight, MarginNote } from '../protocol.ts'
import { MarginApiError } from './api.ts'
import type { MarginKey } from './locales.ts'

/** Every key this module may emit; every one exists in `zh` (asserted in tests). */
export type AnnotationKey = Extract<MarginKey, `annotations.${string}`>

/**
 * Client mirrors of the host ceilings (`src/highlights.ts`, annotation routes).
 * Kept local so the browser half imports no host module; the values are
 * asserted in tests/annotation-ui.test.mjs.
 */
export const NOTE_CONTENT_MAX = 20_000
export const SELECTION_TEXT_MAX = 12_000
/** Preview window only: the full trimmed selection is what gets posted. */
export const SELECTION_PREVIEW_MAX = 2_000

/* ------------------------------------------------------------------ *
 * Wire shapes (mirror src/annotationRoutes.ts exactly).
 * ------------------------------------------------------------------ */

/** POST /highlight-create body. `occurrence` is 0-based and only sent when chosen. */
export interface HighlightCreateInput {
  candidateId: number
  instanceUrl: string
  selectedText: string
  occurrence?: number
}

/** POST /highlight-delete body; `selectedText` is the proof the host re-reads. */
export interface HighlightDeleteInput {
  highlightId: number
  candidateId: number
  selectedText: string
  instanceUrl: string
}

/** 201 from /highlight-create and 200 from /highlight-link. */
export interface HighlightReply {
  instanceUrl: string
  highlight: MarginHighlight
}

/** 200 from /highlight-delete; Margin keeps the linked note. */
export interface HighlightDeleteReply {
  instanceUrl: string
  deletedId: number
  notesPreserved: boolean
}

/** 201 from /note-create and 200 from /note-update (whole-content replace). */
export interface NoteReply {
  instanceUrl: string
  note: MarginNote
}

/** 200 from /note-delete; Margin detaches the affected highlights. */
export interface NoteDeleteReply {
  instanceUrl: string
  deletedId: number
  highlightsDetached: boolean
}

/**
 * The annotation route family, and nothing else. The reader hands this narrow
 * face to the panel so no reading-status, save, import or AI method is even
 * reachable from here.
 */
export interface AnnotationApi {
  loadAnnotations(id: number, instanceUrl: string): Promise<MarginAnnotationView>
  createHighlight(input: HighlightCreateInput): Promise<HighlightReply>
  linkHighlight(highlightId: number, noteId: number | null, instanceUrl: string): Promise<HighlightReply>
  deleteHighlight(input: HighlightDeleteInput): Promise<HighlightDeleteReply>
  createNote(candidateId: number, content: string, instanceUrl: string): Promise<NoteReply>
  updateNote(candidateId: number, noteId: number, content: string, expectedContent: string, instanceUrl: string): Promise<NoteReply>
  deleteNote(candidateId: number, noteId: number, content: string, instanceUrl: string): Promise<NoteDeleteReply>
  /**
   * Supplied by the shell. Without it nothing renders, so an installation that
   * does not opt into annotations adds no UI and no request.
   */
  Panel?: AnnotationPanelComponent
}

/** Props the reader passes to the injected panel component. */
export interface AnnotationPanelProps {
  api: AnnotationApi
  candidateId: number
  /**
   * The reader URL of the article. The configured Margin origin is derived from
   * it rather than asked for again; the host compares it verbatim.
   */
  marginUrl: string
  /** Snapshot of the in-article selection, or undefined when there is none. */
  readSelection?: () => string | undefined
  t: (key: MarginKey) => string
}

/**
 * A component typed without React so this module stays framework-free. The
 * panel component is assignable to it; the reader casts it back at the JSX
 * boundary.
 */
export type AnnotationPanelComponent = (props: AnnotationPanelProps) => unknown

/* ------------------------------------------------------------------ *
 * URL / selection / content helpers (pure).
 * ------------------------------------------------------------------ */

/**
 * Recover the configured Margin origin from a reader URL.
 *
 * Deliberately regex-only and local: annotations must remain usable when the AI
 * half of the plugin is not installed, and no note text may ever participate in
 * URL construction. Mirrors `readerInstance` in aiModel.ts (reader and
 * candidate routes, optional deployment prefix, no trailing slash).
 */
export function annotationInstance(marginUrl: string): string | null {
  if (typeof marginUrl !== 'string') return null
  const match = /^(https?:\/\/[^\s/]+(?:\/[^\s?#]*)?)\/(?:reader|candidate)\/\d+\/?$/.exec(marginUrl)
  if (match === null) return null
  const origin = (match[1] ?? '').replace(/\/+$/, '')
  return origin === '' ? null : origin
}

/** Trimmed selection or undefined; the host trims `selectedText` the same way. */
export function selectionText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/** First `limit` characters for display, plus whether display was cut. */
export function selectionPreview(text: string, limit = SELECTION_PREVIEW_MAX): { text: string; truncated: boolean } {
  const bounded = typeof text === 'string' ? text : ''
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : SELECTION_PREVIEW_MAX
  if (bounded.length <= safeLimit) return { text: bounded, truncated: false }
  return { text: bounded.slice(0, safeLimit), truncated: true }
}

/** Why this selection cannot become a highlight, or undefined when it may. */
export function selectionProblem(selection: string | undefined): AnnotationKey | undefined {
  if (selection === undefined || selection.trim() === '') return 'annotations.error.emptySelection'
  if (selection.length > SELECTION_TEXT_MAX) return 'annotations.error.selectionTooLong'
  return undefined
}

/** Why this note content cannot be posted, or undefined when it may. */
export function noteContentProblem(content: unknown): AnnotationKey | undefined {
  if (typeof content !== 'string' || content.trim() === '') return 'annotations.error.emptyContent'
  if (content.length > NOTE_CONTENT_MAX) return 'annotations.error.contentTooLong'
  return undefined
}

/**
 * Deletion proof: the typed text must equal the *current* note content exactly.
 * An empty body cannot be proof because the host also refuses an empty one.
 */
export function canDeleteNote(note: MarginNote, typed: string): boolean {
  if (typeof typed !== 'string') return false
  const content = note.content
  if (content === '') return false
  return typed === content
}

/** Deletion proof: the typed text must equal the highlight's selected text. */
export function canDeleteHighlight(highlight: MarginHighlight, typed: string): boolean {
  if (typeof typed !== 'string') return false
  const selected = highlight.selectedText
  if (selected === '') return false
  return typed === selected
}

/**
 * Pending ambiguity for one selection. `count` is null when the host did not
 * state a countable number (`count`) when the host supplies one.
 */
export interface PendingAmbiguity {
  selectedText: string
  count: number | null
}

/**
 * Resubmission gate for an ambiguous selection.
 *
 * Returns a key when the caller must not post yet: a pending ambiguity for the
 * same text needs an explicit occurrence, and an occurrence must be a
 * non-negative integer inside the reported count (0-based, as the host reads
 * it). Returns undefined when the post may proceed.
 */
export function occurrenceProblem(
  pending: PendingAmbiguity | null,
  selection: string,
  occurrence: number | undefined,
): AnnotationKey | undefined {
  if (pending === null || pending.selectedText !== selection) return undefined
  if (occurrence === undefined) return 'annotations.error.occurrenceRequired'
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) return 'annotations.error.invalid'
  if (pending.count !== null && occurrence >= pending.count) return 'annotations.error.invalid'
  return undefined
}

/**
 * The match count the host reports for `ambiguous_selection`, or null.
 *
 * The count exists nowhere else in the reply (the route returns only
 * code/message/status), so this function reads the host-built sentence and
 * keeps *only* its bounded integer. The message itself is never rendered,
 * logged, forwarded or used for classification; a message that does not match
 * the host's own wording yields null, which the UI explains without echoing it.
 * If the host ever adds a structured count field, this parser should be deleted.
 */
export function ambiguityCount(error: unknown): number | null {
  // Structured field only. The host returns `error.count` for this code; the
  // human sentence is never parsed, so an upstream message cannot steer the UI.
  if (!(error instanceof MarginApiError) || error.code !== 'ambiguous_selection') return null
  const count = error.count
  return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : null
}

/* ------------------------------------------------------------------ *
 * Error mapping: code first, HTTP status second, message never.
 * ------------------------------------------------------------------ */

const CODE_KEYS: Record<string, AnnotationKey> = {
  writes_disabled: 'annotations.error.writesDisabled',
  not_configured: 'annotations.error.notConfigured',
  instance_changed: 'annotations.error.instanceChanged',
  selection_not_located: 'annotations.error.selectionNotFound',
  ambiguous_selection: 'annotations.error.ambiguous',
  offsets_unavailable: 'annotations.error.offsetsUnavailable',
  empty_selection: 'annotations.error.emptySelection',
  selection_too_long: 'annotations.error.selectionTooLong',
  invalid_occurrence: 'annotations.error.invalid',
  invalid_content: 'annotations.error.invalidContent',
  confirm_required: 'annotations.error.confirmRequired',
  note_too_long: 'annotations.error.noteTruncated',
  confirmation_mismatch: 'annotations.error.confirmMismatch',
  margin_unauthorized: 'annotations.error.unauthorized',
  margin_rejected: 'annotations.error.rejected',
  margin_conflict: 'annotations.error.conflict',
  margin_bad_shape: 'annotations.error.upstream',
  margin_upstream_error: 'annotations.error.upstream',
  margin_request_failed: 'annotations.error.upstream',
  not_found: 'annotations.error.notFound',
  bad_body: 'annotations.error.request',
  invalid_id: 'annotations.error.request',
  invalid_note_id: 'annotations.error.request',
  method_not_allowed: 'annotations.error.request',
  internal_error: 'annotations.error.request',
}

function mapError(error: unknown): AnnotationKey {
  if (!(error instanceof MarginApiError)) return 'annotations.error.network'
  const code = typeof error.code === 'string' ? CODE_KEYS[error.code] : undefined
  if (code !== undefined) return code
  switch (error.status) {
    case 400: return 'annotations.error.request'
    case 401: return 'annotations.error.unauthorized'
    case 403: return 'annotations.error.writesDisabled'
    case 404: return 'annotations.error.notFound'
    case 409: return 'annotations.error.conflict'
    case 422: return 'annotations.error.rejected'
    case 502: return 'annotations.error.upstream'
    case 504: return 'annotations.error.network'
    default: return 'annotations.error.unknown'
  }
}

/** Fixed key for a read/highlight failure. Never inspects `error.message`. */
export function annotationErrorKey(error: unknown): AnnotationKey {
  return mapError(error)
}

/** Fixed key for a note failure. Never inspects `error.message`. */
export function noteErrorKey(error: unknown): AnnotationKey {
  return mapError(error)
}

/* ------------------------------------------------------------------ *
 * Session controller.
 * ------------------------------------------------------------------ */

/** The instance an open panel is bound to; both fields are instance-local. */
export interface AnnotationTarget {
  candidateId: number
  instanceUrl: string
}

/** Why the lists are not actionable: no snapshot, failed read, or unconfirmed write. */
export type AnnotationStatus = 'loading' | 'ready' | 'failed'

const INSTANCE_DRIFT = new Set(['confirmation_mismatch', 'not_found', 'margin_conflict'])

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * One article's annotation session.
 *
 * The panel builds a fresh session when the candidate or instance changes, and
 * a second epoch guard inside the session protects the same commit from late
 * replies. `changed` is the component's redraw callback.
 */
export class AnnotationSession {
  /** Last successful read; null means "nothing actionable, nothing to show". */
  view: MarginAnnotationView | null = null
  status: AnnotationStatus = 'loading'
  /** A read is in flight (separate from `busy`, which is a mutation). */
  loading = false
  /** One mutation at a time; also the only window in which controls are inert. */
  busy = false
  /**
   * The snapshot may no longer describe live state (failed read, failed
   * re-read, or a conflict reply). Lists stay readable; writes stop until a
   * successful refresh.
   */
  stale = false
  /** Fixed key for a read/highlight failure. */
  errorKey: AnnotationKey | null = null
  /** Fixed key for a note failure, kept in its own slot so both stay visible. */
  noteError: AnnotationKey | null = null
  /** Fixed key for the last confirmed action. */
  notice: AnnotationKey | null = null
  /** Pending new-note draft. Memory only (see the module header). */
  draft = ''
  /** Set when the host refused a selection as ambiguous; cleared on success. */
  ambiguous: PendingAmbiguity | null = null

  private active = false
  private epoch = 0

  constructor(
    private readonly api: AnnotationApi,
    private readonly target: AnnotationTarget,
    private readonly changed: () => void,
  ) {}

  /** True only when a confirmed snapshot allows this session to write. */
  get writable(): boolean {
    return this.active && this.view !== null && this.status === 'ready' && !this.stale
      && !this.busy && !this.loading && this.view.writesAllowed === true
  }

  /**
   * Open: a new epoch invalidates anything left in flight, state from a
   * previous open is dropped, and exactly one read is issued.
   */
  start(): void {
    this.active = true
    this.epoch++
    this.view = null
    this.status = 'loading'
    this.loading = false
    this.busy = false
    this.stale = false
    this.errorKey = null
    this.noteError = null
    this.notice = null
    this.draft = ''
    this.ambiguous = null
    if (this.target.instanceUrl.trim() === '') {
      this.status = 'failed'
      this.errorKey = 'annotations.error.instanceUnknown'
      this.changed()
      return
    }
    this.changed()
    void this.refresh()
  }

  /** Close/unmount: bump the epoch first so a late settle cannot notify. */
  stop(): void {
    this.active = false
    this.epoch++
    this.view = null
    this.status = 'loading'
    this.loading = false
    this.busy = false
    this.stale = false
    this.errorKey = null
    this.noteError = null
    this.notice = null
    this.draft = ''
    this.ambiguous = null
  }

  /** Keep the pending note draft controlled. Nothing is persisted. */
  setDraft(value: string): void {
    if (!this.active) return
    this.draft = typeof value === 'string' ? value : ''
    this.notice = null
    this.changed()
  }

  /** Drop the ambiguity prompt without posting anything. */
  clearAmbiguity(): void {
    if (!this.active) return
    this.ambiguous = null
    if (this.errorKey === 'annotations.error.ambiguous' || this.errorKey === 'annotations.error.occurrenceRequired') this.errorKey = null
    this.changed()
  }

  /** Read-only refresh. Never mutates, never cancels work upstream. */
  async refresh(explicit = true): Promise<void> {
    if (!this.active || this.loading) return
    if (this.target.instanceUrl.trim() === '') {
      this.status = 'failed'
      this.errorKey = 'annotations.error.instanceUnknown'
      this.changed()
      return
    }
    const epoch = this.epoch
    this.loading = true
    if (explicit) {
      this.errorKey = null
      this.noteError = null
      this.notice = null
    }
    this.changed()
    try {
      const next = await this.api.loadAnnotations(this.target.candidateId, this.target.instanceUrl)
      if (!this.alive(epoch)) return
      // IDs are instance-local: never adopt another instance's rows.
      if (trimSlash(next.instanceUrl) !== trimSlash(this.target.instanceUrl) || next.candidateId !== this.target.candidateId) {
        this.discardInstance()
        return
      }
      this.view = next
      this.stale = false
      this.status = 'ready'
    } catch (error) {
      if (!this.alive(epoch)) return
      if (annotationErrorKey(error) === 'annotations.error.instanceChanged') {
        this.discardInstance()
        return
      }
      // Keep the previous rows readable, but they no longer justify writes.
      this.stale = this.view !== null
      this.status = this.view === null ? 'failed' : 'ready'
      this.errorKey = annotationErrorKey(error)
    } finally {
      if (this.alive(epoch)) {
        this.loading = false
        this.changed()
      }
    }
  }

  /** Create one note from the in-memory draft. Empty/oversized drafts never post. */
  async createNote(): Promise<boolean> {
    const problem = noteContentProblem(this.draft)
    if (problem !== undefined) { this.report('note', problem); return false }
    const content = this.draft
    const ok = await this.run('note', instance => this.api.createNote(this.target.candidateId, content, instance))
    if (!ok) return false
    this.draft = ''
    this.notice = 'annotations.note.created'
    this.changed()
    return true
  }

  /** Replace a note's whole content (Margin has no PATCH). */
  async updateNote(noteId: number, content: string): Promise<boolean> {
    const note = this.note(noteId)
    if (note === undefined) { this.report('note', 'annotations.error.notFound'); return false }
    if (note.contentTruncated) { this.report('note', 'annotations.error.noteTruncated'); return false }
    const problem = noteContentProblem(content)
    if (problem !== undefined) { this.report('note', problem); return false }
    const candidateId = this.view?.candidateId
    if (candidateId === undefined) { this.report('note', 'annotations.error.notFound'); return false }
    // The projected snapshot is the edit precondition; a concurrent edit
    // changes the live content and the host answers 409 instead of overwriting.
    const ok = await this.run('note', instance => this.api.updateNote(candidateId, noteId, content, note.content, instance))
    if (!ok) return false
    this.notice = 'annotations.note.updated'
    this.changed()
    return true
  }

  /**
   * Delete one note after the exact-content proof. The proof sent upstream is
   * the snapshot content, not the typed text, so a typo can never widen it.
   */
  async deleteNote(noteId: number, typed: string): Promise<boolean> {
    const note = this.note(noteId)
    if (note === undefined) { this.report('note', 'annotations.error.notFound'); return false }
    if (note.contentTruncated) { this.report('note', 'annotations.error.noteTruncated'); return false }
    if (!canDeleteNote(note, typed)) { this.report('note', 'annotations.error.confirmRequired'); return false }
    const candidateId = this.view?.candidateId
    if (candidateId === undefined) { this.report('note', 'annotations.error.notFound'); return false }
    const ok = await this.run('note', instance => this.api.deleteNote(candidateId, note.id, note.content, instance))
    if (!ok) return false
    this.notice = 'annotations.note.deleted'
    this.changed()
    return true
  }

  /**
   * Create a highlight from the trimmed selection. An ambiguous reply stores
   * the pending selection; a resubmit must name the occurrence explicitly.
   */
  async createHighlight(selectedText: string, occurrence?: number): Promise<boolean> {
    if (!this.active || this.view === null || this.status !== 'ready' || this.busy || this.loading) return false
    if (this.stale) { this.report('highlight', 'annotations.error.unconfirmed'); return false }
    if (this.view.writesAllowed !== true) { this.report('highlight', 'annotations.error.writesDisabled'); return false }
    if (this.view.offsetsAvailable !== true) { this.report('highlight', 'annotations.error.offsetsUnavailable'); return false }
    const selection = selectionText(selectedText)
    if (selection === undefined) { this.report('highlight', 'annotations.error.emptySelection'); return false }
    const problem = selectionProblem(selection) ?? occurrenceProblem(this.ambiguous, selection, occurrence)
    if (problem !== undefined) { this.report('highlight', problem); return false }
    const ok = await this.run('highlight', instance => this.api.createHighlight({
      candidateId: this.target.candidateId,
      instanceUrl: instance,
      selectedText: selection,
      ...(occurrence === undefined ? {} : { occurrence }),
    }), selection)
    if (!ok) return false
    this.ambiguous = null
    this.notice = 'annotations.highlight.created'
    this.changed()
    return true
  }

  /** Link (or unlink, with `null`) one highlight to one of this article's notes. */
  async linkHighlight(highlightId: number, noteId: number | null): Promise<boolean> {
    if (this.highlight(highlightId) === undefined) { this.report('highlight', 'annotations.error.notFound'); return false }
    if (noteId !== null && this.note(noteId) === undefined) { this.report('highlight', 'annotations.error.notFound'); return false }
    const ok = await this.run('highlight', instance => this.api.linkHighlight(highlightId, noteId, instance))
    if (!ok) return false
    this.notice = noteId === null ? 'annotations.highlight.unlinked' : 'annotations.highlight.linked'
    this.changed()
    return true
  }

  /** Delete one highlight after the exact selected-text proof. */
  async deleteHighlight(highlightId: number, typed: string): Promise<boolean> {
    const highlight = this.highlight(highlightId)
    if (highlight === undefined) { this.report('highlight', 'annotations.error.notFound'); return false }
    if (!canDeleteHighlight(highlight, typed)) { this.report('highlight', 'annotations.error.confirmRequired'); return false }
    const ok = await this.run('highlight', instance => this.api.deleteHighlight({
      highlightId: highlight.id,
      candidateId: this.target.candidateId,
      selectedText: highlight.selectedText,
      instanceUrl: instance,
    }))
    if (!ok) return false
    this.notice = 'annotations.highlight.deleted'
    this.changed()
    return true
  }

  private note(id: number): MarginNote | undefined {
    return this.view?.notes.find(entry => entry.id === id)
  }

  private highlight(id: number): MarginHighlight | undefined {
    return this.view?.highlights.find(entry => entry.id === id)
  }

  private alive(epoch: number): boolean {
    return this.active && epoch === this.epoch
  }

  private report(surface: 'note' | 'highlight', key: AnnotationKey): void {
    if (!this.active) return
    if (surface === 'note') this.noteError = key
    else this.errorKey = key
    this.notice = null
    this.changed()
  }

  /** Instance identity moved: drop results, draft, ambiguity and the snapshot. */
  private discardInstance(): void {
    this.epoch++
    this.view = null
    this.status = 'failed'
    this.loading = false
    this.busy = false
    this.stale = false
    this.errorKey = 'annotations.error.instanceChanged'
    this.noteError = null
    this.notice = null
    this.draft = ''
    this.ambiguous = null
    this.changed()
  }

  /**
   * One gated mutation. The POST reply only proves *that something happened*;
   * the following re-read is what the session then trusts. A failed re-read
   * leaves the snapshot stale because the write may have landed.
   */
  private async run(
    surface: 'note' | 'highlight',
    action: (instance: string) => Promise<{ instanceUrl: string }>,
    ambiguityFor?: string,
  ): Promise<boolean> {
    if (!this.active) return false
    const view = this.view
    if (view === null || this.status !== 'ready' || this.stale || this.busy || this.loading) return false
    if (view.writesAllowed !== true) { this.report(surface, 'annotations.error.writesDisabled'); return false }
    const epoch = this.epoch
    const instance = view.instanceUrl
    let stage: 'post' | 'reread' = 'post'
    this.busy = true
    this.errorKey = null
    this.noteError = null
    this.notice = null
    if (surface === 'highlight') this.ambiguous = null
    this.changed()
    try {
      const reply = await action(instance)
      if (!this.alive(epoch)) return false
      if (trimSlash(reply.instanceUrl) !== trimSlash(instance)) {
        this.discardInstance()
        return false
      }
      stage = 'reread'
      const next = await this.api.loadAnnotations(this.target.candidateId, instance)
      if (!this.alive(epoch)) return false
      if (trimSlash(next.instanceUrl) !== trimSlash(instance) || next.candidateId !== this.target.candidateId) {
        this.discardInstance()
        return false
      }
      this.view = next
      this.stale = false
      this.status = 'ready'
      return true
    } catch (error) {
      if (!this.alive(epoch)) return false
      if (stage === 'reread') {
        // The write was acknowledged but no re-read confirmed it: unknown state.
        this.stale = true
        const key: AnnotationKey = 'annotations.error.unconfirmed'
        if (surface === 'note') this.noteError = key
        else this.errorKey = key
        return false
      }
      const code = error instanceof MarginApiError ? error.code : undefined
      if (code === 'instance_changed') {
        this.discardInstance()
        return false
      }
      const key = surface === 'note' ? noteErrorKey(error) : annotationErrorKey(error)
      if (surface === 'highlight' && code === 'ambiguous_selection' && ambiguityFor !== undefined) {
        // Keep the selection so the user can name the occurrence; nothing is
        // anchored until an explicit resubmit succeeds.
        this.ambiguous = { selectedText: ambiguityFor, count: ambiguityCount(error) }
      } else if (code !== undefined && INSTANCE_DRIFT.has(code)) {
        // A conflict/not-found reply means the snapshot no longer describes
        // live state; every control stops until a successful refresh.
        this.stale = true
      }
      if (surface === 'note') this.noteError = key
      else this.errorKey = key
      return false
    } finally {
      if (this.alive(epoch)) {
        this.busy = false
        this.changed()
      }
    }
  }
}
