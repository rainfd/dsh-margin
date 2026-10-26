/**
 * Explicit "save this article to Trilium" section (spec 006).
 *
 * It renders below the article body, only when the shell injects a save face.
 * Opening the article issues one read-only state call; the single POST happens
 * after an explicit click. It cannot mark read, import, annotate or call a model.
 * A failed or ambiguous reply is verified with a read-only state call and is
 * never retried automatically.
 */

import { useEffect, useMemo, useState } from 'react'
import { SaveSession, saveInstance, type SaveApi, type SavePanelProps } from './saveModel.ts'

/** One timestamp for display without trusting arbitrary upstream text. */
function stampLabel(iso: string | null): string {
  if (iso === null || iso === '') return ''
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return ''
  return new Date(parsed).toISOString().slice(0, 16).replace('T', ' ')
}

/** The save section. */
export function SavePanel({ api, candidateId, marginUrl, t }: SavePanelProps) {
  const [, redraw] = useState(0)
  const instanceUrl = useMemo(() => saveInstance(marginUrl) ?? '', [marginUrl])
  const session = useMemo(
    () => new SaveSession(api, { candidateId, instanceUrl }, () => redraw(value => value + 1)),
    [api, candidateId, instanceUrl],
  )
  useEffect(() => {
    void session.start()
    return () => session.stop()
  }, [session])

  // No actionable state and nothing saved: render no chrome at all.
  if (session.status === 'loading' || session.status === 'hidden') return null
  const view = session.view
  const saved = view?.saved === true || session.status === 'saved'
  const saving = session.status === 'saving'
  const allowed = view?.saveAllowed === true && !saved
  const savedAt = stampLabel(view?.savedAt ?? null)
  const noteRef = view?.externalRef ?? ''

  return (
    <section className="margin-reader__save" aria-label={t('save.title')} data-save-status={session.status}>
      <header className="margin-reader__aiHead">
        <h2 className="margin-reader__aiTitle">{t('save.title')}</h2>
        {saved
          ? <p className="margin-reading__count" data-save-saved="true">
            {t('save.saved')}{savedAt === '' ? '' : t('save.savedAt').replace('{time}', savedAt)}
          </p>
          : <p className="margin-reading__intro">{t('save.boundary')}</p>}
      </header>
      {saved && session.unconfirmed && <p className="margin-reader__warning" role="status" data-save-unconfirmed="true">{t('save.unconfirmed')}</p>}
      {saved && noteRef !== '' && <p className="margin-reading__count">{t('save.externalRef').replace('{ref}', noteRef)}</p>}
      {saved && <p className="margin-reading__intro">{t('save.needsTask')}</p>}
      {!saved && <div className="margin-reading__actions">
        <button type="button" className="margin-reading__button" disabled={!allowed || saving}
          onClick={() => { void session.save() }}>
          {saving ? t('save.saving') : allowed ? t('save.button') : t('save.disabled')}
        </button>
        {(session.status === 'failed' || session.unconfirmed) && <button type="button" className="margin-reading__button" disabled={saving}
          onClick={() => { void session.start() }}>{t('save.recheck')}</button>}
      </div>}
      {session.status === 'failed' && session.errorKey !== null
        && <p className="margin-reader__warning" role="alert" data-save-error="true">{t(session.errorKey)}</p>}
    </section>
  )
}
