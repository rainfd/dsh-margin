import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import ts from 'typescript'

// Compile the pure model and real API, independently of the coordinated bundle build.
const temp = mkdtempSync(join(tmpdir(), 'dsh-margin-reader-'))
after(() => rmSync(temp, { recursive: true, force: true }))
writeFileSync(join(temp, 'package.json'), '{"type":"module"}')
execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
  '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext',
  '--skipLibCheck', '--rewriteRelativeImportExtensions', '--rootDir', 'src', '--outDir', temp,
  'src/client/readerModel.ts', 'src/client/importModel.ts', 'src/client/api.ts'], { cwd: resolve('.'), stdio: 'pipe' })
const model = await import(pathToFileURL(join(temp, 'client/readerModel.js')))
const apiModule = await import(pathToFileURL(join(temp, 'client/api.js')))
const importModel = await import(pathToFileURL(join(temp, 'client/importModel.js')))
const { safeMarginUrl, selectReaderBody, requestReaderDetail } = model
const { MarginApi, MarginApiError } = apiModule
const require = createRequire(import.meta.url)
const jsxRuntime = require('react/jsx-runtime')
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const candidate = { status: 'unprocessed', sourceUrl: 'https://example.com/article', category: null, tags: [], isSavedToTrilium: false, updatedAt: '', id: 7, title: 'Article', sourceDomain: 'example.com', sourceType: 'rss', createdAt: '', author: null, marginUrl: 'https://margin.example/candidate/7', summary: 'excerpt', summaryText: 'summary' }
const detail = { ...candidate, contentMd: '# Body', contentText: 'plain', contentFetchFailed: false }
const readingView = (overrides = {}) => ({ items: [candidate], total: 1, breakdown: [{ sourceType: 'rss', count: 1 }], page: 1, pageSize: 30, totalPages: 1, scannedTotal: 1, upstreamTotal: 1, totalExact: true, truncated: false, writesAllowed: true, applied: { status: 'unprocessed', sourceType: null, query: null, limit: 30 }, ...overrides })
const acknowledgement = status => ({ id: 7, status, isSavedToTrilium: false, updatedAt: '2026-10-25' })
const t = key => key

// Minimal deterministic hook driver: tests real component event handlers/effects and
// React element output without installing a DOM or a second React renderer.
// It does not claim browser layout, real DOM focus, or Markdown renderer coverage.
function componentHarness(file, name) {
  const cells = []
  let index = 0, effects = [], tree, props
  const changed = (a, b) => !a || a.length !== b.length || a.some((v, i) => v !== b[i])
  const hooks = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next }] },
    useRef(initial) { const i = index++; cells[i] ??= { current: initial }; return cells[i] },
    useEffect(effect, deps) { const i = index++; if (changed(cells[i]?.deps, deps)) effects.push(() => { cells[i]?.cleanup?.(); cells[i] = { deps, cleanup: effect() } }) },
    useMemo(factory, deps) { const i = index++; if (changed(cells[i]?.deps, deps)) cells[i] = { deps, value: factory() }; return cells[i].value },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps) },
  }
  const MarkdownText = () => null
  const MarkdownDelegateProvider = () => null
  const mocks = {
    react: hooks, 'react/jsx-runtime': jsxRuntime,
    '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText, MarkdownDelegateProvider },
    './api.ts': apiModule, './readerModel.ts': model,
    './readingStyles.ts': { readingStyles: '' },
    './ArticleReader.tsx': { ArticleReader: function ArticleReader() {} },
    './ImportPanel.tsx': { ImportPanel: function ImportPanel() {} },
    './SourcePanel.tsx': { SourcePanel: function SourcePanel() {} },
    './importModel.ts': importModel,
  }
  const output = ts.transpileModule(readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(id => { if (!(id in mocks)) throw new Error(`Unmocked import ${id}`); return mocks[id] }, module, module.exports)
  return {
    MarkdownText, MarkdownDelegateProvider,
    render(next = props) { props = next; index = 0; effects = []; tree = module.exports[name](props); effects.forEach(run => run()); return tree },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  // Item/Chip have no hooks. Expand them so we can click real list controls.
  if (typeof tree.type === 'function' && ['Item', 'Chip'].includes(tree.type.name)) return nodes(tree.type(tree.props))
  return [tree, ...nodes(tree.props?.children)]
}
const find = (tree, predicate) => nodes(tree).find(predicate)
const button = (tree, label) => find(tree, node => node.type === 'button' && node.props.children === label)
const containsText = (tree, text) => nodes(tree).some(node => node.props?.children === text)

test('body selection prioritizes Markdown, preserves plain text and never substitutes summary', () => {
  assert.deepEqual(selectReaderBody(detail), { kind: 'markdown', text: '# Body' })
  assert.deepEqual(selectReaderBody({ ...detail, contentMd: ' \n', contentText: '<b>not HTML</b>\n**not markdown**' }), { kind: 'text', text: '<b>not HTML</b>\n**not markdown**' })
  assert.deepEqual(selectReaderBody({ ...detail, contentMd: '', contentText: '  ' }), { kind: 'empty', text: '' })
})

test('fallback URLs accept absolute HTTP(S) only', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', '//evil.test', '/relative', '', 'mailto:a@b']) assert.equal(safeMarginUrl(value), null, value)
  assert.equal(safeMarginUrl('https://margin.example/a?q=7'), 'https://margin.example/a?q=7')
  assert.equal(safeMarginUrl('http://localhost:3000/'), 'http://localhost:3000/')
})

