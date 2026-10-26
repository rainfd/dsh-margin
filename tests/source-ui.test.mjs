import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

/*
 * spec004 来源与凭据 UI.
 *
 * Compiles only the pure model + the real API (same pattern as
 * tests/import-ui.test.mjs), then drives the real SourcePanel component through
 * a deterministic hook harness. The harness runs real event handlers and real
 * useEffect cleanup, and inspects the produced React element tree.
 *
 * Honest limits: no DOM, no layout, no focus management, no controlled-input
 * browser semantics (a password field's value is asserted explicitly below),
 * and no visual/CSS assertions. Anything that depends on the browser is out of
 * scope for this file.
 */

const temp = mkdtempSync(join(tmpdir(), 'dsh-margin-source-ui-'))
after(() => rmSync(temp, { recursive: true, force: true }))
writeFileSync(join(temp, 'package.json'), '{"type":"module"}')
// Compile only what this panel owns. Sibling agents share this checkout, so a
// transient diagnostic in a file we do not own (e.g. an in-progress wire type)
// must not fail this suite — but a diagnostic in *our* files must.
const OURS = ['src/client/sourceModel.ts', 'src/client/api.ts', 'src/client/locales.ts', 'src/protocol.ts', 'src/management.ts']
const tscArgs = ['--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', '--rewriteRelativeImportExtensions', '--rootDir', 'src', '--outDir', temp, 'src/client/sourceModel.ts', 'src/client/api.ts']
let diagnostics = ''
try {
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), ...tscArgs], { stdio: 'pipe' })
} catch (error) {
  diagnostics = String(error.stdout ?? '') + String(error.stderr ?? '')
  const mine = diagnostics.split('\n').filter(line => OURS.some(file => line.startsWith(file)))
  if (mine.length > 0) throw new Error('type errors in this panel\'s own files:\n' + mine.join('\n'))
}

// Even when the compile step is tolerated, the artifacts we drive must exist.
for (const artifact of ['client/sourceModel.js', 'client/api.js', 'client/locales.js']) {
  if (!existsSync(join(temp, artifact))) throw new Error('missing compiled artifact ' + artifact)
}
const model = await import(pathToFileURL(join(temp, 'client/sourceModel.js')))
const { SourceSession, SUPPORTED_DOMAINS, sourceErrorKey, feedProblem, labelProblem, intervalProblem, parseInterval, credentialDomainProblem, cookieInputProblem, statusKey } = model
const { MarginApi, MarginApiError } = await import(pathToFileURL(join(temp, 'client/api.js')))
const { zh } = await import(pathToFileURL(join(temp, 'client/locales.js')))
const require = createRequire(import.meta.url)

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const instanceUrl = 'https://margin.example'
// Shaped like a real cookie header so it passes the host's name=value rule.
const CANARY = 'session=CANARY-cookie-7f3a9c'

const source = (overrides = {}) => ({
  id: 5, sourceType: 'rss', label: 'Example feed', status: 'active',
  feedOrigin: 'https://feeds.example.org', pollIntervalMinutes: 90,
  consecutiveFailures: 2, hasError: true, lastErrorAt: '2026-10-24T02:00:00.000Z',
  recordedFetchAt: '2026-10-25T01:00:00.000Z', ...overrides,
})
const credential = (overrides = {}) => ({
  id: 3, domain: 'mp.weixin.qq.com', configured: true, supported: true,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', ...overrides,
})
const view = (overrides = {}) => ({
  instanceUrl,
  observedAt: '2026-10-25T12:34:56.000Z',
  sourceWritesAllowed: true,
  credentialWritesAllowed: true,
  sources: [source()],
  credentials: [credential(), credential({ id: 4, domain: 'bilibili.com', supported: false })],
  scheduler: { running: true, sourcePollJobs: 2, jobs: [
    { sourceId: 5, nextRunTime: '2026-10-25T13:00:00.000Z', intervalMinutes: 90 },
    { sourceId: 6, nextRunTime: null, intervalMinutes: null },
  ] },
  ...overrides,
})

/** Fake SourceApi that records every call; management reads are scriptable. */
function fixture(overrides = {}) {
  const posts = [], reads = []
  const state = { management: view() }
  let nextSourceId = 100
  let nextCredentialId = 100
  const api = {
    loadManagement: async () => { reads.push('management'); return state.management },
    createSource: async (...args) => {
      posts.push(['createSource', ...args])
      const created = source({ id: nextSourceId++, label: args[1], feedOrigin: new URL(args[0]).origin, pollIntervalMinutes: args[2] })
      state.management = { ...state.management, sources: [...state.management.sources, created] }
      return { instanceUrl: args[3], source: created }
    },
    setSourceStatus: async (...args) => {
      posts.push(['setSourceStatus', ...args])
      const current = state.management.sources.find(entry => entry.id === args[0]) ?? source({ id: args[0] })
      const updated = { ...current, status: args[1] }
      state.management = { ...state.management, sources: state.management.sources.map(entry => (entry.id === args[0] ? updated : entry)) }
      return { instanceUrl: args[2], source: updated }
    },
    fetchSource: async (...args) => { posts.push(['fetchSource', ...args]); return { instanceUrl: args[1], id: args[0], newCandidates: 0, message: 'ok' } },
    deleteSource: async (...args) => {
      posts.push(['deleteSource', ...args])
      state.management = { ...state.management, sources: state.management.sources.filter(entry => entry.id !== args[0]) }
      return { instanceUrl: args[2], deletedId: args[0], articlesRetained: true }
    },
    createCredential: async (...args) => {
      posts.push(['createCredential', ...args])
      const created = credential({ id: nextCredentialId++, domain: args[0], configured: true, supported: true })
      state.management = { ...state.management, credentials: [...state.management.credentials, created] }
      return { instanceUrl: args[2], credential: { id: created.id, domain: created.domain, configured: true } }
    },
    deleteCredential: async (...args) => {
      posts.push(['deleteCredential', ...args])
      state.management = { ...state.management, credentials: state.management.credentials.filter(entry => entry.id !== args[0]) }
      return { instanceUrl: args[2], deletedId: args[0], domain: args[1] }
    },
    ...overrides,
  }
  return { api, posts, reads, state, session: new SourceSession(api, () => {}) }
}

