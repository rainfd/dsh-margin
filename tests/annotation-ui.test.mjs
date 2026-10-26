/**
 * spec007 (highlights + notes panel) — browser-half tests.
 *
 * Compiled with the same tsc invocation as tests/import-ui.test.mjs: only pure
 * client logic, the real API client and the reader model are compiled; no
 * plugin bundle build and no network call is involved.
 *
 * The component harness drives real event handlers and effects (as the AI and
 * import tests do) but does not implement a DOM: browser selection, focus and
 * layout are exercised only through the injected `readSelection` callback.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const temp = mkdtempSync(join(tmpdir(), 'dsh-margin-annotation-ui-'))
after(() => rmSync(temp, { recursive: true, force: true }))
writeFileSync(join(temp, 'package.json'), '{"type":"module"}')
execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
  '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext',
  '--skipLibCheck', '--rewriteRelativeImportExtensions', '--rootDir', 'src', '--outDir', temp,
  'src/client/annotationModel.ts', 'src/client/api.ts', 'src/client/readerModel.ts', 'src/client/locales.ts'], { stdio: 'pipe' })

const model = await import(pathToFileURL(join(temp, 'client/annotationModel.js')))
const apiModule = await import(pathToFileURL(join(temp, 'client/api.js')))
const readerModel = await import(pathToFileURL(join(temp, 'client/readerModel.js')))
const { zh } = await import(pathToFileURL(join(temp, 'client/locales.js')))
const {
  AnnotationSession,
  NOTE_CONTENT_MAX,
  SELECTION_PREVIEW_MAX,
  SELECTION_TEXT_MAX,
  ambiguityCount,
  annotationErrorKey,
  annotationInstance,
  canDeleteHighlight,
  canDeleteNote,
  noteContentProblem,
  noteErrorKey,
  occurrenceProblem,
  selectionPreview,
  selectionProblem,
  selectionText,
} = model
const { MarginApi, MarginApiError } = apiModule
const jsxRuntime = createRequire(import.meta.url)('react/jsx-runtime')
const t = key => {
  const value = zh[key]
  if (typeof value !== 'string') throw new Error('missing locale key ' + key)
  return value
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const instance = 'https://margin.example'
const note = (overrides = {}) => ({
  id: 11, candidateId: 7, content: '第一条笔记', contentTruncated: false, contentLength: 5,
  createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', ...overrides,
})
const highlight = (overrides = {}) => ({
  id: 21, candidateId: 7, noteId: null, start: 0, end: 6, selectedText: 'needle', color: '#f5d0a8',
  fingerprint: '0123456789abcdef', createdAt: '2026-10-01T10:00:00Z', ...overrides,
})
const view = (overrides = {}) => ({
  instanceUrl: instance, candidateId: 7, marginUrl: instance + '/reader/7', writesAllowed: true,
  offsetsAvailable: true, notes: [note()], highlights: [highlight()], ...overrides,
})

/* ------------------------------------------------------------------ *
 * Component harness: real hooks/elements, mocked module boundaries.
 * ------------------------------------------------------------------ */

function hooksDriver() {
  const cells = []
  let index = 0
  let effects = []
  const changed = (a, b) => !a || a.length !== b.length || a.some((value, i) => value !== b[i])
  const hooks = {
    useState(initial) {
      const i = index++
      cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next }]
    },
    useRef(initial) { const i = index++; cells[i] ??= { current: initial }; return cells[i] },
    useMemo(factory, deps) { const i = index++; if (changed(cells[i]?.deps, deps)) cells[i] = { deps, value: factory() }; return cells[i].value },
    useEffect(effect, deps) {
      const i = index++
      if (changed(cells[i]?.deps, deps)) effects.push(() => { cells[i]?.cleanup?.(); cells[i] = { deps, cleanup: effect() } })
    },
  }
  return {
    hooks,
    begin() { index = 0; effects = [] },
    drain() { const pending = effects; effects = []; pending.forEach(run => run()) },
    cleanupAll() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}

function load(file, name, mocks) {
  const output = ts.transpileModule(readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(id => {
    if (!(id in mocks)) throw new Error(`Unmocked import ${id}`)
    return mocks[id]
  }, module, module.exports)
  return module.exports[name]
}

function componentHarness(entry) {
  const driver = hooksDriver()
  const MarkdownText = () => null
  const MarkdownDelegateProvider = () => null
  const Component = load(entry.file, entry.name, {
    ...entry.mocks(driver.hooks),
    react: driver.hooks,
    'react/jsx-runtime': jsxRuntime,
    '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText, MarkdownDelegateProvider },
  })
  let props
  return {
    MarkdownText,
    MarkdownDelegateProvider,
    render(next = props) {
      props = next
      driver.begin()
      const tree = Component(props)
      driver.drain()
      return tree
    },
    unmount() { driver.cleanupAll() },
  }
}

const panelHarness = () => componentHarness({
  file: 'AnnotationPanel.tsx',
  name: 'AnnotationPanel',
  mocks: () => ({ './annotationModel.ts': model }),
})

const readerHarness = () => componentHarness({
  file: 'ArticleReader.tsx',
  name: 'ArticleReader',
  mocks: () => ({ './api.ts': apiModule, './readerModel.ts': readerModel }),
})

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.props?.children)]
}
const find = (tree, predicate) => nodes(tree).find(predicate)
const button = (tree, label) => find(tree, node => node.type === 'button' && node.props.children === label)
function textValues(value) {
  if (typeof value === 'string' || typeof value === 'number') return [String(value)]
  if (Array.isArray(value)) return value.flatMap(textValues)
  if (value && typeof value === 'object') return textValues(value.props?.children)
  return []
}
const texts = tree => textValues(tree)
const hasText = (tree, text) => texts(tree).some(value => value.includes(text))

/* ------------------------------------------------------------------ *
 * Fixtures and helpers.
 * ------------------------------------------------------------------ */

