/**
 * Pure logic for the 来源与凭据 panel.
 *
 * Deliberately free of React (and of any DOM API) so it can be compiled and
 * driven standalone. It owns three things:
 *
 * 1. Client-side validation, using the host's own domain/cookie predicates so
 *    the browser and `src/managementRoutes.ts` cannot drift apart.
 * 2. Fixed error text — upstream messages are never relayed. A failure becomes
 *    one of the locale keys below, chosen from the route's error code (or the
 *    HTTP status), never from `error.message`.
 * 3. The request controller: one instance identity per snapshot, one epoch per
 *    read/mutation, so a late response after close, unmount or an instance
 *    change cannot touch state.
 *
 * The pending cookie is held only in this object's `cookie` field while the
 * user types. It is cleared on close, on an instance change, and after every
 * submit attempt. It is never put in storage, a URL, a log or rendered copy.
 */

import type { MarginManagementView, MarginSourceMeta } from '../protocol.ts'
import { SUPPORTED_CREDENTIAL_DOMAINS, canonicalDomain, cookieProblem } from '../management.ts'
import { MarginApiError } from './api.ts'
import type {
  MarginCredentialCreateReply, MarginCredentialDeleteReply, MarginSourceCreateReply,
  MarginSourceDeleteReply, MarginSourceFetchReply, MarginSourceUpdateReply,
} from './api.ts'
import type { MarginKey } from './locales.ts'

/** Every key this panel may emit; checked against the dictionary at compile time. */
export type SourceKey = Extract<MarginKey, `sources.${string}`>

/** Domains the current backend actually consumes (mirrors src/management.ts). */
export const SUPPORTED_DOMAINS: readonly string[] = SUPPORTED_CREDENTIAL_DOMAINS

/**
 * The routes this panel needs. Structurally satisfied by `MarginApi`; the
 * panel only ever sees this narrow face, so tests can inject a fake.
 */
export interface SourceApi {
  loadManagement(): Promise<MarginManagementView>
  createSource(feedUrl: string, label: string, intervalMinutes: number, instanceUrl: string): Promise<MarginSourceCreateReply>
  setSourceStatus(id: number, status: 'active' | 'paused', instanceUrl: string): Promise<MarginSourceUpdateReply>
  fetchSource(id: number, instanceUrl: string): Promise<MarginSourceFetchReply>
  deleteSource(id: number, confirmOrigin: string, instanceUrl: string): Promise<MarginSourceDeleteReply>
  createCredential(domain: string, cookie: string, instanceUrl: string): Promise<MarginCredentialCreateReply>
  deleteCredential(id: number, domain: string, instanceUrl: string): Promise<MarginCredentialDeleteReply>
}

/** Route error codes → fixed local wording. No code means "look at the status". */
const CODE_KEYS: Record<string, SourceKey> = {
  writes_disabled: 'sources.errWritesDisabled',
  instance_changed: 'sources.errInstanceChanged',
  not_configured: 'sources.errNotConfigured',
  unsupported_domain: 'sources.errUnsupportedDomain',
  confirm_required: 'sources.errConfirmRequired',
  confirmation_mismatch: 'sources.errConfirmMismatch',
  invalid_feed_url: 'sources.errInvalidFeedUrl',
  invalid_label: 'sources.errInvalidLabel',
  invalid_interval: 'sources.errInvalidInterval',
  invalid_domain: 'sources.errInvalidDomain',
  invalid_cookie: 'sources.errCookieInvalid',
  margin_unauthorized: 'sources.errUnauthorized',
  margin_not_found: 'sources.errNotFound',
  margin_rejected: 'sources.errRejected',
  margin_conflict: 'sources.errConflict',
  margin_timeout: 'sources.errTimeout',
  margin_upstream_error: 'sources.errUpstream',
  margin_bad_shape: 'sources.errUpstream',
  margin_request_failed: 'sources.errRequest',
  not_found: 'sources.errNotFound',
  invalid_id: 'sources.errRequest',
  bad_body: 'sources.errRequest',
  method_not_allowed: 'sources.errRequest',
  internal_error: 'sources.errRequest',
}

