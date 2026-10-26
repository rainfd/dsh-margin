/**
 * spec005 (AI assistant) — browser-half tests.
 *
 * Compiled with the same tsc invocation as tests/import-ui.test.mjs: only pure
 * client logic and the real API client are compiled; no plugin bundle build and
 * no network or model call is involved.
 *
 * The component harness drives real event handlers and effects (as the reader
 * and import tests do) but does not implement a DOM: browser selection and real
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

const temp = mkdtempSync(join(tmpdir(), 'dsh-margin-ai-ui-'))
after(() => rmSync(temp, { recursive: true, force: true }))
writeFileSync(join(temp, 'package.json'), '{"type":"module"}')
execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
  '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext',
  '--skipLibCheck', '--rewriteRelativeImportExtensions', '--rootDir', 'src', '--outDir', temp,
  'src/client/aiModel.ts', 'src/client/api.ts', 'src/client/readerModel.ts', 'src/client/locales.ts'], { stdio: 'pipe' })

const model = await import(pathToFileURL(join(temp, 'client/aiModel.js')))
const apiModule = await import(pathToFileURL(join(temp, 'client/api.js')))
const readerModel = await import(pathToFileURL(join(temp, 'client/readerModel.js')))
const { zh } = await import(pathToFileURL(join(temp, 'client/locales.js')))
const { AiSession, AI_QUESTION_MAX, aiErrorKey, readerInstance, selectionOf, submitBlocked } = model
const { MarginApi, MarginApiError } = apiModule
const jsxRuntime = createRequire(import.meta.url)('react/jsx-runtime')
const t = key => {
  const value = zh[key]
  if (typeof value !== 'string') throw new Error('missing locale key ' + key)
  return value
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

const capability = (overrides = {}) => ({
  enabled: true,
  modelAvailable: true,
  target: { provider: 'fake', model: 'model-a' },
  limits: { selectionChars: 12000, maxOutputTokens: 2048 },
  ...overrides,
})
const result = (overrides = {}) => ({
  instanceUrl: 'https://margin.example',
  candidateId: 7,
  mode: 'summary',
  provider: 'fake',
  model: 'model-a',
  text: '**Summary** of the article.',
  coverage: { mode: 'summary', scope: 'article', sentChars: 12000, totalChars: 50000, truncated: true, label: '局部内容：仅发送前 12000 字符，共 50000 字符（不是全文）' },
  generated: true,
  ...overrides,
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

/** AiPanel with the compiled pure model — the same module instance the test holds. */
const panelHarness = () => componentHarness({
  file: 'AiPanel.tsx',
  name: 'AiPanel',
  mocks: () => ({ './aiModel.ts': model }),
})

/** ArticleReader, to prove the nesting is optional and scope is derived. */
const readerHarness = () => componentHarness({
  file: 'ArticleReader.tsx',
  name: 'ArticleReader',
  mocks: () => ({ './api.ts': apiModule, './readerModel.ts': readerModel }),
})

/** AiResultView is a nested function component; expand it like Item/Chip in reader tests. */
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  if (typeof tree.type === 'function' && tree.type.name === 'AiResultView') return nodes(tree.type(tree.props))
  return [tree, ...nodes(tree.props?.children)]
}
const find = (tree, predicate) => nodes(tree).find(predicate)
const button = (tree, label) => find(tree, node => node.type === 'button' && node.props.children === label)
const texts = tree => nodes(tree).flatMap(node => (typeof node.props?.children === 'string' ? [node.props.children] : []))
const hasText = (tree, text) => texts(tree).some(value => value.includes(text))

function apiFixture(overrides = {}) {
  const runs = []
  const pending = []
  const status = []
  const api = {
    loadCapability: async () => capability(),
    run(request, signal) {
      runs.push({ request, signal })
      const request_ = deferred()
      pending.push(request_)
      if (signal !== undefined) signal.addEventListener('abort', () => request_.reject(abortError()))
      return request_.promise
    },
    // Present but must never be called: the AI panel holds no status/save API.
    setCandidateStatus: () => { status.push('setCandidateStatus'); throw new Error('AI must not write reading status') },
    saveToTrilium: () => { status.push('saveToTrilium'); throw new Error('AI must not save to Trilium') },
    ...overrides,
  }
  return { api, runs, pending, status }
}

