import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_MARGIN_CONFIG = join(mkdtempSync(join(tmpdir(), 'dsh-margin-ann-')), 'config.json')
const { makeRoutes } = await import('../lib/routes.js')
const { writeConfig } = await import('../lib/store.js')
const { codePointOffset, fingerprint, locateSelection, toNote, toHighlight } = await import('../lib/highlights.js')

const TOKEN = 'annotation-secret'
const TEXT = '第一段内容。第二段里有 needle 这个词。最后一段内容。'
const detail = () => ({
  id: 42, title: 'T', source_url: 'https://e.com/a', source_type: 'rss', source_domain: 'e.com', status: 'unprocessed',
  summary: 's', tags: [], is_saved_to_trilium: false, created_at: '2026-01-01T00:00:00Z',
  content_md: '# rendered markdown differs', content_text: TEXT, content_fetch_failed: false,
})
const noteRow = (o = {}) => ({ id: 5, candidate_id: 42, content: '我的笔记', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...o })
const highlightRow = (o = {}) => ({ id: 9, candidate_id: 42, note_id: null, start_offset: 12, end_offset: 18, selected_text: 'needle', color: '#f5d0a8', text_fingerprint: 'a'.repeat(16), created_at: '2026-01-01T00:00:00Z', ...o })

async function withHost({ permissions = {}, routes: extra = {}, candidate = () => ({ status: 200, body: detail() }) }, run) {
  const seen = []
  const upstream = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const entry = { method: req.method, path: req.url, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(entry)
      const key = `${req.method} ${req.url}`
      const handler = extra[key] ?? (req.url.startsWith('/api/candidates/42/notes') && req.method === 'GET' ? () => ({ body: { notes: [noteRow()], candidate_id: 42 } })
        : req.url.startsWith('/api/candidates/42/highlights') && req.method === 'GET' ? () => ({ body: [highlightRow()] })
          : req.url.startsWith('/api/candidates/42') ? () => candidate()
            : () => ({ status: 404, body: { error: { message: 'no route' } } }))
      const result = handler(entry)
      res.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
      res.end(result.status === 204 ? undefined : JSON.stringify(result.body))
    })
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const instanceUrl = `http://127.0.0.1:${upstream.address().port}`
  writeConfig({ baseUrl: instanceUrl, token: TOKEN, timeoutMs: 3000 })
  const all = makeRoutes({ requestRejection: () => undefined }, permissions)
  const host = createServer((req, res) => {
    const route = all.find(r => r.path === req.url.split('?')[0])
    if (!route) { res.writeHead(404); res.end(); return }
    route.handler(req, res)
  })
  await new Promise(r => host.listen(0, '127.0.0.1', r))
  const call = async (path, init) => {
    const response = await fetch(`http://127.0.0.1:${host.address().port}/api/dsh-margin${path}`, init)
    const raw = await response.text()
    return { status: response.status, text: raw, body: raw === '' ? undefined : JSON.parse(raw) }
  }
  const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try { await run({ call, post, seen, instanceUrl }) } finally {
    await new Promise(r => host.close(r))
    await new Promise(r => upstream.close(r))
  }
}

test('fingerprint matches Margin 16-hex SHA-256 convention', async () => {
  const value = await fingerprint('needle')
  assert.match(value, /^[0-9a-f]{16}$/)
  // Independently computed SHA-256('needle') prefix, so the contract is pinned.
  assert.equal(value, '09881f6ed93360a2')
})

test('UTF-16 indices convert to the code-point offsets Margin validates', () => {
  // Margin is a Python service: len()/slicing count code points, not UTF-16 units.
  assert.equal(codePointOffset('😀 needle', '😀 '.length), 2)
  assert.equal(codePointOffset('abc', 2), 2)
  assert.equal(codePointOffset('😀😀', 4), 2)
  assert.equal(codePointOffset('abc', 0), 0)
  assert.deepEqual(locateSelection('😀 needle tail', 'needle'), { ok: true, value: { start: 3, end: 9 } })
})

