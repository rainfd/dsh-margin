/**
 * Main-view reading backlog and in-plugin article reader.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArticleReader } from './ArticleReader.tsx'
import { ImportPanel } from './ImportPanel.tsx'
import { SourcePanel } from './SourcePanel.tsx'
import { taskBelongsToInstance, type ImportApi } from './importModel.ts'
import type { ProgressApi } from './progressModel.ts'
import type { SourceApi } from './sourceModel.ts'
import type { MarginImportTask } from '../protocol.ts'
import { safeMarginUrl } from './readerModel.ts'
import { readingStyles } from './readingStyles.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarginCandidate, MarginCandidateDetail, MarginCandidateStatus, MarginReadingView, MarginSourceBreakdown, MarginReadStatus, MarginStatusUpdate } from '../protocol.ts'
import { MarginApiError } from './api.ts'
import type { AiApi } from './aiModel.ts'
// Type-only: the annotations panel is injected through its own face, so the
// reading list never imports the annotation UI or its model at runtime.
import type { AnnotationApi } from './annotationModel.ts'
import type { SaveApi } from './saveModel.ts'

/** What the slot injects into the panel. */
export interface ReadingListFace {
  imports?: ImportApi
  /** Source/credential management; absent means the panel entry point is hidden. */
  sources?: SourceApi
  /** Optional AI assistant; absent means the reader renders no AI section. */
  ai?: AiApi
  /**
   * Optional highlights/notes panel; absent means the reader renders no
   * annotation section and issues no annotation request.
   */
  annotations?: AnnotationApi
  /** Optional local scroll position; absent means the reader never reads or saves one. */
  progress?: ProgressApi
  /** Optional save-to-Trilium section; absent keeps the reader unchanged. */
  save?: SaveApi
  loadCandidate: (id: number) => Promise<MarginCandidateDetail>
  loadList: (options: { status?: string; sourceType?: string; q?: string; limit?: number; page?: number }) => Promise<MarginReadingView>
  setCandidateStatus: (id: number, status: MarginReadStatus, marginUrl: string) => Promise<MarginStatusUpdate>
}

/** Panel props. */
export type ReadingListProps = ReadingListFace & PropsLocale<'dsh-margin'> & PropsRuntime<'main'>

/** Sidebar row icon. */
export function ReadingListIcon(props: PropsRuntime<'sidebar.panellist'>) {
  return (
    <svg width={props.size} height={props.size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5h6a3 3 0 0 1 2 1 3 3 0 0 1 2-1h6v14h-6a3 3 0 0 0-2 1 3 3 0 0 0-2-1H4zM12 6v14M7 9h2M7 12h2M15 9h2M15 12h2" />
    </svg>
  )
}

/** Human label for a source type. */
function sourceLabel(sourceType: string): string {
  const known: Record<string, string> = {
    rss: 'RSS',
    wechat: '微信',
    manual_url: '手动',
    github_research: 'GitHub',
    video: '视频',
  }
  return known[sourceType] ?? sourceType
}

/** Short date from an ISO timestamp. */
function shortDate(iso: string): string {
  if (iso.length < 10) return ''
  return iso.slice(5, 10).replace('-', '/')
}

/** A source-type filter, using the host's compact neutral control pattern. */
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className="margin-reading__chip" aria-pressed={active} onClick={onClick}>{children}</button>
}

/** One reading item. Primary action stays in this main view. */
function Item({ candidate, openLabel, readLabel, onRead }: { candidate: MarginCandidate; openLabel: string; readLabel: string; onRead: (candidate: MarginCandidate, button: HTMLButtonElement) => void }) {
  const marginUrl = safeMarginUrl(candidate.marginUrl)
  const excerpt = candidate.summaryText !== '' ? candidate.summaryText : candidate.summary
  return (
    <li className="margin-reading__item">
      <div className="margin-reading__body">
        <h2 className="margin-reading__itemTitle">{candidate.title}</h2>
        <div className="margin-reading__meta">
          <span className="margin-reading__source">{sourceLabel(candidate.sourceType)}</span>
          {candidate.sourceDomain !== '' && <span>{candidate.sourceDomain}</span>}
          {candidate.createdAt !== '' && <time dateTime={candidate.createdAt}>{shortDate(candidate.createdAt)}</time>}
          <span>#{candidate.id}</span>
        </div>
        {excerpt !== '' && <p className="margin-reading__excerpt">{excerpt}</p>}
      </div>
      <div className="margin-reading__actions">
        <button type="button" className="margin-reading__button" aria-label={`${readLabel}：${candidate.title}`} onClick={event => onRead(candidate, event.currentTarget)}>{readLabel}</button>
        {marginUrl !== null && (
          <a className="margin-reading__link" href={marginUrl} target="_blank" rel="noopener noreferrer">
            {openLabel}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4 10 14M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></svg>
          </a>
        )}
      </div>
    </li>
  )
}