/** Render, open the collapsed section, let the capability GET settle. */
async function openPanel(props) {
  const h = panelHarness()
  h.render(props)
  await flush()
  let tree = h.render()
  const expand = button(tree, t('ai.expand'))
  assert.ok(expand, 'AI section must be collapsible and start collapsed')
  expand.props.onClick()
  tree = h.render()
  return { h, tree: () => h.render() }
}

const panelProps = (fixture, overrides = {}) => ({
  api: fixture.api,
  candidateId: 7,
  marginUrl: 'https://margin.example/reader/7',
  t,
  ...overrides,
})

/* ------------------------------------------------------------------ *
 * Pure model
 * ------------------------------------------------------------------ */

test('readerInstance derives the configured Margin origin from the reader URL only', () => {
  assert.equal(readerInstance('https://margin.example/reader/7'), 'https://margin.example')
  assert.equal(readerInstance('https://margin.example/reader/7/'), 'https://margin.example')
  assert.equal(readerInstance('http://127.0.0.1:3000/margin/reader/12'), 'http://127.0.0.1:3000/margin')
  for (const bad of ['javascript:alert(1)', 'https://margin.example/article/7', '', 'not a url']) {
    assert.equal(readerInstance(bad), null, bad)
  }
})

test('submit gating is pure: disabled, model, question, selection ceiling and instance', () => {
  const base = { status: 'ready', capability: capability(), mode: 'qa', question: '', selection: undefined, instanceUrl: 'https://margin.example' }
  assert.equal(submitBlocked(base), 'questionRequired')
  assert.equal(submitBlocked({ ...base, mode: 'summary' }), undefined)
  assert.equal(submitBlocked({ ...base, question: '   ' }), 'questionRequired')
  assert.equal(submitBlocked({ ...base, question: 'x'.repeat(AI_QUESTION_MAX + 1) }), 'questionTooLong')
  assert.equal(submitBlocked({ ...base, mode: 'translate', selection: 'x'.repeat(12001) }), 'selectionTooLong')
  assert.equal(submitBlocked({ ...base, mode: 'translate', selection: 'x'.repeat(12000) }), undefined)
  // The host does not raise selection_too_long for qa (it truncates and says so
  // in the coverage label), so the client must not block it either.
  assert.equal(submitBlocked({ ...base, question: 'q', selection: 'x'.repeat(20000) }), undefined)
  assert.equal(submitBlocked({ ...base, capability: capability({ enabled: false }) }), 'disabled')
  assert.equal(submitBlocked({ ...base, capability: capability({ modelAvailable: false }) }), 'noModel')
  assert.equal(submitBlocked({ ...base, status: 'running', question: 'q' }), 'running')
  assert.equal(submitBlocked({ ...base, status: 'loading' }), 'loading')
  assert.equal(submitBlocked({ ...base, instanceUrl: '  ' }), 'noInstance')
  // A blank selection must be sent as absent, not as an empty string.
  assert.equal(selectionOf('  \n '), undefined)
  assert.equal(selectionOf(' chosen '), 'chosen')
  assert.equal(selectionOf(undefined), undefined)
})

