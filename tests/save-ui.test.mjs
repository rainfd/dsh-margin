/**
 * spec006 (save to Trilium) — browser-half tests.
 *
 * Compiles only the pure model + the real API client (same pattern as the AI and
 * annotation UI tests), then drives the real SavePanel component through a
 * deterministic hook harness. No DOM, no network, no real Trilium write.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const temp = mkdtempSync(join(tmpdir(), 'dsh-margin-save-ui-'))
after(() => rmSync(temp, { recursive: true, force: true }))
writeFileSync(join(temp, 'package.json'), '{"type":"module"}')
execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
  '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext',
  '--skipLibCheck', '--rewriteRelativeImportExtensions', '--rootDir', 'src', '--outDir', temp,
  'src/client/saveModel.ts', 'src/client/api.ts', 'src/client/locales.ts'], { stdio: 'pipe' })

const model = await import(pathToFileURL(join(temp, 'client/saveModel.js')))
const apiModule = await import(pathToFileURL(join(temp, 'client/api.js')))
const { zh } = await import(pathToFileURL(join(temp, 'client/locales.js')))
const { SaveSession, saveInstance, saveErrorKey } = model
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

const state = (overrides = {}) => ({
  instanceUrl: instance, candidateId: 7, marginUrl: instance + '/reader/7',
  saved: false, saveRecordId: null, externalRef: null, savedAt: null,
  needsVerification: false, saveAllowed: true, ...overrides,
})

/* ------------------------------------------------------------------ *
 * Component harness: real hooks/elements, mocked module boundary.
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

const panelHarness = () => {
  const driver = hooksDriver()
  const Component = load('SavePanel.tsx', 'SavePanel', {
    './saveModel.ts': model,
    react: driver.hooks,
    'react/jsx-runtime': jsxRuntime,
  })
  let props
  return {
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

/** One fixture; `state` can be a function to script successive reads. */
function fixture(overrides = {}) {
  const calls = []
  const api = {
    loadSaveState: async (...args) => {
      calls.push(['load', ...args])
      return typeof overrides.state === 'function' ? overrides.state() : (overrides.state ?? state())
    },
    saveToTrilium: async (...args) => {
      calls.push(['save', ...args])
      if (typeof overrides.save === 'function') return overrides.save(...args)
      return state({ saved: true, saveRecordId: 7, externalRef: 'note-abc', savedAt: '2026-10-25T10:00:00Z' })
    },
    ...overrides.api,
  }
  return { api, calls }
}

const panelProps = f => ({ api: f.api, candidateId: 7, marginUrl: instance + '/reader/7', t })

async function openPanel(f) {
  const h = panelHarness()
  h.render(panelProps(f))
  await flush()
  return { h, tree: () => h.render() }
}

/* ------------------------------------------------------------------ *
 * Instance derivation and error mapping.
 * ------------------------------------------------------------------ */

test('the instance is derived from the reader URL without trusting other text', () => {
  assert.equal(saveInstance(instance + '/reader/7'), instance)
  assert.equal(saveInstance(instance + '/candidate/7'), instance)
  assert.equal(saveInstance('https://margin.example/base/reader/7/'), 'https://margin.example/base')
  for (const bad of ['', 'javascript:alert(1)', 'https://margin.example/reader/', 'not a url']) {
    assert.equal(saveInstance(bad), null, bad)
  }
})

test('error classes map to fixed copy and never relay upstream prose', () => {
  const cases = [[401, 'save.error.unauthorized'], [403, 'save.error.disabled'], [404, 'save.error.notFound'], [409, 'save.error.conflict'], [422, 'save.error.notConfigured'], [504, 'save.error.uncertain']]
  for (const [status, key] of cases) assert.equal(saveErrorKey(new MarginApiError('CANARY upstream', status)), key)
  assert.equal(saveErrorKey(new MarginApiError('already', 409, 'already_saved')), 'save.error.alreadySaved')
  assert.equal(saveErrorKey(new Error('CANARY')), 'save.error.network')
  for (const key of Object.values({ ...Object.fromEntries(cases) })) assert.equal(JSON.stringify(zh[key]).includes('CANARY'), false)
})

/* ------------------------------------------------------------------ *
 * Panel behaviour.
 * ------------------------------------------------------------------ */

