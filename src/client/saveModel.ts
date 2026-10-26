/**
 * Pure state for the save-to-Trilium section (spec 006, browser half).
 *
 * Boundaries:
 *  1. Only the two save routes are reachable from this face. It cannot change
 *     reading status, import, annotate or call a model.
 *  2. Nothing is saved automatically: opening an article only reads the state.
 *     The single POST happens after an explicit click.
 *  3. The host already pre-checks `is_saved_to_trilium` and refuses repeats; the
 *     panel keeps the same guard locally and never retries on its own.
 *  4. An ambiguous reply is verified with one read-only state call before it is
 *     reported. A lost reply is never turned into a second save.
 */

import type { MarginSaveState, MarginSaveView } from '../protocol.ts'
import { MarginApiError } from './api.ts'
import type { MarginKey } from './locales.ts'

/** The routes this panel needs; structurally satisfied by MarginApi. */
export interface SaveApi {
  loadSaveState(id: number, instanceUrl: string): Promise<MarginSaveView>
  saveToTrilium(candidateId: number, instanceUrl: string, marginUrl: string): Promise<MarginSaveState>
  /**
   * Supplied by the shell. Without it nothing renders and no save request is
   * issued, so an installation that does not opt in adds no UI.
   */
  Panel?: SavePanelComponent
}

/** Props the reader passes to the injected panel component. */
export interface SavePanelProps {
  api: SaveApi
  candidateId: number
  /** Reader URL of the article; the instance is derived from it. */
  marginUrl: string
  t: (key: MarginKey) => string
}

/** Framework-free component type (same pattern as the other panels). */
export type SavePanelComponent = (props: SavePanelProps) => unknown

/**
 * Recover the configured Margin origin from the candidate's reader URL.
 * Regex-only, mirroring `annotationInstance`/`readerInstance`; a URL we cannot
 * parse disables the section rather than guessing an instance.
 */
