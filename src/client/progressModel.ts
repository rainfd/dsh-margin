/**
 * Pure reading-progress helpers (spec 008, browser half).
 *
 * Boundaries this module exists to enforce:
 *  1. No React and no DOM. Every function is deterministic given its arguments,
 *     so the reader stays testable without a browser and the model cannot read
 *     scroll position behind the caller's back.
 *  2. No storage of any kind: no localStorage/sessionStorage, no cookies, no URL
 *     state. Progress lives only in the host's bounded progress file, reached
 *     through `ProgressApi`.
 *  3. A position is an observation, never a read state. `ratio: 1` means the
 *     bottom was reached; it never means "finished", and nothing here marks an
 *     article read or writes Margin.
 *  4. `contentVersion` is an opaque change detector supplied by the reader. The
 *     host never invents it, so an old pixel position cannot be silently
 *     re-applied to changed text.
 *
 * No React import: tests exercise this module headlessly.
 */

import type { MarginCandidateDetail, MarginProgressEntry, MarginProgressView } from '../protocol.ts'

/** Bytes-like prefix fed to the cheap hash. Changes past it still move the length. */
export const VERSION_HASH_CHARS = 4096
/** Hard cap on extracted table-of-contents entries. */
export const MAX_TOC_ENTRIES = 200
/** Recent rows the reader asks the host for when looking up one position. */
export const PROGRESS_LOOKUP_LIMIT = 100

/** The subset of a candidate/detail that determines the body version. */
export type ProgressSource = Pick<MarginCandidateDetail, 'title' | 'contentMd' | 'contentText'>

/**
 * Which text the reader renders, mirroring `selectReaderBody` in readerModel
 * (markdown wins, then plain text, never the summary). Kept local so this pure
 * model has no dependency on the render layer; the agreement is asserted in
 * tests/progress-ui.test.mjs.
 */
function bodyOf(detail: ProgressSource): { kind: 'markdown' | 'text' | 'empty'; text: string } {
  if (detail.contentMd.trim() !== '') return { kind: 'markdown', text: detail.contentMd }
  if (detail.contentText.trim() !== '') return { kind: 'text', text: detail.contentText }
  return { kind: 'empty', text: '' }
}

/** Mirrors the POST /progress body; every field is validated by the host. */
export interface ProgressSaveInput {
  instanceUrl: string
  candidateId: number
  contentVersion: string
  title?: string
  ratio: number
  scrollTop?: number
  anchor?: string
}

/** 200 from POST /progress. */
export interface ProgressSaveReply {
  entry: MarginProgressEntry
}

/** 200 from POST /progress-clear; deleting a row never touches Margin. */
export interface ProgressClearReply {
  removed: number
  scope: 'one' | 'all'
  marginUntouched: true
}

/**
 * The only progress surface the reader may use. Deliberately does not expose
 * `setCandidateStatus` or any import/save route: local scroll position can
 * never mutate the content store or reading status.
 */
export interface ProgressApi {
  loadProgress(limit?: number): Promise<MarginProgressView>
  saveProgress(input: ProgressSaveInput): Promise<ProgressSaveReply>
  clearProgress(key?: string): Promise<ProgressClearReply>
}

/**
 * FNV-1a, 32-bit. A cheap change detector, **not** a cryptographic digest: it
 * detects edits, it does not authenticate the body and is not collision-proof.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193)
  }
  return hash >>> 0
}

/**
 * Deterministic, short, stable version of what the reader rendered.
 *
 * Derived from the body kind (markdown vs plain text, which changes layout),
 * the full body length, a bounded prefix and the title. It changes when any of
 * those change and is identical for the same body, across sessions and
 * processes. Opaque to the host: no meaning is assigned to its characters.
 *
 * Documented limit: the hash covers only the first `VERSION_HASH_CHARS`
 * characters, so a same-length edit past that prefix is not detected. That is
 * the bounded-cost tradeoff of a cheap detector, not a claim of exactness.
 */
export function contentVersion(detail: ProgressSource): string {
  const body = bodyOf(detail)
  const kind = body.kind === 'markdown' ? 'm' : body.kind === 'text' ? 't' : 'e'
  const head = body.text.slice(0, VERSION_HASH_CHARS)
  const digest = fnv1a(detail.title + '\u0000' + body.text.length + '\u0000' + head)
  return `${kind}${body.text.length.toString(36)}-${digest.toString(36)}`
}

