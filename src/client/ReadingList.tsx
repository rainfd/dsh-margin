/**
 * Sidebar reading-list panel: the Margin backlog, read-only.
 *
 * Stage 1 shows what is waiting in Margin so a session can decide what to turn
 * into a task. Nothing here writes to Margin or Trilium — the only action is
 * "open the source", which hands the URL to the browser.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, IconChecklistOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarginCandidate, MarginReadingView, MarginSourceBreakdown } from '../protocol.ts'
import { MarginApiError } from './api.ts'

/** What the slot injects into the panel. */
export interface ReadingListFace {
  loadList: (options: { status?: string; sourceType?: string; q?: string; limit?: number }) => Promise<MarginReadingView>
}

/** Panel props. */
export type ReadingListProps = ReadingListFace & PropsLocale<'dsh-margin'> & PropsRuntime<'sidebar.panellist'>

/** Sidebar row icon. */
export function ReadingListIcon(props: PropsRuntime<'sidebar.panellist'>) {
  return <IconChecklistOutlineRegular size={props.size} />
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

const headStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 10px',
  borderBottom: '1px solid var(--dsw-alias-border-secondary)',
}

const chipRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
}

const scrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
}

const itemStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  padding: '8px 10px',
  borderBottom: '1px solid var(--dsw-alias-border-secondary)',
}

const titleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
  lineHeight: 1.45,
}

const metaStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
}

const excerptStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)',
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

const noticeStyle: CSSProperties = {
  padding: '16px 12px',
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-secondary)',
  textAlign: 'center',
}

const chipBase: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 11,
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-secondary)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
}

/** A source-type filter chip. */
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  const style: CSSProperties = active
    ? { ...chipBase, background: 'var(--dsw-alias-bg-elevated)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 }
    : chipBase
  return <button type="button" style={style} onClick={onClick}>{children}</button>
}

/** One reading item. */
function Item({ candidate, openLabel }: { candidate: MarginCandidate; openLabel: string }) {
  const excerpt = candidate.summaryText !== '' ? candidate.summaryText : candidate.summary
  return (
    <div style={itemStyle}>
      <div style={titleStyle}>{candidate.title}</div>
      <div style={metaStyle}>
        <span>#{candidate.id}</span>
        <span>{sourceLabel(candidate.sourceType)}</span>
        {candidate.sourceDomain !== '' && <span>{candidate.sourceDomain}</span>}
        {candidate.createdAt !== '' && <span>{shortDate(candidate.createdAt)}</span>}
      </div>
      {excerpt !== '' && <div style={excerptStyle}>{excerpt}</div>}
      {candidate.sourceUrl !== '' && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.open(candidate.sourceUrl, '_blank', 'noopener,noreferrer')}
          >
            {openLabel}
          </Button>
        </div>
      )}
    </div>
  )
}

/** The reading-list panel. */
export function ReadingList({ loadList, t }: ReadingListProps) {
  const [view, setView] = useState<MarginReadingView | null>(null)
  const [sourceType, setSourceType] = useState<string | null>(null)
  const [draftQuery, setDraftQuery] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  // Debounce the free-text filter so typing does not fire a request per key.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(draftQuery.trim()), 300)
    return () => clearTimeout(timer)
  }, [draftQuery])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    loadList({ status: 'unprocessed', sourceType: sourceType ?? undefined, q: query === '' ? undefined : query, limit: 100 })
      .then(result => {
        if (cancelled) return
        setView(result)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof MarginApiError ? cause.message : '加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadList, sourceType, query, attempt])

  const breakdown: MarginSourceBreakdown[] = useMemo(() => view?.breakdown ?? [], [view])

  const retry = useCallback(() => setAttempt(value => value + 1), [])

  if (error !== '' && error.includes('尚未配置')) {
    return <div style={noticeStyle}>{t('list.notConfigured')}</div>
  }
  if (error !== '') {
    return (
      <div style={noticeStyle}>
        <div>{error}</div>
        <div style={{ marginTop: 8 }}><Button variant="outline" size="sm" onClick={retry}>{t('list.retry')}</Button></div>
      </div>
    )
  }

  return (
    <div style={listStyle}>
      <div style={headStyle}>
        <Input
          value={draftQuery}
          placeholder={t('list.searchPlaceholder')}
          onChange={(event: { target: { value: string } }) => setDraftQuery(event.target.value)}
        />
        <div style={chipRowStyle}>
          <Chip active={sourceType === null} onClick={() => setSourceType(null)}>{t('list.allSources')}</Chip>
          {breakdown.map(entry => (
            <Chip key={entry.sourceType} active={sourceType === entry.sourceType} onClick={() => setSourceType(entry.sourceType)}>
              {sourceLabel(entry.sourceType)} {entry.count}
            </Chip>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
          {loading && view === null ? t('list.loading') : t('list.total').replace('{total}', String(view?.total ?? 0))}
        </div>
      </div>
      <div style={scrollStyle}>
        {loading && view === null && <div style={noticeStyle}>{t('list.loading')}</div>}
        {view !== null && view.items.length === 0 && <div style={noticeStyle}>{t('list.empty')}</div>}
        {view?.items.map(candidate => (
          <Item key={candidate.id} candidate={candidate} openLabel={t('list.openSource')} />
        ))}
      </div>
    </div>
  )
}
