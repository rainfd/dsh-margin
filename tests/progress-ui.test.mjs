import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

// Compile only the pure browser progress model and the API client — not a bundle build.
const temp = mkdtempSync(join(tmpdir(), 'dsh-margin-progress-ui-'))
after(() => rmSync(temp, { recursive: true, force: true }))
writeFileSync(join(temp, 'package.json'), '{"type":"module"}')
execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', '--rewriteRelativeImportExtensions', '--rootDir', 'src', '--outDir', temp, 'src/client/progressModel.ts', 'src/client/readerModel.ts', 'src/client/api.ts'], { stdio: 'pipe' })
const progressModel = await import(pathToFileURL(join(temp, 'client/progressModel.js')))
const readerModel = await import(pathToFileURL(join(temp, 'client/readerModel.js')))
const { MarginApi, MarginApiError } = await import(pathToFileURL(join(temp, 'client/api.js')))
const {
  MAX_TOC_ENTRIES, PROGRESS_LOOKUP_LIMIT,
  contentVersion, instanceFromMarginUrl, progressLabel, readingRatio, restorePlan, shouldPersist, tocFromMarkdown,
} = progressModel

const require = createRequire(import.meta.url)
const jsxRuntime = require('react/jsx-runtime')
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const t = key => key
const INSTANCE = 'https://margin.example'
const candidate = { status: 'unprocessed', sourceUrl: 'https://example.com/a', category: null, tags: [], isSavedToTrilium: false, updatedAt: '', id: 7, title: 'Article', sourceDomain: 'example.com', sourceType: 'rss', createdAt: '', author: null, marginUrl: INSTANCE + '/reader/7', summary: 'excerpt', summaryText: 'summary' }
const bodyText = '# Body\n\nParagraph one.\n\n## Section\n\nParagraph two.\n\n### Deep\n\nTail.'
const detail = { ...candidate, contentMd: bodyText, contentText: 'plain fallback', contentFetchFailed: false }
const versionOf = source => contentVersion(source)
const entry = (overrides = {}) => ({
  key: `${INSTANCE}|7|${versionOf(detail)}`, instanceUrl: INSTANCE, candidateId: 7, contentVersion: versionOf(detail),
  title: 'Article', ratio: 0.4, scrollTop: 0, anchor: '', openedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...overrides,
})
const progressView = (entries = []) => ({ observedAt: '2026-10-01T00:00:00Z', maxEntries: 500, ttlDays: 180, total: entries.length, entries })
const acknowledgement = status => ({ id: 7, status, isSavedToTrilium: false, updatedAt: '2026-10-25' })
const readingView = (overrides = {}) => ({ instanceUrl: INSTANCE, items: [candidate], total: 1, breakdown: [{ sourceType: 'rss', count: 1 }], page: 1, pageSize: 30, totalPages: 1, scannedTotal: 1, upstreamTotal: 1, totalExact: true, truncated: false, writesAllowed: true, applied: { status: 'unprocessed', sourceType: null, query: null, limit: 30 }, ...overrides })
const progressFace = (overrides = {}) => ({
  loadProgress: async () => progressView([]),
  saveProgress: async input => ({ entry: entry({ ...input }) }),
  clearProgress: async () => ({ removed: 0, scope: 'all', marginUntouched: true }),
  ...overrides,
})

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  // Item/Chip are plain function components with no hooks; expand them too.
  if (typeof tree.type === 'function' && ['Item', 'Chip'].includes(tree.type.name)) return nodes(tree.type(tree.props))
  return [tree, ...nodes(tree.props?.children)]
}
const find = (tree, predicate) => nodes(tree).find(predicate)
const button = (tree, label) => find(tree, node => node.type === 'button' && node.props?.children === label)
const containsText = (tree, text) => nodes(tree).some(node => node.props?.children === text)
const hasClass = (tree, className) => find(tree, node => String(node.props?.className ?? '').split(/\s+/).includes(className)) !== undefined

