/**
 * Highlights and notes panel (spec 007, browser half) — a collapsible section
 * *inside* the article reader, below the article body and beside the optional
 * AI section.
 *
 * Design constraints, and where each one lives:
 *  - Read-only first. The lists render from the last confirmed snapshot even
 *    when writing is disabled, stale or still loading.
 *  - Default deny. Every mutation control is disabled unless
 *    `session.writable` is true, which requires `writesAllowed` *and* a
 *    successful, uncontested read; the explanation is always on screen.
 *  - User content is rendered as text only: no Markdown pipeline, no
 *    raw-HTML injection path, and the colour comes from the host-validated
 *    hex field.
 *  - The selection preview shows the trimmed text the model/session would post
 *    (display-capped, with an explicit note when capped). The actual submit
 *    re-reads the selection at click time.
 *  - This panel holds no reading-status, save, import or AI method: the face it
 *    receives contains exactly the annotation routes.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  AnnotationSession,
  NOTE_CONTENT_MAX,
  SELECTION_PREVIEW_MAX,
  annotationInstance,
  canDeleteHighlight,
  canDeleteNote,
  noteContentProblem,
  selectionPreview,
  selectionProblem,
  selectionText,
  type AnnotationPanelProps,
} from './annotationModel.ts'

/** Local, prefix-only stamp; no locale machinery and no user text. */
function stampLabel(value: string): string {
  if (value === '') return ''
  const sliced = value.length > 16 ? value.slice(0, 16) : value
  return sliced.replace('T', ' ')
}

/**
 * The annotation section. Collapsed until opened, so plain reading is never
 * pushed down by notes chrome; the header still reports what exists.
 */
