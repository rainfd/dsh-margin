/**
 * Local reading progress: a bounded, disposable observation store.
 *
 * This is **not** a read-state source of truth. Margin owns `status`, and a
 * progress entry never sets it. What lives here is only what the old web UI
 * cannot know: how far this reader scrolled, and when it was last opened.
 *
 * Design constraints (spec 008):
 *  - Keyed by `instance + candidateId + contentVersion`, so the same id on
 *    another instance, or after the article body changed, is a different row.
 *  - Bounded: hard entry cap, per-entry count cap and TTL; oldest entries are
 *    evicted first. A progress file that cannot be parsed is ignored, not
 *    repaired into invented data.
 *  - Written atomically with 0600, because titles are user content.
 *  - No credentials, no article bodies, no per-scroll network calls.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MarginProgressEntry, MarginProgressView } from './protocol.ts'

/** Above this many entries the oldest are dropped. */
export const MAX_PROGRESS_ENTRIES = 500
/** Entries older than this are discarded on read. */
export const PROGRESS_TTL_MS = 180 * 24 * 60 * 60 * 1000
/** Cap on the title we keep; the body is never stored. */
const MAX_TITLE = 300

interface StoredFile {
  version: 1
  entries: MarginProgressEntry[]
}

export function progressPath(): string {
  return process.env['DSH_MARGIN_PROGRESS'] ?? join(homedir(), '.dsh', 'dsh-margin-progress.json')
}

/** Stable key: instance, article and content version all matter. */
export function progressKey(instanceUrl: string, candidateId: number, contentVersion: string): string {
  return `${instanceUrl.replace(/\/+$/, '')}|${candidateId}|${contentVersion.slice(0, 64)}`
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const finite = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined

/** Validate one stored entry; anything odd is dropped rather than coerced. */
function validEntry(raw: unknown): MarginProgressEntry | undefined {
  if (!record(raw)) return undefined
  const instanceUrl = raw['instanceUrl']
  const candidateId = raw['candidateId']
  const contentVersion = raw['contentVersion']
  if (typeof instanceUrl !== 'string' || instanceUrl === '' || instanceUrl.length > 2048) return undefined
  if (typeof candidateId !== 'number' || !Number.isSafeInteger(candidateId) || candidateId <= 0) return undefined
  if (typeof contentVersion !== 'string' || contentVersion.length > 64) return undefined
  const ratio = finite(raw['ratio'], 0, 1)
  const openedAt = raw['openedAt']
  const updatedAt = raw['updatedAt']
  if (typeof openedAt !== 'string' || Number.isNaN(Date.parse(openedAt))) return undefined
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) return undefined
  const scrollTop = finite(raw['scrollTop'], 0, 1e9) ?? 0
  const title = typeof raw['title'] === 'string'
    ? raw['title'].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE) : ''
  return {
    key: progressKey(instanceUrl, candidateId, contentVersion),
    instanceUrl,
    candidateId,
    contentVersion,
    title,
    // A ratio, not "read": 1.0 does not mean finished.
    ratio: ratio ?? 0,
    scrollTop,
    anchor: typeof raw['anchor'] === 'string' ? raw['anchor'].slice(0, 300) : '',
    openedAt,
    updatedAt,
  }
}

/** Read the store, dropping expired and invalid rows. Never throws. */
export function readProgress(now = Date.now()): StoredFile {
  const path = progressPath()
  if (!existsSync(path)) return { version: 1, entries: [] }
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { return { version: 1, entries: [] } }
  if (!record(parsed) || !Array.isArray(parsed['entries'])) return { version: 1, entries: [] }
  const entries: MarginProgressEntry[] = []
  for (const raw of parsed['entries']) {
    const entry = validEntry(raw)
    if (entry === undefined) continue
    if (now - Date.parse(entry.updatedAt) > PROGRESS_TTL_MS) continue
    entries.push(entry)
  }
  return { version: 1, entries }
}

/** Persist, evicting oldest first to stay under the cap. Atomic + 0600. */
export function writeProgress(entries: MarginProgressEntry[]): void {
  const bounded = [...entries]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_PROGRESS_ENTRIES)
  const path = progressPath()
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + '.tmp'
  writeFileSync(temp, JSON.stringify({ version: 1, entries: bounded }, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
  chmodSync(path, 0o600)
}

/** Insert or update one entry; a non-finite ratio rejects instead of storing 0. */
export function upsertProgress(input: {
  instanceUrl: string
  candidateId: number
  contentVersion: string
  title?: string
  ratio: number
  scrollTop?: number
  anchor?: string
}, now = new Date()): MarginProgressEntry {
  const entries = readProgress(now.getTime()).entries
  const key = progressKey(input.instanceUrl, input.candidateId, input.contentVersion)
  const previous = entries.find(entry => entry.key === key)
  const entry: MarginProgressEntry = {
    key,
    instanceUrl: input.instanceUrl.replace(/\/+$/, ''),
    candidateId: input.candidateId,
    contentVersion: input.contentVersion,
    title: (input.title ?? previous?.title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE),
    ratio: Math.min(1, Math.max(0, input.ratio)),
    scrollTop: Math.max(0, input.scrollTop ?? previous?.scrollTop ?? 0),
    anchor: (input.anchor ?? previous?.anchor ?? '').slice(0, 300),
    // Reopening does not reset when the reader first saw this article.
    openedAt: previous?.openedAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  }
  writeProgress([entry, ...entries.filter(candidate => candidate.key !== key)])
  return entry
}

/** The browser view: recent entries only, never the whole history. */
export function progressView(limit = 20, now = Date.now()): MarginProgressView {
  const all = readProgress(now).entries
  return {
    observedAt: new Date(now).toISOString(),
    maxEntries: MAX_PROGRESS_ENTRIES,
    ttlDays: Math.round(PROGRESS_TTL_MS / 86_400_000),
    total: all.length,
    entries: [...all]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, Math.min(100, Math.max(1, limit))),
  }
}

/** Remove one entry, or the whole local history. Never touches Margin. */
export function clearProgress(key?: string): number {
  const entries = readProgress().entries
  if (key === undefined) {
    writeProgress([])
    return entries.length
  }
  const kept = entries.filter(entry => entry.key !== key)
  writeProgress(kept)
  return entries.length - kept.length
}