/** One extracted heading. */
export interface TocEntry {
  /** 1–6, matching the heading level. */
  depth: number
  /** Plain label with markdown emphasis/links/code markers removed. */
  text: string
  /**
   * 0-based character offset of the heading in the markdown source. It also
   * identifies the entry, and its ratio (index / source length) is the
   * proportional fallback used when the rendered heading cannot be found.
   */
  index: number
}

/** A fence line: marker character, marker length and the trailing info string. */
function fenceLine(line: string): { char: string; size: number; info: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (match === null) return null
  const marker = match[1] ?? ''
  const info = match[2] ?? ''
  // A backtick fence's info string may not contain a backtick (CommonMark).
  if (marker.startsWith('`') && info.includes('`')) return null
  return { char: marker[0] ?? '`', size: marker.length, info }
}

/**
 * Strip the markdown decoration a heading label can carry. Cheap on purpose:
 * this is a human-readable label, not a CommonMark parser.
 */
function headingLabel(raw: string): string {
  let text = raw
  text = text.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
  text = text.replace(/<[^>]*>/g, '')
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
  text = text.replace(/`+([^`]*)`+/g, '$1')
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/(^|[^\w])__([^_]+)__(?!\w)/g, '$1$2')
  text = text.replace(/\*([^*]+)\*/g, '$1')
  text = text.replace(/(^|[^\w])_([^_]+)_(?!\w)/g, '$1$2')
  text = text.replace(/~~([^~]+)~~/g, '$1')
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!~<>])/g, '$1')
  text = text.replace(/^[*_~`\s]+|[*_~`\s]+$/g, '')
  return text.replace(/\s+/g, ' ').trim()
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
// Block starts that can never be setext-heading paragraph text.
const BLOCK_START = /^(?: {4,}|\t|>|[-+*][ \t]+|\d+[.)][ \t]+|\||<|\[[^\]]+\]:)/

/**
 * Extract ATX (`#`…`######`) and cheap setext (`===` / `---`) headings from
 * markdown source.
 *
 * Fenced code (``` and ~~~) is skipped entirely, inline code is not treated as
 * a heading, heading labels lose emphasis/link/code markers, blank labels are
 * dropped, and at most `MAX_TOC_ENTRIES` entries are returned in document order.
 * Not a full CommonMark parser: blockquoted headings and indented-code fences
 * are intentionally out of scope.
 */
export function tocFromMarkdown(markdown: string): TocEntry[] {
  const entries: TocEntry[] = []
  if (markdown === '') return entries
  const lines = markdown.split('\n')
  let offset = 0
  let fence: { char: string; size: number } | null = null
  let paragraph: { text: string; offset: number } | null = null
  for (const raw of lines) {
    if (entries.length >= MAX_TOC_ENTRIES) break
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const info = fenceLine(line)
    if (fence !== null) {
      // Only a same-character fence at least as long, with no info string, closes.
      if (info !== null && info.char === fence.char && info.size >= fence.size && info.info.trim() === '') fence = null
      paragraph = null
      offset += raw.length + 1
      continue
    }
    if (info !== null) {
      fence = { char: info.char, size: info.size }
      paragraph = null
      offset += raw.length + 1
      continue
    }
    const atx = ATX.exec(line)
    if (atx !== null) {
      const label = headingLabel((atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, ''))
      if (label !== '') entries.push({ depth: atx[1]?.length ?? 1, text: label, index: offset })
      paragraph = null
      offset += raw.length + 1
      continue
    }
    const setext = paragraph === null ? null : SETEXT.exec(line)
    if (setext !== null && paragraph !== null) {
      const marker = setext[1] ?? ''
      const label = headingLabel(paragraph.text)
      if (label !== '') entries.push({ depth: marker.startsWith('=') ? 1 : 2, text: label, index: paragraph.offset })
      paragraph = null
      offset += raw.length + 1
      continue
    }
    if (line.trim() === '' || BLOCK_START.test(line) || THEMATIC.test(line)) {
      paragraph = null
    } else {
      const text = line.trim()
      paragraph = paragraph === null
        ? { text, offset }
        : { text: paragraph.text + ' ' + text, offset: paragraph.offset }
    }
    offset += raw.length + 1
  }
  return entries
}

function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/**
 * Fraction scrolled, clamped to 0–1.
 *
 * When the content fits (`scrollHeight <= clientHeight`) this returns 1,
 * because the bottom is already visible. That is a statement about position,
 * **not** about reading: "fits on screen" must never be rendered as "read".
 */
export function readingRatio(scrollTop: number, clientHeight: number, scrollHeight: number): number {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(clientHeight) || !Number.isFinite(scrollHeight)) return 0
  if (scrollHeight <= clientHeight) return 1
  return Math.min(1, Math.max(0, scrollTop / (scrollHeight - clientHeight)))
}

/** A ratio and the wall-clock time it was observed at. */
export interface ProgressPoint {
  ratio: number
  at: number
}

/**
 * Whether a scroll position is worth a write.
 *
 * Writes are throttled by both ratio delta and elapsed time, so ordinary
 * reading does not post once per scroll event. The first observation is always
 * persisted; a non-finite point never is. Teardown/back saves bypass this on
 * purpose (the caller asks for `force`).
 */
export function shouldPersist(previous: ProgressPoint | null, next: ProgressPoint, minDelta = 0.01, minIntervalMs = 5000): boolean {
  if (!Number.isFinite(next.ratio) || !Number.isFinite(next.at)) return false
  if (previous === null || !Number.isFinite(previous.ratio) || !Number.isFinite(previous.at)) return true
  if (next.at - previous.at >= minIntervalMs) return true
  return Math.abs(clampRatio(next.ratio) - clampRatio(previous.ratio)) >= minDelta
}

/** The reason a saved position is not restored. */
export type RestoreReason = 'no-entry' | 'version-mismatch' | 'at-start'

/** What (if anything) the reader should restore. */
export interface RestorePlan {
  restore: boolean
  ratio: number
  approximate: boolean
  reason?: RestoreReason
}

/**
 * Decide whether a stored position may be re-applied.
 *
 * A missing row, a different `contentVersion` (the text changed) or a position
 * at the very start all mean "do nothing": a stale pixel position must never be
 * silently applied to changed text. A restorable position is always
 * `approximate`, because it is a pixel offset and layout can differ between
 * renders, fonts and widths. This function never claims an exact restore.
 */
export function restorePlan(entry: MarginProgressEntry | null | undefined, contentVersion: string): RestorePlan {
  if (entry === null || entry === undefined) return { restore: false, ratio: 0, approximate: false, reason: 'no-entry' }
  if (entry.contentVersion !== contentVersion) return { restore: false, ratio: 0, approximate: false, reason: 'version-mismatch' }
  if (!(entry.ratio > 0)) return { restore: false, ratio: 0, approximate: false, reason: 'at-start' }
  return { restore: true, ratio: clampRatio(entry.ratio), approximate: true }
}

/**
 * Fixed Chinese position label. Honest about its limits:
 *
 *  - it is a scroll position, not a read state;
 *  - below the bottom it never prints 100% (99% is the ceiling), because
 *    rounding up would claim a completion that did not happen;
 *  - at the bottom it says 已到文末 and adds 未标记为已读: "reached the end" is
 *    not "finished", and only Margin's status can say the latter.
 */
export function progressLabel(ratio: number): string {
  const clamped = clampRatio(ratio)
  if (clamped >= 1) return '已到文末（未标记为已读）'
  return `已读约 ${Math.min(99, Math.floor(clamped * 100))}%`
}

/**
 * Recover the Margin instance base from a candidate's reader URL.
 *
 * The host builds `marginUrl` as `${baseUrl}/reader/${id}`, so stripping the
 * suffix restores the configured base exactly (including a path). Anything that
 * does not look like an http(s) base with this id is refused instead of
 * guessed, which keeps a progress row from landing under the wrong instance.
 */
export function instanceFromMarginUrl(marginUrl: string, candidateId: number): string | null {
  if (!Number.isSafeInteger(candidateId) || candidateId <= 0) return null
  const suffix = `/reader/${candidateId}`
  if (!marginUrl.endsWith(suffix)) return null
  const base = marginUrl.slice(0, -suffix.length).replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(base)) return null
  return base
}