test('request cleanup ignores late success and failure; a new request still completes', async () => {
  const old = deferred(), current = deferred(), failed = deferred(), values = []
  const stop = requestReaderDetail(() => old.promise, v => values.push(v), e => values.push(e))
  const stopFailure = requestReaderDetail(() => failed.promise, v => values.push(v), e => values.push(e))
  stop(); stopFailure()
  requestReaderDetail(() => current.promise, v => values.push(v), e => values.push(e))
  current.resolve('current'); old.resolve('stale'); failed.reject(new Error('stale failure'))
  await flush()
  assert.deepEqual(values, ['current'])
})

test('API issues GET detail and preserves HTTP status for JSON and non-JSON 404', async () => {
  const original = globalThis.fetch
  try {
    const calls = []
    globalThis.fetch = async (...args) => { calls.push(args); return new Response(JSON.stringify(detail)) }
    assert.deepEqual(await new MarginApi().loadCandidate(7), detail)
    assert.deepEqual(calls, [['/api/dsh-margin/candidate?id=7']])
    for (const body of ['{"error":{"message":"gone"}}', 'not JSON']) {
      globalThis.fetch = async () => new Response(body, { status: 404 })
      await assert.rejects(new MarginApi().loadCandidate(7), error => error instanceof MarginApiError && error.status === 404)
    }
  } finally { globalThis.fetch = original }
})

test('reader lazily loads, distinguishes Markdown/text/summary/empty and warning', async () => {
  const h = componentHarness('ArticleReader.tsx', 'ArticleReader')
  let calls = 0, result = detail
  const props = { candidate, t, onBack() {}, loadCandidate: async () => { calls++; return result } }
  let tree = h.render(props)
  assert.equal(calls, 0)
  assert.ok(containsText(tree, 'reader.loading'))
  await flush(); tree = h.render()
  assert.equal(calls, 1)
  const markdown = find(tree, node => node.type === h.MarkdownText)
  assert.equal(markdown.props.text, '# Body')
  assert.deepEqual(Object.keys(markdown.props).sort(), ['labels', 'text', 'variant'])
  const delegate = find(tree, node => node.type === h.MarkdownDelegateProvider)
  assert.deepEqual(Object.keys(delegate.props), ['children'])
  assert.equal(delegate.props.children, markdown)
  assert.ok(containsText(tree, 'reader.summary'))
  result = { ...detail, id: 8, contentMd: '', contentText: '<script>literal</script>\n**plain**', contentFetchFailed: true }
  h.render({ ...props, candidate: { ...candidate, id: 8 } }); await flush(); tree = h.render()
  assert.equal(find(tree, node => node.type === h.MarkdownText), undefined)
  assert.ok(containsText(tree, result.contentText))
  assert.ok(containsText(tree, 'reader.fetchFailed'))
  result = { ...result, id: 9, contentText: '' }
  h.render({ ...props, candidate: { ...candidate, id: 9 } }); await flush(); tree = h.render()
  assert.ok(containsText(tree, 'reader.noBody'))
  assert.ok(containsText(tree, 'summary'))
  h.unmount()
})