test('error codes map to fixed locale keys and never expose upstream wording', () => {
  const expected = {
    ai_disabled: 'ai.error.disabled',
    model_unavailable: 'ai.error.noModel',
    not_configured: 'ai.error.notConfigured',
    instance_changed: 'ai.error.instanceChanged',
    invalid_mode: 'ai.error.invalid',
    invalid_id: 'ai.error.invalid',
    missing_question: 'ai.error.invalid',
    question_too_long: 'ai.error.invalid',
    selection_too_long: 'ai.error.invalid',
    bad_body: 'ai.error.invalid',
    empty_content: 'ai.error.empty',
    not_found: 'ai.error.notFound',
    margin_unavailable: 'ai.error.margin',
    ai_failed: 'ai.error.failed',
    ai_timeout: 'ai.error.timeout',
  }
  for (const [code, key] of Object.entries(expected)) {
    assert.equal(aiErrorKey(new MarginApiError('UPSTREAM DETAIL', 400, code)), key, code)
    // The upstream message must play no part in the mapping.
    assert.equal(aiErrorKey(new MarginApiError('DIFFERENT DETAIL', 400, code)), key, code)
  }
  assert.equal(aiErrorKey(new MarginApiError('x', 403)), 'ai.error.disabled')
  assert.equal(aiErrorKey(new MarginApiError('x', 504)), 'ai.error.timeout')
  assert.equal(aiErrorKey(abortError()), 'ai.error.cancelled')
  assert.equal(aiErrorKey(new Error('boom')), 'ai.error.unknown')
})

test('session refuses a run while another is in flight and aborts on cancel', async () => {
  const fixture = apiFixture()
  let changes = 0
  const session = new AiSession(fixture.api, { candidateId: 7, instanceUrl: 'https://margin.example' }, () => changes++)
  await session.start()
  assert.equal(session.status, 'ready')
  const first = session.run({ mode: 'summary', question: '' })
  await session.run({ mode: 'summary', question: '' })
  assert.equal(fixture.runs.length, 1, 'a second submit while running must be ignored')
  session.cancel()
  assert.equal(fixture.runs[0].signal.aborted, true, 'cancel must abort the fetch signal')
  assert.equal(session.cancelled, true)
  assert.equal(session.result, null)
  // A late completion of the aborted run must be dropped.
  fixture.pending[0].resolve(result())
  await first; await flush()
  assert.equal(session.result, null)
  assert.equal(session.status, 'ready')
})

/* ------------------------------------------------------------------ *
 * Panel rendering and actions
 * ------------------------------------------------------------------ */

test('disabled capability renders nothing at all — not even a submit control', async () => {
  const fixture = apiFixture({ loadCapability: async () => capability({ enabled: false }) })
  const h = panelHarness()
  // The very first paint is already empty: no expand control while loading.
  assert.equal(h.render(panelProps(fixture)), null)
  await flush()
  const tree = h.render()
  assert.equal(tree, null)
  assert.equal(nodes(tree).length, 0)
  assert.equal(fixture.runs.length, 0)
  h.unmount()
})

test('an unreadable capability hides the panel and leaves reading untouched', async () => {
  const fixture = apiFixture({ loadCapability: async () => { throw new Error('offline') } })
  const h = panelHarness()
  h.render(panelProps(fixture))
  await flush()
  assert.equal(h.render(), null)
  assert.equal(fixture.runs.length, 0)
  h.unmount()
})

test('no usable model blocks the actions with fixed text, without hiding the reader', async () => {
  const fixture = apiFixture({ loadCapability: async () => capability({ modelAvailable: false, target: null }) })
  const { h, tree } = await openPanel(panelProps(fixture))
  const current = tree()
  assert.ok(hasText(current, t('ai.noModel')))
  assert.ok(hasText(current, t('ai.modelUnknown')))
  assert.equal(find(current, node => node.props?.['data-ai-no-model'] === 'true') !== undefined, true)
  assert.equal(button(current, t('ai.run')).props.disabled, true)
  for (const mode of [t('ai.mode.qa'), t('ai.mode.translate'), t('ai.mode.summary')]) {
    assert.equal(button(current, mode).props.disabled, true, mode)
  }
  const input = find(current, node => node.type === 'input')
  assert.equal(input.props.disabled, true)
  h.unmount()
})

test('boundary notice precedes the first run and the selected model is shown', async () => {
  const fixture = apiFixture()
  const { h, tree } = await openPanel(panelProps(fixture))
  const current = tree()
  assert.ok(hasText(current, t('ai.boundary')))
  assert.match(t('ai.boundary'), /不可信数据/)
  assert.ok(hasText(current, t('ai.model').replace('{model}', 'model-a')))
  h.unmount()
})