function fixture(overrides = {}) {
  const calls = []
  const api = {
    loadAnnotations: async (id, instanceUrl) => {
      calls.push(['loadAnnotations', id, instanceUrl])
      return typeof overrides.view === 'function' ? overrides.view(id, instanceUrl) : (overrides.view ?? view({ instanceUrl }))
    },
    createHighlight: async input => {
      calls.push(['createHighlight', input])
      return { instanceUrl: input.instanceUrl, highlight: highlight() }
    },
    linkHighlight: async (highlightId, noteId, instanceUrl) => {
      calls.push(['linkHighlight', highlightId, noteId, instanceUrl])
      return { instanceUrl, highlight: highlight({ noteId }) }
    },
    deleteHighlight: async input => {
      calls.push(['deleteHighlight', input])
      return { instanceUrl: input.instanceUrl, deletedId: input.highlightId, notesPreserved: true }
    },
    createNote: async (candidateId, content, instanceUrl) => {
      calls.push(['createNote', candidateId, content, instanceUrl])
      return { instanceUrl, note: note({ content }) }
    },
    updateNote: async (candidateId, noteId, content, expectedContent, instanceUrl) => {
      calls.push(['updateNote', candidateId, noteId, content, expectedContent, instanceUrl])
      return { instanceUrl, note: note({ id: noteId, content }) }
    },
    deleteNote: async (candidateId, noteId, content, instanceUrl) => {
      calls.push(['deleteNote', candidateId, noteId, content, instanceUrl])
      return { instanceUrl, deletedId: noteId, highlightsDetached: true }
    },
    ...overrides.api,
  }
  return { api, calls }
}
const posts = calls => calls.filter(call => call[0] !== 'loadAnnotations')

const panelProps = (fixture_, overrides = {}) => ({
  api: fixture_.api,
  candidateId: 7,
  marginUrl: instance + '/reader/7',
  t,
  ...overrides,
})

async function openPanel(fixture_, overrides = {}) {
  const h = panelHarness()
  const render = (extra = {}) => h.render(panelProps(fixture_, { ...overrides, ...extra }))
  render()
  await flush()
  let tree = render()
  const expand = button(tree, t('annotations.expand'))
  assert.ok(expand, 'the annotation section must be collapsible and start collapsed')
  expand.props.onClick()
  tree = render()
  return { h, tree: () => render() }
}

/* ------------------------------------------------------------------ *
 * Pure model.
 * ------------------------------------------------------------------ */

test('the reader origin is derived from the URL alone, without URL parsing', () => {
  assert.equal(annotationInstance('https://margin.example/reader/7'), 'https://margin.example')
  assert.equal(annotationInstance('https://margin.example/reader/7/'), 'https://margin.example')
  assert.equal(annotationInstance('http://127.0.0.1:3000/margin/reader/12'), 'http://127.0.0.1:3000/margin')
  assert.equal(annotationInstance('https://margin.example/candidate/7'), 'https://margin.example')
  for (const bad of ['javascript:alert(1)', 'https://margin.example/article/7', 'https://margin.example/reader/7?x=1', '', 'not a url', undefined]) {
    assert.equal(annotationInstance(bad), null, String(bad))
  }
})

test('selection preview is trimmed, capped for display and validates the host ceilings', () => {
  assert.equal(selectionText('  needle  '), 'needle')
  assert.equal(selectionText(' \n '), undefined)
  assert.equal(selectionText(undefined), undefined)
  assert.equal(SELECTION_TEXT_MAX, 12_000)
  assert.equal(NOTE_CONTENT_MAX, 20_000)
  assert.equal(selectionProblem(undefined), 'annotations.error.emptySelection')
  assert.equal(selectionProblem('x'.repeat(SELECTION_TEXT_MAX)), undefined)
  assert.equal(selectionProblem('x'.repeat(SELECTION_TEXT_MAX + 1)), 'annotations.error.selectionTooLong')
  assert.deepEqual(selectionPreview('short'), { text: 'short', truncated: false })
  const long = 'y'.repeat(SELECTION_PREVIEW_MAX + 5)
  assert.deepEqual(selectionPreview(long), { text: 'y'.repeat(SELECTION_PREVIEW_MAX), truncated: true })
  assert.equal(noteContentProblem(''), 'annotations.error.emptyContent')
  assert.equal(noteContentProblem('  '), 'annotations.error.emptyContent')
  assert.equal(noteContentProblem('x'.repeat(NOTE_CONTENT_MAX)), undefined)
  assert.equal(noteContentProblem('x'.repeat(NOTE_CONTENT_MAX + 1)), 'annotations.error.contentTooLong')
  assert.equal(noteContentProblem(5), 'annotations.error.emptyContent')
})

test('deletion proofs require the exact current content or selected text', () => {
  const storedNote = note({ content: '完整内容\n第二行' })
  assert.equal(canDeleteNote(storedNote, '完整内容\n第二行'), true)
  assert.equal(canDeleteNote(storedNote, '完整内容'), false)
  assert.equal(canDeleteNote(storedNote, ' 完整内容\n第二行'), false)
  assert.equal(canDeleteNote(note({ content: '' }), ''), false, 'an empty body cannot prove anything')
  const storedHighlight = highlight({ selectedText: 'needle' })
  assert.equal(canDeleteHighlight(storedHighlight, 'needle'), true)
  assert.equal(canDeleteHighlight(storedHighlight, 'needl'), false)
  assert.equal(canDeleteHighlight(storedHighlight, 'needle '), false)
  assert.equal(canDeleteHighlight(highlight({ selectedText: '' }), ''), false)
})