// Minimal deterministic hook driver with React-style ref assignment before
// effects. Not a real DOM: layout, scrollIntoView and TreeWalker behavior are
// simulated by plain objects supplied per test.
function componentHarness(file, name, mocks, refs = {}) {
  const cells = []
  let index = 0, effects = [], props, tree
  const changed = (a, b) => !a || a.length !== b.length || a.some((value, at) => value !== b[at])
  const hooks = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next }] },
    useRef(initial) { const i = index++; cells[i] ??= { current: initial }; return cells[i] },
    useEffect(effect, deps) { const i = index++; if (changed(cells[i]?.deps, deps)) effects.push(() => { cells[i]?.cleanup?.(); cells[i] = { deps, cleanup: effect() } }) },
    useMemo(factory, deps) { const i = index++; if (changed(cells[i]?.deps, deps)) cells[i] = { deps, value: factory() }; return cells[i].value },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps) },
  }
  const output = ts.transpileModule(readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(id => {
    if (id === 'react') return hooks
    if (id === 'react/jsx-runtime') return jsxRuntime
    if (!(id in mocks)) throw new Error(`Unmocked import ${id}`)
    return mocks[id]
  }, module, module.exports)
  return {
    module,
    render(next = props) {
      props = next; index = 0; effects = []
      tree = module.exports[name](props)
      // React assigns refs before passive effects; mirror that for fake nodes.
      for (const node of nodes(tree)) {
        const ref = node.ref
        if (ref === null || typeof ref !== 'object') continue
        const classes = String(node.props?.className ?? '').split(/\s+/)
        if (classes.includes('margin-reader')) ref.current = refs.article ?? null
        else if (classes.includes('margin-reader__body')) ref.current = refs.body ?? null
      }
      effects.forEach(run => run())
      return tree
    },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}

function readerHarness(refs = {}) {
  return componentHarness('ArticleReader.tsx', 'ArticleReader', {
    '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: function MarkdownText() { return null }, MarkdownDelegateProvider: function MarkdownDelegateProvider() { return null } },
    './api.ts': { MarginApiError },
    './readerModel.ts': readerModel,
    './readingStyles.ts': { readingStyles: '' },
  }, refs)
}

function fakeScroller({ scrollTop = 0, clientHeight = 500, scrollHeight = 1500 } = {}) {
  const listeners = new Map()
  return {
    scrollTop, clientHeight, scrollHeight,
    addEventListener(type, handler) { listeners.set(type, handler) },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type) },
    fire(type) { listeners.get(type)?.() },
    listenerCount() { return listeners.size },
  }
}
const fakeArticle = scroller => ({ closest: selector => selector === '.margin-reading__viewport' ? scroller : null })

/** Render, let the detail load, then render again so ready-state effects run. */
async function settle(harness, props) {
  let tree = harness.render(props)
  await flush()
  tree = harness.render()
  await flush()
  return harness.render()
}

test('contentVersion is stable for one body and changes when the rendered body changes', () => {
  const base = { title: 'T', contentMd: '# A\n\nhello', contentText: 'plain' }
  const value = contentVersion(base)
  assert.equal(value, contentVersion({ ...base }))
  assert.match(value, /^m[0-9a-z]+-[0-9a-z]+$/)
  assert.ok(value.length <= 64)
  // A same-length edit inside the hashed prefix still changes the version.
  assert.notEqual(value, contentVersion({ ...base, contentMd: '# A\n\nhellO' }))
  assert.notEqual(value, contentVersion({ ...base, contentMd: '# A\n\nhello\nmore' }))
  assert.notEqual(value, contentVersion({ ...base, contentMd: '# A\n\nhello', title: 'Other' }))
  // Markdown and plain text render differently even with identical text.
  assert.notEqual(contentVersion({ title: 'T', contentMd: '', contentText: '# A\n\nhello' }), contentVersion(base))
  assert.match(contentVersion({ title: 'T', contentMd: '', contentText: '# A\n\nhello' }), /^t[0-9a-z]+-/)
  // Text is ignored while Markdown is present: that text is not rendered.
  assert.equal(contentVersion({ ...base, contentText: 'unused' }), contentVersion({ ...base }))
  // A body past the hashed prefix only moves the version through its length.
  const long = 'x'.repeat(progressModel.VERSION_HASH_CHARS + 50)
  assert.notEqual(contentVersion({ title: 'T', contentMd: long, contentText: '' }), contentVersion({ title: 'T', contentMd: long + 'y', contentText: '' }))
})

