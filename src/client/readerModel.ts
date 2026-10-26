import type { MarginCandidateDetail } from '../protocol.ts'

/**
 * Reader-facing re-exports of the pure progress model.
 *
 * `ArticleReader.tsx` keeps its non-React runtime imports to exactly `api.ts`
 * and this module (its module graph is mocked at that boundary in tests), so the
 * progress helpers are surfaced here. The implementation lives in
 * `progressModel.ts`; this is a boundary, not a second copy.
 */
export {
  MAX_TOC_ENTRIES, PROGRESS_LOOKUP_LIMIT, VERSION_HASH_CHARS,
  contentVersion, instanceFromMarginUrl, progressLabel, readingRatio,
  restorePlan, shouldPersist, tocFromMarkdown,
} from './progressModel.ts'

/** Never hand an untrusted fallback URL to the browser without checking its scheme. */
export function safeMarginUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export type ReaderBody = { kind: 'markdown' | 'text' | 'empty'; text: string }

/**
 * Summaries are deliberately not promoted to article bodies. Preserve original
 * whitespace. Takes only the body fields it reads, so a detail-like value does
 * not need the whole candidate record.
 */
export function selectReaderBody(detail: Pick<MarginCandidateDetail, 'contentMd' | 'contentText'>): ReaderBody {
  if (detail.contentMd.trim() !== '') return { kind: 'markdown', text: detail.contentMd }
  if (detail.contentText.trim() !== '') return { kind: 'text', text: detail.contentText }
  return { kind: 'empty', text: '' }
}

/** One effect-owned request. Cleanup makes all subsequent completions inert. */
export function requestReaderDetail<T>(load: () => Promise<T>, onSuccess: (value: T) => void, onError: (error: unknown) => void): () => void {
  let active = true
  // Also convert a synchronous loader exception to the normal error state.
  Promise.resolve().then(load).then(
    value => { if (active) onSuccess(value) },
    error => { if (active) onError(error) },
  )
  return () => { active = false }
}
