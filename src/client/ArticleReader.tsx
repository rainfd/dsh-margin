import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarginCandidate, MarginCandidateDetail, MarginReadStatus, MarginStatusUpdate } from '../protocol.ts'
import { MarginApiError } from './api.ts'
// The progress helpers are re-exported by the reader model: the reader keeps its
// non-React runtime imports to `api.ts` and `readerModel.ts`, which is the exact
// boundary the reader/AI test harnesses mock.
import {
  PROGRESS_LOOKUP_LIMIT,
  contentVersion,
  instanceFromMarginUrl,
  progressLabel,
  readingRatio,
  requestReaderDetail,
  restorePlan,
  safeMarginUrl,
  selectReaderBody,
  shouldPersist,
  tocFromMarkdown,
} from './readerModel.ts'
// Type-only: erased at runtime, so it adds no module boundary.
import type { ProgressApi, TocEntry } from './progressModel.ts'
// Type-only: the reader must not pull the AI panel (or its model) into its own
// module graph — tests mock exactly these runtime imports, and a disabled AI
// feature should add nothing to the reader bundle.
import type { AiApi, AiPanelProps } from './aiModel.ts'
// Type-only for the same reason: the annotations panel is injected through
// `annotations.Panel`, so this file keeps its runtime imports unchanged.
import type { AnnotationApi, AnnotationPanelProps } from './annotationModel.ts'
// Type-only again: the save section is injected through `save.Panel`, so the
// reader gains no runtime dependency on its model or component.
import type { SaveApi, SavePanelProps } from './saveModel.ts'

export type ArticleReaderProps = PropsLocale<'dsh-margin'> & {
  candidate: MarginCandidate
  loadCandidate: (id: number) => Promise<MarginCandidateDetail>
  onBack: () => void
  writesAllowed?: boolean
  setCandidateStatus?: (id: number, status: MarginReadStatus, marginUrl: string) => Promise<MarginStatusUpdate>
  onStatusChanged?: (update: MarginStatusUpdate) => void
  /**
   * Optional AI assistant. Absent means the feature is not installed: nothing
   * renders, no capability request is issued, and reading is bit-for-bit the
   * same as before this prop existed.
   */
  ai?: AiApi
  /**
   * Optional highlights/notes panel. Absent (or without `Panel`) means the
   * feature is not installed: no panel, no annotation request, and reading is
   * bit-for-bit the same as before this prop existed. The face exposes only the
   * annotation routes, so it cannot mark an article read or save anything.
   */
  annotations?: AnnotationApi
  /**
   * Optional local scroll position. Absent means the feature is not installed:
   * no progress row is read or written, no TOC is built, and the reader is
   * bit-for-bit the same as before this prop existed. This face never exposes
   * status, import or save routes: it cannot mark an article read.
   */
  progress?: ProgressApi
  /** Optional save-to-Trilium section; absent means no UI and no save request. */
  save?: SaveApi
}

/** The reader's scroll container, owned by the reading-list viewport. */
function scrollContainer(node: HTMLElement | null): HTMLElement | null {
  return node?.closest<HTMLElement>('.margin-reading__viewport') ?? null
}

type ReaderState =
  | { kind: 'loading' }
  | { kind: 'ready'; detail: MarginCandidateDetail }
  | { kind: 'error'; reason: 'notFound' | 'unauthorized' | 'timeout' | 'instanceChanged' | 'loadFailed' }