test('contentVersion follows the reader\'s own body selection rule', () => {
  const cases = [
    { title: 'T', contentMd: '# Md', contentText: 'text' },
    { title: 'T', contentMd: '   ', contentText: 'text' },
    { title: 'T', contentMd: '', contentText: '  ' },
  ]
  for (const source of cases) {
    const selected = readerModel.selectReaderBody(source)
    const prefix = selected.kind === 'markdown' ? 'm' : selected.kind === 'text' ? 't' : 'e'
    assert.equal(contentVersion(source)[0], prefix)
  }
  assert.notEqual(contentVersion({ title: 'T', contentMd: '  ', contentText: 'alpha' }), contentVersion({ title: 'T', contentMd: '  ', contentText: 'beta' }))
})

test('tocFromMarkdown extracts ATX/setext headings, ignores code and cleans labels', () => {
  const markdown = [
    'Intro text',
    '',
    '# One',
    '## Two *em* and `code` and [link](https://example.com/x)',
    '```js',
    '# not a heading',
    '```',
    '~~~',
    '## also not',
    '~~~',
    '````',
    '```',
    '# still code',
    '````',
    'Setext title',
    '------------',
    '### Three',
    '#### Four',
    '##### Five',
    '###### Six',
    '####### Seven',
    '`# only inline code`',
    '# ',
  ].join('\n')
  const toc = tocFromMarkdown(markdown)
  assert.deepEqual(toc.map(item => [item.depth, item.text]), [
    [1, 'One'],
    [2, 'Two em and code and link'],
    [2, 'Setext title'],
    [3, 'Three'],
    [4, 'Four'],
    [5, 'Five'],
    [6, 'Six'],
  ])
  assert.equal(toc[0].index, markdown.indexOf('# One'))
  assert.equal(toc[2].index, markdown.indexOf('Setext title'))
  // Offsets are strictly increasing in document order.
  assert.ok(toc.every((item, at) => at === 0 || item.index > toc[at - 1].index))
  assert.deepEqual(tocFromMarkdown(''), [])
  assert.deepEqual(tocFromMarkdown('no headings here'), [])
})

test('tocFromMarkdown caps entries at MAX_TOC_ENTRIES', () => {
  const markdown = Array.from({ length: MAX_TOC_ENTRIES + 60 }, (_, at) => `# H${at}`).join('\n\n')
  const toc = tocFromMarkdown(markdown)
  assert.equal(toc.length, MAX_TOC_ENTRIES)
  assert.equal(toc[0].text, 'H0')
  assert.equal(toc.at(-1).text, `H${MAX_TOC_ENTRIES - 1}`)
})

test('readingRatio clamps and treats fitting content as bottom, not "read"', () => {
  assert.equal(readingRatio(0, 500, 1500), 0)
  assert.equal(readingRatio(500, 500, 1500), 0.5)
  assert.equal(readingRatio(1000, 500, 1500), 1)
  assert.equal(readingRatio(9999, 500, 1500), 1)
  assert.equal(readingRatio(-50, 500, 1500), 0)
  assert.equal(readingRatio(0, 800, 800), 1)
  assert.equal(readingRatio(0, 800, 200), 1)
  assert.equal(readingRatio(Number.NaN, 500, 1500), 0)
  assert.equal(readingRatio(10, Number.POSITIVE_INFINITY, 1500), 0)
})

test('shouldPersist throttles writes by ratio delta and elapsed time', () => {
  assert.equal(shouldPersist(null, { ratio: 0.1, at: 1000 }), true)
  assert.equal(shouldPersist({ ratio: 0.1, at: 1000 }, { ratio: 0.105, at: 2000 }), false)
  assert.equal(shouldPersist({ ratio: 0.1, at: 1000 }, { ratio: 0.2, at: 2000 }), true)
  assert.equal(shouldPersist({ ratio: 0.1, at: 1000 }, { ratio: 0.1, at: 7000 }), true)
  assert.equal(shouldPersist({ ratio: 0.1, at: 1000 }, { ratio: Number.NaN, at: 7000 }), false)
  assert.equal(shouldPersist({ ratio: 0.1, at: Number.NaN }, { ratio: 0.1, at: 2000 }), true)
  assert.equal(shouldPersist({ ratio: 0.1, at: 1000 }, { ratio: 0.3, at: 1000 }, 0.5, 5000), false)
})

