/**
 * Registration tests: what the plugin mounts for a given cordis config.
 *
 * The invariant these lock down is the write gate: with `allowWrites: false`
 * (the default, and what the profile ships) the plugin must not register
 * margin_mark_read at all — not merely refuse at call time. A tool that is
 * listed can be called, so "not registered" is the only safe shape.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-margin-registration-'))
process.env.DSH_MARGIN_CONFIG = join(dir, 'dsh-margin.json')

const plugin = await import('../lib/index.js')

/**
 * Cordis hands volatile fields to apply() as references, not plain booleans.
 * Every case below uses this shape by default: a fake context that passes raw
 * booleans would have hidden the "switch can never be turned off" bug.
 */
const volatile = value => ({ get: () => value })

/** A minimal cordis-shaped context recording what the plugin registers. */
function fakeContext() {
  const tools = []
  const routes = []
  const sections = []
  const effects = []
  const ctx = {
    webServer: { register: route => { routes.push(route); return () => {} } },
    tools: { register: tool => { tools.push(tool); return () => {} } },
    systemPrompt: { section: section => { sections.push(section); return () => {} } },
    effect: (factory) => { effects.push(factory); return () => {} },
  }
  // cordis runs effect callbacks when the plugin's fiber activates; the fake
  // context must do the same or the mounting assertions test nothing.
  const mounted = { tools, routes, sections, effects, ctx }
  mounted.run = () => { for (const factory of effects) factory() }
  return mounted
}

/** Names of the tools a context ended up with. */
function toolNames(tools) {
  return tools.map(tool => tool.name).sort()
}

test('默认（allowWrites 缺省）不注册任何写工具', () => {
  const { ctx, tools, run } = fakeContext()
  plugin.apply(ctx, { enabled: volatile(true), announceToAgent: volatile(false) })
  run()
  assert.deepEqual(toolNames(tools), ['margin_get_candidate', 'margin_list_candidates'])
  assert.equal(toolNames(tools).includes('margin_mark_read'), false)
})

test('allowWrites:false 显式关闭时同样不注册写工具', () => {
  const { ctx, tools, run } = fakeContext()
  plugin.apply(ctx, { enabled: volatile(true), allowWrites: volatile(false), announceToAgent: volatile(false) })
  run()
  assert.equal(toolNames(tools).includes('margin_mark_read'), false)
  assert.equal(tools.length, 2, '只读阶段应恰好注册 2 个工具')
})

test('allowWrites:true 才注册 margin_mark_read', () => {
  const { ctx, tools, run } = fakeContext()
  plugin.apply(ctx, { enabled: volatile(true), allowWrites: volatile(true), announceToAgent: volatile(false) })
  run()
  assert.deepEqual(toolNames(tools), ['margin_get_candidate', 'margin_list_candidates', 'margin_mark_read'])
})

test('enabled:false 时什么都不注册', () => {
  const { ctx, tools, routes, sections } = fakeContext()
  plugin.apply(ctx, { enabled: volatile(false), announceToAgent: volatile(true) })
  assert.equal(tools.length, 0)
  assert.equal(routes.length, 0)
  assert.equal(sections.length, 0)
})

test('路由族始终注册 4 条', () => {
  const { ctx, routes, run } = fakeContext()
  plugin.apply(ctx, { enabled: volatile(true), announceToAgent: volatile(false) })
  run()
  assert.deepEqual(routes.map(route => route.path).sort(), [
    '/api/dsh-margin/candidate',
    '/api/dsh-margin/candidates',
    '/api/dsh-margin/config',
    '/api/dsh-margin/test',
  ])
})

test('announceToAgent 打开时注入能力边界说明', () => {
  const { ctx, sections } = fakeContext()
  plugin.apply(ctx, { enabled: volatile(true), allowWrites: volatile(false), announceToAgent: volatile(true) })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'plugin:dsh-margin')
  assert.match(sections[0].text, /Margin（阅读内容仓）/)
  assert.match(sections[0].text, /任务账本在 Trilium/)
})

test('announceToAgent 关闭时不注入', () => {
  const { ctx, sections } = fakeContext()
  plugin.apply(ctx, { enabled: volatile(true), announceToAgent: volatile(false) })
  assert.equal(sections.length, 0)
})

test('写工具的描述明确要求用户已确认读完', () => {
  const { ctx, tools, run } = fakeContext()
  plugin.apply(ctx, { enabled: volatile(true), allowWrites: volatile(true), announceToAgent: volatile(false) })
  run()
  const writeTool = tools.find(tool => tool.name === 'margin_mark_read')
  assert.ok(writeTool !== undefined)
  assert.match(writeTool.description, /never a toggle/)
  assert.match(writeTool.description, /finished/)
})

test('裸布尔与 volatile 引用两种形状都要正确', () => {
  for (const shape of [false, volatile(false)]) {
    const { ctx, tools, run } = fakeContext()
    plugin.apply(ctx, { enabled: true, allowWrites: shape, announceToAgent: false })
    run()
    assert.equal(toolNames(tools).includes('margin_mark_read'), false,
      'allowWrites=' + JSON.stringify(shape) + ' 时不得注册写工具')
  }
  for (const shape of [true, volatile(true)]) {
    const { ctx, tools, run } = fakeContext()
    plugin.apply(ctx, { enabled: true, allowWrites: shape, announceToAgent: false })
    run()
    assert.equal(toolNames(tools).includes('margin_mark_read'), true,
      'allowWrites=' + JSON.stringify(shape) + ' 时才注册写工具')
  }
})

test('volatile 引用取的是当前快照而不是恒真的对象', () => {
  // 这是修复前的真实故障：对象恒真 → 写工具总是被注册。
  let current = false
  const live = { get: () => current }
  const first = fakeContext()
  plugin.apply(first.ctx, { enabled: volatile(true), allowWrites: live, announceToAgent: volatile(false) })
  first.run()
  assert.equal(toolNames(first.tools).includes('margin_mark_read'), false)

  current = true
  const second = fakeContext()
  plugin.apply(second.ctx, { enabled: volatile(true), allowWrites: live, announceToAgent: volatile(false) })
  second.run()
  assert.equal(toolNames(second.tools).includes('margin_mark_read'), true)
})

test('参数被规范化为 JSON Schema（properties + required 数组）', () => {
  const { ctx, tools, run } = fakeContext()
  plugin.apply(ctx, { enabled: volatile(true), announceToAgent: volatile(false) })
  run()
  const getTool = tools.find(tool => tool.name === 'margin_get_candidate')
  assert.deepEqual(getTool.parameters.required, ['id'])
  assert.equal(getTool.parameters.properties.id.type, 'integer')
})