test('error mapping uses code then status and never the upstream message', () => {
  const expected = {
    writes_disabled: 'annotations.error.writesDisabled',
    not_configured: 'annotations.error.notConfigured',
    instance_changed: 'annotations.error.instanceChanged',
    selection_not_located: 'annotations.error.selectionNotFound',
    ambiguous_selection: 'annotations.error.ambiguous',
    offsets_unavailable: 'annotations.error.offsetsUnavailable',
    empty_selection: 'annotations.error.emptySelection',
    selection_too_long: 'annotations.error.selectionTooLong',
    invalid_content: 'annotations.error.invalidContent',
    confirm_required: 'annotations.error.confirmRequired',
    confirmation_mismatch: 'annotations.error.confirmMismatch',
    margin_unauthorized: 'annotations.error.unauthorized',
    margin_rejected: 'annotations.error.rejected',
    margin_conflict: 'annotations.error.conflict',
    margin_bad_shape: 'annotations.error.upstream',
    margin_upstream_error: 'annotations.error.upstream',
    not_found: 'annotations.error.notFound',
    bad_body: 'annotations.error.request',
    invalid_id: 'annotations.error.request',
    internal_error: 'annotations.error.request',
  }
  for (const [code, key] of Object.entries(expected)) {
    assert.equal(annotationErrorKey(new MarginApiError('SECRET NOTE BODY token=abc', 500, code)), key, code)
    assert.equal(noteErrorKey(new MarginApiError('DIFFERENT DETAIL', 418, code)), key, code)
  }
  assert.equal(annotationErrorKey(new MarginApiError('x', 401)), 'annotations.error.unauthorized')
  assert.equal(annotationErrorKey(new MarginApiError('x', 409)), 'annotations.error.conflict')
  assert.equal(annotationErrorKey(new MarginApiError('x', 422)), 'annotations.error.rejected')
  assert.equal(annotationErrorKey(new MarginApiError('x', 504)), 'annotations.error.network')
  assert.equal(annotationErrorKey(new Error('offline')), 'annotations.error.network')
  // Every mapped value is a real locale key; a typo would throw here.
  for (const key of Object.values(expected)) assert.equal(typeof t(key), 'string')
})

test('ambiguity count reads only a bounded integer from the host sentence', () => {
  const host = new MarginApiError('所选文字出现多次，请指定第几处', 409, 'ambiguous_selection', 3)
  assert.equal(ambiguityCount(host), 3)
  // A message that is not the host's own wording yields null, never text.
  const canary = new MarginApiError('SECRET NOTE BODY token=abc', 409, 'ambiguous_selection')
  assert.equal(ambiguityCount(canary), null)
  assert.equal(ambiguityCount(new MarginApiError('出现 3 次', 409, 'ambiguous_selection')), null, 'no structured count, no guess')
  assert.equal(ambiguityCount(new MarginApiError('x', 409, 'ambiguous_selection', 99999)), 99999, 'structured count is trusted as sent')
  assert.equal(ambiguityCount(new MarginApiError('x', 409, 'not_found', 3)), null, 'only the ambiguity code')
  assert.equal(ambiguityCount(new Error('出现 3 次')), null)
  assert.equal(occurrenceProblem(null, 'needle', undefined), undefined)
  assert.equal(occurrenceProblem({ selectedText: 'needle', count: 3 }, 'other', undefined), undefined)
  assert.equal(occurrenceProblem({ selectedText: 'needle', count: 3 }, 'needle', undefined), 'annotations.error.occurrenceRequired')
  assert.equal(occurrenceProblem({ selectedText: 'needle', count: 3 }, 'needle', 2), undefined)
  assert.equal(occurrenceProblem({ selectedText: 'needle', count: 3 }, 'needle', 3), 'annotations.error.invalid')
  assert.equal(occurrenceProblem({ selectedText: 'needle', count: 3 }, 'needle', -1), 'annotations.error.invalid')
  assert.equal(occurrenceProblem({ selectedText: 'needle', count: null }, 'needle', 0), undefined)
})

/* ------------------------------------------------------------------ *
 * Session controller.
 * ------------------------------------------------------------------ */

test('open reads once, default deny blocks every mutation without a request', async () => {
  const f = fixture({ view: view({ writesAllowed: false }) })
  const session = new AnnotationSession(f.api, { candidateId: 7, instanceUrl: instance }, () => {})
  await session.start()
  assert.equal(session.status, 'ready')
  assert.equal(f.calls.filter(call => call[0] === 'loadAnnotations').length, 1)
  assert.equal(session.writable, false)
  session.setDraft('一条草稿')
  assert.equal(await session.createNote(), false)
  assert.equal(posts(f.calls).length, 0, 'a denied session must not post anything')
  assert.equal(session.noteError, 'annotations.error.writesDisabled')
  assert.equal(session.draft, '一条草稿', 'a failed write keeps the draft for the user')
  session.stop()
})

test('a mutation posts, verifies the reply instance, re-reads and only then trusts state', async () => {
  const f = fixture()
  const session = new AnnotationSession(f.api, { candidateId: 7, instanceUrl: instance }, () => {})
  await session.start()
  session.setDraft('新笔记')
  assert.equal(await session.createNote(), true)
  assert.deepEqual(f.calls.map(call => call[0]), ['loadAnnotations', 'createNote', 'loadAnnotations'])
  assert.equal(f.calls[1][1], 7)
  assert.equal(f.calls[1][2], '新笔记')
  assert.equal(f.calls[1][3], instance)
  assert.equal(session.draft, '', 'a confirmed create clears the draft')
  assert.equal(session.notice, 'annotations.note.created')
  session.stop()
})

test('a reply or re-read from another instance is discarded, not adopted', async () => {
  // Reply says another instance: no re-read may happen and state is dropped.
  const f = fixture({ api: { createNote: async () => ({ instanceUrl: 'https://other.example', note: note() }) } })
  const session = new AnnotationSession(f.api, { candidateId: 7, instanceUrl: instance }, () => {})
  await session.start()
  session.setDraft('新笔记')
  assert.equal(await session.createNote(), false)
  assert.equal(f.calls.filter(call => call[0] === 'loadAnnotations').length, 1, 'no re-read for a mismatched reply')
  assert.equal(session.view, null)
  assert.equal(session.draft, '')
  assert.equal(session.errorKey, 'annotations.error.instanceChanged')

  // Re-read says another instance: the state is discarded too.
  const g = fixture()
  const second = new AnnotationSession(g.api, { candidateId: 7, instanceUrl: instance }, () => {})
  await second.start()
  second.setDraft('草稿')
  g.api.loadAnnotations = async () => view({ instanceUrl: 'https://other.example' })
  assert.equal(await second.createNote(), false)
  assert.equal(posts(g.calls)[0][0], 'createNote', 'the POST still happened')
  assert.equal(second.view, null)
  assert.equal(second.draft, '')
  assert.equal(second.errorKey, 'annotations.error.instanceChanged')
})