test('restorePlan refuses missing, changed and zero positions and never claims exactness', () => {
  assert.equal(restorePlan(null, 'v').restore, false)
  assert.equal(restorePlan(undefined, 'v').reason, 'no-entry')
  assert.deepEqual(restorePlan(entry({ contentVersion: 'old' }), versionOf(detail)), { restore: false, ratio: 0, approximate: false, reason: 'version-mismatch' })
  assert.equal(restorePlan(entry({ ratio: 0 }), versionOf(detail)).restore, false)
  assert.equal(restorePlan(entry({ ratio: Number.NaN }), versionOf(detail)).restore, false)
  assert.deepEqual(restorePlan(entry(), versionOf(detail)), { restore: true, ratio: 0.4, approximate: true })
  const bottom = restorePlan(entry({ ratio: 1 }), versionOf(detail))
  assert.equal(bottom.restore, true)
  assert.equal(bottom.approximate, true)
})

test('progressLabel never claims completion or 100% before the bottom', () => {
  assert.equal(progressLabel(0.42), '已读约 42%')
  assert.equal(progressLabel(0), '已读约 0%')
  assert.equal(progressLabel(0.999), '已读约 99%')
  assert.equal(progressLabel(1), '已到文末（未标记为已读）')
  for (const ratio of [0, 0.1, 0.42, 0.999, 1]) {
    const label = progressLabel(ratio)
    assert.doesNotMatch(label, /已读完|已完成|100%/)
  }
})

test('instanceFromMarginUrl derives the exact base and refuses anything else', () => {
  assert.equal(instanceFromMarginUrl(INSTANCE + '/reader/7', 7), INSTANCE)
  assert.equal(instanceFromMarginUrl('https://margin.example/app/reader/7', 7), 'https://margin.example/app')
  assert.equal(instanceFromMarginUrl(INSTANCE + '/reader/7', 8), null)
  assert.equal(instanceFromMarginUrl(INSTANCE + '/reader/7/', 7), null)
  assert.equal(instanceFromMarginUrl('javascript:alert(1)/reader/7', 7), null)
  assert.equal(instanceFromMarginUrl('https://margin.example/reader/0', 0), null)
})

test('progress files never use storage, URL state or React', () => {
  // Comments name the forbidden APIs to explain why they are absent; strip them.
  const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const modelSource = stripComments(readFileSync(new URL('../src/client/progressModel.ts', import.meta.url), 'utf8'))
  assert.doesNotMatch(modelSource, /localStorage|sessionStorage|URLSearchParams|new URL|document\.|window\.|from 'react'/)
  for (const file of ['ArticleReader.tsx', 'ReadingList.tsx']) {
    const source = stripComments(readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8'))
    assert.doesNotMatch(source, /localStorage|sessionStorage/, file)
  }
  assert.equal(PROGRESS_LOOKUP_LIMIT, 100)
})

test('real API sends GET limit, explicit POST body and clear scope', async () => {
  const original = globalThis.fetch
  const calls = []
  try {
    globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(progressView([entry()]))) }
    const api = new MarginApi()
    await api.loadProgress()
    await api.loadProgress(100)
    const input = { instanceUrl: INSTANCE, candidateId: 7, contentVersion: versionOf(detail), title: 'Article', ratio: 0.4, scrollTop: 120 }
    await api.saveProgress(input)
    await api.clearProgress(`${INSTANCE}|7|${versionOf(detail)}`)
    await api.clearProgress()
    assert.equal(calls[0].url, '/api/dsh-margin/progress?limit=20')
    assert.equal(calls[0].options, undefined)
    assert.equal(calls[1].url, '/api/dsh-margin/progress?limit=100')
    assert.equal(calls[2].url, '/api/dsh-margin/progress')
    assert.equal(calls[2].options.method, 'POST')
    assert.deepEqual(JSON.parse(calls[2].options.body), input)
    assert.equal(calls[3].url, '/api/dsh-margin/progress-clear')
    assert.deepEqual(JSON.parse(calls[3].options.body), { key: `${INSTANCE}|7|${versionOf(detail)}` })
    assert.deepEqual(JSON.parse(calls[4].options.body), {})
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'invalid_ratio', message: 'ratio 必须在 0–1 之间' } }), { status: 400 })
    await assert.rejects(api.saveProgress(input), error => error instanceof MarginApiError && error.status === 400 && error.code === 'invalid_ratio')
  } finally { globalThis.fetch = original }
})