/**
 * Map a thrown value to a fixed key. `error.message` is intentionally never
 * read: it can quote a URL, a header or an upstream stack.
 */
export function sourceErrorKey(error: unknown): SourceKey {
  if (!(error instanceof MarginApiError)) return 'sources.errNetwork'
  const code = typeof error.code === 'string' ? CODE_KEYS[error.code] : undefined
  if (code !== undefined) return code
  const status = error.status
  if (status === 401 || status === 403) return 'sources.errUnauthorized'
  if (status === 404) return 'sources.errNotFound'
  if (status === 409) return 'sources.errConflict'
  if (status === 422) return 'sources.errRejected'
  if (status === 504) return 'sources.errTimeout'
  if (typeof status === 'number' && status >= 500) return 'sources.errUpstream'
  return 'sources.errRequest'
}

/** A feed URL must be absolute HTTP(S), credential-free and visible-text only. */
export function feedProblem(value: string): SourceKey | undefined {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(value)) return 'sources.errInvalidFeedUrl'
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'sources.errInvalidFeedUrl'
    if (url.username !== '' || url.password !== '') return 'sources.errInvalidFeedUrl'
    if (url.hostname === '') return 'sources.errInvalidFeedUrl'
    return undefined
  } catch { return 'sources.errInvalidFeedUrl' }
}

export function labelProblem(value: string): SourceKey | undefined {
  if (typeof value !== 'string') return 'sources.errInvalidLabel'
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) return 'sources.errInvalidLabel'
  return undefined
}

export function intervalProblem(minutes: number): SourceKey | undefined {
  // The host accepts 5–10080; refuse locally instead of round-tripping a 400.
  if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 10080) return 'sources.errInvalidInterval'
  return undefined
}

/** Parse the interval text field without inventing a number out of "12.5" or "". */
export function parseInterval(text: string): number | undefined {
  if (typeof text !== 'string' || !/^\d{1,5}$/.test(text.trim())) return undefined
  const value = Number(text.trim())
  return Number.isSafeInteger(value) ? value : undefined
}

/** Client-side cookie guard; reuses the host predicate and localises the reason. */
export function cookieInputProblem(cookie: string): SourceKey | undefined {
  return cookieProblem(cookie) === undefined ? undefined : 'sources.errCookieInvalid'
}

/** Domain must be a bare lowercase host AND one the backend consumes. */
export function credentialDomainProblem(domain: string): SourceKey | undefined {
  const canonical = canonicalDomain(domain)
  if (canonical === undefined) return 'sources.errInvalidDomain'
  if (!SUPPORTED_DOMAINS.includes(canonical)) return 'sources.errUnsupportedDomain'
  return undefined
}

const STATUS_KEYS: Record<MarginSourceMeta['status'], SourceKey> = {
  active: 'sources.status.active',
  paused: 'sources.status.paused',
  error: 'sources.status.error',
  unknown: 'sources.status.unknown',
}

/** Status badge key; an unexpected value is shown as unknown, never echoed. */
export function statusKey(status: string): SourceKey {
  return STATUS_KEYS[status as MarginSourceMeta['status']] ?? 'sources.status.unknown'
}

/**
 * Panel controller. `changed` is the component's redraw callback; every async
 * completion checks the epoch first, so post-close results are inert.
 */
export class SourceSession {
  /** Last successful read; null means "no snapshot, nothing is actionable". */
  view: MarginManagementView | null = null
  /**
   * True when the snapshot can no longer be trusted to describe live state
   * (a read failed, or a mutation was not confirmed by a re-read). Rows stay
   * readable; every mutation is disabled until a successful read.
   */
  stale = false
  /** Fixed locale key for the current status line ('' = nothing to say). */
  note: SourceKey | '' = ''
  /** `{count}` substitution for the manual-fetch message. */
  noteCount = 0
  loading = false
  busy = false
  /**
   * The one and only place the pending cookie lives. Never rendered as text,
   * never persisted, cleared aggressively (see `clearSecret`).
   */
  cookie = ''
  private active = false
  private epoch = 0

  constructor(readonly api: SourceApi, private changed: () => void) {}

