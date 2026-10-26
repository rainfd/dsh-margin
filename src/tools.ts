/**
 * Agent tools (margin_*): the reading-list half of the capture loop.
 *
 * Reads are always available; explicit read/unread tools are registered only
 * when writes are enabled and recheck live authorization at execution.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MarginClient } from './margin.ts'
import type { MarginCandidate, MarginCandidateStatus, MarginReadStatus } from './protocol.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Compact single-line candidate summary. */
function candidateLine(candidate: MarginCandidate): string {
  const parts = [`#${candidate.id}`, candidate.title]
  if (candidate.sourceType !== '') parts.push(`[${candidate.sourceType}]`)
  if (candidate.sourceDomain !== '') parts.push(candidate.sourceDomain)
  parts.push(candidate.status)
  return parts.join('  ')
}

/** Render a candidate list. */
function renderCandidates(items: MarginCandidate[]): string {
  if (items.length === 0) return '（无结果）'
  return items.map(candidateLine).join('\n')
}

/** Resolve the client or return a refusal string the tool returns verbatim. */
function requireClient(client: MarginClient | undefined): MarginClient | string {
  if (client === undefined) return '尚未配置 Margin 地址或 token：请在 设置 → Margin 中填写。'
  return client
}

/** Render a thrown client error without leaking the token. */
function failure(error: unknown): string {
  return `Margin 请求失败：${error instanceof Error ? error.message : '未知错误'}`
}

/** Coerce one status argument. */
function toStatus(value: unknown): MarginCandidateStatus {
  return value === 'read' || value === 'processing' || value === 'error' ? value : 'unprocessed'
}

/** List reading items. */
export function marginListTool(getClient: () => MarginClient | undefined) {
  return defineTool({
    name: 'margin_list_candidates',
    description: 'List reading items (candidates) from the Margin content store, filtered by status and optionally by source type or free text. ' +
      'This is the reading backlog behind the task ledger — Margin holds the articles, Trilium holds the tasks. Read-only. ' +
      'Triggers: what should I read, list unread articles, show my reading queue, Margin backlog.',
    parameters: {
      status: {
        type: 'string',
        enum: ['unprocessed', 'read', 'processing', 'error'],
        description: 'Candidate status to list. Default unprocessed (the unread backlog).',
      },
      sourceType: {
        type: 'string',
        description: 'Filter by origin: rss, wechat, manual_url, github_research, video.',
      },
      query: {
        type: 'string',
        description: 'Free-text filter over title, domain and tags.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum items to return. Default 30, capped at 100.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args) {
      const client = requireClient(getClient())
      if (typeof client === 'string') return client
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 100) : 30
      try {
        const page = await client.queryReadingList({
          status: toStatus(args.status),
          sourceType: args.sourceType,
          query: args.query,
          limit,
        })
        const scope = page.totalExact ? '共' : `扫描 ${page.scannedTotal} 条后观察到（结果可能不完整）`
        return `Margin ${scope} ${page.total} 条匹配，返回 ${page.items.length} 条：\n${renderCandidates(page.items)}`
      } catch (error) {
        return failure(error)
      }
    },
  })
}

/** Read one candidate in full. */
export function marginGetTool(getClient: () => MarginClient | undefined) {
  return defineTool({
    name: 'margin_get_candidate',
    description: 'Read one Margin candidate in full: title, source URL, domain, category, tags, Margin\'s own AI summary and the extracted excerpt. ' +
      'Read-only. Triggers: show that article, what is candidate 865, open that link in Margin.',
    parameters: {
      id: { type: 'integer', required: true, description: 'Margin candidate id (the number in marginCandidateId).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args) {
      const client = requireClient(getClient())
      if (typeof client === 'string') return client
      const id = Number(args.id)
      if (!Number.isSafeInteger(id) || id <= 0) return 'id 必须是正整数。'
      try {
        const candidate = await client.getCandidate(id)
        if (candidate === undefined) return `Margin 中不存在 candidate ${id}。`
        const lines = [
          `#${candidate.id}  ${candidate.title}`,
          `链接：${candidate.sourceUrl}`,
          `来源：${candidate.sourceType}  ${candidate.sourceDomain}`,
          `状态：${candidate.status}${candidate.isSavedToTrilium ? '（已存 Trilium）' : ''}`,
          candidate.category === null ? '' : `分类：${candidate.category}`,
          candidate.tags.length === 0 ? '' : `标签：${candidate.tags.join('、')}`,
          candidate.createdAt === '' ? '' : `入库：${candidate.createdAt}`,
        ].filter(line => line !== '')
        if (candidate.summaryText !== '') lines.push('', `摘要：${candidate.summaryText}`)
        if (candidate.summary !== '') lines.push('', `原文摘录：${candidate.summary.slice(0, 2000)}`)
        return lines.join('\n')
      } catch (error) {
        return failure(error)
      }
    },
  })
}

/** Explicit, idempotent state assignment; recheck live permissions at execution. */
function statusTool(getClient: () => MarginClient | undefined, mayWrite: () => boolean, status: MarginReadStatus) {
  const read = status === 'read'
  return defineTool({
    name: read ? 'margin_mark_read' : 'margin_mark_unread',
    description: read
      ? 'Mark one Margin candidate as read (explicit value, never a toggle). Use only after the user states the article is finished. Triggers: mark it read, I finished this one, 这篇读完了.'
      : 'Set one Margin candidate to unread (explicit unprocessed value, never a toggle). Use only after an explicit user request to mark unread. Does not reopen Trilium tasks.',
    parameters: {
      id: { type: 'integer', required: true, description: 'Candidate id in the currently configured Margin instance.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value: string) => text(value) },
    async execute(args) {
      if (!mayWrite()) return 'Margin 写能力未启用。'
      const client = requireClient(getClient())
      if (typeof client === 'string') return client
      const id = Number(args.id)
      if (!Number.isSafeInteger(id) || id <= 0) return 'id 必须是正整数。'
      try {
        if (!mayWrite()) return 'Margin 写能力未启用。'
        const updated = await client.setCandidateStatus(id, status)
        return `已将 candidate ${updated.id} 设为 ${updated.status}。`
      } catch (error) {
        return `${failure(error)}；结果未确认，请先重新读取状态，不要自动重试写入。`
      }
    },
  })
}

export function marginMarkReadTool(getClient: () => MarginClient | undefined, mayWrite: () => boolean = () => false) {
  return statusTool(getClient, mayWrite, 'read')
}

export function marginMarkUnreadTool(getClient: () => MarginClient | undefined, mayWrite: () => boolean = () => false) {
  return statusTool(getClient, mayWrite, 'unprocessed')
}
