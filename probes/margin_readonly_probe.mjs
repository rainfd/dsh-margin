/**
 * Read-only probe against a configured Margin instance: proves the plugin's
 * client parses real data, and that the route family answers the reading-list
 * request the sidebar makes.
 *
 * Read-only by construction — the client is only asked to LIST and GET; no
 * write path is exercised. Credentials come from the plugin's own store
 * (~/.dsh/dsh-margin.json), never from argv or the environment, and are never
 * printed.
 *
 * Usage: node probes/margin_readonly_probe.mjs [--base <url>]
 */

import { createServer } from 'node:http'
import { readConfig } from '../lib/store.js'
import { MarginClient } from '../lib/margin.js'
import { makeRoutes } from '../lib/routes.js'

const argv = process.argv.slice(2)
const baseIndex = argv.indexOf('--base')
const baseOverride = baseIndex >= 0 ? argv[baseIndex + 1] : undefined

/** Fail loudly rather than printing a partial result. */
function die(message) {
  process.stderr.write(`✗ ${message}\n`)
  process.exit(1)
}

const config = readConfig()
const baseUrl = baseOverride ?? config.baseUrl
if (config.token === '') die('未配置 token：先运行插件设置页或写入 ~/.dsh/dsh-margin.json')

const client = new MarginClient({ baseUrl, token: config.token, timeoutMs: config.timeoutMs })
process.stdout.write(`Margin 只读探针\n  实例: ${baseUrl}\n  token: 已加载（不回显）\n\n`)

let failed = 0
const check = (label, ok, detail) => {
  process.stdout.write(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : '  — ' + detail}\n`)
  if (!ok) failed += 1
}

// 1. Connection probe.
try {
  const counts = await client.probe()
  check('连接与鉴权', true, `未读 ${counts.unprocessed} / 已读 ${counts.read}`)
} catch (error) {
  die(`连接失败：${error instanceof Error ? error.message : String(error)}`)
}

// 2. Reading list: parse real rows.
const page = await client.listCandidates({ status: 'unprocessed', limit: 10 })
check('待读列表解析', page.items.length > 0, `共 ${page.total} 条，取回 ${page.items.length} 条`)
const hasShape = page.items.every(item =>
  Number.isInteger(item.id) && typeof item.title === 'string' && typeof item.sourceUrl === 'string')
check('条目字段完整', hasShape, 'id/title/sourceUrl 均为预期类型')

// 3. Breakdown matches the total.
const tally = await client.tallyBySource('unprocessed')
const summed = [...tally.counts.values()].reduce((a, b) => a + b, 0)
check('来源分布合计等于总数', summed === tally.total, `${summed} vs ${tally.total}`)
if (tally.truncated) check('分页未截断', false, '超过最大页数，分布可能不完整')

process.stdout.write('\n来源分布：\n')
for (const [sourceType, count] of [...tally.counts.entries()].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`  ${sourceType.padEnd(16)} ${count}\n`)
}

// 4. Single candidate.
const first = page.items[0]
const one = await client.getCandidate(first.id)
check(`单条读取（#${first.id}）`, one !== undefined && one.id === first.id, one?.title.slice(0, 40))

// 5. Missing id must be undefined, not a throw.
const missing = await client.getCandidate(999999999)
check('不存在的 id 返回 undefined', missing === undefined)

// 6. Route family answers the sidebar's request, through a real socket.
// Test-only gate for this loopback harness, not the real DSH session service.
// Production route admission is covered by registration/routes tests and must
// still be verified through an authenticated existing GUI session.
const routes = makeRoutes({
  requestRejection(req) {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers['sec-fetch-site'] === 'cross-site') return 403
    if (req.headers.origin !== undefined && new URL(req.headers.origin).host !== req.headers.host) return 403
    return undefined
  },
})
const host = createServer((req, res) => {
  const route = routes.find(candidate => req.url.split('?')[0] === candidate.path)
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  void route.handler(req, res)
})
await new Promise(resolve => host.listen(0, '127.0.0.1', resolve))
try {
  const port = host.address().port
  const response = await fetch(`http://127.0.0.1:${port}/api/dsh-margin/candidates?status=unprocessed&limit=5`)
  const body = await response.json()
  check('GET /candidates 返回 200', response.status === 200, `HTTP ${response.status}`)
  check('视图含 items/breakdown/total', Array.isArray(body.items) && Array.isArray(body.breakdown) && typeof body.total === 'number',
    `items=${body.items?.length} breakdown=${body.breakdown?.length} total=${body.total}`)
  check('视图不含 token', JSON.stringify(body).includes(config.token) === false)

  const blocked = await fetch(`http://127.0.0.1:${port}/api/dsh-margin/config`, { headers: { 'sec-fetch-site': 'cross-site' } })
  check('cross-site 请求被 403 拒绝', blocked.status === 403, `HTTP ${blocked.status}`)
} finally {
  await new Promise(resolve => host.close(resolve))
}

process.stdout.write(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}\n`)
process.exit(failed === 0 ? 0 : 1)