test('an ambiguous create stores the selection and requires an explicit occurrence', async () => {
  const f = fixture()
  let attempts = 0
  f.api.createHighlight = async input => {
    f.calls.push(['createHighlight', input])
    attempts++
    if (attempts === 1) throw new MarginApiError('所选文字出现多次，请指定第几处', 409, 'ambiguous_selection', 3)
    return { instanceUrl: input.instanceUrl, highlight: highlight() }
  }
  const session = new AnnotationSession(f.api, { candidateId: 7, instanceUrl: instance }, () => {})
  await session.start()
  assert.equal(await session.createHighlight('  needle  '), false)
  assert.deepEqual(session.ambiguous, { selectedText: 'needle', count: 3 })
  assert.equal(f.calls.find(call => call[0] === 'createHighlight')[1].selectedText, 'needle')
  assert.equal('occurrence' in f.calls.find(call => call[0] === 'createHighlight')[1], false)
  const afterFirst = f.calls.filter(call => call[0] === 'createHighlight').length
  // No silent first match: a resubmit without a choice never reaches the host.
  assert.equal(await session.createHighlight('needle'), false)
  assert.equal(f.calls.filter(call => call[0] === 'createHighlight').length, afterFirst)
  assert.equal(session.errorKey, 'annotations.error.occurrenceRequired')
  // Out-of-range indices are refused locally as well.
  assert.equal(await session.createHighlight('needle', 3), false)
  assert.equal(f.calls.filter(call => call[0] === 'createHighlight').length, afterFirst)
  // The explicit 0-based choice succeeds, and the notice is re-read backed.
  assert.equal(await session.createHighlight('needle', 1), true)
  const last = f.calls.filter(call => call[0] === 'createHighlight').at(-1)[1]
  assert.equal(last.occurrence, 1)
  assert.equal(session.ambiguous, null)
  assert.equal(session.notice, 'annotations.highlight.created')
  session.stop()
})

test('delete proofs are re-checked against the snapshot before posting', async () => {
  const f = fixture()
  const session = new AnnotationSession(f.api, { candidateId: 7, instanceUrl: instance }, () => {})
  await session.start()
  assert.equal(await session.deleteNote(11, '第一条笔'), false)
  assert.equal(posts(f.calls).length, 0)
  assert.equal(session.noteError, 'annotations.error.confirmRequired')
  assert.equal(await session.deleteNote(11, '第一条笔记'), true)
  assert.deepEqual(posts(f.calls)[0], ['deleteNote', 7, 11, '第一条笔记', instance])

  assert.equal(await session.deleteHighlight(21, 'needl'), false)
  assert.equal(await session.deleteHighlight(21, 'needle'), true)
  const deleted = posts(f.calls).find(call => call[0] === 'deleteHighlight')[1]
  assert.deepEqual(deleted, { highlightId: 21, candidateId: 7, selectedText: 'needle', instanceUrl: instance })
  session.stop()
})

test('an instance change during refresh discards the view, draft and ambiguity', async () => {
  const f = fixture()
  const session = new AnnotationSession(f.api, { candidateId: 7, instanceUrl: instance }, () => {})
  await session.start()
  session.setDraft('未提交草稿')
  session.ambiguous = { selectedText: 'needle', count: 2 }
  f.api.loadAnnotations = async () => view({ instanceUrl: 'https://other.example' })
  await session.refresh()
  assert.equal(session.view, null)
  assert.equal(session.draft, '')
  assert.equal(session.ambiguous, null)
  assert.equal(session.status, 'failed')
  assert.equal(session.errorKey, 'annotations.error.instanceChanged')
  session.stop()
})

test('a late settle after stop/unmount writes nothing and notifies nothing', async () => {
  const pending = deferred()
  const f = fixture({ api: { loadAnnotations: () => pending.promise } })
  let changes = 0
  const session = new AnnotationSession(f.api, { candidateId: 7, instanceUrl: instance }, () => changes++)
  session.start()
  assert.ok(changes >= 1, 'open must report itself')
  session.stop()
  const afterStop = changes
  pending.resolve(view())
  await flush()
  assert.equal(session.view, null)
  assert.equal(session.draft, '')
  assert.equal(session.status, 'loading')
  assert.equal(changes, afterStop, 'no redraw after teardown')
})

/* ------------------------------------------------------------------ *
 * Panel: read-only first, default deny.
 * ------------------------------------------------------------------ */

test('default deny keeps both lists readable and disables every mutation with an explanation', async () => {
  const f = fixture({ view: view({ writesAllowed: false }) })
  const { h, tree } = await openPanel(f)
  let current = tree()
  assert.ok(hasText(current, note().content), 'notes stay readable without writes')
  assert.ok(hasText(current, highlight().selectedText), 'highlights stay readable without writes')
  assert.ok(find(current, node => node.props?.['data-annotation-readonly'] === 'true'))
  assert.ok(hasText(current, t('annotations.readOnly')))

  // Every mutation control is disabled; the list is not.
  for (const label of [
    t('annotations.note.edit'),
    t('annotations.note.save'),
    t('annotations.note.delete'),
    t('annotations.selection.create'),
    t('annotations.highlight.link'),
    t('annotations.highlight.delete'),
  ]) assert.equal(button(current, label).props.disabled, true, label)
  const noteTextarea = find(current, node => node.type === 'textarea')
  assert.equal(noteTextarea.props.disabled, true)

  // Even a captured click cannot post.
  button(current, t('annotations.note.save')).props.onClick()
  button(current, t('annotations.selection.create')).props.onClick()
  await flush()
  assert.equal(posts(f.calls).length, 0)
  h.unmount()
})

