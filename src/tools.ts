/**
 * Agent tools (margin_*): the reading-list half of the capture loop.
 *
 * Read-only in this stage. `margin_mark_read` is defined here but only
 * registered when writes are explicitly enabled (see index.ts), so an agent
 * cannot change reading state by accident.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MarginClient } from './margin.ts'
import type { MarginCandidate, MarginCandidateStatus } from './protocol.ts'

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
        const page = await client.listCandidates({
          status: toStatus(args.status),
          sourceType: args.sourceType,
          query: args.query,
          limit,
        })
        return `Margin 共 ${page.total} 条匹配，返回 ${page.items.length} 条：\n${renderCandidates(page.items)}`
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
      if (!Number.isInteger(id) || id <= 0) return 'id 必须是正整数。'
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

/** Mark a candidate read. Registered only when writes are enabled. */
export function marginMarkReadTool(getClient: () => MarginClient | undefined) {
  return defineTool({
    name: 'margin_mark_read',
    description: 'Mark one Margin candidate as read (explicit value, never a toggle). ' +
      'Use only after the user states the article is finished. Triggers: mark it read, I finished this one, 这篇读完了.',
    parameters: {
      id: { type: 'integer', required: true, description: 'Margin candidate id to mark read.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args) {
      const client = requireClient(getClient())
      if (typeof client === 'string') return client
      const id = Number(args.id)
      if (!Number.isInteger(id) || id <= 0) return 'id 必须是正整数。'
      try {
        const updated = await client.setCandidateStatus(id, 'read')
        return `已将 candidate ${updated.id} 标记为 read：${updated.title}`
      } catch (error) {
        return failure(error)
      }
    },
  })
}
