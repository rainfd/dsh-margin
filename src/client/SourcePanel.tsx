/**
 * 来源与凭据 panel (spec004).
 *
 * Rendered as a *hidden* sibling viewport, never an unmount: the reading list,
 * the reader state and the import session stay mounted exactly as ImportPanel
 * does it. Every mutation is gated by the live `sourceWritesAllowed` /
 * `credentialWritesAllowed` from the last successful `/management` read, then
 * followed by a re-read — the mutation reply is never treated as final state.
 *
 * All hooks live in this component (no stateful children) so hook order stays
 * stable and the request controller remains the only owner of the pending
 * cookie. The cookie is a controlled password input: it exists in this
 * component's memory and in that one input's value, nowhere else — never in
 * storage, the URL, a log, or any rendered text.
 */

import { useEffect, useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { SourceSession, SUPPORTED_DOMAINS, statusKey, type SourceApi } from './sourceModel.ts'

export type SourcePanelProps = PropsLocale<'dsh-margin'> & {
  api: SourceApi
  active: boolean
  onClose: () => void
  /** Re-read the reading list after a poll may have produced articles. */
  onChanged?: () => void
}

/** Local `YYYY-MM-DD HH:mm` from an ISO stamp; null when unusable (never echoed). */
function stamp(value: string | null): string | null {
  if (value === null || value === '') return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  const date = new Date(parsed)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function SourcePanel({ api, active, onClose, onChanged, t }: SourcePanelProps) {
  const [, redraw] = useState(0)
  const session = useMemo(() => new SourceSession(api, () => redraw(n => n + 1)), [api])
  // Form state lives in the component; the cookie itself lives only in the session.
  const [feedUrl, setFeedUrl] = useState('')
  const [name, setName] = useState('')
  const [intervalText, setIntervalText] = useState('60')
  const [domain, setDomain] = useState(SUPPORTED_DOMAINS[0] ?? '')
  /** Typed delete confirmations, keyed by source id. */
  const [confirmText, setConfirmText] = useState<Record<number, string>>({})
  useEffect(() => {
    if (active) session.start()
    return () => session.stop()
  }, [session, active])

  const view = session.view
  const sourceGate = view?.sourceWritesAllowed === true
  const credentialGate = view?.credentialWritesAllowed === true
  // A stale snapshot keeps its rows readable but must not offer actions.
  const blocked = session.busy || view === null || session.stale
  const sources = view?.sources ?? []
  const credentials = view?.credentials ?? []
  const jobs = view?.scheduler.jobs ?? []
  const note = session.note === '' ? null : session.note
  const noteParams = note === 'sources.noteFetched' ? { count: session.noteCount } : undefined

  return <div className="margin-reading__viewport" hidden={!active}>
    <section className="margin-reading__content" aria-label={t('sources.title')}>
      <header className="margin-reading__head">
        <div>
          <h1 className="margin-reading__title">{t('sources.title')}</h1>
          <p className="margin-reading__intro">{t('sources.intro')}</p>
        </div>
        <button type="button" className="margin-reading__button" onClick={onClose}>{t('sources.close')}</button>
      </header>

      <div className="margin-reading__toolbar">
        <div className="margin-reading__filters">
          <button type="button" className="margin-reading__button" disabled={session.loading || session.busy}
            onClick={() => { void session.refresh(true) }}>{t('sources.refresh')}</button>
          <span className="margin-reading__count" role="status">
            {session.loading ? t('sources.loading')
              : view === null ? ''
                : t('sources.observedAt', { time: stamp(view.observedAt) ?? view.observedAt })}
          </span>
        </div>
        {view !== null && <p className="margin-reading__count">{t('sources.instance', { instance: view.instanceUrl })}</p>}
        {session.busy && <p className="margin-reading__count" role="status">{t('sources.busy')}</p>}
        {note !== null && <p className="margin-reader__warning" role="alert" data-source-note={note}>{t(note, noteParams)}</p>}
        {session.stale && <p className="margin-reader__warning" role="status">{t('sources.refreshNeeded')}</p>}
        {view === null && !session.loading && <p className="margin-reader__warning" role="status">{t('sources.refreshNeeded')}</p>}
        {view !== null && !sourceGate && <p className="margin-reading__count" role="status">{t('sources.gateSourceOff')}</p>}
        {view !== null && !credentialGate && <p className="margin-reading__count" role="status">{t('sources.gateCredentialOff')}</p>}
      </div>

      <section aria-label={t('sources.section.scheduler')}>
        <h2 className="margin-reading__itemTitle">{t('sources.section.scheduler')}</h2>
        <p className="margin-reading__intro">{t('sources.scheduler.scope')}</p>
        {view !== null && <>
          <div className="margin-reading__meta">
            <span>{view.scheduler.running ? t('sources.scheduler.running') : t('sources.scheduler.stopped')}</span>
            <span>{t('sources.scheduler.jobs', { count: view.scheduler.sourcePollJobs })}</span>
          </div>
          <ul className="margin-reading__list" aria-label={t('sources.section.scheduler')}>
            {jobs.map(job => {
              const next = stamp(job.nextRunTime)
              return <li key={job.sourceId} className="margin-reading__item">
                <div className="margin-reading__body">
                  <h3 className="margin-reading__itemTitle">#{job.sourceId}</h3>
                  <div className="margin-reading__meta">
                    <span>{next === null ? t('sources.scheduler.noNextRun') : t('sources.scheduler.nextRun', { time: next })}</span>
                    {job.intervalMinutes !== null && <span>{t('sources.scheduler.interval', { minutes: job.intervalMinutes })}</span>}
                  </div>
                </div>
              </li>
            })}
          </ul>
          {jobs.length === 0 && <p className="margin-reading__notice">{t('sources.scheduler.empty')}</p>}
        </>}
      </section>

      <section aria-label={t('sources.section.sources')}>
        <h2 className="margin-reading__itemTitle">{t('sources.section.sources')}</h2>
        <ul className="margin-reading__list">
          {sources.map(source => {
            const origin = source.feedOrigin
            const fetched = stamp(source.recordedFetchAt)
            const lastError = stamp(source.lastErrorAt)
            const typed = confirmText[source.id] ?? ''
            const confirmed = typed.trim() !== '' && typed.trim() === origin
            const fetchable = source.status === 'active' || source.status === 'error'
            return <li key={source.id} className="margin-reading__item">
              <div className="margin-reading__body">
                <h3 className="margin-reading__itemTitle">{source.label} <span className="margin-reading__count">#{source.id}</span></h3>
                <div className="margin-reading__meta">
                  <span>{t(statusKey(source.status))}</span>
                  <span>{t('sources.source.origin', { origin })}</span>
                  <span>{t('sources.source.interval', { minutes: source.pollIntervalMinutes })}</span>
                  <span>{t('sources.source.failures', { count: source.consecutiveFailures })}</span>
                  <span>{source.hasError ? t('sources.source.error') : t('sources.source.noError')}</span>
                  <span>{fetched === null ? t('sources.source.notFetched') : t('sources.source.fetchedAt', { time: fetched })}</span>
                  {source.hasError && lastError !== null && <span>{t('sources.source.lastErrorAt', { time: lastError })}</span>}
                </div>
                <p className="margin-reading__intro">{t('sources.pauseHint')}</p>
                <div className="margin-reading__actions">
                  <button type="button" className="margin-reading__button"
                    disabled={!sourceGate || blocked || source.status === 'unknown'}
                    onClick={() => { void session.setSourceStatus(source.id, source.status === 'paused' ? 'active' : 'paused') }}
                  >{source.status === 'paused' ? t('sources.action.resume') : t('sources.action.pause')}</button>
                  {fetchable && <button type="button" className="margin-reading__button"
                    disabled={!sourceGate || blocked}
                    aria-label={`${t('sources.action.fetch')} #${source.id}`}
                    onClick={() => { void session.fetchSource(source.id).then(ok => { if (ok) onChanged?.() }) }}
                  >{t('sources.action.fetch')}</button>}
                </div>
                {fetchable && <p className="margin-reading__intro">{t('sources.fetchHint')}</p>}
                <div className="margin-reading__filters">
                  <label>{t('sources.confirm.label', { origin })}
                    <input className="margin-reading__select" type="text" autoComplete="off" spellCheck={false}
                      value={typed} placeholder={t('sources.confirm.placeholder')}
                      aria-label={t('sources.confirm.label', { origin })}
                      onChange={event => setConfirmText(current => ({ ...current, [source.id]: event.target.value }))} />
                  </label>
                  <button type="button" className="margin-reading__button"
                    disabled={!sourceGate || blocked || !confirmed}
                    onClick={() => { if (confirmed) void session.deleteSource(source.id, origin) }}
                  >{t('sources.action.delete')}</button>
                  <span className="margin-reading__count">{t('sources.confirm.retained')}</span>
                </div>
              </div>
            </li>
          })}
        </ul>
        {view !== null && sources.length === 0 && <p className="margin-reading__notice">{t('sources.noSources')}</p>}
      </section>

      {view !== null && <section aria-label={t('sources.create.label')}>
        <h2 className="margin-reading__itemTitle">{t('sources.create.label')}</h2>
        <p className="margin-reading__intro">{t('sources.create.hint')}</p>
        <div className="margin-reading__toolbar">
          <label>{t('sources.create.feedUrl')}
            <input className="margin-reading__select" type="url" autoComplete="off" spellCheck={false}
              value={feedUrl} onChange={event => setFeedUrl(event.target.value)} /></label>
          <label>{t('sources.create.name')}
            <input className="margin-reading__select" type="text" autoComplete="off"
              value={name} onChange={event => setName(event.target.value)} /></label>
          <label>{t('sources.create.interval')}
            <input className="margin-reading__select" type="number" min={5} max={10080} step={1} inputMode="numeric"
              value={intervalText} onChange={event => setIntervalText(event.target.value)} /></label>
          <button type="button" className="margin-reading__button" disabled={!sourceGate || blocked}
            onClick={() => { void session.createSource(feedUrl, name, intervalText) }}>{t('sources.create.submit')}</button>
        </div>
      </section>}

      <section aria-label={t('sources.section.credentials')}>
        <h2 className="margin-reading__itemTitle">{t('sources.section.credentials')}</h2>
        <p className="margin-reading__intro">{t('sources.credential.neverEcho')}</p>
        <p className="margin-reading__intro">{t('sources.credential.supportedList', { domains: SUPPORTED_DOMAINS.join('、') })}</p>
        <ul className="margin-reading__list">
          {credentials.map(credential => {
            const updated = stamp(credential.updatedAt)
            return <li key={credential.id} className="margin-reading__item">
              <div className="margin-reading__body">
                <h3 className="margin-reading__itemTitle">{credential.domain} <span className="margin-reading__count">#{credential.id}</span></h3>
                <div className="margin-reading__meta">
                  <span className="margin-reading__source">{credential.configured ? t('sources.credential.configured') : t('sources.credential.unconfigured')}</span>
                  <span>{credential.supported ? t('sources.credential.supported') : t('sources.credential.unsupported')}</span>
                  {updated !== null && <span>{updated}</span>}
                </div>
                {!credential.supported && <p className="margin-reading__intro">{t('sources.credential.unsupportedNote')}</p>}
              </div>
              <div className="margin-reading__actions">
                <button type="button" className="margin-reading__button"
                  disabled={!credentialGate || blocked}
                  aria-label={`${t('sources.action.deleteCredential')}：${credential.domain}`}
                  onClick={() => { void session.deleteCredential(credential.id, credential.domain) }}
                >{t('sources.action.deleteCredential')}</button>
              </div>
            </li>
          })}
        </ul>
        {view !== null && credentials.length === 0 && <p className="margin-reading__notice">{t('sources.noCredentials')}</p>}
      </section>

      {view !== null && <section aria-label={t('sources.createCredential.label')}>
        <h2 className="margin-reading__itemTitle">{t('sources.createCredential.label')}</h2>
        <p className="margin-reading__intro">{t('sources.createCredential.hint')}</p>
        <div className="margin-reading__toolbar">
          <label>{t('sources.createCredential.domain')}
            <select className="margin-reading__select" value={domain} onChange={event => setDomain(event.target.value)}>
              {SUPPORTED_DOMAINS.map(value => <option key={value} value={value}>{value}</option>)}
            </select></label>
          <label>{t('sources.createCredential.cookie')}
            <input className="margin-reading__select" type="password" autoComplete="off" spellCheck={false}
              name="margin-domain-cookie" value={session.cookie}
              onChange={event => session.setCookie(event.target.value)} /></label>
          <button type="button" className="margin-reading__button"
            disabled={!credentialGate || blocked || session.cookie === ''}
            onClick={() => { void session.createCredential(domain, session.cookie) }}
          >{t('sources.createCredential.submit')}</button>
        </div>
      </section>}
    </section>
  </div>
}