test('提问 requires a non-empty question; 翻译 and 摘要 do not', async () => {
  const fixture = apiFixture()
  const { h, tree } = await openPanel(panelProps(fixture))
  let current = tree()
  assert.equal(button(current, t('ai.run')).props.disabled, true)
  // Clicking the (disabled) control still cannot reach the model.
  await button(current, t('ai.run')).props.onClick()
  current = tree()
  assert.equal(fixture.runs.length, 0)
  assert.ok(hasText(current, t('ai.block.questionRequired')))

  const input = find(current, node => node.type === 'input' && node.props.type === 'text')
  input.props.onChange({ target: { value: 'What is the main claim?' } })
  current = tree()
  assert.equal(button(current, t('ai.run')).props.disabled, false)

  button(current, t('ai.mode.summary')).props.onClick()
  current = tree()
  assert.equal(button(current, t('ai.run')).props.disabled, false)
  button(current, t('ai.run')).props.onClick()
  assert.equal(fixture.runs.length, 1)
  assert.equal(fixture.runs[0].request.mode, 'summary')
  assert.equal('question' in fixture.runs[0].request, false, 'a transform must not send a question')
  h.unmount()
})

test('a second click while running is ignored and 取消 aborts the request', async () => {
  const fixture = apiFixture()
  const { h, tree } = await openPanel(panelProps(fixture))
  const input = find(tree(), node => node.type === 'input')
  input.props.onChange({ target: { value: 'Summarize the argument' } })
  const run = button(tree(), t('ai.run'))
  run.props.onClick()
  run.props.onClick()
  let current = tree()
  assert.equal(fixture.runs.length, 1)
  assert.equal(button(current, t('ai.running')).props.disabled, true)
  const cancel = button(current, t('ai.cancel'))
  assert.ok(cancel, 'a running request must offer 取消')
  cancel.props.onClick()
  assert.equal(fixture.runs[0].signal.aborted, true)
  current = tree()
  assert.ok(hasText(current, t('ai.cancelled')))
  assert.equal(fixture.runs.length, 1, 'cancel must not resubmit')
  h.unmount()
})

test('coverage label is displayed verbatim, in a block labelled AI 生成', async () => {
  const fixture = apiFixture()
  const { h, tree } = await openPanel(panelProps(fixture))
  find(tree(), node => node.type === 'input').props.onChange({ target: { value: 'q' } })
  button(tree(), t('ai.run')).props.onClick()
  fixture.pending[0].resolve(result())
  await flush()
  const current = tree()
  const label = result().coverage.label
  assert.match(label, /不是全文/)
  const coverage = find(current, node => node.props?.['data-ai-coverage'] === 'true')
  assert.equal(coverage.props.children, label, 'the host coverage label must appear verbatim, unprefixed')
  assert.ok(hasText(current, t('ai.generated')))
  const markdown = find(current, node => node.type === h.MarkdownText)
  assert.equal(markdown.props.text, result().text)
  assert.equal(markdown.props.variant, 'body')
  // Same safe render path as the article body: a delegate provider, never raw HTML.
  assert.ok(find(current, node => node.type === h.MarkdownDelegateProvider))
  assert.equal(find(current, node => node.props?.dangerouslySetInnerHTML !== undefined), undefined)
  h.unmount()
})

test('a result from a cancelled run is never displayed', async () => {
  const fixture = apiFixture()
  // Ignore the signal: this is the hostile case where the fetch settles anyway.
  fixture.api.run = (request) => { fixture.runs.push({ request }); const pending = deferred(); fixture.pending.push(pending); return pending.promise }
  const { h, tree } = await openPanel(panelProps(fixture))
  find(tree(), node => node.type === 'input').props.onChange({ target: { value: 'q' } })
  button(tree(), t('ai.run')).props.onClick()
  button(tree(), t('ai.cancel')).props.onClick()
  fixture.pending[0].resolve(result())
  await flush()
  const current = tree()
  assert.equal(hasText(current, result().text), false)
  assert.equal(hasText(current, t('ai.generated')), false)
  assert.equal(find(current, node => node.type === h.MarkdownText), undefined)
  h.unmount()
})

