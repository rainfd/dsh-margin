/**
 * Optional AI reading assistant (spec 005) — a collapsible section *inside* the
 * article reader, below the article body.
 *
 * Design constraints, and where each one lives:
 *  - Off or absent ⇒ nothing renders. The reader decides whether this component
 *    is mounted; this component also returns null unless the capability says
 *    `enabled`, and it never offers a submit control when the model is missing.
 *  - Article text, the selection, the question and the output stay in memory.
 *    Nothing is persisted client-side or encoded into a URL.
 *  - Output is rendered through the same MarkdownText + MarkdownDelegateProvider
 *    path the reader already uses for untrusted article Markdown.
 *  - This panel cannot change reading status: it is handed no status setter, and
 *    the only API it receives is the read-only capability plus one explicit run.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarginKey } from './locales.ts'
import {
  AiSession,
  AI_QUESTION_MAX,
  aiBlockKey,
  readerInstance,
  selectionOf,
  submitBlocked,
  type AiApi,
  type AiMode,
  type AiPanelProps,
} from './aiModel.ts'

/** Mode buttons, in a deliberate order: ask, then transform. */
const MODES: { mode: AiMode; key: MarginKey }[] = [
  { mode: 'qa', key: 'ai.mode.qa' },
  { mode: 'translate', key: 'ai.mode.translate' },
  { mode: 'summary', key: 'ai.mode.summary' },
]

/**
 * The AI section. Collapsed until the user opens it, so plain reading is never
 * pushed down by assistant chrome.
 */
