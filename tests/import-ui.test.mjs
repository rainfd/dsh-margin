import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { File } from 'node:buffer'

// Compile only pure browser logic and API; not a plugin bundle build.
const temp = mkdtempSync(join(tmpdir(), 'dsh-margin-import-ui-'))
after(() => rmSync(temp, { recursive: true, force: true }))
writeFileSync(join(temp, 'package.json'), '{"type":"module"}')
execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', '--rewriteRelativeImportExtensions', '--rootDir', 'src', '--outDir', temp, 'src/client/importModel.ts', 'src/client/api.ts'], { stdio: 'pipe' })
const importModel = await import(pathToFileURL(join(temp, 'client/importModel.js')))
const { ImportSession, validatePdf, taskBelongsToInstance, importError } = importModel
const { MarginApi, MarginApiError } = await import(pathToFileURL(join(temp, 'client/api.js')))
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const instanceUrl = 'https://margin.example'
const task = (overrides = {}) => ({ id: 1, title: 'Example', sourceUrl: 'https://example.org', sourceType: 'manual_url', status: 'processing', marginUrl: instanceUrl + '/reader/1', errorMessage: null, createdAt: '', ...overrides })
const view = (overrides = {}) => ({ instanceUrl, urlAllowed: true, pdfAllowed: true, maxPdfBytes: 10485760, recentLimit: 20, tasks: [], ...overrides })
function fixture(overrides = {}) {
  const posts = [], gets = [], completed = []
  const api = {
    loadImports: async () => { gets.push('queue'); return view() },
    loadImportTask: async id => { gets.push(id); throw new MarginApiError('missing', 404) },
    importUrl: async (url, instance) => { posts.push([url, instance]); return { instanceUrl: instance, task: task() } },
    importPdf: async (file, instance) => { posts.push([file, instance]); return { instanceUrl: instance, task: task() } },
    ...overrides,
  }
  const session = new ImportSession(api, () => {}, () => completed.push(true))
  return { session, posts, gets, completed }
}