test('reader 404, retry and back work, and stale loads cannot replace a changed item', async () => {
  const h = componentHarness('ArticleReader.tsx', 'ArticleReader')
  const old = deferred(); let calls = 0, back = 0
  const props = { candidate, t, onBack: () => back++, loadCandidate: async id => { calls++; if (id === 7) return old.promise; if (calls === 2) throw new MarginApiError('gone', 404); return { ...detail, id, title: 'Current' } } }
  h.render(props); await flush()
  h.render({ ...props, candidate: { ...candidate, id: 8 } }); await flush()
  let tree = h.render()
  assert.ok(containsText(tree, 'reader.notFound'))
  button(tree, 'list.retry').props.onClick(); h.render(); await flush(); tree = h.render()
  assert.ok(containsText(tree, 'Current'))
  old.resolve({ ...detail, title: 'Stale' }); await flush(); tree = h.render()
  assert.equal(containsText(tree, 'Stale'), false)
  button(tree, 'reader.back').props.onClick(); assert.equal(back, 1)
  h.unmount()
})

test('reader generic failures can retry; unmount suppresses pending completions', async () => {
  const h = componentHarness('ArticleReader.tsx', 'ArticleReader')
  const pending = deferred(); let calls = 0
  h.render({ candidate, t, onBack() {}, loadCandidate: () => { calls++; return calls === 1 ? Promise.reject(new Error('offline')) : pending.promise } })
  await flush(); let tree = h.render()
  assert.ok(containsText(tree, 'reader.loadFailed'))
  button(tree, 'list.retry').props.onClick(); h.render(); await flush()
  assert.ok(containsText(h.render(), 'reader.loading'))
  h.unmount(); pending.resolve(detail); await flush()
  // With no live effect, a late result must not transition state to ready.
  assert.ok(containsText(h.render(), 'reader.loading'))
})

test('reader distinguishes auth/timeouts and refuses same-ID detail from another instance', async () => {
  for (const [status, label] of [[401, 'reader.unauthorized'], [403, 'reader.unauthorized'], [504, 'reader.timeout']]) {
    const h = componentHarness('ArticleReader.tsx', 'ArticleReader')
    h.render({ candidate, t, onBack() {}, loadCandidate: async () => { throw new MarginApiError('failure', status) } })
    await flush()
    assert.ok(containsText(h.render(), label))
    h.unmount()
  }
  for (const wrongDetail of [{ ...detail, marginUrl: 'https://another-instance.example/reader/7' }, { ...detail, id: 99 }]) {
    const h = componentHarness('ArticleReader.tsx', 'ArticleReader')
    h.render({ candidate, t, onBack() {}, loadCandidate: async () => wrongDetail })
    await flush()
    const tree = h.render()
    assert.ok(containsText(tree, 'reader.instanceChanged'))
    assert.equal(find(tree, node => node.type === h.MarkdownText), undefined)
    h.unmount()
  }
})

test('the reader nests the optional save panel only when the face is present', async () => {
  const h = componentHarness('ArticleReader.tsx', 'ArticleReader')
  const Panel = function SavePanel() { return null }
  const base = { candidate, t, onBack() {}, loadCandidate: async () => detail }
  h.render(base); await flush()
  assert.equal(find(h.render(), node => node.type === Panel), undefined)
  h.render({ ...base, save: { loadSaveState: async () => ({}), saveToTrilium: async () => ({}), Panel } }); await flush()
  const element = find(h.render(), node => node.type === Panel)
  assert.ok(element, 'an injected save panel must be rendered')
  assert.equal(element.props.candidateId, 7)
  assert.equal(element.props.marginUrl, candidate.marginUrl)
  h.unmount()
})