export function saveInstance(marginUrl: string): string | null {
  if (typeof marginUrl !== 'string') return null
  const match = /^(https?:\/\/[^\s/]+(?:\/[^\s?#]*)?)\/(?:reader|candidate)\/\d+\/?$/.exec(marginUrl)
  if (match === null) return null
  const origin = (match[1] ?? '').replace(/\/+$/, '')
  return origin === '' ? null : origin
}

/** Fixed error key; upstream prose is never relayed. */
export function saveErrorKey(error: unknown): MarginKey {
  if (!(error instanceof MarginApiError)) return 'save.error.network'
  const code = typeof error.code === 'string' ? error.code : ''
  if (code === 'instance_changed') return 'save.error.instanceChanged'
  if (code === 'saves_disabled') return 'save.error.disabled'
  if (code === 'already_saved') return 'save.error.alreadySaved'
  if (code === 'save_conflict') return 'save.error.conflict'
  if (code === 'save_unconfirmed' || code === 'trilium_timeout') return 'save.error.uncertain'
  if (code === 'trilium_not_configured') return 'save.error.notConfigured'
  if (code === 'candidate_not_found') return 'save.error.notFound'
  if (code === 'margin_unauthorized') return 'save.error.unauthorized'
  if (code === 'trilium_save_failed' || code === 'margin_unavailable') return 'save.error.failed'
  switch (error.status) {
    case 400: return 'save.error.request'
    case 401: return 'save.error.unauthorized'
    case 403: return 'save.error.disabled'
    case 404: return 'save.error.notFound'
    case 409: return 'save.error.conflict'
    case 422: return 'save.error.notConfigured'
    case 504: return 'save.error.uncertain'
    default: return 'save.error.failed'
  }
}

export type SaveStatus = 'loading' | 'hidden' | 'ready' | 'saving' | 'saved' | 'failed'

/** One article's save section. */
export class SaveSession {
  status: SaveStatus = 'loading'
  view: MarginSaveView | null = null
  errorKey: MarginKey | null = null
  /** True when the last write was acknowledged but its final state is uncertain. */
  unconfirmed = false
  private active = true
  private epoch = 0
  private busy = false
  constructor(
    readonly api: SaveApi,
    readonly target: { candidateId: number; instanceUrl: string },
    private changed: () => void,
  ) {}

  private alive(epoch: number): boolean {
    return this.active && epoch === this.epoch
  }

  private expect(view: MarginSaveView | MarginSaveState): boolean {
    return view.instanceUrl === this.target.instanceUrl
      && view.candidateId === this.target.candidateId
  }

  stop(): void {
    this.active = false
    this.epoch++
    this.busy = false
  }

  /** Read-only: safe on every article open, and the only call until a click. */
  async start(): Promise<void> {
    if (!this.active) return
    if (this.target.instanceUrl === '') {
      this.status = 'hidden'
      this.changed()
      return
    }
    const epoch = this.epoch
    this.status = 'loading'
    this.changed()
    try {
      const view = await this.api.loadSaveState(this.target.candidateId, this.target.instanceUrl)
      if (!this.alive(epoch)) return
      if (!this.expect(view)) {
        this.status = 'hidden'
        this.changed()
        return
      }
      this.view = view
      this.status = view.saveAllowed || view.saved ? 'ready' : 'hidden'
    } catch (error) {
      if (!this.alive(epoch)) return
      // Read failure hides the action instead of offering a blind save.
      this.status = 'hidden'
      this.errorKey = saveErrorKey(error)
    } finally {
      if (this.alive(epoch)) this.changed()
    }
  }

  /** Explicit single save. Never runs unless the state allows it. */
  async save(): Promise<boolean> {
    const view = this.view
    if (!this.active || this.busy || this.status !== 'ready' || view === null) return false
    if (view.saved || view.saveAllowed !== true) return false
    const epoch = this.epoch
    this.busy = true
    this.status = 'saving'
    this.errorKey = null
    this.changed()
    try {
      const reply = await this.api.saveToTrilium(this.target.candidateId, this.target.instanceUrl, this.marginUrlFor(view))
      if (!this.alive(epoch)) return false
      if (!this.expect(reply) || reply.marginUrl !== this.marginUrlFor(view)) {
        this.status = 'failed'
        this.errorKey = 'save.error.instanceChanged'
        return false
      }
      // The receipt is a valid success only when the backend says so and names
      // the record; otherwise verify once, read-only.
      if (reply.saved && reply.saveRecordId !== null) {
        this.view = { ...view, saved: true, saveRecordId: reply.saveRecordId, externalRef: reply.externalRef, savedAt: reply.savedAt, needsVerification: reply.needsVerification }
        this.status = 'saved'
        this.unconfirmed = reply.needsVerification
        return true
      }
      return await this.confirmAfterFailure(epoch, reply.needsVerification || reply.saved)
    } catch (error) {
      if (!this.alive(epoch)) return false
      const key = saveErrorKey(error)
      // A lost/ambiguous reply is always verified before reporting failure, and
      // a concurrent save is reconciled against the authoritative state.
      if (key === 'save.error.uncertain' || key === 'save.error.network' || key === 'save.error.failed'
        || key === 'save.error.alreadySaved' || key === 'save.error.conflict') {
        return await this.confirmAfterFailure(epoch, true)
      }
      this.errorKey = key
      this.status = 'failed'
      return false
    } finally {
      if (this.alive(epoch)) {
        this.busy = false
        this.changed()
      }
    }
  }

  /** The exact URL the host compares: `<instance>/reader/<id>`. */
  private marginUrlFor(view: MarginSaveView): string {
    return view.marginUrl !== '' ? view.marginUrl : `${this.target.instanceUrl}/reader/${this.target.candidateId}`
  }

  /** One read-only state check after an ambiguous write; never a second save. */
  private async confirmAfterFailure(epoch: number, uncertain: boolean): Promise<boolean> {
    try {
      const next = await this.api.loadSaveState(this.target.candidateId, this.target.instanceUrl)
      if (!this.alive(epoch)) return false
      if (!this.expect(next)) {
        this.status = 'failed'
        this.errorKey = 'save.error.instanceChanged'
        return false
      }
      this.view = next
      if (next.saved) {
        this.status = 'saved'
        this.unconfirmed = true
        this.errorKey = null
        return true
      }
    } catch {
      // Fall through: the state is still unknown.
    }
    if (!this.alive(epoch)) return false
    this.status = 'failed'
    this.errorKey = 'save.error.uncertain'
    this.unconfirmed = uncertain
    return false
  }
}