test('reader renders without a DOM and without a progress face', async () => {
  const harness = readerHarness()
  const props = { candidate, t, onBack() {}, loadCandidate: async () => detail, setCandidateStatus: async () => acknowledgement('read') }
  const tree = await settle(harness, props)
  assert.ok(hasClass(tree, 'margin-reader'))
  assert.equal(hasClass(tree, 'margin-reader__progress'), false)
  assert.equal(hasClass(tree, 'margin-reader__toc'), false)
  assert.ok(containsText(tree, 'reader.summary'))
  assert.equal(find(tree, node => String(node.props?.className ?? '').includes('margin-reader__progress')), undefined)
  harness.unmount()
})

test('reader restores one approximate position and saves throttled scroll positions with instance+version', async () => {
  const scroller = fakeScroller()
  const article = fakeArticle(scroller)
  const harness = readerHarness({ article, body: {} })
  const calls = []
  const saved = entry({ ratio: 0.4, scrollTop: 400 })
  const face = progressFace({
    loadProgress: async limit => { calls.push(['load', limit]); return progressView([saved]) },
    saveProgress: async input => { calls.push(['save', input]); return { entry: { ...saved, ...input } } },
    clearProgress: async () => { calls.push(['clear']); return { removed: 0, scope: 'all', marginUntouched: true } },
  })
  const props = { candidate, t, onBack() {}, loadCandidate: async () => detail, progress: face }
  let tree = await settle(harness, props)
  assert.deepEqual(calls[0], ['load', 100])
  // 0.4 of (1500 - 500) is 400 px; restore is approximate by definition.
  assert.equal(scroller.scrollTop, 400)
  assert.equal(calls.filter(([kind]) => kind === 'save').length, 0)
  assert.ok(containsText(tree, 'progress.restoredApproximate'))
  assert.ok(containsText(tree, progressLabel(0.4)))
  // No re-read and no re-apply on later ready renders.
  tree = harness.render()
  assert.equal(calls.filter(([kind]) => kind === 'load').length, 1)
  // A first scroll is persisted with the derived instance and the body version.
  scroller.scrollTop = 750
  scroller.fire('scroll')
  await flush()
  const saves = calls.filter(([kind]) => kind === 'save')
  assert.equal(saves.length, 1)
  assert.deepEqual(saves[0][1], {
    instanceUrl: INSTANCE,
    candidateId: 7,
    contentVersion: versionOf(detail),
    title: 'Article',
    ratio: 0.75,
    scrollTop: 750,
  })
  // A tiny movement within the delta/interval window is not written again.
  scroller.scrollTop = 752
  scroller.fire('scroll')
  await flush()
  assert.equal(calls.filter(([kind]) => kind === 'save').length, 1)
  // Only the three progress methods were ever touched; no AI/import/status call.
  assert.deepEqual([...new Set(calls.map(([kind]) => kind))].sort(), ['load', 'save'])
  harness.unmount()
})

test('a version mismatch is never applied to changed text', async () => {
  const scroller = fakeScroller()
  const harness = readerHarness({ article: fakeArticle(scroller), body: {} })
  const stale = entry({ contentVersion: 'old-version', ratio: 0.8 })
  const face = progressFace({ loadProgress: async () => progressView([stale]) })
  const tree = await settle(harness, { candidate, t, onBack() {}, loadCandidate: async () => detail, progress: face })
  assert.equal(scroller.scrollTop, 0)
  assert.equal(containsText(tree, progressLabel(0.8)), false)
  assert.equal(containsText(tree, 'progress.restoredApproximate'), false)
  harness.unmount()
})

test('a failed save surfaces a note once and is never retried in a loop', async () => {
  const scroller = fakeScroller()
  const harness = readerHarness({ article: fakeArticle(scroller), body: {} })
  let saves = 0
  const face = progressFace({ saveProgress: async () => { saves++; throw new MarginApiError('offline', 503) } })
  await settle(harness, { candidate, t, onBack() {}, loadCandidate: async () => detail, progress: face })
  scroller.scrollTop = 300
  scroller.fire('scroll')
  await flush()
  let tree = harness.render()
  assert.equal(saves, 1)
  assert.ok(containsText(tree, 'progress.saveFailed'))
  // Extra renders and microtask turns do not resend: no timer, no retry loop.
  await flush(); tree = harness.render(); await flush(); tree = harness.render()
  assert.equal(saves, 1)
  harness.unmount()
})