test('list primary action opens same-view reader while preserving mounted filters and safe fallback', async () => {
  const h = componentHarness('ReadingList.tsx', 'ReadingList')
  let listCalls = 0, detailCalls = 0
  const props = { t, loadCandidate: async () => { detailCalls++; return detail }, loadList: async () => { listCalls++; return readingView({ items: [candidate, { ...candidate, id: 9, marginUrl: 'javascript:alert(1)' }], total: 2, breakdown: [{ sourceType: 'rss', count: 2 }] }) } }
  h.render(props); await flush(); let tree = h.render()
  assert.equal(detailCalls, 0)
  const search = find(tree, node => node.type === 'input')
  search.props.onChange({ target: { value: 'my filter' } }); tree = h.render()
  const chip = find(tree, node => node.type === 'button' && node.props['aria-pressed'] === false)
  chip.props.onClick(); tree = h.render(); await flush(); tree = h.render()
  assert.equal(nodes(tree).filter(node => node.type === 'a').length, 1)
  let focusCount = 0
  button(tree, 'list.read').props.onClick({ currentTarget: { focus() { focusCount++ } } })
  tree = h.render()
  const reader = find(tree, node => typeof node.type === 'function' && node.type.name === 'ArticleReader')
  assert.ok(reader)
  assert.equal(reader.props.candidate.id, 7)
  assert.equal(find(tree, node => node.props.className === 'margin-reading__viewport').props.hidden, true)
  assert.equal(find(tree, node => node.type === 'input').props.value, 'my filter')
  const beforeBack = listCalls
  reader.props.onBack(); tree = h.render()
  assert.equal(find(tree, node => node.props.className === 'margin-reading__viewport').props.hidden, false)
  assert.equal(find(tree, node => node.type === 'input').props.value, 'my filter')
  assert.ok(find(tree, node => node.type === 'button' && node.props['aria-pressed'] === true && Array.isArray(node.props.children)))
  assert.equal(listCalls, beforeBack)
  assert.equal(detailCalls, 0) // Child owns fetching, never the list action.
  assert.equal(focusCount, 1)
  h.unmount()
})

test('imported article opens are instance-bound and a late earlier open cannot replace the latest', async () => {
  const h = componentHarness('ReadingList.tsx', 'ReadingList')
  const instance = 'https://margin.example'
  const a = deferred(), b = deferred()
  const first = { ...detail, id: 7, marginUrl: instance + '/reader/7' }
  const second = { ...detail, id: 8, marginUrl: instance + '/reader/8' }
  const imports = { loadImports: async () => ({ instanceUrl: instance }) }
  h.render({ t, imports, loadCandidate: id => id === 7 ? a.promise : b.promise, loadList: async () => readingView() })
  await flush()
  let tree = h.render()
  const panel = find(tree, node => typeof node.type === 'function' && node.type.name === 'ImportPanel')
  const pendingFirst = panel.props.onOpen(first, instance)
  const pendingSecond = panel.props.onOpen(second, instance)
  b.resolve(second); await pendingSecond
  tree = h.render()
  assert.equal(find(tree, node => typeof node.type === 'function' && node.type.name === 'ArticleReader').props.candidate.id, 8)
  a.resolve(first); await pendingFirst
  tree = h.render()
  assert.equal(find(tree, node => typeof node.type === 'function' && node.type.name === 'ArticleReader').props.candidate.id, 8)
  await assert.rejects(panel.props.onOpen({ ...first, marginUrl: 'https://another.example/reader/7' }, instance), /实例/)
  h.unmount()
})

test('API sends explicit PATCH target, instance URL and paginated filters', async () => {
  const original = globalThis.fetch
  try {
    const calls = []
    globalThis.fetch = async (...args) => { calls.push(args); return new Response(JSON.stringify(acknowledgement('read'))) }
    assert.deepEqual(await new MarginApi().setCandidateStatus(7, 'read', candidate.marginUrl), acknowledgement('read'))
    assert.equal(calls[0][0], '/api/dsh-margin/candidate-status')
    assert.equal(calls[0][1].method, 'PATCH')
    assert.deepEqual(JSON.parse(calls[0][1].body), { id: 7, status: 'read', marginUrl: candidate.marginUrl })
    await new MarginApi().loadReadingList({ status: 'read', sourceType: 'rss', q: 'hello world', limit: 30, page: 3 })
    assert.equal(calls[1][0], '/api/dsh-margin/candidates?status=read&sourceType=rss&q=hello+world&limit=30&page=3')
  } finally { globalThis.fetch = original }
})