/** Lazily loaded detail. Only an explicit button action can write reading status. */
export function ArticleReader({ candidate, loadCandidate, onBack, t, writesAllowed = false, setCandidateStatus, onStatusChanged, ai, annotations, progress, save }: ArticleReaderProps) {
  const [state, setState] = useState<ReaderState>({ kind: 'loading' })
  const [writeState, setWriteState] = useState<'idle' | 'pending' | 'error' | 'uncertain'>('idle')
  const pending = useRef(false)
  const uncertain = useRef(false)
  const scope = useRef({ alive: false })
  const identity = `${candidate.id}:${candidate.marginUrl}`
  const live = useRef({ identity, writesAllowed })
  live.current = { identity, writesAllowed }
  useEffect(() => {
    const current = { alive: true }
    scope.current = current
    pending.current = false
    uncertain.current = false
    setWriteState('idle')
    return () => { current.alive = false }
  }, [candidate.id, candidate.marginUrl, loadCandidate])
  const [attempt, setAttempt] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [candidate.id])
  useEffect(() => {
    setState({ kind: 'loading' })
    return requestReaderDetail(
      () => loadCandidate(candidate.id),
      detail => {
        // IDs are instance-local. A config change must not silently open a
        // same-numbered article from a different Margin instance.
        if (detail.id !== candidate.id || safeMarginUrl(detail.marginUrl) !== safeMarginUrl(candidate.marginUrl)) {
          setState({ kind: 'error', reason: 'instanceChanged' })
          return
        }
        setState({ kind: 'ready', detail })
      },
      error => {
        const status = error instanceof MarginApiError ? error.status : undefined
        setState({ kind: 'error', reason: status === 404 ? 'notFound'
          : status === 401 || status === 403 ? 'unauthorized'
            : status === 504 ? 'timeout' : 'loadFailed' })
      },
    )
  }, [candidate.id, candidate.marginUrl, loadCandidate, attempt])
  const labels = useMemo(() => ({
    code: { copyLabel: t('reader.copy'), copiedLabel: t('reader.copied') },
    footnotes: t('reader.footnotes'),
  }), [t])
  // Selection source for the optional AI panel. Deliberately local: the panel
  // never queries the DOM itself, and this returns undefined outside a browser
  // (so the same code runs headlessly in tests).
  const bodyRef = useRef<HTMLElement | null>(null)
  const readSelection = (): string | undefined => {
    const container = bodyRef.current
    if (container === null || typeof window === 'undefined') return undefined
    const selection = window.getSelection()
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined
    const text = selection.toString().trim()
    if (text === '') return undefined
    // Only a selection that starts inside the rendered article body counts;
    // a stray selection elsewhere on the page is not article text.
    return container.contains(selection.getRangeAt(0).commonAncestorContainer) ? text : undefined
  }
  const AiView = ai?.Panel as ComponentType<AiPanelProps> | undefined
  const AnnotationsView = annotations?.Panel as ComponentType<AnnotationPanelProps> | undefined
  const SaveView = save?.Panel as ComponentType<SavePanelProps> | undefined
  const detail = state.kind === 'ready' ? state.detail : null
  const article = detail ?? candidate
  const url = safeMarginUrl(article.marginUrl)
  const body = detail === null ? null : selectReaderBody(detail)
  const bodyKind = body?.kind ?? 'empty'
  const bodyText = body?.text ?? ''
  /* ---- Optional local scroll position (spec 008) ----------------------
   * Every hook below runs unconditionally, but without the `progress` face it
   * does no work at all: no request, no DOM access, no TOC, no extra markup.
   * Nothing here can write Margin status or article content. */
  const [ratio, setRatio] = useState(0)
  const [saveFailed, setSaveFailed] = useState(false)
  const [restored, setRestored] = useState(false)
  const [tocOpen, setTocOpen] = useState(false)
  const [tocApproximate, setTocApproximate] = useState(false)
  const articleRef = useRef<HTMLElement | null>(null)
  /** Last *attempted* save: throttling and teardown dedupe use it. */
  const lastAttempt = useRef<{ ratio: number; at: number } | null>(null)
  const latestRatio = useRef(0)
  const latestScrollTop = useRef(0)
  /** Identity (candidate + URL + body version) already restored in this mount. */
  const restoredFor = useRef<string | null>(null)
  const exiting = useRef(false)
  const version = useMemo(
    () => (detail === null || progress === undefined ? '' : contentVersion(detail)),
    [detail, progress],
  )
  // The reader only knows its base instance through the candidate's reader URL.
  // If it cannot be derived exactly, progress is disabled rather than guessed.
  const instance = progress === undefined ? null : instanceFromMarginUrl(candidate.marginUrl, candidate.id)
  const toc = useMemo(
    () => (progress === undefined || bodyKind !== 'markdown' ? [] : tocFromMarkdown(bodyText)),
    [progress, bodyKind, bodyText],
  )
  /** Latest persist closure for the scroll listener (which registers once). */
  const persistRef = useRef<(nextRatio: number, scrollTop: number, force?: boolean) => void>(() => {})
  const persist = (nextRatio: number, scrollTop: number, force = false): void => {
    if (progress === undefined || version === '' || instance === null) return
    const now = Date.now()
    if (!force && !shouldPersist(lastAttempt.current, { ratio: nextRatio, at: now })) return
    lastAttempt.current = { ratio: nextRatio, at: now }
    const current = scope.current
    // One explicit POST at most; a failure sets a note and is not retried here.
    progress.saveProgress({
      instanceUrl: instance,
      candidateId: candidate.id,
      contentVersion: version,
      // The host stores at most 300 title characters; do not make a long title
      // turn a position save into an invalid_title rejection.
      title: article.title.slice(0, 300),
      ratio: nextRatio,
      scrollTop: Math.max(0, Math.round(scrollTop)),
    }).then(
      () => { if (current.alive && scope.current === current) setSaveFailed(false) },
      () => { if (current.alive && scope.current === current) setSaveFailed(true) },
    )
  }
  persistRef.current = persist
  // Restore once per candidate/version. Positions are pixel offsets, so this is
  // approximate by construction; after the first application the user owns the
  // viewport and nothing re-applies the saved value.
  useEffect(() => {
    if (progress === undefined || detail === null || version === '' || instance === null) return
    const identity = `${candidate.id}:${candidate.marginUrl}:${version}`
    if (restoredFor.current === identity) return
    restoredFor.current = identity
    const current = scope.current
    let active = true
    // Measure even when nothing is restored: a short article already shows its
    // bottom (ratio 1 = bottom reached), and a false 0% would be misleading.
    const scroller = scrollContainer(articleRef.current)
    if (scroller !== null) {
      const measured = readingRatio(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight)
      latestRatio.current = measured
      latestScrollTop.current = scroller.scrollTop
      setRatio(measured)
    }
    progress.loadProgress(PROGRESS_LOOKUP_LIMIT).then(view => {
      if (!active || !current.alive) return
      const saved = view.entries.find(entry => entry.instanceUrl === instance
        && entry.candidateId === candidate.id && entry.contentVersion === version) ?? null
      const plan = restorePlan(saved, version)
      if (!plan.restore) return
      latestRatio.current = plan.ratio
      lastAttempt.current = { ratio: plan.ratio, at: Date.now() }
      setRatio(plan.ratio)
      setRestored(true)
      const target = scrollContainer(articleRef.current)
      if (target === null) return
      const range = target.scrollHeight - target.clientHeight
      if (!Number.isFinite(range) || range <= 0) return
      target.scrollTop = Math.min(range, Math.max(0, plan.ratio * range))
      latestScrollTop.current = target.scrollTop
    }, () => {
      // A failed read only means "no restore": no note, no retry loop.
    })
    return () => { active = false }
  }, [progress, version, instance, candidate.id, candidate.marginUrl])
  // One listener on the actual scroll container (the list viewport that owns the
  // reader). Scroll events do not bubble, so this cannot be a JSX prop.
  useEffect(() => {
    if (progress === undefined || version === '' || instance === null) return
    const scroller = scrollContainer(articleRef.current)
    if (scroller === null || typeof scroller.addEventListener !== 'function') return
    const handler = () => {
      const next = readingRatio(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight)
      latestRatio.current = next
      latestScrollTop.current = scroller.scrollTop
      setRatio(previous => (Math.round(previous * 100) === Math.round(next * 100) ? previous : next))
      persistRef.current(next, scroller.scrollTop)
    }
    scroller.addEventListener('scroll', handler, { passive: true })
    return () => { scroller.removeEventListener('scroll', handler) }
  }, [progress, version, instance])
  // Teardown save covers back/unmount/candidate switch. It is skipped when the
  // same position was already the last attempt, so back does not double-write.
  useEffect(() => {
    if (progress === undefined || version === '' || instance === null) return
    const saveProgress = progress
    const input = { instanceUrl: instance, candidateId: candidate.id, contentVersion: version, title: article.title.slice(0, 300) }
    return () => {
      if (exiting.current) return
      const finalRatio = latestRatio.current
      const previous = lastAttempt.current
      if (previous !== null && Math.abs(previous.ratio - finalRatio) < 0.0005) return
      lastAttempt.current = { ratio: finalRatio, at: Date.now() }
      void saveProgress.saveProgress({
        ...input,
        ratio: finalRatio,
        scrollTop: Math.max(0, Math.round(latestScrollTop.current)),
      }).catch(() => {
        // Unmounting: nothing to show and nothing to retry.
      })
    }
  }, [progress, version, instance, candidate.id, article.title])
  // DOM-free heading lookup: TreeWalker is only touched when a document exists,
  // so the component still renders (and TOC falls back proportionally) headlessly.
  // Repeated labels resolve to the first match on purpose; the proportional
  // fallback is used only when no rendered heading carries the label at all.
  const headingFor = (label: string): HTMLElement | null => {
    if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return null
    const container = bodyRef.current
    if (container === null) return null
    let walker: TreeWalker
    try { walker = document.createTreeWalker(container, 1) } catch { return null }
    let node: Node | null = walker.nextNode()
    let guard = 0
    while (node !== null && guard < 10000) {
      guard++
      const element = node as HTMLElement
      if (/^H[1-6]$/.test(element.nodeName) && (element.textContent ?? '').trim() === label) return element
      node = walker.nextNode()
    }
    return null
  }
  const jump = (entry: TocEntry) => {
    const heading = headingFor(entry.text)
    if (heading !== null && typeof heading.scrollIntoView === 'function') {
      setTocApproximate(false)
      heading.scrollIntoView({ block: 'start' })
      return
    }
    // No rendered heading to land on: approximate by character offset ratio.
    setTocApproximate(true)
    const scroller = scrollContainer(articleRef.current)
    if (scroller === null || bodyText === '') return
    const range = scroller.scrollHeight - scroller.clientHeight
    if (!Number.isFinite(range) || range <= 0) return
    const proportional = Math.min(1, Math.max(0, entry.index / bodyText.length))
    scroller.scrollTop = proportional * range
    latestScrollTop.current = scroller.scrollTop
  }
  const back = () => {
    exiting.current = true
    persist(latestRatio.current, latestScrollTop.current, true)
    onBack()
  }
  const summary = detail?.summaryText || detail?.summary || ''
  const readable = detail?.status === 'read' || detail?.status === 'unprocessed'
  const target: MarginReadStatus = detail?.status === 'read' ? 'unprocessed' : 'read'
  const changeStatus = async () => {
    if (!scope.current.alive || pending.current || uncertain.current || !readable || !setCandidateStatus
      || !live.current.writesAllowed || live.current.identity !== identity || detail === null
      || detail.id !== candidate.id || safeMarginUrl(detail.marginUrl) !== safeMarginUrl(candidate.marginUrl) || url === null) return
    pending.current = true
    setWriteState('pending')
    const current = scope.current
    const active = () => current.alive && scope.current === current && live.current.identity === identity
    let acknowledged = false
    try {
      const update = await setCandidateStatus(candidate.id, target, candidate.marginUrl)
      if (!active()) return
      acknowledged = true
      // The acknowledgement is not a full detail: refresh counts even if rereading fails.
      onStatusChanged?.(update)
      const refreshed = await loadCandidate(candidate.id)
      if (!active()) return
      if (refreshed.id !== candidate.id || safeMarginUrl(refreshed.marginUrl) !== safeMarginUrl(candidate.marginUrl)) {
        throw new Error('instanceChanged')
      }
      setState({ kind: 'ready', detail: refreshed })
      setWriteState('idle')
    } catch {
      if (!active()) return
      if (acknowledged) {
        uncertain.current = true
        setWriteState('uncertain')
        return
      }
      // Not acknowledged: one read-only confirmation. Never resend the write;
      // the truth is whatever Margin reports now (spec 002).
      try {
        const confirmed = await loadCandidate(candidate.id)
        if (!active()) return
        if (confirmed.id !== candidate.id || safeMarginUrl(confirmed.marginUrl) !== safeMarginUrl(candidate.marginUrl)) {
          setWriteState('error')
          return
        }
        setState({ kind: 'ready', detail: confirmed })
        // The write may have landed even though its reply was lost.
        const applied = confirmed.status === target
        setWriteState(applied ? 'idle' : 'error')
        if (applied) {
          onStatusChanged?.({ id: confirmed.id, status: target, isSavedToTrilium: confirmed.isSavedToTrilium, updatedAt: confirmed.updatedAt })
        }
      } catch {
        if (active()) setWriteState('error')
      }
    } finally {
      if (active()) pending.current = false
    }
  }
  const reload = () => {
    if (pending.current) return
    uncertain.current = false
    setWriteState('idle')
    setAttempt(value => value + 1)
  }
  return (
    <article className="margin-reader margin-reading__content" aria-label={t('reader.title')} ref={articleRef}>
      {/* Optional, off by default: no progress face means none of this renders. */}
      {progress !== undefined && detail !== null && <div className="margin-reader__progress" role="group" aria-label={t('progress.position')}>
        <div className="margin-reader__progressTrack" aria-hidden="true">
          {/* Below the bottom the bar stops at 99%, matching the label's ceiling. */}
          <div className="margin-reader__progressFill" style={{ width: `${ratio >= 1 ? 100 : Math.min(99, Math.max(0, Math.round(ratio * 100)))}%` }} />
        </div>
        <span className="margin-reader__progressLabel">{progressLabel(ratio)}</span>
        {restored && <span className="margin-reader__progressNote">{t('progress.restoredApproximate')}</span>}
        {saveFailed && <span className="margin-reader__progressNote" role="alert">{t('progress.saveFailed')}</span>}
      </div>}
      <nav className="margin-reader__nav" aria-label={t('reader.navigation')}>
        <button type="button" className="margin-reading__button" onClick={back}>{t('reader.back')}</button>
        {url !== null && <a className="margin-reading__link" href={url} target="_blank" rel="noopener noreferrer">{t('list.openMargin')}</a>}
      </nav>
      <header className="margin-reader__header">
        <h1 className="margin-reader__title" tabIndex={-1} ref={heading}>{article.title}</h1>
        <div className="margin-reading__meta">
          {article.sourceDomain && <span>{article.sourceDomain}</span>}
          {article.author && <span>{article.author}</span>}
          {article.createdAt && <time dateTime={article.createdAt}>{article.createdAt.slice(0, 10)}</time>}
          <span>#{article.id}</span>
        </div>
      </header>
      {state.kind === 'loading' && <p className="margin-reading__notice" role="status">{t('reader.loading')}</p>}
      {state.kind === 'error' && <div className="margin-reading__notice" role="alert" data-error="true">
        <p>{t(`reader.${state.reason}`)}</p>
        <button type="button" className="margin-reading__button" onClick={() => setAttempt(value => value + 1)}>{t('list.retry')}</button>
      </div>}
      {detail !== null && <>
        <div className="margin-reader__nav">
          {readable && <button type="button" className="margin-reading__button" onClick={changeStatus}
            disabled={!writesAllowed || !setCandidateStatus || writeState === 'pending' || writeState === 'uncertain'}>
            {writeState === 'pending' ? t('reader.saving') : t(target === 'read' ? 'reader.markRead' : 'reader.markUnread')}
          </button>}
          <button type="button" className="margin-reading__button" onClick={reload} disabled={writeState === 'pending'}>{t('reader.reload')}</button>
          {!writesAllowed && <span className="margin-reading__intro">{t('reader.readOnly')}</span>}
        </div>
        {(writeState === 'error' || writeState === 'uncertain') && <p className="margin-reader__warning" role="alert">
          {t(writeState === 'uncertain' ? 'reader.writeUncertain' : 'reader.writeFailed')}
        </p>}
        {detail.contentFetchFailed && <p className="margin-reader__warning" role="status">{t('reader.fetchFailed')}</p>}
        {summary !== '' && <aside className="margin-reader__summary" aria-label={t('reader.summary')}>
          <h2>{t('reader.summary')}</h2><p className="margin-reader__plain">{summary}</p>
        </aside>}
        {/* Optional: built from the markdown source, hidden when there are no headings. */}
        {progress !== undefined && bodyKind === 'markdown' && toc.length > 0 && <nav className="margin-reader__toc" aria-label={t('progress.toc')}>
          <button type="button" className="margin-reading__button" aria-expanded={tocOpen} onClick={() => setTocOpen(open => !open)}>{t('progress.toc')}</button>
          {tocOpen && <ol className="margin-reader__tocList">
            {toc.map(entry => <li key={entry.index} className={`margin-reader__tocItem margin-reader__tocItem--h${entry.depth}`}>
              <button type="button" className="margin-reader__tocLink" onClick={() => jump(entry)}>{entry.text}</button>
            </li>)}
          </ol>}
          {tocOpen && tocApproximate && <p className="margin-reader__progressNote" role="status">{t('progress.tocApproximate')}</p>}
        </nav>}
        {body?.kind === 'markdown' && <p className="margin-reading__intro">{t('reader.remoteImages')}</p>}
        <section className="margin-reader__body" aria-label={t('reader.body')} ref={bodyRef}>
          {/* Reset inherited delegates: untrusted article paths must not open workspace files. */}
          {body?.kind === 'markdown' ? <MarkdownDelegateProvider><MarkdownText text={body.text} labels={labels} variant="body" /></MarkdownDelegateProvider>
            : body?.kind === 'text' ? <div className="margin-reader__plain">{body.text}</div>
              : <p className="margin-reading__notice">{t('reader.noBody')}</p>}
        </section>
        {/* Optional, off by default: no save face means no state read and no button. */}
        {SaveView !== undefined && <SaveView api={save as SaveApi} candidateId={candidate.id} marginUrl={article.marginUrl} t={t} />}
        {/* Optional, off by default: without a Panel nothing renders and no annotation is read. */}
        {AnnotationsView !== undefined && <AnnotationsView api={annotations as AnnotationApi} candidateId={candidate.id} marginUrl={article.marginUrl} readSelection={readSelection} t={t} />}
        {/* Optional, off by default: absent AI means this renders nothing at all. */}
        {AiView !== undefined && <AiView api={ai as AiApi} candidateId={candidate.id} marginUrl={article.marginUrl} readSelection={readSelection} t={t} />}
      </>}
    </article>
  )
}