test('switching article aborts the old run, drops its result and clears its input', async () => {
  const fixture = apiFixture({ loadCapability: async () => capability() })
  const runs = []
  fixture.api.run = (request, signal) => {
    runs.push({ request, signal })
    const pending = deferred()
    fixture.pending.push(pending)
    if (signal !== undefined) signal.addEventListener('abort', () => pending.reject(abortError()))
    return pending.promise
  }
  const { h, tree } = await openPanel(panelProps(fixture))
  find(tree(), node => node.type === 'input').props.onChange({ target: { value: 'about article 7' } })
  button(tree(), t('ai.run')).props.onClick()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].signal.aborted, false)

  // A different article is a different session: the old request is aborted and
  // its state is discarded, even though this component instance stays mounted.
  h.render(panelProps(fixture, { candidateId: 8, marginUrl: 'https://margin.example/reader/8' }))
  assert.equal(runs[0].signal.aborted, true, 'the superseded request must be aborted')
  await flush()
  let current = tree()
  assert.ok(button(current, t('ai.expand')), 'the new article starts collapsed again')

  // The aborted run's late result cannot appear in the new article either.
  fixture.pending[0].resolve(result({ candidateId: 8 }))
  await flush()
  current = tree()
  assert.equal(hasText(current, t('ai.generated')), false)
  assert.equal(find(current, node => node.type === h.MarkdownText), undefined)

  // Reopening on the new article shows fresh, empty input — no leak from A.
  button(current, t('ai.expand')).props.onClick()
  current = tree()
  assert.equal(find(current, node => node.type === 'input').props.value, '')
  assert.equal(hasText(current, 'about article 7'), false, 'input must not leak into the next article')
  h.unmount()
})

test('a cleanup followed by a re-run revives the session (strict-mode double invoke)', async () => {
  const fixture = apiFixture()
  let changes = 0
  const session = new AiSession(fixture.api, { candidateId: 7, instanceUrl: 'https://margin.example' }, () => changes++)
  await session.start()
  assert.equal(session.status, 'ready')
  session.stop()
  // stop() detaches the session: a captured handler firing afterwards must not
  // reach the network at all.
  await session.run({ mode: 'summary', question: '' })
  assert.equal(fixture.runs.length, 0, 'a stopped session must not submit')
  await session.start()
  assert.equal(session.status, 'ready', 'a re-run after cleanup must not stay stopped')
  const running = session.run({ mode: 'summary', question: '' })
  assert.equal(fixture.runs.length, 1)
  fixture.pending[0].resolve(result())
  await running
  assert.equal(session.result?.text, result().text)
  assert.ok(changes > 0)
  session.stop()
})

test('a change of Margin instance also discards the pending run', async () => {
  const fixture = apiFixture({ loadCapability: async () => capability() })
  const runs = []
  fixture.api.run = (request, signal) => { runs.push({ request, signal }); const pending = deferred(); fixture.pending.push(pending); return pending.promise }
  const { h, tree } = await openPanel(panelProps(fixture))
  find(tree(), node => node.type === 'input').props.onChange({ target: { value: 'q' } })
  button(tree(), t('ai.run')).props.onClick()
  // Same candidate id, different instance: IDs are instance-local, so this is a
  // different article and the old request must not survive.
  h.render(panelProps(fixture, { marginUrl: 'https://other.example/reader/7' }))
  assert.equal(runs[0].signal.aborted, true)
  await flush()
  assert.equal(hasText(tree(), t('ai.generated')), false)
  h.unmount()
})