test('reader default deny and processing/error states never write on open or scroll', async () => {
  for (const status of ['unprocessed', 'read', 'processing', 'error']) {
    const h = componentHarness('ArticleReader.tsx', 'ArticleReader')
    let writes = 0
    const props = { candidate, t, onBack() {}, loadCandidate: async () => ({ ...detail, status }), setCandidateStatus: async () => { writes++; return acknowledgement('read') } }
    h.render(props); await flush(); let tree = h.render()
    assert.equal(writes, 0)
    assert.equal(find(tree, n => n.props.onScroll), undefined)
    const action = button(tree, status === 'read' ? 'reader.markUnread' : 'reader.markRead')
    if (status === 'processing' || status === 'error') assert.equal(action, undefined)
    else { assert.equal(action.props.disabled, true); await action.props.onClick(); assert.equal(writes, 0) }
    h.unmount()
  }
})

test('reader locks rapid clicks, sends idempotent target and rereads before changing status', async () => {
  const h = componentHarness('ArticleReader.tsx', 'ArticleReader')
  const patch = deferred(), reread = deferred(), calls = [], updates = []
  let loads = 0
  const props = { candidate, t, onBack() {}, writesAllowed: true,
    loadCandidate: () => ++loads === 1 ? Promise.resolve(detail) : reread.promise,
    setCandidateStatus: (...args) => { calls.push(args); return patch.promise }, onStatusChanged: update => updates.push(update) }
  h.render(props); await flush(); let tree = h.render()
  const action = button(tree, 'reader.markRead')
  const completing = action.props.onClick(); action.props.onClick()
  assert.deepEqual(calls, [[7, 'read', candidate.marginUrl]])
  tree = h.render(); assert.equal(button(tree, 'reader.saving').props.disabled, true)
  patch.resolve(acknowledgement('read')); await flush(); tree = h.render()
  assert.equal(updates.length, 1); assert.equal(loads, 2)
  assert.equal(button(tree, 'reader.markUnread'), undefined)
  reread.resolve({ ...detail, status: 'read' }); await completing
  tree = h.render(); assert.equal(button(tree, 'reader.markUnread').props.disabled, false)
  h.unmount()
})

test('read article explicitly writes unprocessed and pending reread cannot replace another article', async () => {
  const h = componentHarness('ArticleReader.tsx', 'ArticleReader'), reread = deferred(), calls = []
  let loads = 0, updates = 0
  const props = { candidate: { ...candidate, status: 'read' }, t, onBack() {}, writesAllowed: true,
    loadCandidate: async id => { if (++loads === 2) return reread.promise; return { ...detail, id, status: 'read' } },
    setCandidateStatus: async (...args) => { calls.push(args); return acknowledgement('unprocessed') }, onStatusChanged: () => updates++ }
  h.render(props); await flush(); const completion = button(h.render(), 'reader.markUnread').props.onClick()
  await flush(); assert.deepEqual(calls, [[7, 'unprocessed', candidate.marginUrl]]); assert.equal(updates, 1)
  h.render({ ...props, candidate: { ...candidate, id: 8 } }); await flush(); h.render()
  reread.resolve({ ...detail, title: 'Old reread', status: 'unprocessed' }); await completion
  const tree = h.render(); assert.equal(containsText(tree, 'Old reread'), false)
  assert.ok(button(tree, 'reader.markUnread')); h.unmount()
})

