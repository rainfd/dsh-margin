import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { MarginClient, MarginAuthError, MarginRequestError, MarginShapeError } from '../src/margin.ts'
import { MARGIN_MAX_PDF_BYTES } from '../src/protocol.ts'

const token = 'private-import-token'
const row = (extra = {}) => ({ id: 42, status: 'processing', title: 'Queued', source_url: 'https://example.org/article', source_type: 'manual_url', created_at: '2026-10-25', ...extra })
const pdf = new TextEncoder().encode('%PDF-1.7\nnot parsed locally')

async function fakeHttp(handler, run, timeoutMs = 1500) {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) }
    seen.push(request)
    await handler(request, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    await run(new MarginClient({ baseUrl, token, timeoutMs }), seen, baseUrl)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

test('URL import requires HTTP202 and reports processing, not completion; exact JSON/auth', async () => {
  await fakeHttp((req, res) => json(res, row(), 202), async (client, seen, base) => {
    const task = await client.importUrl('https://example.org/article')
    assert.equal(task.status, 'processing')
    assert.equal(task.marginUrl, `${base}/reader/42`)
    assert.equal(task.errorMessage, null)
    assert.deepEqual(Object.keys(task).sort(), ['id', 'title', 'sourceUrl', 'sourceType', 'status', 'marginUrl', 'errorMessage', 'createdAt'].sort())
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].path, '/api/imports')
    assert.deepEqual(JSON.parse(seen[0].body), { url: 'https://example.org/article' })
    assert.equal(seen[0].headers['x-auth-token'], token)
    assert.equal(seen[0].headers.authorization, undefined)
    assert.equal(seen[0].headers.accept, 'application/json')
    assert.equal(seen[0].headers['content-type'], 'application/json')
  })
})

test('PDF is a real multipart file only with generated boundary and sanitized basename', async () => {
  await fakeHttp((req, res) => json(res, row({ source_type: 'pdf' }), 202), async (client, seen) => {
    assert.equal((await client.importPdf(pdf, '../nested\\folder\\na\u0000me";.PDF')).status, 'processing')
    const request = seen[0]
    assert.equal(request.path, '/api/imports/pdf')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers['x-auth-token'], token)
    assert.equal(request.headers.authorization, undefined)
    const boundary = /multipart\/form-data; boundary=(.+)/.exec(request.headers['content-type'])?.[1]
    assert.ok(boundary, 'fetch must generate the multipart boundary, not a manual content-type')
    const body = request.body.toString()
    assert.ok(body.startsWith(`--${boundary}\r\n`))
    assert.equal((body.match(/Content-Disposition:/g) ?? []).length, 1)
    assert.ok(body.includes('name="file"; filename="name.pdf"'))
    assert.ok(body.includes('Content-Type: application/pdf'))
    assert.ok(request.body.includes(pdf))
    assert.equal(body.includes('nested'), false)
    assert.equal(body.includes(token), false)
  })
})

test('PDF filename is capped at 128 characters with .pdf suffix', async () => {
  await fakeHttp((req, res) => json(res, row(), 202), async (client, seen) => {
    await client.importPdf(pdf, 'a'.repeat(300) + '.pdf')
    const filename = /filename="([^"]+)"/.exec(seen[0].body.toString())[1]
    assert.equal(filename.length, 128)
    assert.ok(filename.endsWith('.pdf'))
  })
})

test('invalid URL/PDF inputs are rejected before any request', async () => {
  await fakeHttp((req, res) => json(res, row(), 202), async (client, seen) => {
    for (const url of ['', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.org', 'https://example.org/' + 'x'.repeat(8192), null]) {
      await assert.rejects(() => client.importUrl(url), MarginShapeError)
    }
    for (const bytes of [new Uint8Array(), new Uint8Array(MARGIN_MAX_PDF_BYTES + 1), new TextEncoder().encode('not PDF'), new TextEncoder().encode('%PDF'), null]) {
      await assert.rejects(() => client.importPdf(bytes, 'a.pdf'), MarginShapeError)
    }
    for (const filename of ['', 'a.txt', '.pdf', '..pdf', '/folder/', null]) {
      await assert.rejects(() => client.importPdf(pdf, filename), MarginShapeError)
    }
    assert.equal(seen.length, 0)
  })
})

test('queue is bounded metadata only, sanitizes token/control text and preserves unknown status', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => row({ id: i + 1, status: 'complete', title: `\u0000${token} queued`, source_url: 'javascript:evil', error_message: `failed ${token}`, content_md: 'RAW BODY', token, created_at: {} }))
  await fakeHttp((req, res) => json(res, rows), async (client, seen) => {
    const tasks = await client.listImportQueue()
    assert.equal(seen[0].path, '/api/imports/queue?limit=20')
    assert.equal(tasks.length, 20)
    assert.equal(tasks[0].status, 'unknown')
    assert.equal(tasks[0].sourceUrl, '')
    assert.equal(tasks[0].createdAt, '')
    assert.equal(tasks[0].title.includes('\u0000'), false)
    assert.equal(JSON.stringify(tasks).includes(token), false)
    assert.equal(JSON.stringify(tasks).includes('RAW BODY'), false)
    assert.equal(tasks[0].errorMessage, 'failed [redacted]')
  })
})

