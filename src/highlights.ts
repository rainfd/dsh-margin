/**
 * Highlights and notes projection.
 *
 * Margin stores highlights as offsets into `feed_entry.content_text` plus a
 * 16-hex-character fingerprint of the selected text. Our reader renders
 * `content_md` when present, so an offset computed against the rendered view is
 * NOT guaranteed to match `content_text`. The plugin therefore never invents an
 * offset from the rendered document: it recomputes the exact offset inside
 * `content_text` from the selected string, and refuses when that is ambiguous or
 * absent. Reusing Margin's own fingerprint algorithm keeps existing anchors
 * comparable (see `computeFingerprint` in the Margin reader).
 */

import type { MarginHighlight, MarginNote } from './protocol.ts'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : ''

/** Mirror of Margin's 16-hex fingerprint (SHA-256 first 8 bytes, hex). */
export async function fingerprint(selected: string): Promise<string> {
  const bytes = new TextEncoder().encode(selected)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest).slice(0, 8)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export interface Located { start: number; end: number }

/**
 * Locate the selection inside `content_text` without guessing.
 *
 * `occurrence` picks the nth match (0-based) when the same phrase appears more
 * than once. The default (-1) means "unspecified": an ambiguous phrase is then
 * refused instead of silently anchoring the highlight to the first match, which
 * would attach the note to the wrong sentence.
 */
export function locateSelection(contentText: string, selected: string, occurrence = -1): { ok: true; value: Located } | { ok: false; reason: 'empty' | 'not-found' | 'ambiguous'; count: number } {
  const needle = selected.trim()
  if (needle === '') return { ok: false, reason: 'empty', count: 0 }
  const matches: Located[] = []
  let from = 0
  for (;;) {
    const start = contentText.indexOf(needle, from)
    if (start === -1) break
    matches.push({ start, end: start + needle.length })
    // Non-overlapping occurrences, matching Margin's own indexOf convention.
    from = start + Math.max(1, needle.length)
  }
  if (matches.length === 0) return { ok: false, reason: 'not-found', count: 0 }
  // An unspecified occurrence is only safe when there is exactly one match.
  if (matches.length > 1 && occurrence < 0) return { ok: false, reason: 'ambiguous', count: matches.length }
  const chosen = matches[occurrence < 0 ? 0 : occurrence]
  if (chosen === undefined) return { ok: false, reason: 'ambiguous', count: matches.length }
  return { ok: true, value: chosen }
}

export function toNote(raw: unknown): MarginNote | undefined {
  if (!record(raw)) return undefined
  const id = raw['id']
  const candidateId = raw['candidate_id']
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined
  if (typeof candidateId !== 'number' || !Number.isSafeInteger(candidateId) || candidateId <= 0) return undefined
  const stored = typeof raw['content'] === 'string' ? raw['content'] : ''
  const content = text(stored, 20_000)
  return {
    id,
    candidateId,
    content,
    // Any difference means the projection cannot be used as a whole-content
    // proof: rewriting it back would silently drop the rest of the note.
    contentTruncated: content !== stored,
    contentLength: stored.length,
    createdAt: typeof raw['created_at'] === 'string' ? text(raw['created_at'], 64) : '',
    updatedAt: typeof raw['updated_at'] === 'string' ? text(raw['updated_at'], 64) : '',
  }
}

/** A highlight is trusted only for identity and offsets; text is capped. */
export function toHighlight(raw: unknown): MarginHighlight | undefined {
  if (!record(raw)) return undefined
  const id = raw['id']
  const candidateId = raw['candidate_id']
  const start = raw['start_offset']
  const end = raw['end_offset']
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined
  if (typeof candidateId !== 'number' || !Number.isSafeInteger(candidateId) || candidateId <= 0) return undefined
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) return undefined
  if (typeof end !== 'number' || !Number.isSafeInteger(end) || end <= start) return undefined
  const noteId = raw['note_id']
  return {
    id,
    candidateId,
    noteId: typeof noteId === 'number' && Number.isSafeInteger(noteId) && noteId > 0 ? noteId : null,
    start,
    end,
    selectedText: text(raw['selected_text'], 12_000),
    color: /^#[0-9a-f]{6}$/i.test(String(raw['color'] ?? '')) ? String(raw['color']) : '#f5d0a8',
    fingerprint: text(raw['text_fingerprint'], 16),
    createdAt: typeof raw['created_at'] === 'string' ? text(raw['created_at'], 64) : '',
  }
}

/** Note bodies and highlight text are user content; cap what a route returns. */
export const MAX_NOTE_CHARS = 20_000

export function noteProblem(content: unknown): string | undefined {
  if (typeof content !== 'string') return '笔记内容必须是字符串'
  if (content.trim() === '') return '笔记内容不能为空'
  if (content.length > MAX_NOTE_CHARS) return `笔记最多 ${MAX_NOTE_CHARS} 字符`
  return undefined
}

/**
 * Convert a UTF-16 index (what JavaScript uses) into a Unicode code-point
 * index (what Python's `len`/slicing uses). Margin validates offsets against
 * `content_text` in Python, so a non-BMP character before the selection would
 * otherwise shift every anchor by one and may make the end offset too large.
 */
export function codePointOffset(text: string, utf16Index: number): number {
  if (!Number.isSafeInteger(utf16Index) || utf16Index <= 0) return 0
  if (utf16Index >= text.length) return [...text].length
  return [...text.slice(0, utf16Index)].length
}