  /** Open: a fresh epoch invalidates anything still in flight from before. */
  start(): void {
    this.active = true
    this.epoch++
    this.note = ''
    this.noteCount = 0
    this.loading = true
    // A snapshot from a previous open may not match the current host config
    // (or its write gates), so nothing is actionable until this read lands.
    this.stale = this.view !== null
    this.changed()
    void this.refresh(false)
  }

  /** Close/unmount: bump the epoch first so late results cannot write state. */
  stop(): void {
    this.active = false
    this.epoch++
    this.busy = false
    this.loading = false
    this.clearSecret()
  }

  /** Cookie input handler; the redraw keeps the password field controlled. */
  setCookie(value: string): void {
    if (!this.active) return
    this.cookie = typeof value === 'string' ? value : ''
    this.changed()
  }

  /** Surface a locally-rejected action (validation, wrong confirmation). */
  report(key: SourceKey): void {
    if (!this.active) return
    this.note = key
    this.noteCount = 0
    this.changed()
  }

  /** Read-only refresh. Never mutates, never cancels anything upstream. */
  async refresh(explicit = true): Promise<void> {
    if (!this.active) return
    const epoch = this.epoch
    this.loading = true
    if (explicit) this.note = ''
    this.changed()
    try {
      const next = await this.api.loadManagement()
      if (!this.alive(epoch)) return
      // A different instance means every id/credential below belongs to a
      // configuration that is no longer in force.
      if (this.view !== null && this.view.instanceUrl !== next.instanceUrl) { this.discardInstance(); return }
      this.view = next
      this.stale = false
    } catch (error) {
      if (!this.alive(epoch)) return
      if (sourceErrorKey(error) === 'sources.errInstanceChanged') { this.discardInstance(); return }
      // Keep what was readable, but stop claiming it is current.
      this.stale = this.view !== null
      this.note = sourceErrorKey(error)
    } finally {
      if (this.alive(epoch)) {
        this.loading = false
        this.changed()
      }
    }
  }

  async createSource(feedUrl: string, label: string, intervalText: string): Promise<boolean> {
    const minutes = parseInterval(intervalText)
    const problem = feedProblem(feedUrl) ?? labelProblem(label)
      ?? (minutes === undefined ? 'sources.errInvalidInterval' : intervalProblem(minutes))
    if (problem !== undefined) { this.report(problem); return false }
    return this.run('source',
      instance => this.api.createSource(feedUrl.trim(), label.trim(), minutes as number, instance),
      () => 'sources.noteCreated',
      (next, reply) => next.sources.some(source => source.id === reply.source.id))
  }

  async setSourceStatus(id: number, status: 'active' | 'paused'): Promise<boolean> {
    if (this.source(id) === undefined) { this.report('sources.errSourceMissing'); return false }
    return this.run('source',
      instance => this.api.setSourceStatus(id, status, instance),
      () => (status === 'paused' ? 'sources.notePaused' : 'sources.noteResumed'),
      (next, reply) => next.sources.find(source => source.id === reply.source.id)?.status === reply.source.status)
  }

  async fetchSource(id: number): Promise<boolean> {
    const source = this.source(id)
    if (source === undefined) { this.report('sources.errSourceMissing'); return false }
    // The backend exposes a manual poll for sources it is still polling or has
    // marked broken; a paused source has nothing to fetch.
    if (source.status !== 'active' && source.status !== 'error') { this.report('sources.errFetchNotAllowed'); return false }
    return this.run('source',
      instance => this.api.fetchSource(id, instance),
      reply => { this.noteCount = reply.newCandidates; return 'sources.noteFetched' })
  }

  async deleteSource(id: number, confirmOrigin: string): Promise<boolean> {
    const source = this.source(id)
    if (source === undefined) { this.report('sources.errSourceMissing'); return false }
    const typed = typeof confirmOrigin === 'string' ? confirmOrigin.trim() : ''
    if (typed === '') { this.report('sources.errConfirmRequired'); return false }
    if (typed !== source.feedOrigin) { this.report('sources.errConfirmMismatch'); return false }
    // Send the origin we displayed, not raw user text: the host re-reads live
    // state and compares byte-for-byte.
    return this.run('source',
      instance => this.api.deleteSource(id, source.feedOrigin, instance),
      () => 'sources.noteDeleted',
      (next, reply) => !next.sources.some(source => source.id === reply.deletedId))
  }

