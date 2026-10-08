/**
 * Store tests: config sanitizing, patching, validation and the browser-visible
 * projection. The invariant every case protects is that `toView` never carries
 * the token.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-margin-store-'))
process.env.DSH_MARGIN_CONFIG = join(dir, 'dsh-margin.json')

const store = await import('../lib/store.js')

test('未配置时返回默认值', () => {
  const config = store.readConfig()
  assert.equal(config.baseUrl, 'http://127.0.0.1:3000')
  assert.equal(config.token, '')
  assert.equal(config.timeoutMs, 15000)
})

test('损坏的配置文件回退到默认值而不是抛错', () => {
  writeFileSync(process.env.DSH_MARGIN_CONFIG, '{ not json')
  const config = store.readConfig()
  assert.equal(config.baseUrl, 'http://127.0.0.1:3000')
})

test('写入后回读一致，且文件权限为 0600', () => {
  store.writeConfig({ baseUrl: 'http://8.134.185.171:3000', token: 'secret-token', timeoutMs: 20000 })
  const config = store.readConfig()
  assert.equal(config.baseUrl, 'http://8.134.185.171:3000')
  assert.equal(config.token, 'secret-token')
  assert.equal(config.timeoutMs, 20000)
  const mode = statSync(process.env.DSH_MARGIN_CONFIG).mode & 0o777
  assert.equal(mode, 0o600, '配置文件必须是 0600')
})

test('toView 绝不包含 token，只报告是否已设置', () => {
  const view = store.toView({ baseUrl: 'http://x:3000', token: 'secret-token', timeoutMs: 1000 })
  assert.deepEqual(Object.keys(view).sort(), ['baseUrl', 'timeoutMs', 'tokenSet'])
  assert.equal(view.tokenSet, true)
  assert.equal(JSON.stringify(view).includes('secret-token'), false)
})

test('token 为空时 tokenSet 为 false', () => {
  assert.equal(store.toView({ baseUrl: 'http://x:3000', token: '', timeoutMs: 1000 }).tokenSet, false)
})

test('patch 省略 token 时保留原 token（界面留空不等于清除）', () => {
  const next = store.patchConfig({ baseUrl: 'http://a:3000', token: 'keep-me', timeoutMs: 1000 }, { baseUrl: 'http://b:3000' })
  assert.equal(next.token, 'keep-me')
  assert.equal(next.baseUrl, 'http://b:3000')
})

test('patch 传空字符串才清除 token（显式动作）', () => {
  const next = store.patchConfig({ baseUrl: 'http://a:3000', token: 'keep-me', timeoutMs: 1000 }, { token: '' })
  assert.equal(next.token, '')
})

test('validatePatch 拒绝非法输入', () => {
  assert.equal(store.validatePatch({ baseUrl: '' }), 'baseUrl 不能为空')
  assert.equal(store.validatePatch({ baseUrl: 'not a url' }), 'baseUrl 不是合法 URL')
  assert.equal(store.validatePatch({ baseUrl: 'ftp://x' }), 'baseUrl 仅支持 http/https')
  assert.equal(store.validatePatch({ timeoutMs: -1 }), 'timeoutMs 必须是正数')
  assert.equal(store.validatePatch({ timeoutMs: 999999 }), 'timeoutMs 不能超过 120000')
  assert.equal(store.validatePatch({ timeoutMs: Number.NaN }), 'timeoutMs 必须是正数')
})

test('validatePatch 接受合法输入', () => {
  assert.equal(store.validatePatch({}), undefined)
  assert.equal(store.validatePatch({ baseUrl: 'http://127.0.0.1:3000', token: 't', timeoutMs: 5000 }), undefined)
})

test('超长的超时值被夹到上限而不是写进配置', () => {
  const next = store.patchConfig({ baseUrl: 'http://a:3000', token: 't', timeoutMs: 1000 }, { timeoutMs: 999999 })
  assert.equal(next.timeoutMs, 120000)
})

test('写入时把 token 两端空白去掉', () => {
  store.writeConfig({ baseUrl: 'http://a:3000', token: '  padded  ', timeoutMs: 1000 })
  assert.equal(store.readConfig().token, 'padded')
})

test('配置文件确实是 JSON 且字段完整', () => {
  store.writeConfig({ baseUrl: 'http://a:3000', token: 't', timeoutMs: 1000 })
  const parsed = JSON.parse(readFileSync(process.env.DSH_MARGIN_CONFIG, 'utf8'))
  assert.deepEqual(Object.keys(parsed).sort(), ['baseUrl', 'timeoutMs', 'token'])
})