test('offsetsAvailable=false disables highlights but notes still work end to end', async () => {
  const f = fixture({ view: view({ offsetsAvailable: false }) })
  const { h, tree } = await openPanel(f, { readSelection: () => ' needle ' })
  let current = tree()
  assert.ok(hasText(current, t('annotations.offsetsUnavailable')))
  assert.equal(button(current, t('annotations.selection.create')).props.disabled, true)
  const noteTextarea = find(current, node => node.type === 'textarea' && node.props['aria-label'] === t('annotations.note.placeholder'))
  assert.equal(noteTextarea.props.disabled, false, 'notes must not depend on content_text')

  noteTextarea.props.onChange({ target: { value: '没有纯文本正文也能记笔记' } })
  current = tree()
  assert.equal(button(current, t('annotations.note.save')).props.disabled, false)
  button(current, t('annotations.note.save')).props.onClick()
  await flush()
  const created = posts(f.calls)
  assert.equal(created.length, 1)
  assert.deepEqual(created[0], ['createNote', 7, '没有纯文本正文也能记笔记', instance])
  current = tree()
  assert.ok(hasText(current, t('annotations.note.created')))
  h.unmount()
})

/* ------------------------------------------------------------------ *
 * Panel: content safety and error text.
 * ------------------------------------------------------------------ */

test('note and highlight content are rendered as text, never as HTML', async () => {
  const payload = '<img src=x onerror="alert(1)">SECRET NOTE BODY token=abc'
  const f = fixture({ view: view({ notes: [note({ content: payload })], highlights: [highlight({ selectedText: payload })] }) })
  const { h, tree } = await openPanel(f)
  const current = tree()
  assert.equal(find(current, node => node.props?.dangerouslySetInnerHTML !== undefined), undefined)
  assert.equal(nodes(current).some(node => node.type === 'img'), false, 'markup must not become an element')
  assert.ok(hasText(current, payload), 'the literal text is still shown')
  h.unmount()
})

test('failure text is fixed copy and never relays the response body', async () => {
  const canary = 'SECRET NOTE BODY token=abc'
  // A read failure.
  const readFailure = fixture({ api: { loadAnnotations: async () => { throw new MarginApiError(canary, 403, 'writes_disabled') } } })
  const first = await openPanel(readFailure)
  const readTree = first.tree()
  assert.ok(hasText(readTree, t('annotations.error.writesDisabled')))
  assert.equal(hasText(readTree, canary), false)
  first.h.unmount()

  // A note write failure.
  const writeFailure = fixture({ api: { createNote: async () => { throw new MarginApiError(canary, 500) } } })
  const second = await openPanel(writeFailure)
  const textarea = find(second.tree(), node => node.type === 'textarea' && node.props['aria-label'] === t('annotations.note.placeholder'))
  textarea.props.onChange({ target: { value: '正文' } })
  button(second.tree(), t('annotations.note.save')).props.onClick()
  await flush()
  const writeTree = second.tree()
  assert.ok(hasText(writeTree, t('annotations.error.unknown')))
  assert.equal(hasText(writeTree, canary), false)
  assert.equal(hasText(writeTree, 'HTTP 500'), false)
  second.h.unmount()
})

/* ------------------------------------------------------------------ *
 * Panel: ambiguity and confirmations.
 * ------------------------------------------------------------------ */

test('ambiguity reveals the count and requires an explicit occurrence before resubmit', async () => {
  const f = fixture()
  let attempts = 0
  f.api.createHighlight = async input => {
    f.calls.push(['createHighlight', input])
    attempts++
    if (attempts === 1) throw new MarginApiError('所选文字出现多次，请指定第几处', 409, 'ambiguous_selection', 3)
    return { instanceUrl: input.instanceUrl, highlight: highlight() }
  }
  const { h, tree } = await openPanel(f, { readSelection: () => '  needle  ' })
  let current = tree()
  const preview = find(current, node => node.props?.['data-annotation-selection'] === 'true')
  assert.equal(preview.props.children, 'needle', 'the preview shows exactly the trimmed text that is sent')
  button(current, t('annotations.selection.create')).props.onClick()
  await flush()
  current = tree()
  const block = find(current, node => node.props?.['data-annotation-ambiguous'] === 'true')
  assert.ok(block, 'an ambiguous reply must surface a choice, not pick the first match')
  assert.ok(hasText(current, t('annotations.highlight.ambiguous').replace('{count}', '3')))
  assert.equal(button(current, t('annotations.selection.create')).props.disabled, true)
  const select = find(block, node => node.type === 'select')
  assert.ok(select)
  assert.equal(nodes(select).filter(node => node.type === 'option').length, 3)

  // Without a choice the resubmit is refused locally.
  const before = f.calls.filter(call => call[0] === 'createHighlight').length
  assert.equal(button(current, t('annotations.highlight.resubmit')).props.disabled, false)
  select.props.onChange({ target: { value: '2' } })
  current = tree()
  button(current, t('annotations.highlight.resubmit')).props.onClick()
  await flush()
  const sent = f.calls.filter(call => call[0] === 'createHighlight')
  assert.equal(sent.length, before + 1)
  assert.equal(sent.at(-1)[1].occurrence, 1, 'the UI sends the 0-based occurrence')
  assert.equal(sent.at(-1)[1].selectedText, 'needle')
  await flush()
  current = tree()
  assert.equal(find(current, node => node.props?.['data-annotation-ambiguous'] === 'true'), undefined)
  assert.ok(hasText(current, t('annotations.highlight.created')))
  h.unmount()
})

test('note deletion needs the exact content; a copy button counts as explicit', async () => {
  const f = fixture()
  const { h, tree } = await openPanel(f)
  let current = tree()
  const noteInput = () => find(current, node => node.type === 'input' && node.props['aria-label'] === t('annotations.note.deleteConfirm'))
  assert.equal(button(current, t('annotations.note.delete')).props.disabled, true)
  noteInput().props.onChange({ target: { value: '第一条笔' } })
  current = tree()
  assert.equal(button(current, t('annotations.note.delete')).props.disabled, true, 'a prefix is not proof')
  button(current, t('annotations.note.fill')).props.onClick()
  current = tree()
  assert.equal(noteInput().props.value, note().content, 'copy fills the exact current content')
  assert.equal(button(current, t('annotations.note.delete')).props.disabled, false)
  button(current, t('annotations.note.delete')).props.onClick()
  await flush()
  assert.deepEqual(posts(f.calls)[0], ['deleteNote', 7, 11, note().content, instance])
  h.unmount()
})

