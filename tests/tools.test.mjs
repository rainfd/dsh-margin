import { test } from 'node:test'
import assert from 'node:assert/strict'
import { marginGetTool, marginListTool, marginMarkReadTool, marginMarkUnreadTool } from '../lib/tools.js'

test('GUI 正文扩展不会自动将文章全文放进 agent 工具结果', async () => {
  const tool = marginGetTool(() => ({
    getCandidate: async () => ({
      id: 865, title: '文章', sourceUrl: 'https://example.com/a',
      sourceType: 'rss', sourceDomain: 'example.com', status: 'unprocessed',
      isSavedToTrilium: false, category: null, tags: [], createdAt: '',
      summaryText: 'AI 摘要', summary: '原文摘录',
      contentMd: 'MARKDOWN_FULL_BODY_SENTINEL', contentText: 'TEXT_FULL_BODY_SENTINEL',
      contentFetchFailed: false,
    }),
  }))
  const result = await tool.execute({ id: 865 }, {})
  assert.match(result, /AI 摘要/)
  assert.match(result, /原文摘录/)
  assert.doesNotMatch(result, /FULL_BODY_SENTINEL/)
})

test('写工具默认拒绝执行，动态撤销权限后旧工具引用也不能写', async () => {
  let allowed = true, calls = 0
  const client = { setCandidateStatus: async (id, status) => { calls++; return { id, status } } }
  const disabled = marginMarkReadTool(() => client)
  assert.match(await disabled.execute({ id: 1 }, {}), /未启用/)
  const read = marginMarkReadTool(() => client, () => allowed)
  const unread = marginMarkUnreadTool(() => client, () => allowed)
  assert.match(await read.execute({ id: 1 }, {}), /设为 read/)
  assert.match(await unread.execute({ id: 1 }, {}), /设为 unprocessed/)
  allowed = false
  assert.match(await read.execute({ id: 1 }, {}), /未启用/)
  assert.equal(calls, 2)
})

test('工具写超时不虚报成功、不自动重试', async () => {
  let calls = 0
  const tool = marginMarkReadTool(() => ({ setCandidateStatus: async () => { calls++; throw new Error('timeout') } }), () => true)
  const result = await tool.execute({ id: 1 }, {})
  assert.match(result, /结果未确认/)
  assert.match(result, /不要自动重试/)
  assert.equal(calls, 1)
})

test('列表工具沿用有界全页过滤并告知不完整总数', async () => {
  let options
  const tool = marginListTool(() => ({ queryReadingList: async value => { options = value; return { total: 2, totalExact: false, scannedTotal: 100, items: [] } } }))
  const result = await tool.execute({ query: 'needle', sourceType: 'wechat' }, {})
  assert.equal(options.query, 'needle')
  assert.equal(options.sourceType, 'wechat')
  assert.match(result, /结果可能不完整/)
  assert.match(result, /100/)
})