test('failed write is not optimistic or automatically resent; explicit retry retains target', async () => {
  const h = componentHarness('ArticleReader.tsx', 'ArticleReader')
  const calls = []; let loads = 0
  h.render({ candidate, t, onBack() {}, writesAllowed: true,
    loadCandidate: async () => { loads++; return detail },
    setCandidateStatus: async (...args) => { calls.push(args); throw new MarginApiError('offline', 503) } })
  await flush(); let tree = h.render()
  await button(tree, 'reader.markRead').props.onClick(); tree = h.render()
  assert.ok(containsText(tree, 'reader.writeFailed'))
  assert.equal(button(tree, 'reader.markUnread'), undefined)
  // The failure triggers exactly one read-only confirmation; the write is never resent.
  assert.equal(calls.length, 1); assert.equal(loads, 2)
  await flush(); h.render(); assert.equal(calls.length, 1)
  await button(tree, 'reader.markRead').props.onClick()
  assert.deepEqual(calls, [[7, 'read', candidate.marginUrl], [7, 'read', candidate.marginUrl]])
  button(h.render(), 'reader.reload').props.onClick(); h.render(); await flush(); h.render()
  assert.equal(loads, 4); assert.equal(calls.length, 2)
  h.unmount()
})

test('a failed write is confirmed as applied when the re-read shows the target', async () => {
  const h = componentHarness('ArticleReader.tsx', 'ArticleReader')
  let loads = 0, updates = 0
  h.render({ candidate, t, onBack() {}, writesAllowed: true,
    loadCandidate: async () => (++loads === 1 ? detail : { ...detail, status: 'read' }),
    setCandidateStatus: async () => { throw new MarginApiError('offline', 503) },
    onStatusChanged: () => updates++ })
  await flush(); let tree = h.render()
  await button(tree, 'reader.markRead').props.onClick(); tree = h.render()
  assert.equal(loads, 2, 'one read-only confirmation after the failed reply')
  assert.equal(updates, 1, 'the confirmed state refreshes the hidden list')
  assert.equal(containsText(tree, 'reader.writeFailed'), false)
  assert.ok(button(tree, 'reader.markUnread'), 'the confirmed write is reflected')
  h.unmount()
})

test('acknowledged write with failed or cross-instance reread is uncertain, not rollback', async () => {
  for (const wrongInstance of [false, true]) {
    const h = componentHarness('ArticleReader.tsx', 'ArticleReader')
    let loads = 0, writes = 0, updates = 0
    h.render({ candidate, t, onBack() {}, writesAllowed: true,
      loadCandidate: async () => { if (++loads === 2) { if (wrongInstance) return { ...detail, marginUrl: 'https://other.example/candidate/7' }; throw new Error('offline') }; return { ...detail, status: loads > 2 ? 'read' : 'unprocessed' } },
      setCandidateStatus: async () => { writes++; return acknowledgement('read') }, onStatusChanged: () => updates++ })
    await flush(); let tree = h.render(); await button(tree, 'reader.markRead').props.onClick(); tree = h.render()
    assert.ok(containsText(tree, 'reader.writeUncertain'))
    assert.equal(button(tree, 'reader.markRead').props.disabled, true)
    await button(tree, 'reader.markRead').props.onClick(); assert.equal(writes, 1); assert.equal(updates, 1)
    button(tree, 'reader.reload').props.onClick(); h.render(); await flush(); tree = h.render()
    assert.ok(button(tree, 'reader.markUnread')); assert.equal(writes, 1)
    h.unmount()
  }
})

test('write completions after unmount or same-ID instance change cannot update article or notify list', async () => {
  for (const unmount of [false, true]) {
    const h = componentHarness('ArticleReader.tsx', 'ArticleReader')
    const patch = deferred(); let updates = 0, loads = 0
    const props = { candidate, t, onBack() {}, writesAllowed: true,
      loadCandidate: async () => { loads++; return detail }, setCandidateStatus: () => patch.promise, onStatusChanged: () => updates++ }
    h.render(props); await flush(); const completion = button(h.render(), 'reader.markRead').props.onClick()
    if (unmount) h.unmount()
    else h.render({ ...props, candidate: { ...candidate, marginUrl: 'https://new.example/candidate/7' } })
    patch.resolve(acknowledgement('read')); await completion; await flush()
    assert.equal(updates, 0); assert.equal(loads, unmount ? 1 : 2)
    if (!unmount) assert.ok(containsText(h.render(), 'reader.instanceChanged'))
    h.unmount()
  }
})