test('editing a note replaces the whole content explicitly', async () => {
  const f = fixture()
  const { h, tree } = await openPanel(f)
  let current = tree()
  button(current, t('annotations.note.edit')).props.onClick()
  current = tree()
  const editor = find(current, node => node.type === 'textarea' && node.props['aria-label'] === t('annotations.note.edit'))
  assert.ok(editor, 'editing renders the current content in a textarea')
  assert.equal(editor.props.value, note().content)
  editor.props.onChange({ target: { value: '整体替换后的内容' } })
  current = tree()
  button(current, t('annotations.note.editSave')).props.onClick()
  await flush()
  assert.deepEqual(posts(f.calls)[0], ['updateNote', 7, 11, '整体替换后的内容', note().content, instance])
  current = tree()
  assert.ok(hasText(current, t('annotations.note.updated')))
  assert.equal(find(current, node => node.type === 'textarea' && node.props['aria-label'] === t('annotations.note.edit')), undefined)
  h.unmount()
})

test('a truncated note is readable but cannot be edited or deleted from the projection', async () => {
  const f = fixture({ view: { ...view(), notes: [note({ content: 'x'.repeat(20_000), contentTruncated: true, contentLength: 25_000 })] } })
  const { h, tree } = await openPanel(f)
  const current = tree()
  assert.ok(hasText(current, t('annotations.note.truncated')))
  assert.equal(button(current, t('annotations.note.edit')).props.disabled, true)
  assert.equal(button(current, t('annotations.note.fill')).props.disabled, true)
  assert.equal(button(current, t('annotations.note.delete')).props.disabled, true)
  assert.deepEqual(posts(f.calls), [], 'no write may be attempted from truncated content')
  h.unmount()
})

test('a highlight can be linked to one of this article\'s notes and unlinked again', async () => {
  const f = fixture()
  const { h, tree } = await openPanel(f)
  let current = tree()
  const linkSelect = () => find(current, node => node.type === 'select' && node.props['aria-label'] === t('annotations.highlight.linkTo'))
  linkSelect().props.onChange({ target: { value: '11' } })
  current = tree()
  button(current, t('annotations.highlight.link')).props.onClick()
  await flush()
  assert.deepEqual(posts(f.calls)[0], ['linkHighlight', 21, 11, instance])
  current = tree()
  assert.ok(hasText(current, t('annotations.highlight.linked')))

  linkSelect().props.onChange({ target: { value: '' } })
  current = tree()
  button(current, t('annotations.highlight.link')).props.onClick()
  await flush()
  assert.deepEqual(posts(f.calls).at(-1), ['linkHighlight', 21, null, instance])
  current = tree()
  assert.ok(hasText(current, t('annotations.highlight.unlinked')))
  h.unmount()
})

test('highlight deletion needs the exact selected text', async () => {
  const f = fixture()
  const { h, tree } = await openPanel(f)
  let current = tree()
  const highlightInput = () => find(current, node => node.type === 'input' && node.props['aria-label'] === t('annotations.highlight.deleteConfirm'))
  highlightInput().props.onChange({ target: { value: 'needl' } })
  current = tree()
  assert.equal(button(current, t('annotations.highlight.delete')).props.disabled, true)
  highlightInput().props.onChange({ target: { value: 'needle ' } })
  current = tree()
  assert.equal(button(current, t('annotations.highlight.delete')).props.disabled, true, 'whitespace is not exact')
  button(current, t('annotations.highlight.fill')).props.onClick()
  current = tree()
  assert.equal(highlightInput().props.value, 'needle')
  button(current, t('annotations.highlight.delete')).props.onClick()
  await flush()
  const deleted = posts(f.calls).find(call => call[0] === 'deleteHighlight')
  assert.deepEqual(deleted[1], { highlightId: 21, candidateId: 7, selectedText: 'needle', instanceUrl: instance })
  h.unmount()
})

/* ------------------------------------------------------------------ *
 * Panel: instance change, teardown, isolation.
 * ------------------------------------------------------------------ */

test('an instance change discards results and clears the pending draft', async () => {
  const f = fixture({
    view: (id, instanceUrl) => view({
      instanceUrl,
      notes: instanceUrl === instance ? [note()] : [note({ id: 99, content: '另一个实例的笔记' })],
    }),
  })
  const h = panelHarness()
  const renderA = () => h.render(panelProps(f))
  renderA()
  await flush()
  let tree = renderA()
  button(tree, t('annotations.expand')).props.onClick()
  tree = renderA()
  const textarea = () => find(tree, node => node.type === 'textarea' && node.props['aria-label'] === t('annotations.note.placeholder'))
  textarea().props.onChange({ target: { value: '未提交草稿' } })
  tree = renderA()
  assert.equal(textarea().props.value, '未提交草稿')

  // Same candidate id, different Margin instance: a different article.
  const renderB = () => h.render(panelProps(f, { marginUrl: 'https://other.example/reader/7' }))
  renderB()
  await flush()
  tree = renderB()
  button(tree, t('annotations.expand')).props.onClick()
  tree = renderB()
  assert.equal(textarea().props.value, '', 'the draft must not survive an instance change')
  assert.equal(hasText(tree, '未提交草稿'), false)
  assert.equal(hasText(tree, note().content), false, 'old-instance rows are gone')
  assert.ok(hasText(tree, '另一个实例的笔记'))
  const loads = f.calls.filter(call => call[0] === 'loadAnnotations')
  assert.equal(loads.at(-1)[2], 'https://other.example', 'the new read is bound to the new instance')
  h.unmount()
})