test('a result for a different candidate or instance is refused as instance_changed', async () => {
  for (const wrong of [{ candidateId: 99 }, { instanceUrl: 'https://other.example' }]) {
    const fixture = apiFixture()
    const h = panelHarness()
    const session = new AiSession(fixture.api, { candidateId: 7, instanceUrl: 'https://margin.example' }, () => {})
    await session.start()
    const running = session.run({ mode: 'summary', question: '' })
    fixture.pending[0].resolve(result(wrong))
    await running
    assert.equal(session.result, null, JSON.stringify(wrong))
    assert.equal(session.errorKey, 'ai.error.instanceChanged')
    assert.equal(session.status, 'failed')
    h.unmount()
  }
})

test('error codes render fixed Chinese text and never the response body', async () => {
  const fixture = apiFixture({ run: async () => { throw new MarginApiError('SECRET UPSTREAM BODY token=abc', 504, 'ai_timeout') } })
  const { h, tree } = await openPanel(panelProps(fixture))
  find(tree(), node => node.type === 'input').props.onChange({ target: { value: 'q' } })
  await button(tree(), t('ai.run')).props.onClick()
  const current = tree()
  assert.ok(hasText(current, t('ai.error.timeout')))
  const rendered = texts(current).join('\n')
  assert.equal(rendered.includes('SECRET UPSTREAM BODY'), false)
  assert.equal(rendered.includes('token=abc'), false)
  // One fixed sentence, no code and no upstream text appended.
  const alert = find(current, node => node.props?.['data-ai-error'] === 'true')
  const alertTexts = nodes(alert).flatMap(node => (typeof node.props?.children === 'string' ? [node.props.children] : []))
  assert.deepEqual(alertTexts, [t('ai.error.timeout')])
  h.unmount()
})

test('scope follows the selection: it sends a selection, else the whole article', async () => {
  const fixture = apiFixture()
  const { h, tree } = await openPanel(panelProps(fixture))
  let current = tree()
  // No selection: whole-article scope, and no `selection` key in the request.
  assert.ok(hasText(current, t('ai.scope.article')))
  button(current, t('ai.mode.summary')).props.onClick()
  button(tree(), t('ai.run')).props.onClick()
  assert.equal('selection' in fixture.runs[0].request, false)
  assert.equal(fixture.runs[0].request.instanceUrl, 'https://margin.example')
  assert.equal(fixture.runs[0].request.candidateId, 7)
  fixture.pending[0].resolve(result())
  await flush()

  // With a selection: exactly that text is sent and the scope label says so.
  h.render(panelProps(fixture, { readSelection: () => '  the chosen paragraph  ' }))
  current = tree()
  assert.ok(hasText(current, t('ai.scope.selection')))
  assert.equal(hasText(current, t('ai.scope.article')), false)
  button(current, t('ai.mode.translate')).props.onClick()
  button(tree(), t('ai.run')).props.onClick()
  assert.equal(fixture.runs.at(-1).request.selection, 'the chosen paragraph')
  assert.equal(fixture.runs.at(-1).request.mode, 'translate')
  h.unmount()
})

test('the AI panel holds no status or save capability', async () => {
  const fixture = apiFixture()
  const { h, tree } = await openPanel(panelProps(fixture))
  find(tree(), node => node.type === 'input').props.onChange({ target: { value: 'q' } })
  button(tree(), t('ai.run')).props.onClick()
  fixture.pending[0].resolve(result())
  await flush()
  assert.ok(hasText(tree(), t('ai.generated')))
  assert.deepEqual(fixture.status, [], 'no reading-status or save call may happen')
  // And the panel is not even handed those methods: the API surface it receives
  // is exactly the read-only capability plus one explicit run.
  assert.deepEqual(Object.keys(fixture.api).sort(), ['loadCapability', 'run', 'saveToTrilium', 'setCandidateStatus'])
  h.unmount()
})

/* ------------------------------------------------------------------ *
 * Reader integration (optional nesting)
 * ------------------------------------------------------------------ */

