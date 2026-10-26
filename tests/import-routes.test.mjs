import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_MARGIN_CONFIG = join(mkdtempSync(join(tmpdir(), 'dsh-margin-import-routes-')), 'config.json')
const { makeRoutes } = await import('../lib/routes.js')
const { validImportUrl } = await import('../lib/importRoutes.js')
const { writeConfig } = await import('../lib/store.js')
const { MARGIN_MAX_PDF_BYTES } = await import('../lib/protocol.js')
const TOKEN = 'test-import-secret'
const task = { id: 77, title: 'Accepted', source_url: 'https://example.com/a', source_type: 'manual_url', status: 'processing' }

async function withHost(handler, permissions, run) {
  const seen = []
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    seen.push({ method: req.method, path: req.url, headers: req.headers, body })
    const result = await handler(seen.at(-1))
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result.body))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const instanceUrl = `http://127.0.0.1:${upstream.address().port}`
  writeConfig({ baseUrl: instanceUrl, token: TOKEN, timeoutMs: 2000 })
  const routes = makeRoutes({ requestRejection: req => req.headers['x-deny'] === 'yes' ? 403 : undefined }, permissions)
  const host = createServer((req, res) => {
    const route = routes.find(r => r.path === req.url.split('?')[0])
    if (!route) { res.writeHead(404); res.end(); return }
    route.handler(req, res)
  })
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve))
  const call = async (path, init) => {
    const response = await fetch(`http://127.0.0.1:${host.address().port}/api/dsh-margin${path}`, init)
    return { status: response.status, body: await response.json() }
  }
  const form = (bytes = Buffer.from('%PDF-1.7\n\0binary\xff'), type = 'application/pdf') => {
    const result = new FormData()
    result.append('instanceUrl', instanceUrl)
    result.append('file', new Blob([bytes], { type }), '../sample.pdf')
    return result
  }
  try { await run({ call, seen, instanceUrl, form }) } finally {
    await new Promise(resolve => host.close(resolve))
    await new Promise(resolve => upstream.close(resolve))
  }
}

const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('URL validator rejects local literals, credentials and dangerous schemes without fetching URLs', () => {
  for (const url of ['http://localhost/a', 'http://host.local/', 'http://127.1/', 'http://0x7f000001/', 'http://10.1.2.3/', 'http://169.254.169.254/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://[::1]/', 'ftp://example.com/', 'https://user:pass@example.com/', ' https://example.com/', 'bad']) assert.equal(validImportUrl(url), false, url)
  assert.equal(validImportUrl('https://example.com/article?q=1'), true)
})

test('import paths fail closed independently, including raw direct requests and session rejection', async () => {
  await withHost(() => { throw new Error('must not contact upstream') }, {}, async ({ call, seen, form }) => {
    assert.equal((await call('/import-url', json({ url: 'https://example.com/' }))).status, 403)
    assert.equal((await call('/import-pdf', { method: 'POST', body: form() })).status, 403)
    for (const path of ['/imports', '/import-task?id=77', '/import-url', '/import-pdf']) {
      assert.equal((await call(path, { headers: { 'x-deny': 'yes' } })).status, 403)
    }
    assert.equal(seen.length, 0)
  })
})

test('URL POST is explicitly accepted, instance-bound, and forwarded exactly once', async () => {
  await withHost(() => ({ status: 202, body: task }), { allowUrlImports: () => true }, async ({ call, seen, instanceUrl }) => {
    const result = await call('/import-url', json({ instanceUrl, url: 'https://example.com/a' }))
    assert.equal(result.status, 202)
    assert.equal(result.body.instanceUrl, instanceUrl)
    assert.equal(result.body.task.status, 'processing')
    assert.equal(result.body.task.marginUrl, `${instanceUrl}/reader/77`)
    assert.equal(JSON.stringify(result.body).includes(TOKEN), false)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].path, '/api/imports')
    assert.deepEqual(JSON.parse(seen[0].body), { url: 'https://example.com/a' })
    assert.equal(seen[0].headers['x-auth-token'], TOKEN)
    assert.equal((await call('/import-url', json({ instanceUrl: 'http://other', url: 'https://example.com/a' }))).status, 409)
    for (const body of [null, [], {}, { instanceUrl, url: 'file:///tmp/a' }, { instanceUrl, url: 'http://127.0.0.1/' }, { instanceUrl, url: 'https://example.com/', path: '/tmp/file' }]) assert.equal((await call('/import-url', json(body))).status, 400)
    assert.equal(seen.length, 1)
  })
})

test('URL permission is checked after body read and PDF permission remains separate', async () => {
  let checks = 0
  await withHost(() => { throw new Error('must not write') }, { allowUrlImports: () => ++checks === 1 }, async ({ call, instanceUrl, form, seen }) => {
    assert.equal((await call('/import-url', json({ instanceUrl, url: 'https://example.com/' }))).status, 403)
    assert.equal(checks, 2)
    assert.equal((await call('/import-pdf', { method: 'POST', body: form() })).status, 403)
    assert.equal(seen.length, 0)
  })
})