export function AnnotationPanel({ api, candidateId, marginUrl, readSelection, t }: AnnotationPanelProps) {
  const [, redraw] = useState(0)
  const [open, setOpen] = useState(false)
  /** Per-note whole-content edit buffer; memory only, dropped on article switch. */
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null)
  /** Typed deletion proofs, keyed by note/highlight id. */
  const [confirmNote, setConfirmNote] = useState<Record<number, string>>({})
  const [confirmHighlight, setConfirmHighlight] = useState<Record<number, string>>({})
  /** Pending link targets, keyed by highlight id ('' = no note). */
  const [linkChoice, setLinkChoice] = useState<Record<number, string>>({})
  /** 1-based occurrence chosen for an ambiguous selection; sent as index - 1. */
  const [occurrence, setOccurrence] = useState(1)

  // Derived, never entered by hand: exactly the origin the host compares.
  const instanceUrl = useMemo(() => annotationInstance(marginUrl) ?? '', [marginUrl])
  const session = useMemo(
    () => new AnnotationSession(api, { candidateId, instanceUrl }, () => redraw(n => n + 1)),
    [api, candidateId, instanceUrl],
  )
  // One read per open; the cleanup detaches the session so late replies are inert.
  useEffect(() => {
    void session.start()
    return () => session.stop()
  }, [session])
  // A different article or instance is a different panel: collapse and forget
  // every local proof/edit buffer. (The session itself is rebuilt above.)
  useEffect(() => {
    setOpen(false)
    setEditing(null)
    setConfirmNote({})
    setConfirmHighlight({})
    setLinkChoice({})
    setOccurrence(1)
  }, [candidateId, instanceUrl])

  const view = session.view
  const ready = session.status === 'ready' && view !== null
  const canWrite = session.writable
  const notes = view?.notes ?? []
  const highlights = view?.highlights ?? []
  const annotationsDisabled = view !== null && view.writesAllowed !== true
  const offsetsAvailable = view?.offsetsAvailable === true
  const pending = session.ambiguous
  const selection = selectionText(readSelection?.())
  const selectionBlock = selection === undefined ? undefined : selectionProblem(selection)
  const preview = selection === undefined ? null : selectionPreview(selection)
  const draftProblem = session.draft.trim() === '' ? undefined : noteContentProblem(session.draft)
  const createBlocked = !canWrite || !offsetsAvailable || selection === undefined
    || selectionBlock !== undefined || pending !== null

  return (
    <section className="margin-reader__annotations" aria-label={t('annotations.title')} data-annotation-status={session.status}>
      <header className="margin-reader__annotationsHead">
        <h2 className="margin-reader__annotationsTitle">
          <button type="button" className="margin-reading__button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
            {open ? t('annotations.collapse') : t('annotations.expand')}
          </button>
          <span>{t('annotations.title')}</span>
        </h2>
        <p className="margin-reading__count" data-annotation-counts="true">
          {t('annotations.counts').replace('{notes}', String(notes.length)).replace('{highlights}', String(highlights.length))}
        </p>
      </header>

      {session.status === 'loading' && <p className="margin-reading__count" role="status">{t('annotations.loading')}</p>}
      {session.status === 'failed' && session.errorKey !== null && <div className="margin-reader__warning" role="alert" data-annotation-error="true">
        <p>{t(session.errorKey)}</p>
        <button type="button" className="margin-reading__button" disabled={session.loading} onClick={() => { void session.refresh() }}>
          {t('annotations.retry')}
        </button>
      </div>}

      {!open ? null : <>
        {/* Boundary notices: always visible, not dismissible. */}
        {annotationsDisabled && <p className="margin-reader__warning" role="status" data-annotation-readonly="true">{t('annotations.readOnly')}</p>}
        {session.stale && <p className="margin-reader__warning" role="status" data-annotation-stale="true">{t('annotations.stale')}</p>}
        {session.busy && <p className="margin-reading__count" role="status">{t('annotations.busy')}</p>}
        {session.notice !== null && <p className="margin-reading__count" role="status" data-annotation-notice="true">{t(session.notice)}</p>}
        {session.errorKey !== null && session.status === 'ready' && pending === null
          && <p className="margin-reader__warning" role="alert" data-annotation-error="true">{t(session.errorKey)}</p>}
        {session.noteError !== null
          && <p className="margin-reader__warning" role="alert" data-annotation-note-error="true">{t(session.noteError)}</p>}

        {/* ---- Notes: read first, then explicit create/edit/delete ---- */}
        <section className="margin-reader__annotationsSection" aria-label={t('annotations.notes')}>
          <h3 className="margin-reader__annotationsHeading">{t('annotations.notes')}</h3>
          {notes.length === 0
            ? <p className="margin-reading__count">{t('annotations.noNotes')}</p>
            : <ul className="margin-reading__list">
              {notes.map(note => {
                const typed = confirmNote[note.id] ?? ''
                const truncated = note.contentTruncated === true
                const deletable = !truncated && canDeleteNote(note, typed)
                const isEditing = editing !== null && editing.id === note.id
                return <li key={note.id} className="margin-reading__item">
                  <div className="margin-reading__body">
                    {/* User content is a text node; never HTML/Markdown. */}
                    <p className="margin-reading__plain margin-reader__annotationsText" data-note-id={note.id}>{note.content}</p>
                    <div className="margin-reading__meta">
                      <span>#{note.id}</span>
                      {note.createdAt !== '' && <span>{t('annotations.note.createdAt').replace('{time}', stampLabel(note.createdAt))}</span>}
                      {note.updatedAt !== '' && note.updatedAt !== note.createdAt
                        && <span>{t('annotations.note.updatedAt').replace('{time}', stampLabel(note.updatedAt))}</span>}
                    </div>
                    {truncated && <p className="margin-reading__count" role="status">{t('annotations.note.truncated')}</p>}
                    {isEditing && editing !== null && <div className="margin-reader__annotationsForm">
                      <label className="margin-reading__filters">{t('annotations.note.edit')}
                        <textarea className="margin-reading__input margin-reader__annotationsInput" value={editing.text}
                          maxLength={NOTE_CONTENT_MAX} aria-label={t('annotations.note.edit')}
                          onChange={event => setEditing({ id: editing.id, text: event.target.value })} />
                      </label>
                      <div className="margin-reading__actions">
                        <button type="button" className="margin-reading__button"
                          disabled={!canWrite || noteContentProblem(editing.text) !== undefined}
                          onClick={() => { void session.updateNote(note.id, editing.text).then(ok => { if (ok) setEditing(null) }) }}
                        >{t('annotations.note.editSave')}</button>
                        <button type="button" className="margin-reading__button" onClick={() => setEditing(null)}>{t('annotations.note.cancel')}</button>
                      </div>
                    </div>}
                    <div className="margin-reading__actions">
                      <button type="button" className="margin-reading__button" disabled={!canWrite || truncated}
                        onClick={() => setEditing({ id: note.id, text: note.content })}
                      >{t('annotations.note.edit')}</button>
                    </div>
                    <div className="margin-reading__filters">
                      <label>{t('annotations.note.deleteConfirm')}
                        <input className="margin-reading__select" type="text" autoComplete="off" spellCheck={false} value={typed}
                          aria-label={t('annotations.note.deleteConfirm')}
                          onChange={event => setConfirmNote(current => ({ ...current, [note.id]: event.target.value }))} />
                      </label>
                      <button type="button" className="margin-reading__button" disabled={truncated}
                        onClick={() => setConfirmNote(current => ({ ...current, [note.id]: note.content }))}
                      >{t('annotations.note.fill')}</button>
                      <button type="button" className="margin-reading__button" disabled={!canWrite || !deletable}
                        onClick={() => {
                          void session.deleteNote(note.id, typed).then(ok => {
                            if (!ok) return
                            setConfirmNote(current => { const next = { ...current }; delete next[note.id]; return next })
                          })
                        }}
                      >{t('annotations.note.delete')}</button>
                    </div>
                    {note.content === '' && <p className="margin-reading__count">{t('annotations.note.emptyProof')}</p>}
                  </div>
                </li>
              })}
            </ul>}
        </section>

        {/* ---- Highlights: read first, then explicit link/delete ---- */}
        <section className="margin-reader__annotationsSection" aria-label={t('annotations.highlights')}>
          <h3 className="margin-reader__annotationsHeading">{t('annotations.highlights')}</h3>
          {highlights.length === 0
            ? <p className="margin-reading__count">{t('annotations.noHighlights')}</p>
            : <ul className="margin-reading__list">
              {highlights.map(highlight => {
                const typed = confirmHighlight[highlight.id] ?? ''
                const deletable = canDeleteHighlight(highlight, typed)
                const choice = linkChoice[highlight.id] ?? (highlight.noteId === null ? '' : String(highlight.noteId))
                const linked = highlight.noteId === null
                  ? t('annotations.unlinked')
                  : t('annotations.linkedTo').replace('{id}', String(highlight.noteId))
                return <li key={highlight.id} className="margin-reading__item">
                  <div className="margin-reading__body">
                    <p className="margin-reading__plain margin-reader__annotationsText" data-highlight-id={highlight.id}>
                      <span className="margin-reader__annotationsSwatch" style={{ backgroundColor: highlight.color }} aria-hidden="true" />
                      {highlight.selectedText}
                    </p>
                    <div className="margin-reading__meta">
                      <span>#{highlight.id}</span>
                      <span>{linked}</span>
                    </div>
                    <div className="margin-reading__filters">
                      <label>{t('annotations.highlight.linkTo')}
                        <select className="margin-reading__select" value={choice} disabled={view?.writesAllowed !== true}
                          aria-label={t('annotations.highlight.linkTo')}
                          onChange={event => setLinkChoice(current => ({ ...current, [highlight.id]: event.target.value }))}>
                          <option value="">{t('annotations.highlight.noLink')}</option>
                          {notes.map(note => <option key={note.id} value={String(note.id)}>#{note.id}</option>)}
                        </select>
                      </label>
                      <button type="button" className="margin-reading__button" disabled={!canWrite}
                        onClick={() => { void session.linkHighlight(highlight.id, choice === '' ? null : Number(choice)) }}
                      >{t('annotations.highlight.link')}</button>
                    </div>
                    <div className="margin-reading__filters">
                      <label>{t('annotations.highlight.deleteConfirm')}
                        <input className="margin-reading__select" type="text" autoComplete="off" spellCheck={false} value={typed}
                          aria-label={t('annotations.highlight.deleteConfirm')}
                          onChange={event => setConfirmHighlight(current => ({ ...current, [highlight.id]: event.target.value }))} />
                      </label>
                      <button type="button" className="margin-reading__button"
                        onClick={() => setConfirmHighlight(current => ({ ...current, [highlight.id]: highlight.selectedText }))}
                      >{t('annotations.highlight.fill')}</button>
                      <button type="button" className="margin-reading__button" disabled={!canWrite || !deletable}
                        onClick={() => { void session.deleteHighlight(highlight.id, typed) }}
                      >{t('annotations.highlight.delete')}</button>
                    </div>
                    <p className="margin-reading__count">{t('annotations.highlight.deleteNote')}</p>
                  </div>
                </li>
              })}
            </ul>}
        </section>

        {/* ---- Create a note: explicit save, nothing auto-sent ---- */}
        {view !== null && <section className="margin-reader__annotationsSection" aria-label={t('annotations.note.create')}>
          <h3 className="margin-reader__annotationsHeading">{t('annotations.note.create')}</h3>
          <label className="margin-reading__filters">{t('annotations.note.placeholder')}
            <textarea className="margin-reading__input margin-reader__annotationsInput" value={session.draft}
              maxLength={NOTE_CONTENT_MAX} placeholder={t('annotations.note.placeholder')}
              aria-label={t('annotations.note.placeholder')}
              disabled={!ready || view.writesAllowed !== true}
              onChange={event => session.setDraft(event.target.value)} />
          </label>
          <div className="margin-reading__actions">
            <button type="button" className="margin-reading__button"
              disabled={!canWrite || session.draft.trim() === '' || draftProblem !== undefined}
              onClick={() => { void session.createNote() }}
            >{t('annotations.note.save')}</button>
            <span className="margin-reading__count" data-annotation-draft="true">
              {t('annotations.note.counter').replace('{length}', String(session.draft.length)).replace('{max}', String(NOTE_CONTENT_MAX))}
            </span>
          </div>
          {draftProblem !== undefined && <p className="margin-reading__count" role="status">{t(draftProblem)}</p>}
        </section>}

        {/* ---- Selection → highlight ---- */}
        <section className="margin-reader__annotationsSection" aria-label={t('annotations.selection.title')}>
          <h3 className="margin-reader__annotationsHeading">{t('annotations.selection.title')}</h3>
          {selection === undefined
            ? <p className="margin-reading__count">{t('annotations.selection.none')}</p>
            : <>
              <p className="margin-reading__count">{t('annotations.selection.current')}</p>
              {/* Exactly the trimmed text that would be sent; display-capped only. */}
              <pre className="margin-reading__plain margin-reader__annotationsPreview" data-annotation-selection="true">{preview?.text}</pre>
              {preview?.truncated === true
                && <p className="margin-reading__count">{t('annotations.selection.previewTruncated').replace('{limit}', String(SELECTION_PREVIEW_MAX))}</p>}
            </>}
          <div className="margin-reading__actions">
            <button type="button" className="margin-reading__button" disabled={createBlocked}
              onClick={() => { const current = selectionText(readSelection?.()); void session.createHighlight(current ?? '') }}
            >{t('annotations.selection.create')}</button>
            <button type="button" className="margin-reading__button" onClick={() => redraw(value => value + 1)}>
              {t('annotations.selection.refresh')}
            </button>
          </div>
          {view !== null && view.offsetsAvailable !== true
            && <p className="margin-reading__count" role="status">{t('annotations.offsetsUnavailable')}</p>}
          {selection !== undefined && selectionBlock !== undefined
            && <p className="margin-reading__count" role="status">{t(selectionBlock)}</p>}
        </section>

        {/* ---- Ambiguity: the user must name the occurrence, never a guess ---- */}
        {pending !== null && <div className="margin-reader__warning" role="status" data-annotation-ambiguous="true">
          <p>{pending.count === null
            ? t('annotations.highlight.ambiguousUnknown')
            : t('annotations.highlight.ambiguous').replace('{count}', String(pending.count))}</p>
          <div className="margin-reading__filters">
            <label>{t('annotations.highlight.occurrence')}
              {pending.count === null
                ? <input className="margin-reading__select" type="number" min={1} step={1} inputMode="numeric" value={occurrence}
                  aria-label={t('annotations.highlight.occurrence')}
                  onChange={event => setOccurrence(Number(event.target.value))} />
                : <select className="margin-reading__select" value={occurrence}
                  aria-label={t('annotations.highlight.occurrence')}
                  onChange={event => setOccurrence(Number(event.target.value))}>
                  {Array.from({ length: Math.min(pending.count, 51) }, (_, index) => index + 1).map(value => (
                    <option key={value} value={value}>{t('annotations.highlight.occurrenceOption').replace('{n}', String(value))}</option>
                  ))}
                </select>}
            </label>
            <button type="button" className="margin-reading__button"
              disabled={!canWrite || !Number.isSafeInteger(occurrence) || occurrence < 1}
              onClick={() => { void session.createHighlight(pending.selectedText, occurrence - 1) }}
            >{t('annotations.highlight.resubmit')}</button>
            <button type="button" className="margin-reading__button" onClick={() => session.clearAmbiguity()}>
              {t('annotations.highlight.cancel')}
            </button>
          </div>
        </div>}
      </>}
    </section>
  )
}

export type { AnnotationPanelProps }