test('TOC is collapsible and falls back to a proportional, labelled approximate jump', async () => {
  const scroller = fakeScroller({ clientHeight: 500, scrollHeight: 2500 })
  const harness = readerHarness({ article: fakeArticle(scroller), body: {} })
  const markdown = '# Alpha\n\ntext\n\n## Beta\n\n```\n# ignored\n```\n\n### Gamma'
  const article = { ...detail, contentMd: markdown }
  const face = progressFace()
  let tree = await settle(harness, { candidate, t, onBack() {}, loadCandidate: async () => article, progress: face })
  const toggle = button(tree, 'progress.toc')
  assert.equal(toggle.props['aria-expanded'], false)
  toggle.props.onClick(); tree = harness.render()
  assert.equal(button(tree, 'progress.toc').props['aria-expanded'], true)
  assert.ok(containsText(tree, 'Gamma'))
  assert.equal(containsText(tree, 'ignored'), false)
  const betaEntry = tocFromMarkdown(markdown).find(item => item.text === 'Beta')
  const beta = button(tree, 'Beta')
  beta.props.onClick(); tree = harness.render()
  assert.equal(scroller.scrollTop, (betaEntry.index / markdown.length) * 2000)
  assert.ok(containsText(tree, 'progress.tocApproximate'))
  harness.unmount()
})

test('TOC scrolls to a matching rendered heading instead of guessing', async () => {
  const scroller = fakeScroller({ clientHeight: 500, scrollHeight: 2500 })
  const harness = readerHarness({ article: fakeArticle(scroller), body: {} })
  const markdown = '# Alpha\n\n## Beta'
  const article = { ...detail, contentMd: markdown }
  let tree = await settle(harness, { candidate, t, onBack() {}, loadCandidate: async () => article, progress: progressFace() })
  button(tree, 'progress.toc').props.onClick(); tree = harness.render()
  const scrolled = []
  const heading = { nodeName: 'H2', textContent: ' Beta ', scrollIntoView: options => { scrolled.push(options) } }
  const original = globalThis.document
  globalThis.document = { createTreeWalker: () => { const list = [{ nodeName: 'H1', textContent: ' Alpha ' }, heading]; let at = 0; return { nextNode: () => list[at++] ?? null } } }
  try {
    button(tree, 'Beta').props.onClick(); tree = harness.render()
    assert.deepEqual(scrolled, [{ block: 'start' }])
    assert.equal(scroller.scrollTop, 0)
    assert.equal(containsText(tree, 'progress.tocApproximate'), false)
  } finally {
    if (original === undefined) delete globalThis.document
    else globalThis.document = original
  }
  harness.unmount()
})

test('ReadingList passes the progress face through to the reader unchanged', async () => {
  const harness = componentHarness('ReadingList.tsx', 'ReadingList', {
    './ArticleReader.tsx': { ArticleReader: function ArticleReader() { return null } },
    './ImportPanel.tsx': { ImportPanel: function ImportPanel() { return null } },
    './SourcePanel.tsx': { SourcePanel: function SourcePanel() { return null } },
    './importModel.ts': { taskBelongsToInstance: () => true },
    './readerModel.ts': readerModel,
    './readingStyles.ts': { readingStyles: '' },
    './api.ts': { MarginApiError },
  })
  const face = progressFace()
  const props = { t, progress: face, loadCandidate: async () => detail, setCandidateStatus: async () => acknowledgement('read'), loadList: async () => readingView() }
  let tree = harness.render(props)
  await flush()
  tree = harness.render()
  assert.equal(find(tree, node => typeof node.type === 'function' && node.type.name === 'ArticleReader'), undefined)
  button(tree, 'list.read').props.onClick({ currentTarget: { focus() {} } })
  tree = harness.render()
  const reader = find(tree, node => typeof node.type === 'function' && node.type.name === 'ArticleReader')
  assert.equal(reader.props.progress, face)
  harness.unmount()
})

test('client wiring exposes only the three progress methods', () => {
  const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('progress: {')
  const end = source.indexOf('sources: {')
  assert.ok(start >= 0 && end > start)
  const block = source.slice(start, end)
  for (const method of ['loadProgress', 'saveProgress', 'clearProgress']) assert.match(block, new RegExp(method))
  assert.doesNotMatch(block, /setCandidateStatus|importUrl|runAi|loadCandidate/)
})