// The framework substitutes `{name}` placeholders; mirror that so assertions
// read the same text a user sees.
const t = (key, params) => {
  const text = zh[key]
  if (text === undefined) throw new Error('missing locale key ' + key)
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
}

// Deterministic hook driver for the real component (no DOM, no renderer).
function panelHarness() {
  const cells = []
  let index = 0, effects = [], props, tree
  const differs = (a, b) => !a || a.length !== b.length || a.some((v, i) => v !== b[i])
  const hooks = {
    useState(initial) {
      const i = index++
      cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next }]
    },
    useMemo(factory, deps) {
      const i = index++
      if (differs(cells[i]?.deps, deps)) cells[i] = { deps, value: factory() }
      return cells[i].value
    },
    useEffect(effect, deps) {
      const i = index++
      if (differs(cells[i]?.deps, deps)) effects.push(() => { cells[i]?.cleanup?.(); cells[i] = { deps, cleanup: effect() } })
    },
  }
  const mocks = {
    react: hooks,
    'react/jsx-runtime': require('react/jsx-runtime'),
    './sourceModel.ts': model,
  }
  const output = ts.transpileModule(readFileSync(new URL('../src/client/SourcePanel.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(id => {
    if (!(id in mocks)) throw new Error(`Unmocked import ${id}`)
    return mocks[id]
  }, module, module.exports)
  return {
    render(next = props) { props = next; index = 0; effects = []; tree = module.exports.SourcePanel(props); effects.forEach(run => run()); return tree },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}

function nodes(input) {
  if (Array.isArray(input)) return input.flatMap(nodes)
  if (typeof input === 'string' || typeof input === 'number') return [input]
  if (!input || typeof input !== 'object') return []
  return [input, ...nodes(input.props?.children)]
}
const elements = tree => nodes(tree).filter(node => node !== null && typeof node === 'object')
const find = (tree, predicate) => elements(tree).find(predicate)
const buttons = tree => elements(tree).filter(node => node.type === 'button')
const button = (tree, label) => buttons(tree).find(node => node.props.children === label)
const text = tree => nodes(tree).map(node => (typeof node === 'string' || typeof node === 'number' ? String(node) : '')).join(' ')
/** Every string reachable from the tree, except one password input's live value. */
function renderedStrings(tree) {
  const values = []
  for (const node of nodes(tree)) {
    if (typeof node === 'string' || typeof node === 'number') { values.push(String(node)); continue }
    const { children } = node?.props ?? {}
    if (typeof children === 'string' || typeof children === 'number') values.push(String(children))
  }
  return values
}
function attributeStrings(tree) {
  const values = []
  for (const node of elements(tree)) {
    for (const [name, value] of Object.entries(node.props ?? {})) {
      if (typeof value !== 'string') continue
      // A password input's `value` is the live edit buffer, not output; it is
      // asserted separately (and must be empty after success / instance change).
      if (name === 'value' && node.type === 'input' && node.props.type === 'password') continue
      values.push(value)
    }
  }
  return values
}

const panelProps = (api, overrides = {}) => ({ api, active: true, onClose: () => {}, onChanged: () => {}, t, ...overrides })

/* ------------------------------------------------------------------ *
 * 1. Read-only first: every required fact is visible, actions gated.
 * ------------------------------------------------------------------ */

test('read-only snapshot shows source facts, scheduler scope and observedAt wording', async () => {
  const h = panelHarness()
  h.render(panelProps(fixture().api))
  let tree = h.render()
  // First render is loading; the read is still allowed with writes denied.
  assert.equal(nodes(tree).some(n => n.props?.children === zh['sources.loading']), true)
  await flush()
  tree = h.render()
  const all = text(tree)
  assert.match(all, /#\s*5/)
  assert.match(all, /Example feed/)
  assert.match(all, /https:\/\/feeds\.example\.org/)            // feedOrigin
  assert.match(all, new RegExp(zh['sources.status.active']))    // status
  assert.match(all, /轮询间隔：90 分钟/)                          // poll interval
  assert.match(all, /连续失败：2/)                                // failures count
  assert.match(all, new RegExp(zh['sources.source.error']))     // hasError as fixed text
  assert.match(all, /2026-10-25/)                               // recordedFetchAt rendered
  // Scheduler: scope must be explicit, never implied to cover aggregation.
  assert.match(all, /仅来源轮询任务，不含聚合任务/)
  assert.match(all, new RegExp(zh['sources.scheduler.running']))
  assert.match(all, /来源轮询任务数：2/)
  assert.match(all, new RegExp(zh['sources.scheduler.noNextRun']))  // null next run is stated
  // observedAt must be labelled as the check time, not "now".
  const stamped = text(tree).match(/检查时间=observedAt：([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2})/)
  assert.ok(stamped, 'observedAt label missing')
  // Credentials: metadata only, unsupported domains are called out.
  assert.match(all, /mp\.weixin\.qq\.com/)
  assert.match(all, new RegExp(zh['sources.credential.supported']))
  assert.match(all, new RegExp(zh['sources.credential.unsupported']))
  assert.match(all, new RegExp(zh['sources.credential.unsupportedNote']))
  assert.match(all, new RegExp(zh['sources.credential.neverEcho']))
  h.unmount()
})

test('default deny disables every mutation while the read still works', async () => {
  const f = fixture({ loadManagement: async () => { f.reads.push('management'); return view({ sourceWritesAllowed: false, credentialWritesAllowed: false }) } })
  const h = panelHarness()
  h.render(panelProps(f.api)); await flush()
  const tree = h.render()
  assert.equal(f.reads.length, 1)
  // Read still renders the rows.
  assert.match(text(tree), /Example feed/)
  // Every mutating control is disabled...
  for (const label of [
    zh['sources.action.pause'], zh['sources.action.fetch'],
    zh['sources.action.delete'], zh['sources.create.submit'],
    zh['sources.createCredential.submit'], zh['sources.action.deleteCredential'],
  ]) {
    const control = button(tree, label)
    assert.ok(control, `missing control ${label}`)
    assert.equal(control.props.disabled, true, `${label} must be disabled by default`)
  }
  // ...and the explanation is present rather than a silent dead control.
  assert.match(text(tree), new RegExp(zh['sources.gateSourceOff']))
  assert.match(text(tree), new RegExp(zh['sources.gateCredentialOff']))
  // Even if a captured handler fires, nothing is posted.
  await button(tree, zh['sources.action.pause']).props.onClick()
  await button(tree, zh['sources.create.submit']).props.onClick()
  await button(tree, zh['sources.action.deleteCredential']).props.onClick()
  await flush()
  assert.deepEqual(f.posts, [])
  h.unmount()
})

/* ------------------------------------------------------------------ *
 * 2. Client-side validation, before any request.
 * ------------------------------------------------------------------ */

test('source create form validates feed URL, label and interval before posting', async () => {
  const f = fixture()
  f.session.start(); await flush()
  const attempts = [
    [['javascript:alert(1)', 'ok', '60'], 'sources.errInvalidFeedUrl'],
    [['https://u:p@example.org/feed', 'ok', '60'], 'sources.errInvalidFeedUrl'],
    [['https://example.org/feed', '   ', '60'], 'sources.errInvalidLabel'],
    [['https://example.org/feed', 'ok', '4'], 'sources.errInvalidInterval'],
    [['https://example.org/feed', 'ok', '12.5'], 'sources.errInvalidInterval'],
    [['https://example.org/feed', 'ok', ''], 'sources.errInvalidInterval'],
  ]
  for (const [args, key] of attempts) {
    assert.equal(await f.session.createSource(...args), false, JSON.stringify(args))
    assert.equal(f.session.note, key, JSON.stringify(args))
  }
  assert.deepEqual(f.posts, [])
  assert.equal(await f.session.createSource('https://example.org/feed.xml', ' My feed ', '60'), true)
  assert.deepEqual(f.posts, [['createSource', 'https://example.org/feed.xml', 'My feed', 60, instanceUrl]])
  // The mutation reply is not final state: a second read confirmed it.
  assert.equal(f.reads.length, 2)
  f.session.stop()
})

test('a 2xx write without the expected re-read delta is unconfirmed, not confirmed', async () => {
  const f = fixture({ createSource: async (...args) => { f.posts.push(['createSource', ...args]); return { instanceUrl: args[3], source: source({ id: 999 }) } } })
  f.session.start(); await flush()
  assert.equal(await f.session.createSource('https://example.org/feed.xml', 'My feed', '60'), false)
  assert.equal(f.session.note, 'sources.errUnconfirmed')
  assert.equal(f.session.stale, true, 'the snapshot stays readable but no longer authorizes writes')
  assert.equal(await f.session.createSource('https://example.org/other.xml', 'Other', '60'), false)
  assert.deepEqual(f.posts, [['createSource', 'https://example.org/feed.xml', 'My feed', 60, instanceUrl]])
  f.session.stop()
})

test('helpers reject unsafe input and free-text parsing never invents a number', () => {
  assert.equal(feedProblem('https://example.org/feed'), undefined)
  for (const bad of ['', 'ftp://example.org/feed', 'javascript:alert(1)', 'https://u:p@x.org/f', 'https://x.org/a b', 7]) {
    assert.equal(feedProblem(bad), 'sources.errInvalidFeedUrl', String(bad))
  }
  assert.equal(labelProblem('ok'), undefined)
  assert.equal(labelProblem('x'.repeat(121)), 'sources.errInvalidLabel')
  assert.equal(labelProblem('\u0000'), 'sources.errInvalidLabel')
  assert.equal(intervalProblem(5), undefined)
  assert.equal(intervalProblem(10080), undefined)
  for (const bad of [4, 10081, 1.5, NaN, -1]) assert.equal(intervalProblem(bad), 'sources.errInvalidInterval', String(bad))
  // Unknown statuses are shown as unknown, never echoed from upstream.
  assert.equal(statusKey('active'), 'sources.status.active')
  assert.equal(statusKey('paused'), 'sources.status.paused')
  assert.equal(statusKey('error'), 'sources.status.error')
  for (const odd of ['bogus', '', 'ACTIVE', 'active<script>']) assert.equal(statusKey(odd), 'sources.status.unknown', odd)
  assert.equal(parseInterval('60'), 60)
  assert.equal(parseInterval(' 60 '), 60)
  for (const bad of ['', '6 0', '12.5', '-5', '1e3', 'x', '123456', '0.5']) assert.equal(parseInterval(bad), undefined, bad)
})

test('unsupported domains are rejected client-side and never reach the API', async () => {
  const f = fixture()
  f.session.start(); await flush()
  for (const domain of ['bilibili.com', 'https://zhihu.com', 'zhihu.com:443', '']) {
    assert.equal(await f.session.createCredential(domain, 'a=1'), false, domain)
    assert.ok(['sources.errUnsupportedDomain', 'sources.errInvalidDomain'].includes(f.session.note), domain)
  }
  assert.deepEqual(f.posts, [])
  assert.equal(credentialDomainProblem('mp.weixin.qq.com'), undefined)
  assert.equal(credentialDomainProblem('zhihu.com'), undefined)
  assert.equal(credentialDomainProblem('bilibili.com'), 'sources.errUnsupportedDomain')
  assert.deepEqual(SUPPORTED_DOMAINS, ['mp.weixin.qq.com', 'zhihu.com'])
  // Supported domain + valid cookie does post, canonicalised.
  assert.equal(await f.session.createCredential(' MP.Weixin.QQ.com ', 'session=abc'), true)
  assert.deepEqual(f.posts, [['createCredential', 'mp.weixin.qq.com', 'session=abc', instanceUrl]])
  f.session.stop()
})

test('cookie input is validated locally and the pending value is cleared after submit', async () => {
  const f = fixture()
  f.session.start(); await flush()
  for (const bad of ['', 'no-equals', 'a=1\u0000']) {
    f.session.setCookie(bad)
    assert.equal(await f.session.createCredential('zhihu.com', bad), false)
    assert.equal(f.session.note, 'sources.errCookieInvalid')
  }
  assert.deepEqual(f.posts, [])
  assert.equal(cookieInputProblem('a=1; b=2'), undefined)
  f.session.setCookie(CANARY)
  assert.equal(await f.session.createCredential('zhihu.com', CANARY), true)
  assert.equal(f.session.cookie, '', 'cookie must be cleared after the attempt')
  assert.equal(JSON.stringify(f.posts).includes(CANARY), true, 'the value goes to the API once, by design') // explicit: the secret is posted, not stored
  assert.equal(f.posts.length, 1)
  f.session.stop()
})

/* ------------------------------------------------------------------ *
 * 3. Delete requires the exact origin; articles are retained.
 * ------------------------------------------------------------------ */

test('delete needs the exact displayed origin and always states articles are kept', async () => {
  const f = fixture()
  f.session.start(); await flush()
  assert.equal(await f.session.deleteSource(5, ''), false)
  assert.equal(f.session.note, 'sources.errConfirmRequired')
  assert.equal(await f.session.deleteSource(5, 'https://other.example'), false)
  assert.equal(f.session.note, 'sources.errConfirmMismatch')
  assert.equal(await f.session.deleteSource(5, ' https://feeds.example.org/feed.xml '), false)
  assert.deepEqual(f.posts, [])
  // Exact origin is accepted, and the confirmed value sent is the displayed one.
  assert.equal(await f.session.deleteSource(5, ' https://feeds.example.org '), true)
  assert.deepEqual(f.posts, [['deleteSource', 5, 'https://feeds.example.org', instanceUrl]])

  const h = panelHarness()
  const g = fixture()
  h.render(panelProps(g.api)); await flush()
  let tree = h.render()
  assert.match(text(tree), new RegExp(zh['sources.confirm.retained']))
  assert.match(button(tree, zh['sources.action.delete']).props.children, /保留已抓取文章/)
  const confirmInput = find(tree, node => node.type === 'input' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].includes('https://feeds.example.org'))
  assert.ok(confirmInput, 'confirmation input missing')
  assert.equal(button(tree, zh['sources.action.delete']).props.disabled, true)
  confirmInput.props.onChange({ target: { value: 'https://feeds.example.org' } }); tree = h.render()
  assert.equal(button(tree, zh['sources.action.delete']).props.disabled, false)
  await button(tree, zh['sources.action.delete']).props.onClick(); await flush()
  assert.deepEqual(g.posts, [['deleteSource', 5, 'https://feeds.example.org', instanceUrl]])
  h.unmount()
})

/* ------------------------------------------------------------------ *
 * 4. Instance identity.
 * ------------------------------------------------------------------ */

test('instance change discards the snapshot, clears the cookie and says why', async () => {
  const f = fixture()
  f.session.start(); await flush()
  f.session.setCookie(CANARY)
  assert.equal(f.session.cookie, CANARY)
  f.state.management = view({ instanceUrl: 'https://other.example', sources: [], credentials: [] })
  await f.session.refresh(true)
  assert.equal(f.session.view, null, 'stale rows from the old instance must be dropped')
  assert.equal(f.session.cookie, '', 'pending secret must be cleared')
  assert.equal(f.session.note, 'sources.errInstanceChanged')
  assert.equal(zh['sources.errInstanceChanged'], '实例已变更，已丢弃输入')
  // Nothing actionable remains, and no mutation can be attempted.
  assert.equal(await f.session.createSource('https://example.org/feed', 'x', '60'), false)
  assert.equal(f.session.note, 'sources.errNoSnapshot')
  f.session.stop()
})

test('a mutation reply from another instance is discarded instead of shown', async () => {
  const f = fixture({ createSource: async (...args) => { f.posts.push(['createSource', ...args]); return { instanceUrl: 'https://other.example' } } })
  f.session.start(); await flush()
  f.session.setCookie(CANARY)
  assert.equal(await f.session.createSource('https://example.org/feed', 'x', '60'), false)
  assert.equal(f.session.view, null)
  assert.equal(f.session.note, 'sources.errInstanceChanged')
  assert.equal(f.session.cookie, '')
  f.session.stop()
})

test('panel renders the instance-change notice and clears the password field', async () => {
  const f = fixture()
  const h = panelHarness()
  h.render(panelProps(f.api)); await flush()
  let tree = h.render()
  const cookieInput = find(tree, node => node.type === 'input' && node.props.type === 'password')
  assert.ok(cookieInput, 'password input missing')
  assert.equal(cookieInput.props.autoComplete, 'off')
  cookieInput.props.onChange({ target: { value: CANARY } }); tree = h.render()
  assert.equal(find(tree, node => node.props.type === 'password').props.value, CANARY)
  f.state.management = view({ instanceUrl: 'https://other.example' })
  await find(tree, node => node.type === 'button' && node.props.children === zh['sources.refresh']).props.onClick()
  await flush(); tree = h.render()
  assert.match(text(tree), /实例已变更，已丢弃输入/)
  // The whole tree is now canary-free, including the password field's value.
  assert.equal(text(tree).includes(CANARY), false)
  assert.equal(attributeStrings(tree).some(value => value.includes(CANARY)), false)
  assert.equal(find(tree, node => node.props.type === 'password'), undefined, 'form disappears without a snapshot')
  h.unmount()
})

/* ------------------------------------------------------------------ *
 * 5. Manual fetch: 200 is not "new articles", and the snapshot is re-read.
 * ------------------------------------------------------------------ */

test('manual fetch reports a finished request and newCandidates, then re-reads', async () => {
  const f = fixture({ fetchSource: async (...args) => { f.posts.push(['fetchSource', ...args]); return { instanceUrl: args[1], newCandidates: 0 } } })
  f.session.start(); await flush()
  assert.equal(await f.session.fetchSource(5), true)
  assert.deepEqual(f.posts, [['fetchSource', 5, instanceUrl]])
  assert.equal(f.session.note, 'sources.noteFetched')
  assert.equal(f.session.noteCount, 0)
  assert.equal(f.reads.length, 2, 'management must be re-read after the mutation')
  const message = t('sources.noteFetched', { count: 0 })
  assert.match(message, /请求已结束（200）/)
  assert.match(message, /newCandidates = 0/)
  assert.match(message, /0 表示本次未新增文章/)
  assert.doesNotMatch(message, /新增了|已抓取到/)
  // A paused source has nothing to fetch.
  f.session.view = { ...f.session.view, sources: [source({ status: 'paused' })] }
  assert.equal(await f.session.fetchSource(5), false)
  assert.equal(f.session.note, 'sources.errFetchNotAllowed')
  assert.equal(f.posts.length, 1)
  f.session.stop()
})

test('panel shows the fetch hint and only offers fetch on active/error sources', async () => {
  const f = fixture()
  const h = panelHarness()
  h.render(panelProps(f.api)); await flush()
  const tree = h.render()
  assert.match(text(tree), new RegExp(zh['sources.fetchHint'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(text(tree), new RegExp(zh['sources.pauseHint'].slice(0, 12)))
  assert.ok(button(tree, zh['sources.action.fetch']))
  f.state.management = view({ sources: [source({ status: 'paused' })] })
  await button(tree, zh['sources.refresh']).props.onClick(); await flush()
  const after = h.render()
  assert.equal(button(after, zh['sources.action.fetch']), undefined, 'paused sources must not offer a manual fetch')
  assert.equal(button(after, zh['sources.action.resume']).props.disabled, false)
  h.unmount()
})

/* ------------------------------------------------------------------ *
 * 6. Async safety: close, unmount, staleness.
 * ------------------------------------------------------------------ */

test('a read that resolves after close cannot update state', async () => {
  const late = deferred()
  const f = fixture({ loadManagement: () => late.promise })
  f.session.start()
  f.session.stop()
  late.resolve(view()); await flush()
  assert.equal(f.session.view, null)
  assert.equal(f.session.loading, false)
  assert.equal(f.session.note, '')
  assert.equal(f.session.cookie, '')
})

test('a mutation that resolves after close cannot update state or keep the secret', async () => {
  const late = deferred()
  const f = fixture({ createSource: () => late.promise })
  f.session.start(); await flush()
  const snapshot = f.session.view
  f.session.setCookie(CANARY)
  const attempt = f.session.createSource('https://example.org/feed', 'x', '60')
  f.session.stop()
  assert.equal(f.session.cookie, '', 'closing clears the pending secret')
  assert.equal(f.session.busy, false)
  const readsBefore = f.reads.length
  late.resolve({ instanceUrl }); await attempt; await flush()
  // No state written: same snapshot object, no confirmation note, no re-read.
  assert.equal(f.session.view, snapshot)
  assert.equal(f.session.note, '')
  assert.equal(f.reads.length, readsBefore, 'a closed panel must not issue a confirmation read')
})

test('panel ignores a late read after it is closed (active=false) and after unmount', async () => {
  for (const mode of ['closed', 'unmounted']) {
    const late = deferred()
    const f = fixture({ loadManagement: () => late.promise })
    const h = panelHarness()
    const props = panelProps(f.api)
    h.render(props)
    if (mode === 'closed') h.render({ ...props, active: false })
    else h.unmount()
    late.resolve(view()); await flush()
    // Re-render closed on purpose: re-mounting with active=true would launch a
    // fresh, legitimate read and is not the scenario under test. The point is
    // that the stopped session never captured the late snapshot, so the same
    // component instance cannot display it even when re-shown.
    const tree = h.render({ ...props, active: false })
    assert.equal(text(tree).includes('Example feed'), false, mode)
    assert.equal(text(tree).includes(zh['sources.scheduler.running']), false, mode)
    assert.equal(tree.props.hidden, true, mode)
    h.unmount()
  }
})

test('a failed re-read after a mutation is reported as unconfirmed and blocks further writes', async () => {
  let reads = 0
  const f = fixture({ loadManagement: async () => { reads++; if (reads > 1) throw new MarginApiError('boom', 503); return view() } })
  f.session.start(); await flush()
  assert.equal(await f.session.createSource('https://example.org/feed', 'x', '60'), false)
  assert.equal(f.session.note, 'sources.errUnconfirmed')
  assert.equal(f.session.stale, true)
  const before = f.posts.length
  await f.session.setSourceStatus(5, 'paused')
  assert.equal(f.posts.length, before, 'a stale snapshot must not authorize another mutation')
  assert.equal(f.session.note, 'sources.errNoSnapshot')
  f.session.stop()
})

/* ------------------------------------------------------------------ *
 * 7. Error mapping: fixed local text, no upstream passthrough.
 * ------------------------------------------------------------------ */

test('every error path maps to fixed local text without relaying upstream messages', async () => {
  const cases = [
    [new MarginApiError('CANARY upstream body', 403, 'writes_disabled'), 'sources.errWritesDisabled'],
    [new MarginApiError('CANARY', 409, 'instance_changed'), 'sources.errInstanceChanged'],
    [new MarginApiError('CANARY', 409, 'not_configured'), 'sources.errNotConfigured'],
    [new MarginApiError('CANARY', 400, 'unsupported_domain'), 'sources.errUnsupportedDomain'],
    [new MarginApiError('CANARY', 400, 'confirm_required'), 'sources.errConfirmRequired'],
    [new MarginApiError('CANARY', 409, 'confirmation_mismatch'), 'sources.errConfirmMismatch'],
    [new MarginApiError('CANARY', 400, 'invalid_feed_url'), 'sources.errInvalidFeedUrl'],
    [new MarginApiError('CANARY', 400, 'invalid_label'), 'sources.errInvalidLabel'],
    [new MarginApiError('CANARY', 400, 'invalid_interval'), 'sources.errInvalidInterval'],
    [new MarginApiError('CANARY', 400, 'invalid_domain'), 'sources.errInvalidDomain'],
    [new MarginApiError('CANARY', 400, 'invalid_cookie'), 'sources.errCookieInvalid'],
    [new MarginApiError('CANARY', 401, 'margin_unauthorized'), 'sources.errUnauthorized'],
    [new MarginApiError('CANARY', 404, 'margin_not_found'), 'sources.errNotFound'],
    [new MarginApiError('CANARY', 422, 'margin_rejected'), 'sources.errRejected'],
    [new MarginApiError('CANARY', 409, 'margin_conflict'), 'sources.errConflict'],
    [new MarginApiError('CANARY', 504, 'margin_timeout'), 'sources.errTimeout'],
    [new MarginApiError('CANARY', 500, 'margin_upstream_error'), 'sources.errUpstream'],
    [new MarginApiError('CANARY', 502, 'margin_bad_shape'), 'sources.errUpstream'],
    [new MarginApiError('CANARY', 405, 'method_not_allowed'), 'sources.errRequest'],
    // No code: fall back to the status, never the message.
    [new MarginApiError('CANARY', 403), 'sources.errUnauthorized'],
    [new MarginApiError('CANARY', 404), 'sources.errNotFound'],
    [new MarginApiError('CANARY', 409), 'sources.errConflict'],
    [new MarginApiError('CANARY', 422), 'sources.errRejected'],
    [new MarginApiError('CANARY', 504), 'sources.errTimeout'],
    [new MarginApiError('CANARY', 503), 'sources.errUpstream'],
    [new Error('CANARY raw network failure'), 'sources.errNetwork'],
    ['CANARY string', 'sources.errNetwork'],
  ]
  for (const [error, key] of cases) {
    assert.equal(sourceErrorKey(error), key, String(error.message ?? error))
    const rendered = t(key, { count: 0 })
    assert.equal(rendered.includes('CANARY'), false, key)
    assert.ok(rendered.length > 0, key)
  }
})

test('upstream text never reaches the panel: only the fixed key is rendered', async () => {
  const f = fixture({ setSourceStatus: async () => { throw new MarginApiError('CANARY https://x.org/feed?token=' + CANARY, 500, 'margin_upstream_error') } })
  const h = panelHarness()
  h.render(panelProps(f.api)); await flush()
  await button(h.render(), zh['sources.action.pause']).props.onClick()
  await flush()
  const tree = h.render()
  assert.equal(text(tree).includes('CANARY'), false)
  assert.equal(attributeStrings(tree).some(value => value.includes('CANARY')), false)
  assert.match(text(tree), new RegExp(zh['sources.errUpstream'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  h.unmount()
})

test('a cookie typed into the field never appears in rendered copy or error text', async () => {
  const f = fixture({ createCredential: async () => { throw new MarginApiError('CANARY rejected', 422, 'margin_rejected') } })
  const h = panelHarness()
  h.render(panelProps(f.api)); await flush()
  let tree = h.render()
  const input = find(tree, node => node.type === 'input' && node.props.type === 'password')
  input.props.onChange({ target: { value: CANARY } }); tree = h.render()
  // Before submit: the only place the value exists is the password field itself.
  assert.equal(text(tree).includes(CANARY), false)
  assert.equal(attributeStrings(tree).some(value => value.includes(CANARY)), false)
  await button(tree, zh['sources.createCredential.submit']).props.onClick(); await flush()
  tree = h.render()
  // After the failure: cleared everywhere, fixed error text only.
  assert.equal(text(tree).includes(CANARY), false)
  assert.equal(attributeStrings(tree).some(value => value.includes(CANARY)), false)
  assert.equal(find(tree, node => node.props.type === 'password').props.value, '')
  assert.match(text(tree), new RegExp(zh['sources.errRejected'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  h.unmount()
})

test('the panel never touches storage, document.cookie or the URL for the cookie', () => {
  for (const file of ['../src/client/SourcePanel.tsx', '../src/client/sourceModel.ts']) {
    const code = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(code, /localStorage|sessionStorage|document\.cookie|location\.(href|search|hash)\s*=/, file)
    assert.doesNotMatch(code, /console\.(log|info|warn|error|debug)/, file)
  }
  const api = readFileSync(new URL('../src/client/api.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(api, /localStorage|sessionStorage|console\./)
})

/* ------------------------------------------------------------------ *
 * 8. Mounting: the list viewport must survive opening the panel.
 * ------------------------------------------------------------------ */

// Compile SourcePanel once per harness so ReadingList's tree holds the real
// component identity (the two must share the harness's hook table).
function loadPanel(hooks, requireImpl = require) {
  const output = ts.transpileModule(readFileSync(new URL('../src/client/SourcePanel.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(id => {
    if (id === 'react') return hooks
    if (id === 'react/jsx-runtime') return requireImpl('react/jsx-runtime')
    if (id === './sourceModel.ts') return model
    throw new Error(`Unmocked panel import ${id}`)
  }, module, module.exports)
  return module.exports.SourcePanel
}

// ReadingList imports several siblings; stub them so this file proves only the
// mounting contract (the siblings have their own test files).
function listHarness() {
  const cells = []
  let index = 0, effects = [], props, tree
  const differs = (a, b) => !a || a.length !== b.length || a.some((v, i) => v !== b[i])
  const hooks = {
    useState(initial) {
      const i = index++
      cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next }]
    },
    useRef(initial) { const i = index++; cells[i] ??= { current: initial }; return cells[i] },
    useMemo(factory, deps) { const i = index++; if (differs(cells[i]?.deps, deps)) cells[i] = { deps, value: factory() }; return cells[i].value },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps) },
    useEffect(effect, deps) { const i = index++; if (differs(cells[i]?.deps, deps)) effects.push(() => { cells[i]?.cleanup?.(); cells[i] = { deps, cleanup: effect() } }) },
  }
  const mocks = {
    react: hooks,
    'react/jsx-runtime': require('react/jsx-runtime'),
    './api.ts': { MarginApiError },
    './sourceModel.ts': model,
    './ArticleReader.tsx': { ArticleReader: function ArticleReader() {} },
    './ImportPanel.tsx': { ImportPanel: function ImportPanel() {} },
    // The real panel component, so the tree assertion sees its actual name.
    // It is only inspected through props here; its hooks never run.
    './SourcePanel.tsx': { SourcePanel: loadPanel(hooks) },
    './readingStyles.ts': { readingStyles: '' },
    './readerModel.ts': { safeMarginUrl: value => { try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.href : null } catch { return null } } },
    './importModel.ts': {
      taskBelongsToInstance: () => true,
      ImportSession: class {},
      completed: () => true,
      submissionKey: () => '',
    },
  }
  const output = ts.transpileModule(readFileSync(new URL('../src/client/ReadingList.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(id => {
    if (!(id in mocks)) throw new Error(`Unmocked import ${id}`)
    return mocks[id]
  }, module, module.exports)
  return {
    render(next = props) { props = next; index = 0; effects = []; tree = module.exports.ReadingList(props); effects.forEach(run => run()); return tree },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}

test('the toolbar entry point opens a sibling viewport and keeps the list mounted', async () => {
  const f = fixture()
  const h = listHarness()
  const listView = {
    items: [], breakdown: [], total: 0, page: 1, pageSize: 30, totalPages: 1,
    scannedTotal: 0, upstreamTotal: 0, totalExact: true, truncated: false, writesAllowed: false,
    applied: { status: 'unprocessed', sourceType: null, query: null, limit: 30 },
  }
  const props = {
    t, loadList: async () => listView, loadCandidate: async () => ({}), setCandidateStatus: async () => ({}),
    sources: f.api,
  }
  h.render(props); await flush()
  let tree = h.render()
  const entry = button(tree, zh['sources.open'])
  assert.ok(entry, 'toolbar must offer the 来源与凭据 entry point')
  const listViewport = () => elements(tree).find(node => node.props?.className === 'margin-reading__viewport')
  assert.equal(listViewport().props.hidden, false)
  // Type into the filter first: its state must survive the open/close cycle.
  find(tree, node => node.type === 'input' && node.props.type === 'search').props.onChange({ target: { value: 'kept' } })
  tree = h.render()
  entry.props.onClick({ currentTarget: { focus() {} } })
  tree = h.render()
  assert.equal(listViewport().props.hidden, true, 'the list viewport is hidden, not unmounted')
  const panel = elements(tree).find(node => typeof node.type === 'function' && node.type.name === 'SourcePanel')
  assert.ok(panel, 'SourcePanel must be rendered as a sibling of the list')
  assert.equal(panel.props.active, true)
  // The list is still mounted with its state intact behind the panel.
  assert.equal(find(tree, node => node.type === 'input' && node.props.type === 'search').props.value, 'kept')
  await flush(); tree = h.render()
  // Close: the list comes back with the same filter, without a re-read.
  elements(tree).find(node => typeof node.type === 'function' && node.type.name === 'SourcePanel').props.onClose()
  tree = h.render()
  assert.equal(listViewport().props.hidden, false)
  assert.equal(find(tree, node => node.type === 'input' && node.props.type === 'search').props.value, 'kept')
  h.unmount()
})

test('without a sources face the entry point is absent and the list is unchanged', async () => {
  const h = listHarness()
  const listView = { items: [], breakdown: [], total: 0, page: 1, pageSize: 30, totalPages: 1, scannedTotal: 0, upstreamTotal: 0, totalExact: true, truncated: false, writesAllowed: false, applied: { status: 'unprocessed', sourceType: null, query: null, limit: 30 } }
  h.render({ t, loadList: async () => listView, loadCandidate: async () => ({}), setCandidateStatus: async () => ({}) })
  await flush()
  const tree = h.render()
  assert.equal(button(tree, zh['sources.open']), undefined)
  assert.equal(elements(tree).some(node => typeof node.type === 'function' && node.type.name === 'SourcePanel'), false)
  h.unmount()
})

test('browser-side models stay free of host-only imports so the client bundle can inline them', () => {
  const management = readFileSync(new URL('../src/management.ts', import.meta.url), 'utf8')
  // sourceModel reuses the host predicates (single source of truth for the
  // domain allowlist). That stays safe only while management.ts is pure.
  assert.doesNotMatch(management, /from ['"]node:/)
  assert.doesNotMatch(management, /^import\s+(?!type\b)/m)
  for (const file of ['../src/client/sourceModel.ts', '../src/client/SourcePanel.tsx']) {
    const code = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(code, /^import\s+(?!type\b).*from ['"]@deepseek-ai\/dsh-client/m)
  }
})

/* ------------------------------------------------------------------ *
 * 9. Real API: exact host contract, same-origin JSON POSTs.
 * ------------------------------------------------------------------ */

test('real API hits the documented routes with the documented bodies', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify({ instanceUrl }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const api = new MarginApi()
    await api.loadManagement()
    await api.createSource('https://example.org/feed', 'Label', 60, instanceUrl)
    await api.setSourceStatus(5, 'paused', instanceUrl)
    await api.fetchSource(5, instanceUrl)
    await api.deleteSource(5, 'https://example.org', instanceUrl)
    await api.createCredential('zhihu.com', CANARY, instanceUrl)
    await api.deleteCredential(3, 'zhihu.com', instanceUrl)

    assert.deepEqual(calls.map(call => call.url), [
      '/api/dsh-margin/management',
      '/api/dsh-margin/source-create',
      '/api/dsh-margin/source-update',
      '/api/dsh-margin/source-fetch',
      '/api/dsh-margin/source-delete',
      '/api/dsh-margin/credential-create',
      '/api/dsh-margin/credential-delete',
    ])
    assert.equal(calls[0].options, undefined, 'the read is a plain GET')
    for (const call of calls.slice(1)) {
      assert.equal(call.options.method, 'POST')
      assert.equal(call.options.headers['content-type'], 'application/json')
      assert.equal(call.options.url, undefined)
    }
    assert.deepEqual(JSON.parse(calls[1].options.body), { feedUrl: 'https://example.org/feed', label: 'Label', intervalMinutes: 60, instanceUrl })
    assert.deepEqual(JSON.parse(calls[2].options.body), { id: 5, status: 'paused', instanceUrl })
    assert.deepEqual(JSON.parse(calls[3].options.body), { id: 5, instanceUrl })
    assert.deepEqual(JSON.parse(calls[4].options.body), { id: 5, confirmOrigin: 'https://example.org', instanceUrl })
    assert.deepEqual(JSON.parse(calls[5].options.body), { domain: 'zhihu.com', cookie: CANARY, instanceUrl })
    assert.deepEqual(JSON.parse(calls[6].options.body), { id: 3, domain: 'zhihu.com', instanceUrl })
    // The secret only ever travels in the POST body — never the URL.
    for (const call of calls) assert.equal(call.url.includes(CANARY), false)
  } finally { globalThis.fetch = original }
})

test('API surfaces the host error code so the model can map it', async () => {
  const original = globalThis.fetch
  try {
    for (const [status, code] of [[403, 'writes_disabled'], [409, 'instance_changed'], [400, 'unsupported_domain']]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: { code, message: 'fixed host wording' } }), { status })
      await assert.rejects(
        new MarginApi().createSource('https://example.org/feed', 'L', 60, instanceUrl),
        error => error instanceof MarginApiError && error.status === status && error.code === code,
      )
    }
  } finally { globalThis.fetch = original }
})