test('PDF is binary multipart file-only upstream, with no host/client filesystem path', async () => {
  await withHost(() => ({ status: 202, body: { ...task, source_type: 'pdf', source_url: 'local-pdf://hash' } }), { allowPdfImports: () => true }, async ({ call, form, instanceUrl, seen }) => {
    const bytes = Buffer.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255, 128])
    const result = await call('/import-pdf', { method: 'POST', body: form(bytes) })
    assert.equal(result.status, 202)
    assert.equal(result.body.task.status, 'processing')
    assert.equal(result.body.instanceUrl, instanceUrl)
    assert.equal(seen.length, 1)
    const upload = seen[0]
    assert.equal(upload.path, '/api/imports/pdf')
    assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/)
    const parsed = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': upload.headers['content-type'] }, body: upload.body }).formData()
    assert.deepEqual([...parsed.keys()], ['file'])
    assert.equal(parsed.get('file').name, 'sample.pdf')
    assert.deepEqual(Buffer.from(await parsed.get('file').arrayBuffer()), bytes)
    assert.equal(JSON.stringify(result.body).includes('binary'), false)
  })
})

test('PDF rejects wrong magic, MIME, empty, excess parts and oversize before upstream', async () => {
  await withHost(() => { throw new Error('must not write') }, { allowPdfImports: () => true }, async ({ call, form, seen }) => {
    for (const f of [form(Buffer.from('not pdf')), form(Buffer.alloc(0)), form(Buffer.from('%PDF-1'), 'image/png')]) assert.equal((await call('/import-pdf', { method: 'POST', body: f })).status, 422)
    const extra = form(); extra.append('path', '/etc/passwd')
    assert.equal((await call('/import-pdf', { method: 'POST', body: extra })).status, 400)
    const repeated = form(); repeated.append('file', new Blob(['%PDF-']), 'second.pdf')
    assert.equal((await call('/import-pdf', { method: 'POST', body: repeated })).status, 400)
    assert.equal((await call('/import-pdf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400)
    const large = Buffer.alloc(MARGIN_MAX_PDF_BYTES + 1); large.write('%PDF-')
    assert.equal((await call('/import-pdf', { method: 'POST', body: form(large) })).status, 413)
    // No Content-Length: the running byte bound, not just preflight, must stop it.
    const streamed = Readable.from([Buffer.alloc(MARGIN_MAX_PDF_BYTES + 70 * 1024)])
    assert.equal((await call('/import-pdf', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=chunked-test' }, body: streamed, duplex: 'half' })).status, 413)
    assert.equal(seen.length, 0)
  })
})

test('queue exposes live grants, preserves unknown status; single task lookup cannot mix instances', async () => {
  let allowed = true
  await withHost(req => req.path.startsWith('/api/imports/queue')
    ? { body: [{ ...task, status: 'future_state', error_message: null }] }
    : req.path === '/api/candidates/88' ? { status: 404, body: { error: { message: 'gone' } } }
      : { body: { ...task, content_md: 'PRIVATE_BODY', error_message: 'fail' } },
  { allowUrlImports: () => allowed }, async ({ call, instanceUrl, seen }) => {
    const queue = await call('/imports')
    assert.equal(queue.status, 200)
    assert.equal(queue.body.urlAllowed, true)
    assert.equal(queue.body.pdfAllowed, false)
    assert.equal(queue.body.recentLimit, 20)
    assert.equal(queue.body.tasks[0].status, 'unknown')
    allowed = false
    assert.equal((await call('/imports')).body.urlAllowed, false)
    const result = await call('/import-task?id=77&instanceUrl=' + encodeURIComponent(instanceUrl))
    assert.equal(result.body.task.id, 77)
    assert.equal(JSON.stringify(result.body).includes('PRIVATE_BODY'), false)
    assert.equal((await call('/import-task?id=88&instanceUrl=' + encodeURIComponent(instanceUrl))).status, 404)
    const before = seen.length
    assert.equal((await call('/import-task?id=77&instanceUrl=http://other')).status, 409)
    assert.equal((await call('/import-task?id=0&instanceUrl=' + encodeURIComponent(instanceUrl))).status, 400)
    assert.equal(seen.length, before)
    assert.ok(seen.every(req => req.method === 'GET'))
  })
})

test('duplicate errors do not invent existing candidate IDs, and unknown acceptance is not retried', async () => {
  await withHost(() => ({ status: 409, body: { error: { message: 'duplicate', category: 'import_failed' } } }), { allowUrlImports: () => true }, async ({ call, instanceUrl, seen }) => {
    const result = await call('/import-url', json({ instanceUrl, url: 'https://example.com/a' }))
    assert.equal(result.status, 409)
    assert.equal(result.body.error.category, 'import_failed')
    assert.equal('task' in result.body, false)
    assert.equal(seen.length, 1)
  })
})