test('queue and acknowledgements reject malformed shapes and unsafe IDs', async () => {
  for (const payload of [{ items: [] }, null, [row({ id: '42' })], [row({ id: 0 })], [row({ id: Number.MAX_SAFE_INTEGER + 1 })], [null]]) {
    await fakeHttp((req, res) => json(res, payload), async client => {
      await assert.rejects(() => client.listImportQueue(), MarginShapeError)
    })
  }
  for (const payload of [null, {}, row({ id: '42' }), row({ id: -1 }), row({ status: 'read' }), row({ status: 'complete' }), { task: row() }]) {
    await fakeHttp((req, res) => json(res, payload, 202), async client => {
      await assert.rejects(() => client.importUrl('https://example.org'), MarginShapeError)
    })
  }
  for (const status of [200, 201, 204]) {
    await fakeHttp((req, res) => json(res, row(), status), async client => {
      await assert.rejects(() => client.importUrl('https://example.org'), MarginShapeError)
    })
  }
})

test('getImportTask only exposes metadata, unknown never means success and missing stays undefined', async () => {
  await fakeHttp((req, res) => req.path.endsWith('/43') ? json(res, {}, 404) : json(res, row({ status: null, content_md: 'private body' })), async (client, seen) => {
    const task = await client.getImportTask(42)
    assert.equal(task.status, 'unknown')
    assert.equal(task.errorMessage, null)
    assert.equal('contentMd' in task, false)
    assert.equal(await client.getImportTask(43), undefined)
    assert.equal(seen[0].path, '/api/candidates/42')
    for (const id of ['42', 0, -1, NaN, Infinity]) await assert.rejects(() => client.getImportTask(id), MarginShapeError)
    assert.equal(seen.length, 2)
  })
  await fakeHttp((req, res) => json(res, row({ id: 43 })), async client => {
    await assert.rejects(() => client.getImportTask(42), MarginShapeError)
  })
})

test('409 and nested FastAPI errors keep category but scrub token, auth remains typed', async () => {
  for (const nested of [false, true]) {
    const error = { error: { message: `duplicate ${token}`, category: `conflict:${token}` } }
    await fakeHttp((req, res) => json(res, nested ? { detail: error } : error, 409), async client => {
      await assert.rejects(() => client.importUrl('https://example.org'), error => {
        assert.ok(error instanceof MarginRequestError)
        assert.equal(error.status, 409)
        assert.equal(error.category, 'conflict:[redacted]')
        assert.equal(error.message, 'duplicate [redacted]')
        return true
      })
    })
  }
  for (const status of [401, 403]) {
    await fakeHttp((req, res) => json(res, { error: { message: token } }, status), async client => {
      await assert.rejects(() => client.listImportQueue(), error => error instanceof MarginAuthError && !error.message.includes(token))
    })
  }
})

test('invalid JSON becomes shape error without echoing response text', async () => {
  await fakeHttp((req, res) => { res.writeHead(202); res.end(token) }, async client => {
    await assert.rejects(() => client.importUrl('https://example.org'), error => error instanceof MarginShapeError && !error.message.includes(token))
  })
})

test('timeout includes response body after headers have arrived', async () => {
  await fakeHttp((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); res.write('[') }, async client => {
    await assert.rejects(() => client.listImportQueue(), error => error instanceof MarginRequestError && error.status === 0 && error.message.includes('超时'))
  }, 60)
})