// Deterministic real component event/effect harness, without a DOM dependency.
function panelHarness() {
  const cells = []; let index = 0, effects = [], props
  const differs = (a, b) => !a || a.length !== b.length || a.some((v, i) => v !== b[i])
  const hooks = {
    useState(initial) { const i = index++; cells[i] ??= { value: initial }; return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next }] },
    useMemo(factory, deps) { const i = index++; if (differs(cells[i]?.deps, deps)) cells[i] = { deps, value: factory() }; return cells[i].value },
    useEffect(effect, deps) { const i = index++; if (differs(cells[i]?.deps, deps)) effects.push(() => { cells[i]?.cleanup?.(); cells[i] = { deps, cleanup: effect() } }) },
  }
  const mocks = { react: hooks, 'react/jsx-runtime': createRequire(import.meta.url)('react/jsx-runtime'), './importModel.ts': importModel, './readerModel.ts': { safeMarginUrl: value => { try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.href : null } catch { return null } } } }
  const output = ts.transpileModule(readFileSync(new URL('../src/client/ImportPanel.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(id => { if (!(id in mocks)) throw new Error(id); return mocks[id] }, module, module.exports)
  return {
    render(next = props) { props = next; index = 0; effects = []; const tree = module.exports.ImportPanel(props); effects.forEach(run => run()); return tree },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : []
}

test('real panel gates buttons from live GET, submits only clicked action and stops on close', async () => {
  const f = fixture(); const harness = panelHarness()
  const props = { api: f.session.api, active: true, onClose: () => {}, onCompleted: () => {}, onOpen: async () => {} }
  let tree = harness.render(props)
  const submit = () => nodes(tree).find(n => n.type === 'button' && n.props.children === '提交 URL')
  assert.equal(submit().props.disabled, true)
  await flush(); tree = harness.render()
  const input = nodes(tree).find(n => n.type === 'input' && n.props.type === 'url')
  input.props.onChange({ target: { value: 'https://example.org' } }); tree = harness.render()
  assert.equal(submit().props.disabled, false)
  assert.equal(f.posts.length, 0)
  submit().props.onClick(); submit().props.onClick(); await flush(); tree = harness.render()
  assert.equal(f.posts.length, 1)
  assert.equal(submit().props.disabled, true)
  tree = harness.render({ ...props, active: false })
  assert.equal(tree.props.hidden, true)
  harness.unmount()
})

test('default deny; reading a disabled queue never posts', async () => {
  const f = fixture({ loadImports: async () => view({ urlAllowed: false, pdfAllowed: false, tasks: [task()] }) })
  await f.session.submit('url', 'https://example.org')
  f.session.start(); await flush()
  assert.equal(f.session.tasks.length, 1)
  await f.session.submit('url', 'https://example.org')
  assert.deepEqual(f.posts, [])
  f.session.stop()
})

test('explicit URL submit has an immediate lock, 202 is not completion, missing task remains unknown', async () => {
  const pending = deferred()
  let posts = 0
  const f = fixture({ importUrl: async () => { posts++; return pending.promise } })
  f.session.start(); await flush()
  assert.equal(posts, 0)
  const submission = f.session.submit('url', 'https://example.org')
  await f.session.submit('url', 'https://example.org')
  assert.equal(posts, 1)
  pending.resolve({ instanceUrl, task: task({ status: 'unprocessed' }) })
  await submission; await flush()
  assert.equal(f.completed.length, 0)
  assert.equal(f.session.known.get(1).status, 'unknown')
  assert.ok(f.gets.includes(1))
  await f.session.submit('url', 'https://example.org')
  assert.equal(posts, 1)
  f.session.stop()
})

test('unknown stays unknown; read-only fallback can establish completion', async () => {
  let current = task({ status: 'unknown' })
  const f = fixture({ loadImportTask: async () => ({ instanceUrl, task: current }) })
  f.session.start(); await flush()
  await f.session.submit('url', 'https://example.org'); await flush()
  assert.equal(f.session.known.get(1).status, 'unknown')
  assert.equal(f.completed.length, 0)
  current = task({ status: 'read' })
  await f.session.check(true)
  assert.equal(f.session.known.get(1).status, 'read')
  assert.equal(f.completed.length, 1)
  f.session.stop()
})

test('validation rejects URL schemes, oversized/non-PDF and wrong magic before POST', async () => {
  const f = fixture(); f.session.start(); await flush()
  await f.session.submit('url', 'javascript:alert(1)')
  await f.session.submit('pdf', new File(['not pdf'], 'a.pdf', { type: 'application/pdf' }))
  assert.equal(f.posts.length, 0)
  await assert.rejects(validatePdf(new File(['%PDF-test'], 'a.txt', { type: 'text/plain' })))
  await assert.rejects(validatePdf(new File(['%PDF-test'], 'a.pdf'), 4))
  await validatePdf(new File(['%PDF-test'], 'a.pdf', { type: 'application/pdf' }))
  f.session.stop()
})

test('network/504 uncertainty requires explicit read-only check, never auto resubmits', async () => {
  let posts = 0
  const f = fixture({ importUrl: async () => { posts++; throw new MarginApiError('timeout', 504) } })
  f.session.start(); await flush()
  await f.session.submit('url', 'https://example.org')
  assert.match(f.session.message, /不确定/)
  await f.session.submit('url', 'https://example.org')
  assert.equal(posts, 1)
  await f.session.check(false)
  await f.session.submit('url', 'https://example.org')
  assert.equal(posts, 1)
  await f.session.check(true)
  assert.equal(f.session.blocked.size, 0)
  assert.equal(posts, 1)
  f.session.stop()
})

test('instance changes clear bounded tracking and stale receipts cannot overwrite new instance', async () => {
  const pending = deferred(); let live = view()
  const f = fixture({ loadImports: async () => live, importUrl: async () => pending.promise })
  f.session.start(); await flush()
  const submission = f.session.submit('url', 'https://example.org')
  live = view({ instanceUrl: 'https://new.example', tasks: [task({ id: 2 })] })
  await f.session.check(true)
  pending.resolve({ instanceUrl, task: task() }); await submission
  assert.equal(f.session.view.instanceUrl, 'https://new.example')
  assert.equal(f.session.known.size, 0)
  assert.equal(f.session.blocked.size, 0)
  f.session.stop()
})

test('polling uses backoff, caps attempts and cancels timers/late queue results on close', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout
  const timers = new Map(); const delays = []; let id = 0
  globalThis.setTimeout = (fn, delay) => { delays.push(delay); timers.set(++id, fn); return id }
  globalThis.clearTimeout = timer => timers.delete(timer)
  try {
    const f = fixture(); f.session.start(); await flush()
    for (let i = 0; i < 20; i++) {
      const [timer, run] = timers.entries().next().value
      timers.delete(timer); run(); await flush()
    }
    assert.deepEqual(delays.slice(0, 5), [3000, 6000, 12000, 20000, 20000])
    assert.equal(delays.length, 20)
    assert.equal(timers.size, 0)
    assert.match(f.session.message, /自动检查已停止/)
    f.session.stop()
    const late = deferred(); const other = fixture({ loadImports: () => late.promise })
    other.session.start(); other.session.stop()
    late.resolve(view()); await flush()
    assert.equal(other.session.view, null)
    assert.equal(timers.size, 0)
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear }
})

test('known accepted IDs and missing fallback lookups are bounded to three', async () => {
  let id = 0; let fallbacks = 0
  const f = fixture({ importUrl: async () => ({ instanceUrl, task: task({ id: ++id }) }), loadImportTask: async () => { fallbacks++; throw new Error('missing') } })
  f.session.start(); await flush()
  for (let n = 0; n < 5; n++) { await f.session.submit('url', `https://example.org/${n}`); await flush() }
  assert.equal(f.session.known.size, 3)
  fallbacks = 0; await f.session.check(true)
  assert.equal(fallbacks, 3)
  f.session.stop()
})

test('only current instance reader links are eligible and error classes stay distinct', () => {
  assert.equal(taskBelongsToInstance(task(), instanceUrl), true)
  for (const marginUrl of ['javascript:alert(1)', 'https://other.example/reader/1', instanceUrl + '/reader/2']) assert.equal(taskBelongsToInstance(task({ marginUrl }), instanceUrl), false)
  assert.match(importError(new MarginApiError('x', 409, 'instance_changed')), /实例已变更/)
  assert.match(importError(new MarginApiError('x', 409, 'not_configured')), /尚未配置/)
  for (const [status, fragment] of [[401, 'token'], [403, '禁用'], [409, '重复'], [413, '过大'], [422, '格式'], [504, '不确定']]) assert.match(importError(new MarginApiError('x', status)), new RegExp(fragment))
  assert.match(importError(Object.assign(new Error('aborted'), { name: 'AbortError' })), /超时/)
})

test('real API uses explicit POST JSON or multipart and GET instance-scoped fallback', async () => {
  const original = globalThis.fetch; const calls = []
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ instanceUrl, task: task() }), { status: options?.method === 'POST' ? 202 : 200, headers: { 'content-type': 'application/json' } }) }
  try {
    const api = new MarginApi()
    await api.loadImports(); await api.importUrl('https://example.org', instanceUrl)
    const pdf = new File(['%PDF-test'], 'a.pdf', { type: 'application/pdf' })
    await api.importPdf(pdf, instanceUrl); await api.loadImportTask(1, instanceUrl)
    assert.ok(calls[0].options.signal instanceof AbortSignal, 'queue reads are bounded')
    assert.deepEqual(JSON.parse(calls[1].options.body), { url: 'https://example.org', instanceUrl })
    assert.equal(calls[1].options.method, 'POST')
    assert.equal(calls[2].options.method, 'POST')
    assert.equal(calls[2].options.headers, undefined)
    assert.equal(calls[2].options.body.get('file').name, 'a.pdf')
    assert.equal(calls[2].options.body.get('instanceUrl'), instanceUrl)
    assert.match(calls[3].url, /import-task\?id=1&instanceUrl=/)
    globalThis.fetch = async () => new Response(JSON.stringify({ instanceUrl, task: task() }), { status: 200 })
    await assert.rejects(api.importUrl('https://example.org', instanceUrl), error => error.status === 504)
  } finally { globalThis.fetch = original }
})