test('a late read resolve after unmount cannot paint a note', async () => {
  const pending = deferred()
  const f = fixture({ view: () => pending.promise })
  const h = panelHarness()
  h.render(panelProps(f))
  assert.equal(f.calls.filter(call => call[0] === 'loadAnnotations').length, 1)
  h.unmount()
  pending.resolve(view({ notes: [note({ content: '迟到的笔记' })] }))
  await flush()
  const tree = h.render()
  assert.equal(hasText(tree, '迟到的笔记'), false)
  assert.equal(hasText(tree, t('annotations.loading')), true, 'teardown leaves the session detached')
})

test('the injected face reaches no status, save, import or AI method', async () => {
  const forbidden = []
  const f = fixture({
    api: {
      setCandidateStatus: () => { forbidden.push('setCandidateStatus') },
      saveToTrilium: () => { forbidden.push('saveToTrilium') },
      importUrl: () => { forbidden.push('importUrl') },
      runAi: () => { forbidden.push('runAi') },
      loadCandidate: () => { forbidden.push('loadCandidate') },
    },
  })
  const { h, tree } = await openPanel(f)
  const current = tree()
  find(current, node => node.type === 'textarea').props.onChange({ target: { value: '笔记' } })
  await flush()
  button(tree(), t('annotations.note.save')).props.onClick()
  await flush()
  // The panel only ever received the annotation keys plus Panel; the spies stay cold.
  assert.deepEqual(forbidden, [])
  assert.deepEqual(Object.keys(f.api).sort(), [
    'createHighlight', 'createNote', 'deleteHighlight', 'deleteNote', 'importUrl', 'linkHighlight',
    'loadAnnotations', 'loadCandidate', 'runAi', 'saveToTrilium', 'setCandidateStatus', 'updateNote',
  ])
  h.unmount()
})

/* ------------------------------------------------------------------ *
 * Transport.
 * ------------------------------------------------------------------ */

test('the API client transports every annotation route as documented', async () => {
  const original = globalThis.fetch
  const calls = []
  const reply = url => {
    if (url.endsWith('/annotations') || url.includes('/annotations?')) return view()
    if (url.endsWith('/highlight-create') || url.endsWith('/highlight-link')) return { instanceUrl: instance, highlight: highlight() }
    if (url.endsWith('/highlight-delete')) return { instanceUrl: instance, deletedId: 21, notesPreserved: true }
    if (url.endsWith('/note-create') || url.endsWith('/note-update')) return { instanceUrl: instance, note: note() }
    if (url.endsWith('/note-delete')) return { instanceUrl: instance, deletedId: 11, highlightsDetached: true }
    throw new Error('unexpected URL ' + url)
  }
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options })
      return new Response(JSON.stringify(reply(url)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const api = new MarginApi()
    assert.deepEqual(await api.loadAnnotations(7, instance), view())
    assert.equal(calls[0].url, '/api/dsh-margin/annotations?id=7&instanceUrl=https%3A%2F%2Fmargin.example')
    assert.equal(calls[0].options, undefined)

    await api.createHighlight({ candidateId: 7, instanceUrl: instance, selectedText: 'needle' })
    assert.equal(calls[1].url, '/api/dsh-margin/highlight-create')
    assert.equal(calls[1].options.method, 'POST')
    assert.deepEqual(JSON.parse(calls[1].options.body), { candidateId: 7, instanceUrl: instance, selectedText: 'needle' })
    assert.equal('occurrence' in JSON.parse(calls[1].options.body), false, 'an unspecified occurrence is omitted')

    await api.createHighlight({ candidateId: 7, instanceUrl: instance, selectedText: 'needle', occurrence: 1 })
    assert.deepEqual(JSON.parse(calls[2].options.body), { candidateId: 7, instanceUrl: instance, selectedText: 'needle', occurrence: 1 })

    await api.linkHighlight(21, null, instance)
    assert.equal(calls[3].url, '/api/dsh-margin/highlight-link')
    assert.deepEqual(JSON.parse(calls[3].options.body), { highlightId: 21, noteId: null, instanceUrl: instance })

    await api.deleteHighlight({ highlightId: 21, candidateId: 7, selectedText: 'needle', instanceUrl: instance })
    assert.equal(calls[4].url, '/api/dsh-margin/highlight-delete')
    assert.deepEqual(JSON.parse(calls[4].options.body), { highlightId: 21, candidateId: 7, selectedText: 'needle', instanceUrl: instance })

    await api.createNote(7, '正文', instance)
    assert.equal(calls[5].url, '/api/dsh-margin/note-create')
    assert.deepEqual(JSON.parse(calls[5].options.body), { candidateId: 7, content: '正文', instanceUrl: instance })

    await api.updateNote(7, 11, '整体替换', '旧内容', instance)
    assert.equal(calls[6].url, '/api/dsh-margin/note-update')
    assert.deepEqual(JSON.parse(calls[6].options.body), { candidateId: 7, noteId: 11, content: '整体替换', expectedContent: '旧内容', instanceUrl: instance })

    await api.deleteNote(7, 11, '正文', instance)
    assert.equal(calls[7].url, '/api/dsh-margin/note-delete')
    assert.deepEqual(JSON.parse(calls[7].options.body), { candidateId: 7, noteId: 11, content: '正文', instanceUrl: instance })

    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'writes_disabled', message: 'HOST WORDING' } }), { status: 403 })
    await assert.rejects(api.createNote(7, '正文', instance),
      error => error instanceof MarginApiError && error.status === 403 && error.code === 'writes_disabled')
  } finally {
    globalThis.fetch = original
  }
})

/* ------------------------------------------------------------------ *
 * Reader and browser wiring.
 * ------------------------------------------------------------------ */

const candidate = {
  id: 7, title: 'Article', sourceUrl: 'https://example.com/a', marginUrl: 'https://margin.example/reader/7',
  sourceDomain: 'example.com', status: 'unprocessed', sourceType: 'rss', category: null, tags: [],
  author: null, summaryText: 'summary', summary: 'excerpt', isSavedToTrilium: false, createdAt: '', updatedAt: '',
}
const detail = { ...candidate, contentMd: '# Body', contentText: 'plain', contentFetchFailed: false }