export function AiPanel({ api, candidateId, marginUrl, readSelection, t }: AiPanelProps) {
  const [, redraw] = useState(0)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<AiMode>('qa')
  const [question, setQuestion] = useState('')
  // The scope the *last run* actually sent; the label follows live selection.
  const [scope, setScope] = useState<'article' | 'selection'>('article')
  const resultHeading = useRef<HTMLHeadingElement>(null)
  const labels = useMemo(() => ({
    code: { copyLabel: t('reader.copy'), copiedLabel: t('reader.copied') },
    footnotes: t('reader.footnotes'),
  }), [t])
  // Derived, never entered by hand: exactly the origin POST /ai-run expects.
  const instanceUrl = useMemo(() => readerInstance(marginUrl) ?? '', [marginUrl])

  // A new candidate/instance means a new session; the effect cleanup stops the
  // old one, which aborts its request and drops any pending result.
  const session = useMemo(
    () => new AiSession(api, { candidateId, instanceUrl }, () => redraw(n => n + 1)),
    [api, candidateId, instanceUrl],
  )
  useEffect(() => {
    void session.start()
    return () => session.stop()
  }, [session])
  // Collapse and drop per-article input when the article or instance changes.
  useEffect(() => {
    setOpen(false)
    setMode('qa')
    setQuestion('')
    setScope('article')
  }, [candidateId, instanceUrl])
  useEffect(() => {
    if (session.result !== null) resultHeading.current?.focus()
  }, [session.result])

  const status = session.status
  const capability = session.capability
  const modelId = capability?.target?.model ?? ''
  const liveSelection = status === 'running' ? undefined : selectionOf(readSelection?.())
  // While running, describe the snapshot that run was started with; otherwise
  // describe what the next run would send (the coverage label on a finished
  // result already states exactly what the model saw).
  const shownScope = status === 'running' ? scope : liveSelection === undefined ? 'article' : 'selection'
  const blocked = submitBlocked({ status, capability, mode, question, selection: liveSelection, instanceUrl })

  if (status === 'loading' || status === 'hidden' || capability === null) return null

  const disabled = capability.modelAvailable !== true
  const blockKey: MarginKey | undefined = session.blocked === null ? undefined : aiBlockKey(session.blocked)

  const submit = (): void => {
    const selection = selectionOf(readSelection?.())
    setScope(selection === undefined ? 'article' : 'selection')
    void session.run({ mode, question, ...(selection === undefined ? {} : { selection }) })
  }

  return (
    <section className="margin-reader__ai" aria-label={t('ai.title')} data-ai-status={status}>
      <header className="margin-reader__aiHead">
        <h2 className="margin-reader__aiTitle">
          <button type="button" className="margin-reading__button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
            {open ? t('ai.collapse') : t('ai.expand')}
          </button>
          <span>{t('ai.title')}</span>
        </h2>
        <p className="margin-reading__intro">{modelId === '' ? t('ai.modelUnknown') : t('ai.model').replace('{model}', modelId)}</p>
      </header>

      {/* Visible without expanding: a missing model must be obvious up front. */}
      {disabled && <p className="margin-reader__warning" role="status" data-ai-no-model="true">{t('ai.noModel')}</p>}

      {!open ? null : <>
        {/* Boundary notice: always before the first run, not a one-time dismissal. */}
        <p className="margin-reader__warning" role="note">{t('ai.boundary')}</p>
        <div className="margin-reading__filters" role="group" aria-label={t('ai.mode')}>
          {MODES.map(entry => (
            <button key={entry.mode} type="button" className="margin-reading__chip" aria-pressed={mode === entry.mode}
              disabled={disabled || status === 'running'} onClick={() => { setMode(entry.mode); session.clearBlocked() }}>
              {t(entry.key)}
            </button>
          ))}
        </div>
        {mode === 'qa' && <label className="margin-reading__filters">
          {t('ai.question')}
          <input
            className="margin-reading__input margin-reader__aiInput"
            type="text"
            aria-label={t('ai.question')}
            maxLength={AI_QUESTION_MAX}
            placeholder={t('ai.questionPlaceholder')}
            value={question}
            disabled={disabled || status === 'running'}
            onChange={event => { setQuestion(event.target.value); session.clearBlocked() }}
          />
        </label>}
        <p className="margin-reading__count" data-ai-scope={shownScope}>{t('ai.scope') + '：' + t(shownScope === 'selection' ? 'ai.scope.selection' : 'ai.scope.article')}</p>
        <div className="margin-reading__actions">
          <button type="button" className="margin-reading__button" disabled={disabled || blocked !== undefined} onClick={submit}>
            {status === 'running' ? t('ai.running') : t('ai.run')}
          </button>
          {status === 'running' && <button type="button" className="margin-reading__button" onClick={() => session.cancel()}>{t('ai.cancel')}</button>}
        </div>
        {!disabled && blocked !== undefined && status !== 'running' && <p className="margin-reading__count" role="status">{t(aiBlockKey(blocked))}</p>}
        {blockKey !== undefined && <p className="margin-reader__warning" role="status">{t(blockKey)}</p>}
        {session.cancelled && status !== 'running' && <p className="margin-reading__count" role="status">{t('ai.cancelled')}</p>}
        {session.errorKey !== null && status === 'failed' && <div className="margin-reader__warning" role="alert" data-ai-error="true">
          <p>{t(session.errorKey)}</p>
        </div>}
        {session.result !== null && status === 'done' && <section className="margin-reader__aiResult" aria-label={t('ai.generated')}>
          <h3 className="margin-reader__aiResultTitle" tabIndex={-1} ref={resultHeading}>{t('ai.generated')}</h3>
          {/* Host-built coverage label, verbatim and unprefixed: the label already
              states the scope and whether the input was truncated. */}
          <p className="margin-reading__count" data-ai-coverage="true">{session.result.coverage.label}</p>
          <p className="margin-reading__count">{t('ai.model').replace('{model}', session.result.model)}</p>
          <div className="margin-reader__body margin-reader__aiBody">
            {/* Same safe path as the article: reset delegates, never raw HTML. */}
            <MarkdownDelegateProvider><MarkdownText text={session.result.text} labels={labels} variant="body" /></MarkdownDelegateProvider>
          </div>
          <p className="margin-reading__intro">{t('ai.resultNotice')}</p>
        </section>}
      </>}
    </section>
  )
}

export type { AiApi }
