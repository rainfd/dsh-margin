/**
 * dsh-margin — host half. Wraps the Margin reading-content store into DSH:
 * the /api/dsh-margin route family the browser half calls, and the margin_*
 * agent tools that let a session read the backlog behind the task ledger.
 *
 * Stage 1 is read-only by construction: no route and no tool writes to Margin
 * unless `allowWrites` is switched on in cordis.yml, which registers
 * margin_mark_read. The browser half (./client) renders the reading-list panel
 * (设置 → Margin, sidebar 待读).
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { MarginClient } from './margin.ts'
import { makeRoutes } from './routes.ts'
import { readConfig } from './store.ts'
import { marginGetTool, marginListTool, marginMarkReadTool } from './tools.ts'

/** Stable cordis plugin name. */
export const name = 'margin'

/** Services required before the Margin surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/**
 * Plugin config (cordis.yml). The connection (baseUrl/token/timeoutMs) lives
 * in ~/.dsh/dsh-margin.json (0600) and is edited on the settings page; only
 * behaviour switches are configurable here.
 */
export interface Config {
  enabled: Volatile<boolean>
  /** Register margin_mark_read and future write routes. */
  allowWrites: Volatile<boolean>
  /** Announce the plugin's capability boundary to the agent. */
  announceToAgent: Volatile<boolean>
}

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  allowWrites: z.boolean().default(false).volatile(),
  announceToAgent: z.boolean().default(true).volatile(),
})

/**
 * Read one boolean config switch.
 *
 * Cordis hands volatile fields to apply() as `Volatile<boolean>` references
 * (an object with `get()`), not as plain booleans — so `if (config.x)` is
 * always true and a switch can never be turned off. Accept both shapes so the
 * plugin works under the real loader and under a hand-built test context.
 */
function readSwitch(value: boolean | Volatile<boolean> | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  const reference = value as Volatile<boolean>
  if (typeof reference.get === 'function') return reference.get() === true
  return fallback
}

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 154

/** Build a client from the live config, or undefined when unconfigured. */
function client(): MarginClient | undefined {
  const config = readConfig()
  if (config.baseUrl === '' || config.token === '') return undefined
  return new MarginClient(config)
}

/**
 * The capability boundary the agent needs in order to not conflate the two
 * systems: Margin is the content store, Trilium is the task ledger, and this
 * plugin only reads the former.
 */
const MARGIN_GUIDANCE = [
  '## Margin（阅读内容仓）',
  '',
  'Margin 是链接类内容的仓库：RSS / 微信 / 视频 / 手动导入的文章都在这里，',
  '**任务账本在 Trilium**。两套系统的规模不匹配是正常的——Margin 是主要阅读场所，',
  'Trilium 里只有你主动建过的任务。',
  '',
  '工具：`margin_list_candidates`（待读/已读列表，可按来源筛选）、',
  '`margin_get_candidate`（单条详情与摘要）。',
  '',
  '边界：',
  '- Margin 只承载**链接**；名词类任务（如「整理年度发票」）不属于它，不要尝试为它查 candidate。',
  '- 只有用户明确说读完了，才可以把 candidate 标记为 read（且需要启用写入）。',
  '- `marginCandidateId` 只在所属实例内有效，跨实例 ID 不可混用。',
].join('\n')

/** Mount the Margin surfaces. */
export function apply(ctx: Context, config: Config): void {
  if (!readSwitch(config.enabled, true)) return
  const allowWrites = readSwitch(config.allowWrites, false)
  const announce = readSwitch(config.announceToAgent, true)

  const getClient = (): MarginClient | undefined => client()

  // Routes (loopback-only; see routes.ts).
  ctx.effect(() => {
    const disposers = makeRoutes().map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-margin: /api/dsh-margin routes')

  // Agent tools. Read-only always; the write tool is opt-in.
  ctx.effect(() => {
    const factories = [marginListTool(getClient), marginGetTool(getClient)]
    if (allowWrites) factories.push(marginMarkReadTool(getClient))
    const disposers = factories.map(factory => ctx.tools.register(factory))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-margin: margin_* tools')

  if (announce) {
    ctx.systemPrompt.section({
      name: 'plugin:dsh-margin',
      order: SECTION_ORDER,
      text: MARGIN_GUIDANCE,
    })
  }
}