test('selection must exist in content_text, not in the rendered view', () => {
  assert.deepEqual(locateSelection(TEXT, 'needle'), { ok: true, value: { start: 12, end: 18 } })
  assert.equal(locateSelection(TEXT, 'rendered markdown').reason, 'not-found')
  assert.equal(locateSelection(TEXT, '   ').reason, 'empty')
  assert.equal(locateSelection(TEXT, '').reason, 'empty')
  assert.equal(locateSelection('x needle y needle z', 'needle').reason, 'ambiguous')
  assert.deepEqual(locateSelection('x needle y needle z', 'needle', 1), { ok: true, value: { start: 11, end: 17 } })
  assert.equal(locateSelection('x needle y needle z', 'needle', 5).reason, 'ambiguous')
})

test('annotation projections cap user text and reject impossible rows', () => {
  assert.equal(toNote(noteRow({ id: 0 })), undefined)
  assert.equal(toNote({ id: 1, candidate_id: 42, content: 5 }).content, '')
  const longNote = toNote(noteRow({ content: 'x'.repeat(30_000) }))
  assert.equal(longNote.content.length, 20_000)
  assert.equal(longNote.contentTruncated, true)
  assert.equal(longNote.contentLength, 30_000)
  assert.equal(toNote(noteRow()).contentTruncated, false)
  assert.equal(toNote(noteRow()).contentLength, '我的笔记'.length)
  assert.equal(toHighlight(highlightRow({ end_offset: 3 })), undefined)
  assert.equal(toHighlight(highlightRow({ start_offset: -1 })), undefined)
  assert.equal(toHighlight(highlightRow({ color: 'javascript:alert(1)' })).color, '#f5d0a8')
  assert.equal(toHighlight(highlightRow({ note_id: 0 })).noteId, null)
  assert.equal(toHighlight(highlightRow({ selected_text: 'x'.repeat(20_000) })).selectedText.length, 12_000)
})

test('annotations read is instance-bound and never leaks note text into metadata errors', async () => {
  await withHost({}, async ({ call, instanceUrl }) => {
    const result = await call(`/annotations?id=42&instanceUrl=${encodeURIComponent(instanceUrl)}`)
    assert.equal(result.status, 200)
    assert.equal(result.body.offsetsAvailable, true)
    assert.equal(result.body.notes[0].content, '我的笔记')
    assert.equal(result.body.highlights[0].start, 12)
    assert.equal(result.body.writesAllowed, false)
    assert.equal(result.text.includes(TOKEN), false)
    assert.equal((await call(`/annotations?id=42&instanceUrl=${encodeURIComponent('http://x')}`)).status, 409)
    assert.equal((await call('/annotations?id=0')).status, 400)
  })
})

test('all annotation writes are refused by default with no upstream mutation', async () => {
  await withHost({}, async ({ post, seen, instanceUrl }) => {
    const bodies = [
      ['/highlight-create', { candidateId: 42, selectedText: 'needle', instanceUrl }],
      ['/highlight-link', { highlightId: 9, noteId: 5, instanceUrl }],
      ['/highlight-delete', { highlightId: 9, candidateId: 42, selectedText: 'needle', instanceUrl }],
      ['/note-create', { candidateId: 42, content: 'x', instanceUrl }],
      ['/note-update', { noteId: 5, content: 'x', instanceUrl }],
      ['/note-delete', { noteId: 5, content: 'x', instanceUrl }],
    ]
    for (const [path, body] of bodies) {
      const result = await post(path, body)
      assert.equal(result.status, 403, path)
      assert.equal(result.body.error.code, 'writes_disabled', path)
    }
    assert.equal(seen.filter(req => req.method !== 'GET').length, 0)
  })
})

test('highlight creation recomputes offsets in content_text and posts Margin field names', async () => {
  await withHost({
    permissions: { allowHighlightWrites: () => true },
    routes: { 'POST /api/candidates/42/highlights': () => ({ status: 201, body: highlightRow() }) },
  }, async ({ post, seen, instanceUrl }) => {
    const result = await post('/highlight-create', { candidateId: 42, selectedText: 'needle', instanceUrl })
    assert.equal(result.status, 201)
    assert.equal(result.body.highlight.id, 9)
    const write = seen.find(req => req.method === 'POST')
    assert.deepEqual(JSON.parse(write.body), {
      start_offset: 12, end_offset: 18, selected_text: 'needle', text_fingerprint: await fingerprint('needle'),
    })
  })
})