test('the reader nests the injected annotation panel after the body, and only when present', async () => {
  const plain = readerHarness()
  plain.render({ candidate, t, onBack() {}, loadCandidate: async () => detail })
  await flush()
  assert.equal(find(plain.render(), node => node.props?.className === 'margin-reader__annotations'), undefined)
  plain.unmount()

  const seen = []
  const Panel = props => { seen.push(props); return null }
  const face = { ...fixture().api, Panel }
  const nested = readerHarness()
  nested.render({ candidate, t, onBack() {}, loadCandidate: async () => detail, annotations: face })
  await flush()
  const tree = nested.render()
  const injected = find(tree, node => node.type === Panel)
  assert.ok(injected, 'the reader must nest the injected panel')
  injected.type(injected.props)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].api, face, 'the panel receives the narrow annotation face')
  assert.equal(seen[0].candidateId, 7)
  assert.equal(seen[0].marginUrl, candidate.marginUrl)
  assert.equal(typeof seen[0].readSelection, 'function', 'the panel must reuse the reader selection closure')
  assert.equal(seen[0].t, t)
  const article = find(tree, node => node.type === 'article')
  const body = find(tree, node => node.type === 'section' && node.props?.['aria-label'] === t('reader.body'))
  const flat = nodes(article)
  assert.ok(flat.includes(injected))
  assert.ok(flat.indexOf(body) < flat.indexOf(injected), 'the panel sits after the article body')

  // A face without Panel is "not installed": nothing renders.
  const bare = readerHarness()
  bare.render({ candidate, t, onBack() {}, loadCandidate: async () => detail, annotations: fixture().api })
  await flush()
  assert.equal(find(bare.render(), node => node.props?.className === 'margin-reader__annotations'), undefined)
  nested.unmount()
  bare.unmount()
})

test('the reader and list keep type-only imports and pass the face through', () => {
  const reader = readFileSync(new URL('../src/client/ArticleReader.tsx', import.meta.url), 'utf8')
  assert.match(reader, /import type \{ AnnotationApi, AnnotationPanelProps \} from '\.\/annotationModel\.ts'/)
  assert.doesNotMatch(reader, /import \{[^}]*\} from '\.\/annotationModel\.ts'/)
  assert.doesNotMatch(reader, /from '\.\/AnnotationPanel\.tsx'/)
  assert.match(reader, /annotations\?\.Panel/)

  const list = readFileSync(new URL('../src/client/ReadingList.tsx', import.meta.url), 'utf8')
  assert.match(list, /annotations\?: AnnotationApi/)
  assert.match(list, /annotations=\{annotations\}/)
  assert.doesNotMatch(list, /from '\.\/AnnotationPanel\.tsx'/)
})

test('client wiring exposes only the annotation methods plus Panel', () => {
  const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('annotations: {')
  const end = source.indexOf('imports: {')
  assert.ok(start >= 0 && end > start)
  const block = source.slice(start, end)
  for (const method of ['loadAnnotations', 'createHighlight', 'linkHighlight', 'deleteHighlight', 'createNote', 'updateNote', 'deleteNote']) {
    assert.match(block, new RegExp(method))
  }
  assert.match(block, /Panel: AnnotationPanel/)
  for (const forbidden of ['setCandidateStatus', 'loadCandidate', 'loadImports', 'importUrl', 'runAi', 'loadProgress', 'saveProgress', 'setSourceStatus']) {
    assert.equal(block.includes(forbidden), false, `annotation face must not expose ${forbidden}`)
  }
})

/* ------------------------------------------------------------------ *
 * Source hygiene.
 * ------------------------------------------------------------------ */

test('annotation client sources never touch browser storage, a URL or raw HTML', () => {
  for (const file of ['annotationModel.ts', 'AnnotationPanel.tsx']) {
    const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    for (const forbidden of [
      'localStorage', 'sessionStorage', 'indexedDB', 'dangerouslySetInnerHTML',
      'location.search', 'location.hash', 'location.href', 'history.pushState', 'history.replaceState',
      'document.cookie', 'new URL(',
    ]) assert.equal(source.includes(forbidden), false, `${file} must not use ${forbidden}`)
  }
  // The transport adds no storage/HTML and no annotation mutation query string.
  const api = readFileSync(new URL('../src/client/api.ts', import.meta.url), 'utf8')
  assert.equal(api.includes('localStorage'), false)
  assert.equal(api.includes('sessionStorage'), false)
  assert.equal(api.includes('dangerouslySetInnerHTML'), false)
  assert.equal(api.includes('new URL('), false)
  const annotationCalls = api.slice(api.indexOf('async loadAnnotations'), api.lastIndexOf('}'))
  assert.equal(annotationCalls.includes('query('), true, 'the GET is the only query-string call')
  for (const mutation of ['highlight-create', 'highlight-link', 'highlight-delete', 'note-create', 'note-update', 'note-delete']) {
    const at = api.indexOf(`'/${mutation}'`)
    assert.ok(at > 0, mutation)
    assert.equal(api.slice(at, at + 120).includes('query('), false, `${mutation} must not build a query string`)
  }
  // Scope that rule to the added section: the rest of api.ts legitimately has
  // status/import/AI/progress routes that annotations must not reach.
  const annotationSection = api.slice(api.indexOf('async loadAnnotations'), api.indexOf('async loadAiCapability'))
  for (const forbidden of ['candidate-status', 'ai-run', 'import-url', 'saveToTrilium', 'progressModel', 'runAi']) {
    assert.equal(annotationSection.includes(forbidden), false, `annotation API must not add ${forbidden}`)
  }
})

test('the panel and model never mention status, save, import or AI endpoints', () => {
  for (const file of ['annotationModel.ts', 'AnnotationPanel.tsx']) {
    const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    for (const forbidden of ['candidate-status', 'ai-capability', 'ai-run', 'import-url', 'isSavedToTrilium', 'saveProgress', 'progressModel', 'Trilium']) {
      assert.equal(source.includes(forbidden), false, `${file} must not reference ${forbidden}`)
    }
  }
})