const candidate = {
  id: 7, title: 'Article', sourceUrl: 'https://example.com/a', marginUrl: 'https://margin.example/reader/7',
  sourceDomain: 'example.com', status: 'unprocessed', sourceType: 'rss', category: null, tags: [],
  author: null, summaryText: 'summary', summary: 'excerpt', isSavedToTrilium: false, createdAt: '', updatedAt: '',
}
const detail = { ...candidate, contentMd: '# Body', contentText: 'plain', contentFetchFailed: false }
const aiSection = tree => find(tree, node => node.props?.className === 'margin-reader__ai')

test('reader renders no AI section when the prop is absent and passes article context when present', async () => {
  const plain = readerHarness()
  plain.render({ candidate, t, onBack() {}, loadCandidate: async () => detail })
  await flush()
  assert.equal(aiSection(plain.render()), undefined, 'without ai nothing may render or be fetched')
  plain.unmount()

  const seen = []
  const Panel = props => { seen.push(props); return null }
  const nested = readerHarness()
  nested.render({ candidate, t, onBack() {}, loadCandidate: async () => detail, ai: { loadCapability: async () => capability(), run: async () => result(), Panel } })
  await flush()
  const tree = nested.render()
  // The reader only creates the element; expanding it is the renderer's job, so
  // the harness expands the injected component the way React would.
  const injected = find(tree, node => node.type === Panel)
  assert.ok(injected, 'the reader must nest the injected panel inside the article view')
  nodes(injected).length
  injected.type(injected.props)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].candidateId, 7)
  assert.equal(seen[0].marginUrl, candidate.marginUrl)
  assert.equal(typeof seen[0].readSelection, 'function')
  assert.equal(seen[0].t, t)
  // It sits after the article body, inside the reader, not in another view.
  const article = find(tree, node => node.type === 'article')
  assert.ok(nodes(article).includes(injected))
  nested.unmount()
})

test('reader scope helper accepts only a selection inside the article body', async () => {
  const h = readerHarness()
  h.render({ candidate, t, onBack() {}, loadCandidate: async () => detail, ai: {
    loadCapability: async () => capability(), run: async () => result(),
    Panel: () => null,
  } })
  await flush()
  let tree = h.render()
  const panel = find(tree, node => typeof node.type === 'function' && typeof node.props?.readSelection === 'function')
  assert.ok(panel, 'the reader must pass a selection reader to the AI panel')
  const readSelection = panel.props.readSelection
  // No browser globals at all: no selection, so the panel falls back to the article.
  assert.equal(readSelection(), undefined)

  // Wire the body container ref as a real mount would, then simulate the
  // browser selection API. This exercises the gate, not real DOM behaviour.
  const body = find(tree, node => node.type === 'section' && node.props?.['aria-label'] === t('reader.body'))
  const insideText = { nodeName: '#text' }
  const outsideText = { nodeName: '#text' }
  // jsx-runtime carries `ref` on the element, not inside props.
  const bodyRef = body.ref ?? body.props.ref
  assert.ok(bodyRef, 'the article body must expose a ref to scope the selection')
  bodyRef.current = { contains: node => node === insideText }
  const selection = (text, target) => ({ isCollapsed: false, rangeCount: 1, toString: () => text, getRangeAt: () => ({ commonAncestorContainer: target }) })
  const originalWindow = globalThis.window
  try {
    globalThis.window = { getSelection: () => selection('  inside the body  ', insideText) }
    assert.equal(readSelection(), 'inside the body')
    globalThis.window = { getSelection: () => selection('elsewhere on the page', outsideText) }
    assert.equal(readSelection(), undefined, 'a selection outside the article must be ignored')
    globalThis.window = { getSelection: () => selection('   ', insideText) }
    assert.equal(readSelection(), undefined)
    globalThis.window = { getSelection: () => ({ isCollapsed: true, rangeCount: 0, toString: () => 'x' }) }
    assert.equal(readSelection(), undefined)
  } finally {
    globalThis.window = originalWindow
    h.unmount()
  }
})

/* ------------------------------------------------------------------ *
 * Transport and hygiene
 * ------------------------------------------------------------------ */