test('opening reads once; a disabled or already-saved state never renders a write button', async () => {
  const disabled = fixture({ state: state({ saveAllowed: false }) })
  let { h, tree } = await openPanel(disabled)
  assert.equal(tree(), null, 'no permission and not saved: no chrome at all')
  assert.deepEqual(disabled.calls, [['load', 7, instance]])
  h.unmount()

  const saved = fixture({ state: state({ saved: true, saveRecordId: 3, externalRef: 'note-3', saveAllowed: false }) })
  ;({ h, tree } = await openPanel(saved))
  const current = tree()
  assert.ok(hasText(current, t('save.saved')))
  assert.ok(hasText(current, 'note-3'))
  assert.equal(button(current, t('save.button')), undefined)
  assert.equal(saved.calls.filter(call => call[0] === 'save').length, 0)
  h.unmount()
})

test('one explicit click posts exactly once and then shows the saved state', async () => {
  const f = fixture()
  const { h, tree } = await openPanel(f)
  button(tree(), t('save.button')).props.onClick()
  await flush()
  const current = tree()
  assert.deepEqual(f.calls[1], ['save', 7, instance, instance + '/reader/7'])
  assert.ok(hasText(current, t('save.saved')))
  assert.equal(f.calls.filter(call => call[0] === 'save').length, 1)
  assert.equal(button(current, t('save.button')), undefined)
  h.unmount()
})

test('a second click while the save is in flight is ignored', async () => {
  const pending = deferred()
  const f = fixture({ api: { saveToTrilium: (...args) => { f.calls.push(['save', ...args]); return pending.promise } } })
  const { h, tree } = await openPanel(f)
  const saveButton = button(tree(), t('save.button'))
  saveButton.props.onClick()
  tree()
  button(tree(), t('save.saving')).props.onClick()
  assert.equal(f.calls.filter(call => call[0] === 'save').length, 1)
  pending.resolve(state({ saved: true, saveRecordId: 7 }))
  await flush()
  assert.ok(hasText(tree(), t('save.saved')))
  h.unmount()
})

test('an ambiguous timeout is verified read-only and never resubmitted', async () => {
  const reads = []
  const f = fixture({
    state: () => {
      reads.push('read')
      return reads.length === 1 ? state() : state({ saved: true, saveRecordId: null })
    },
    api: {
      saveToTrilium: async (...args) => {
        f.calls.push(['save', ...args])
        throw new MarginApiError('timeout', 504, 'save_unconfirmed')
      },
    },
  })
  const { h, tree } = await openPanel(f)
  button(tree(), t('save.button')).props.onClick()
  await flush()
  const current = tree()
  assert.ok(hasText(current, t('save.saved')))
  assert.ok(hasText(current, t('save.unconfirmed')))
  assert.equal(f.calls.filter(call => call[0] === 'save').length, 1, 'no automatic retry')
  assert.ok(reads.length >= 2, 'one read-only verification happened')
  h.unmount()
})

test('a reply from another instance is discarded rather than painted as saved', async () => {
  const f = fixture({ api: { saveToTrilium: async (...args) => { f.calls.push(['save', ...args]); return state({ saved: true, saveRecordId: 7, instanceUrl: 'https://other.example' }) } } })
  const { h, tree } = await openPanel(f)
  button(tree(), t('save.button')).props.onClick()
  await flush()
  const current = tree()
  assert.ok(hasText(current, t('save.error.instanceChanged')))
  assert.equal(hasText(current, t('save.saved')), false)
  h.unmount()
})

test('a failed state read hides the action instead of offering a blind save', async () => {
  const f = fixture({ api: { loadSaveState: async () => { throw new MarginApiError('no', 401) } } })
  const { h, tree } = await openPanel(f)
  assert.equal(tree(), null)
  assert.equal(f.calls.filter(call => call[0] === 'save').length, 0)
  h.unmount()
})

test('a late save completion after unmount changes nothing and writes nothing else', async () => {
  const pending = deferred()
  const f = fixture({ api: { saveToTrilium: (...args) => { f.calls.push(['save', ...args]); return pending.promise } } })
  const { h, tree } = await openPanel(f)
  button(tree(), t('save.button')).props.onClick()
  h.unmount()
  pending.resolve(state({ saved: true, saveRecordId: 7 }))
  await flush()
  assert.equal(f.calls.filter(call => call[0] === 'save').length, 1)
})

test('the panel exposes no status, import, annotation or AI method', async () => {
  const f = fixture()
  const { h, tree } = await openPanel(f)
  assert.deepEqual(Object.keys(f.api).sort(), ['loadSaveState', 'saveToTrilium'])
  assert.equal(hasText(tree(), 'dangerouslySetInnerHTML'), false)
  h.unmount()

  const source = readFileSync(new URL('../src/client/SavePanel.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|localStorage|sessionStorage|setCandidateStatus|importUrl|runAi/)
  const modelSource = readFileSync(new URL('../src/client/saveModel.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(modelSource, /setCandidateStatus|importUrl|saveProgress|runAi/)
})