  async createCredential(domain: string, cookie: string): Promise<boolean> {
    const problem = credentialDomainProblem(domain) ?? cookieInputProblem(cookie)
    if (problem !== undefined) { this.report(problem); return false }
    const canonical = canonicalDomain(domain) as string
    return this.run('credential',
      instance => this.api.createCredential(canonical, cookie, instance),
      () => 'sources.noteCredentialCreated',
      (next, reply) => next.credentials.some(credential => credential.id === reply.credential.id),
      true)
  }

  async deleteCredential(id: number, domain: string): Promise<boolean> {
    const credential = this.view?.credentials.find(entry => entry.id === id)
    if (credential === undefined || credential.domain !== canonicalDomain(domain)) {
      this.report('sources.errCredentialMissing')
      return false
    }
    return this.run('credential',
      instance => this.api.deleteCredential(id, credential.domain, instance),
      () => 'sources.noteCredentialDeleted',
      (next, reply) => !next.credentials.some(entry => entry.id === reply.deletedId))
  }

  private source(id: number): MarginSourceMeta | undefined {
    return this.view?.sources.find(entry => entry.id === id)
  }

  private alive(epoch: number): boolean {
    return this.active && epoch === this.epoch
  }

  private clearSecret(): void {
    this.cookie = ''
  }

  /** Instance identity moved: drop results, secrets and the stale snapshot. */
  private discardInstance(): void {
    this.epoch++
    this.clearSecret()
    this.view = null
    this.stale = false
    this.busy = false
    this.loading = false
    this.noteCount = 0
    this.note = 'sources.errInstanceChanged'
    this.changed()
  }

  /**
   * One gated mutation. The reply is never treated as final state: a second
   * `/management` read must agree on the instance *and* show the expected
   * delta before the write is reported as confirmed.
   */
  private async run<T extends { instanceUrl: string }>(
    gate: 'source' | 'credential',
    action: (instance: string) => Promise<T>,
    done: (reply: T) => SourceKey,
    verify?: (next: MarginManagementView, reply: T) => boolean,
    clearsSecret = false,
  ): Promise<boolean> {
    if (!this.active) return false
    const view = this.view
    if (view === null || this.stale) { this.report('sources.errNoSnapshot'); return false }
    if (this.busy) return false
    if ((gate === 'source' ? view.sourceWritesAllowed : view.credentialWritesAllowed) !== true) {
      this.report('sources.errWritesDisabled')
      return false
    }
    const epoch = this.epoch
    const instance = view.instanceUrl
    let stage: 'action' | 'reread' = 'action'
    this.busy = true
    this.note = ''
    this.noteCount = 0
    this.changed()
    try {
      const reply = await action(instance)
      if (!this.alive(epoch)) return false
      if (reply.instanceUrl !== instance) { this.discardInstance(); return false }
      stage = 'reread'
      const next = await this.api.loadManagement()
      if (!this.alive(epoch)) return false
      if (next.instanceUrl !== instance) { this.discardInstance(); return false }
      this.view = next
      const confirmed = verify === undefined || verify(next, reply)
      // A 2xx reply alone is not confirmation: the re-read must show the
      // effect. Otherwise the snapshot stays readable but writes are blocked.
      this.stale = !confirmed
      if (!confirmed) {
        this.note = 'sources.errUnconfirmed'
        this.noteCount = 0
        return false
      }
      this.note = done(reply)
      return true
    } catch (error) {
      if (!this.alive(epoch)) return false
      const key = sourceErrorKey(error)
      if (key === 'sources.errInstanceChanged') { this.discardInstance(); return false }
      // The snapshot can no longer be trusted to describe the confirmed state.
      this.stale = true
      this.note = stage === 'reread' ? 'sources.errUnconfirmed' : key
      this.noteCount = 0
      return false
    } finally {
      if (clearsSecret) this.clearSecret()
      if (this.alive(epoch)) {
        this.busy = false
        this.changed()
      }
    }
  }
}