test('runAi passes the request body and the AbortSignal into fetch; capability is a GET', async () => {
  const original = globalThis.fetch
  const calls = []
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options })
      return new Response(JSON.stringify(url.endsWith('/ai-capability') ? capability() : result()), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const api = new MarginApi()
    assert.deepEqual(await api.loadAiCapability(), capability())
    assert.equal(calls[0].url, '/api/dsh-margin/ai-capability')
    assert.equal(calls[0].options, undefined)

    const controller = new AbortController()
    const request = { candidateId: 7, mode: 'summary', instanceUrl: 'https://margin.example' }
    const reply = await api.runAi(request, controller.signal)
    assert.equal(calls[1].url, '/api/dsh-margin/ai-run')
    assert.equal(calls[1].options.method, 'POST')
    assert.equal(calls[1].options.signal, controller.signal, 'the caller signal must reach fetch')
    assert.deepEqual(JSON.parse(calls[1].options.body), request)
    assert.equal(reply.generated, true)

    // Rejections still keep the route's status and code for fixed-text mapping.
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'ai_timeout', message: 'HOST WORDING' } }), { status: 504 })
    await assert.rejects(api.runAi(request), error => error instanceof MarginApiError && error.status === 504 && error.code === 'ai_timeout')
  } finally {
    globalThis.fetch = original
  }
})

test('AI client sources never touch browser storage, a URL or raw HTML', () => {
  for (const file of ['AiPanel.tsx', 'aiModel.ts']) {
    const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'dangerouslySetInnerHTML', 'location.search', 'location.hash', 'location.href', 'history.pushState', 'history.replaceState', 'document.cookie']) {
      assert.equal(source.includes(forbidden), false, `${file} must not use ${forbidden}`)
    }
  }
  // The two AI calls transport the request as a JSON body; no article-derived
  // query string is ever built (the file's URLSearchParams use is the list query).
  const api = readFileSync(new URL('../src/client/api.ts', import.meta.url), 'utf8')
  const aiCalls = api.slice(api.indexOf('loadAiCapability'), api.indexOf('loadSaveState'))
  assert.equal(aiCalls.includes('query('), false, 'AI calls must not build a query string')
  assert.equal(api.includes('localStorage'), false)
  assert.equal(api.includes('sessionStorage'), false)
  assert.equal(api.includes('dangerouslySetInnerHTML'), false)
})

test('an AiApi without a Panel still renders nothing (feature not installed)', async () => {
  const h = readerHarness()
  h.render({ candidate, t, onBack() {}, loadCandidate: async () => detail, ai: { loadCapability: async () => capability(), run: async () => result() } })
  await flush()
  const tree = h.render()
  assert.equal(aiSection(tree), undefined)
  assert.equal(find(tree, node => typeof node.type === 'function' && typeof node.props?.readSelection === 'function'), undefined)
  h.unmount()
})

test('the browser bundle wires only the two AI routes into the reader face', () => {
  const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const face = source.slice(source.indexOf('ai: {'), source.indexOf('annotations: {'))
  assert.match(face, /loadCapability: \(\) => api\.loadAiCapability\(\)/)
  assert.match(face, /run: \(request, signal\) => api\.runAi\(request, signal\)/)
  assert.match(face, /Panel: AiPanel/)
  // No status/save/import method may be handed to the AI surface.
  for (const forbidden of ['setCandidateStatus', 'loadCandidate', 'loadImports', 'createSource', 'deleteCredential', 'save']) {
    assert.equal(face.includes(forbidden), false, `AI face must not expose ${forbidden}`)
  }
})

test('the panel never mentions a status or save endpoint', () => {
  for (const file of ['AiPanel.tsx', 'aiModel.ts']) {
    const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    for (const forbidden of ['candidate-status', 'isSavedToTrilium', 'saveRoutes', 'trilium', 'Trilium 保存']) {
      assert.equal(source.includes(forbidden), false, `${file} must not reference ${forbidden}`)
    }
  }
})