test('highlight offsets are sent as code points even after non-BMP text', async () => {
  const emojiText = '😀 needle tail'
  await withHost({
    permissions: { allowHighlightWrites: () => true },
    candidate: () => ({ status: 200, body: { ...detail(), content_text: emojiText } }),
    routes: { 'POST /api/candidates/42/highlights': () => ({ status: 201, body: highlightRow() }) },
  }, async ({ post, seen, instanceUrl }) => {
    const result = await post('/highlight-create', { candidateId: 42, selectedText: 'needle', instanceUrl })
    assert.equal(result.status, 201)
    const write = seen.find(req => req.method === 'POST')
    const body = JSON.parse(write.body)
    assert.equal(body.start_offset, 2)
    assert.equal(body.end_offset, 8)
    assert.equal(body.selected_text, 'needle')
  })
})

test('a note with no pure-text body refuses highlight offsets', async () => {
  await withHost({
    permissions: { allowHighlightWrites: () => true },
    candidate: () => ({ status: 200, body: { ...detail(), content_text: '   ', content_md: '# only markdown' } }),
  }, async ({ post, seen, instanceUrl }) => {
    const result = await post('/highlight-create', { candidateId: 42, selectedText: 'only', instanceUrl })
    assert.equal(result.status, 422)
    assert.equal(result.body.error.code, 'offsets_unavailable')
    assert.equal(seen.filter(req => req.method === 'POST').length, 0)
  })
})

test('ambiguous, absent and untestable selections are refused instead of guessing offsets', async () => {
  await withHost({
    permissions: { allowHighlightWrites: () => true },
    routes: { 'POST /api/candidates/42/highlights': () => { throw new Error('must not write') } },
    candidate: () => ({ status: 200, body: detail() }),
  }, async ({ post, seen, instanceUrl }) => {
    const absent = await post('/highlight-create', { candidateId: 42, selectedText: 'rendered markdown', instanceUrl })
    assert.equal(absent.status, 422)
    assert.equal(absent.body.error.code, 'selection_not_located')
    const ambiguous = await post('/highlight-create', { candidateId: 42, selectedText: '内容', instanceUrl })
    assert.equal(ambiguous.status, 409)
    assert.equal(ambiguous.body.error.code, 'ambiguous_selection')
    // The count is structured, so the client never parses the sentence.
    assert.equal(ambiguous.body.error.count, 2)
    assert.equal(typeof ambiguous.body.error.message, 'string')
    assert.equal((await post('/highlight-create', { candidateId: 42, selectedText: '  ', instanceUrl })).status, 400)
    assert.equal((await post('/highlight-create', { candidateId: 42, selectedText: 'needle', instanceUrl, start: 0 })).status, 400)
    assert.equal(seen.filter(req => req.method === 'POST').length, 0)
  })
  await withHost({
    permissions: { allowHighlightWrites: () => true },
    candidate: () => ({ status: 200, body: detail() }),
  }, async ({ post, instanceUrl }) => {
    const nothing = await post('/highlight-create', { candidateId: 42, selectedText: 'x'.repeat(12_001), instanceUrl })
    assert.equal(nothing.status, 422)
  })
  await withHost({ permissions: { allowHighlightWrites: () => true } }, async ({ post, instanceUrl }) => {
    const rich = await post('/highlight-create', { candidateId: 42, selectedText: 'needle', instanceUrl, occurrence: -2 })
    assert.equal(rich.status, 400)
  })
})