test('permission revocation blocks even a previously captured enabled handler', async () => {
  const h = componentHarness('ArticleReader.tsx', 'ArticleReader'); let writes = 0
  const props = { candidate, t, onBack() {}, writesAllowed: true, loadCandidate: async () => detail, setCandidateStatus: async () => { writes++; return acknowledgement('read') } }
  h.render(props); await flush(); const action = button(h.render(), 'reader.markRead')
  h.render({ ...props, writesAllowed: false }); await action.props.onClick()
  assert.equal(writes, 0)
  h.unmount()
})

test('source and debounced query changes reset pagination to first page', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const h = componentHarness('ReadingList.tsx', 'ReadingList'), calls = []
  h.render({ t, loadCandidate: async () => detail, setCandidateStatus: async () => acknowledgement('read'),
    loadList: async options => { calls.push(options); return readingView({ page: options.page, totalPages: 5 }) } })
  await flush(); let tree = h.render()
  button(tree, 'list.next').props.onClick(); h.render(); await flush(); tree = h.render()
  assert.equal(calls.at(-1).page, 2)
  const source = find(tree, node => node.type === 'button' && Array.isArray(node.props.children) && node.props['aria-pressed'] === false)
  source.props.onClick(); h.render(); await flush(); tree = h.render()
  assert.equal(calls.at(-1).page, 1); assert.equal(calls.at(-1).sourceType, 'rss')
  button(tree, 'list.next').props.onClick(); h.render(); await flush(); tree = h.render()
  find(tree, node => node.type === 'input').props.onChange({ target: { value: '  search term  ' } }); h.render()
  const beforeDebounce = calls.length
  context.mock.timers.tick(299); h.render(); assert.equal(calls.length, beforeDebounce)
  context.mock.timers.tick(1); h.render(); await flush(); h.render()
  assert.equal(calls.at(-1).q, 'search term'); assert.equal(calls.at(-1).page, 1)
  h.unmount()
})

test('list pages from server page, resets filters, ignores stale requests and refreshes hidden counts', async () => {
  const h = componentHarness('ReadingList.tsx', 'ReadingList'), calls = [], pending = []
  const patch = async () => acknowledgement('read')
  const props = { t, loadCandidate: async () => detail, setCandidateStatus: patch,
    loadList: options => { calls.push(options); const request = deferred(); pending.push(request); return request.promise } }
  h.render(props)
  assert.deepEqual(calls[0], { status: 'unprocessed', sourceType: undefined, q: undefined, limit: 30, page: 1 })
  pending[0].resolve(readingView({ page: 2, totalPages: 4, totalExact: false, truncated: true })); await flush(); let tree = h.render()
  assert.ok(containsText(tree, 'list.partial'))
  button(tree, 'list.next').props.onClick(); h.render(); assert.equal(calls[1].page, 3)
  find(h.render(), node => node.type === 'select').props.onChange({ target: { value: 'read' } }); h.render()
  assert.equal(calls[2].page, 1); assert.equal(calls[2].status, 'read')
  pending[2].resolve(readingView({ items: [{ ...candidate, title: 'Latest' }], writesAllowed: false })); await flush(); tree = h.render()
  pending[1].resolve(readingView({ items: [{ ...candidate, title: 'Stale' }] })); await flush(); tree = h.render()
  assert.ok(containsText(tree, 'Latest')); assert.equal(containsText(tree, 'Stale'), false)
  button(tree, 'list.read').props.onClick({ currentTarget: { focus() {} } }); tree = h.render()
  let reader = find(tree, node => node.type.name === 'ArticleReader')
  assert.equal(reader.props.writesAllowed, false); assert.equal(reader.props.setCandidateStatus, patch)
  reader.props.onStatusChanged(acknowledgement('read')); h.render(); assert.equal(calls.length, 4)
  pending[3].resolve(readingView({ items: [], total: 0, writesAllowed: true })); await flush(); tree = h.render()
  reader = find(tree, node => node.type.name === 'ArticleReader')
  assert.equal(reader.props.writesAllowed, true)
  assert.equal(find(tree, node => node.props.className === 'margin-reading__viewport').props.hidden, true)
  reader.props.onBack(); tree = h.render(); assert.equal(containsText(tree, 'Latest'), false)
  h.unmount()
})