/** The reading-list panel. */
export function ReadingList({ loadList, loadCandidate, setCandidateStatus, imports, sources, ai, annotations, progress, save, t }: ReadingListProps) {
  const [importOpen, setImportOpen] = useState(false)
  const importTrigger = useRef<HTMLButtonElement | null>(null)
  const importOpenEpoch = useRef(0)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const sourcesTrigger = useRef<HTMLButtonElement | null>(null)
  const closeImports = useCallback(() => { importOpenEpoch.current++; setImportOpen(false); importTrigger.current?.focus() }, [])
  const openSources = useCallback((button: HTMLButtonElement) => {
    sourcesTrigger.current = button
    importOpenEpoch.current++
    setImportOpen(false)
    setSourcesOpen(true)
  }, [])
  const closeSources = useCallback(() => { setSourcesOpen(false); sourcesTrigger.current?.focus() }, [])
  const [selected, setSelected] = useState<MarginCandidate | null>(null)
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  // The list viewport is hidden (display:none) while the reader is open; a
  // display:none box has no scroll box, so the offset must be captured before
  // hiding and re-applied after it is shown again (spec 001).
  const listViewport = useRef<HTMLDivElement | null>(null)
  const listScrollTop = useRef(0)
  useEffect(() => {
    if (selected !== null) return
    const node = listViewport.current
    if (node !== null) node.scrollTop = listScrollTop.current
    returnFocus.current?.focus()
  }, [selected])
  const openReader = useCallback((candidate: MarginCandidate, button: HTMLButtonElement) => {
    listScrollTop.current = listViewport.current?.scrollTop ?? 0
    returnFocus.current = button
    setSelected(candidate)
  }, [])
  const [view, setView] = useState<MarginReadingView | null>(null)
  const [sourceType, setSourceType] = useState<string | null>(null)
  const [status, setStatus] = useState<MarginCandidateStatus>('unprocessed')
  const [page, setPage] = useState(1)
  const limit = 30
  const [draftQuery, setDraftQuery] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  // Debounce the free-text filter so typing does not fire a request per key.
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(draftQuery.trim()); setPage(1) }, 300)
    return () => clearTimeout(timer)
  }, [draftQuery])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    loadList({ status, sourceType: sourceType ?? undefined, q: query === '' ? undefined : query, limit, page })
      .then(result => {
        if (cancelled) return
        setView(result)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof MarginApiError ? cause.message : t('list.loadFailed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadList, status, sourceType, query, page, attempt, t])

  const breakdown: MarginSourceBreakdown[] = useMemo(() => view?.breakdown ?? [], [view])

  const retry = useCallback(() => setAttempt(value => value + 1), [])
  const openImported = useCallback(async (task: MarginImportTask, instance: string) => {
    if (!imports || !taskBelongsToInstance(task, instance)) throw new Error('实例不匹配')
    const epoch = ++importOpenEpoch.current
    const detail = await loadCandidate(task.id)
    const live = await imports.loadImports()
    if (epoch !== importOpenEpoch.current) return
    if (live.instanceUrl !== instance || detail.id !== task.id || detail.marginUrl !== task.marginUrl) throw new Error('实例已变更')
    setSelected(detail)
    setImportOpen(false)
  }, [imports, loadCandidate])
  useEffect(() => () => { importOpenEpoch.current++ }, [])

  return (
    <section className="margin-reading" aria-label={t('list.title')}>
      <style>{readingStyles}</style>
      <div className="margin-reading__viewport" ref={listViewport} hidden={selected !== null || importOpen || sourcesOpen}>
        <div className="margin-reading__content">
          <header className="margin-reading__head">
            <div>
              <h1 className="margin-reading__title">{t('list.title')}</h1>
              <p className="margin-reading__intro">{t('list.description')}</p>
            </div>
            <button type="button" className="margin-reading__button" onClick={retry} disabled={loading}>{t('list.refresh')}</button>
          </header>
          <div className="margin-reading__toolbar">
            {imports && <button ref={importTrigger} type="button" className="margin-reading__button" onClick={event => { importTrigger.current = event.currentTarget; importOpenEpoch.current++; setImportOpen(true) }}>导入 URL / PDF</button>}
            {sources && <button type="button" className="margin-reading__button" onClick={event => openSources(event.currentTarget)}>{t('sources.open')}</button>}
            <label className="margin-reading__search">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
              <input
                className="margin-reading__input"
                type="search"
                aria-label={t('list.searchPlaceholder')}
                value={draftQuery}
                placeholder={t('list.searchPlaceholder')}
                onChange={event => setDraftQuery(event.target.value)}
              />
            </label>
            <label className="margin-reading__filters">
              {t('list.statusLabel')}
              <select className="margin-reading__select" aria-label={t('list.statusLabel')} value={status} onChange={event => { setStatus(event.target.value as MarginCandidateStatus); setPage(1) }}>
                {(['unprocessed', 'read', 'processing', 'error'] as const).map(value => <option key={value} value={value}>{t(`list.status.${value}`)}</option>)}
              </select>
            </label>
            <div className="margin-reading__filters" role="group" aria-label={t('list.allSources')}>
              <Chip active={sourceType === null} onClick={() => { setSourceType(null); setPage(1) }}>{t('list.allSources')}</Chip>
              {breakdown.map(entry => (
                <Chip key={entry.sourceType} active={sourceType === entry.sourceType} onClick={() => { setSourceType(entry.sourceType); setPage(1) }}>
                  {sourceLabel(entry.sourceType)} <span className="margin-reading__count">{entry.count}</span>
                </Chip>
              ))}
            </div>
            <div className="margin-reading__count" role="status">
              {loading ? t('list.loading') : error === '' ? t('list.total').replace('{total}', String(view?.total ?? 0)) : null}
            </div>
          </div>
          {view !== null && (!view.totalExact || view.truncated) && <p className="margin-reader__warning" role="status">{t('list.partial').replace('{scanned}', String(view.scannedTotal)).replace('{upstream}', String(view.upstreamTotal))}</p>}
          {error !== '' ? (
            <div className="margin-reading__notice" data-error={!error.includes('尚未配置')} role="alert">
              <p>{error.includes('尚未配置') ? t('list.notConfigured') : error}</p>
              <button type="button" className="margin-reading__button" onClick={retry}>{t('list.retry')}</button>
            </div>
          ) : (
            <div aria-busy={loading}>
              {loading && view === null && <div className="margin-reading__notice">{t('list.loading')}</div>}
              {!loading && view !== null && view.items.length === 0 && <div className="margin-reading__notice">{t('list.empty')}</div>}
              <ul className="margin-reading__list">
                {view?.items.map(candidate => <Item key={candidate.id} candidate={candidate} openLabel={t('list.openMargin')} readLabel={t('list.read')} onRead={openReader} />)}
              </ul>
              {view !== null && <nav className="margin-reader__nav" aria-label={t('list.pagination')}>
                <button type="button" className="margin-reading__button" disabled={loading || view.page <= 1} onClick={() => setPage(Math.max(1, view.page - 1))}>{t('list.previous')}</button>
                <span>{t('list.page').replace('{page}', String(view.page)).replace('{pages}', String(view.totalPages))}</span>
                <button type="button" className="margin-reading__button" disabled={loading || view.page >= view.totalPages} onClick={() => setPage(view.page + 1)}>{t('list.next')}</button>
              </nav>}
            </div>
          )}
        </div>
      </div>
      {imports && <ImportPanel api={imports} active={importOpen} onClose={closeImports} onCompleted={retry} onOpen={openImported} />}
      {sources && <SourcePanel api={sources} active={sourcesOpen} onClose={closeSources} onChanged={retry} t={t} />}
      {selected !== null && <div className="margin-reading__viewport" hidden={importOpen || sourcesOpen}>
        {imports && <button type="button" className="margin-reading__button" onClick={event => { importTrigger.current = event.currentTarget; importOpenEpoch.current++; setImportOpen(true) }}>导入 URL / PDF</button>}
        <ArticleReader key={`${selected.id}:${selected.marginUrl}`} candidate={selected} loadCandidate={loadCandidate} onBack={() => setSelected(null)} t={t} writesAllowed={view?.writesAllowed === true && error === ''} setCandidateStatus={setCandidateStatus} onStatusChanged={retry} ai={ai} annotations={annotations} progress={progress} save={save} /></div>}
    </section>
  )
}
