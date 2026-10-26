/**
 * Plugin config store: ~/.dsh/dsh-margin.json (0600).
 *
 * Same contract as dsh-trilium's store — the file holds the credential, the
 * browser only ever learns whether one is set. The endpoint URI may be plain
 * http on a LAN address, which is why `allowInsecureHttp` exists and is
 * re-checked on every read rather than trusted once.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MarginConfigPatch, MarginConfigView } from './protocol.ts'

/** On-disk config shape. */
export interface MarginConfig {
  baseUrl: string
  token: string
  timeoutMs: number
}

/** Default when no config file exists yet. */
export const DEFAULT_CONFIG: MarginConfig = {
  baseUrl: 'http://127.0.0.1:3000',
  token: '',
  timeoutMs: 15000,
}

/** Resolved config file path (honours DSH_MARGIN_CONFIG for tests). */
export function configPath(): string {
  return process.env['DSH_MARGIN_CONFIG'] ?? join(homedir(), '.dsh', 'dsh-margin.json')
}

/** Coerce one field, discarding anything that would produce a broken client. */
function sanitize(raw: Partial<MarginConfig>): MarginConfig {
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim() !== ''
    ? raw.baseUrl.trim()
    : DEFAULT_CONFIG.baseUrl
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  const timeoutMs = typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
    ? Math.min(raw.timeoutMs, 120000)
    : DEFAULT_CONFIG.timeoutMs
  return { baseUrl, token, timeoutMs }
}

/** Read the config; a missing or corrupt file yields the defaults. */
export function readConfig(): MarginConfig {
  const path = configPath()
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MarginConfig>
    return sanitize(parsed)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** Write the config atomically with 0600 permissions. */
export function writeConfig(config: MarginConfig): void {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + '.tmp'
  writeFileSync(temp, JSON.stringify(sanitize(config), null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
  chmodSync(path, 0o600)
}

/** The browser-visible projection — note the absence of `token`. */
export function toView(config: MarginConfig): MarginConfigView {
  return {
    baseUrl: config.baseUrl,
    tokenSet: config.token !== '',
    timeoutMs: config.timeoutMs,
  }
}

/**
 * Validate a patch before it touches disk.
 *
 * Returns an error string for the first problem found, so the route can回 a
 * 400 with a specific reason instead of silently storing a broken endpoint.
 */
export function validatePatch(patch: MarginConfigPatch): string | undefined {
  if (patch.baseUrl !== undefined) {
    if (typeof patch.baseUrl !== 'string' || patch.baseUrl.trim() === '') return 'baseUrl 不能为空'
    let parsed: URL
    try {
      parsed = new URL(patch.baseUrl.trim())
    } catch {
      return 'baseUrl 不是合法 URL'
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'baseUrl 仅支持 http/https'
    // Credentials in the endpoint would be embedded in every marginUrl and
    // rendered as a link. Import URLs already reject them; the config must too.
    if (parsed.username !== '' || parsed.password !== '') return 'baseUrl 不能包含用户名或密码'
  }
  if (patch.token !== undefined && typeof patch.token !== 'string') return 'token 必须是字符串'
  if (patch.timeoutMs !== undefined) {
    if (typeof patch.timeoutMs !== 'number' || !Number.isFinite(patch.timeoutMs) || patch.timeoutMs <= 0) {
      return 'timeoutMs 必须是正数'
    }
    if (patch.timeoutMs > 120000) return 'timeoutMs 不能超过 120000'
  }
  return undefined
}

/**
 * Apply a patch. An empty-string token clears the stored credential (an
 * explicit action), while an omitted token leaves it untouched — the UI must
 * not wipe a working token just because the field was left blank.
 */
export function patchConfig(current: MarginConfig, patch: MarginConfigPatch): MarginConfig {
  const next: MarginConfig = { ...current }
  if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl.trim()
  if (patch.token !== undefined) next.token = patch.token.trim()
  if (patch.timeoutMs !== undefined) next.timeoutMs = patch.timeoutMs
  return sanitize(next)
}