test('note writes are gated separately, use PUT for whole-content updates, and require deletion proof', async () => {
  await withHost({
    permissions: { allowNoteWrites: () => true, allowHighlightWrites: () => false },
    routes: {
      'POST /api/candidates/42/notes': () => ({ status: 201, body: noteRow() }),
      'PUT /api/notes/5': () => ({ body: noteRow({ content: '改过' }) }),
      'DELETE /api/notes/5': () => ({ status: 204 }),
    },
  }, async ({ post, seen, instanceUrl }) => {
    assert.equal((await post('/highlight-create', { candidateId: 42, selectedText: 'needle', instanceUrl })).status, 403)
    const created = await post('/note-create', { candidateId: 42, content: '我的笔记', instanceUrl })
    assert.equal(created.status, 201)
    assert.equal(created.body.note.content, '我的笔记')
    const updated = await post('/note-update', { candidateId: 42, noteId: 5, content: '改过', expectedContent: '我的笔记', instanceUrl })
    assert.equal(updated.status, 200)
    assert.equal(seen.find(req => req.method === 'PUT').path, '/api/notes/5')
    assert.equal((await post('/note-delete', { noteId: 5, instanceUrl })).status, 400)
    // The proof is checked against live content, not merely "non-empty".
    assert.equal((await post('/note-delete', { noteId: 5, candidateId: 42, content: '改过', instanceUrl })).status, 409)
    assert.equal((await post('/note-delete', { noteId: 5, content: '我的笔记', instanceUrl })).status, 400)
    const deleted = await post('/note-delete', { noteId: 5, candidateId: 42, content: '我的笔记', instanceUrl })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.highlightsDetached, true)
    assert.equal(seen.filter(req => req.method === 'DELETE').length, 1)
    assert.equal((await post('/note-create', { candidateId: 42, content: 'x'.repeat(20_001), instanceUrl })).status, 400)
    assert.equal((await post('/note-create', { candidateId: 42, content: '   ', instanceUrl })).status, 400)
    // Whole-content update needs the content the editor started from.
    assert.equal((await post('/note-update', { candidateId: 42, noteId: 5, content: '改过', instanceUrl })).status, 400)
    const conflict = await post('/note-update', { candidateId: 42, noteId: 5, content: '改过', expectedContent: '旧内容', instanceUrl })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.code, 'confirmation_mismatch')
    assert.equal(seen.filter(req => req.method === 'PUT').length, 1)
    assert.equal((await post('/note-create', { candidateId: 42, content: 'x', instanceUrl: 'http://other' })).status, 409)
  })
})

test('a note longer than the projection is not rewritten or deleted from truncated content', async () => {
  const long = 'x'.repeat(20_001)
  await withHost({
    permissions: { allowNoteWrites: () => true },
    routes: {
      'GET /api/candidates/42/notes': () => ({ body: { notes: [noteRow({ content: long })] } }),
      'PUT /api/notes/5': () => { throw new Error('must not rewrite a truncated note') },
      'DELETE /api/notes/5': () => { throw new Error('must not delete a truncated note') },
    },
  }, async ({ post, seen, instanceUrl }) => {
    const update = await post('/note-update', { candidateId: 42, noteId: 5, content: 'short', expectedContent: 'x'.repeat(20_000), instanceUrl })
    assert.equal(update.status, 409)
    assert.equal(update.body.error.code, 'note_too_long')
    const remove = await post('/note-delete', { candidateId: 42, noteId: 5, content: 'x'.repeat(20_000), instanceUrl })
    assert.equal(remove.status, 409)
    assert.equal(remove.body.error.code, 'note_too_long')
    assert.equal(seen.filter(req => req.method === 'PUT' || req.method === 'DELETE').length, 0)
  })
})

test('highlight delete confirms against live text and preserves notes; link/unlink is explicit', async () => {
  await withHost({
    permissions: { allowHighlightWrites: () => true },
    routes: {
      'PATCH /api/highlights/9': entry => ({ body: highlightRow({ note_id: JSON.parse(entry.body).note_id }) }),
      'DELETE /api/highlights/9': () => ({ status: 204 }),
    },
  }, async ({ post, seen, instanceUrl }) => {
    assert.equal((await post('/highlight-delete', { highlightId: 9, candidateId: 42, selectedText: 'other', instanceUrl })).status, 409)
    assert.equal(seen.filter(req => req.method === 'DELETE').length, 0)
    const deleted = await post('/highlight-delete', { highlightId: 9, candidateId: 42, selectedText: 'needle', instanceUrl })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.notesPreserved, true)
    const linked = await post('/highlight-link', { highlightId: 9, noteId: 5, instanceUrl })
    assert.equal(linked.status, 200)
    assert.equal(linked.body.highlight.noteId, 5)
    const unlinked = await post('/highlight-link', { highlightId: 9, noteId: null, instanceUrl })
    assert.equal(unlinked.body.highlight.noteId, null)
    assert.equal((await post('/highlight-link', { highlightId: 9, noteId: 0, instanceUrl })).status, 400)
  })
})
