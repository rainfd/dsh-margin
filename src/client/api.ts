/**
 * Browser-side API client for the /api/dsh-margin route family. The only data
 * access path the reading-list panel and settings card use — plain fetch,
 * same origin (loopback).
 */

import {
  MARGIN_API,
  type MarginApiErrorBody,
  type MarginCandidate,
  type MarginConfigPatch,
  type MarginConfigView,
  type MarginReadingView,
  type MarginTestResult,
} from '../protocol.ts'

/** Error carrying the route's JSON error message. */
export class MarginApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarginApiError'
  }
}

/** Parse a JSON response or throw a MarginApiError with the route's message. */
async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new MarginApiError('HTTP ' + response.status + '：响应不是合法 JSON')
  }
  if (!response.ok) {
    const envelope = body as MarginApiErrorBody
    const message = typeof envelope?.error?.message === 'string'
      ? envelope.error.message
      : 'HTTP ' + response.status
    throw new MarginApiError(message)
  }
  return body as T
}

/** Query-string helper. */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : '?' + text
}

/** The /api/dsh-margin client. */
export class MarginApi {
  /** Read the connection config (token presence only — never the token). */
  async loadConfig(): Promise<MarginConfigView> {
    return readJson<MarginConfigView>(await fetch(MARGIN_API + '/config'))
  }

  /** Store a config patch. */
  async saveConfig(patch: MarginConfigPatch): Promise<MarginConfigView> {
    return readJson<MarginConfigView>(await fetch(MARGIN_API + '/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }))
  }

  /** Probe the connection; a rejection comes back as ok:false, not a throw. */
  async test(): Promise<MarginTestResult> {
    return readJson<MarginTestResult>(await fetch(MARGIN_API + '/test', { method: 'POST' }))
  }

  /** Read the reading list. */
  async loadReadingList(options: {
    status?: string
    sourceType?: string
    q?: string
    limit?: number
  } = {}): Promise<MarginReadingView> {
    return readJson<MarginReadingView>(await fetch(MARGIN_API + '/candidates' + query(options)))
  }

  /** Read one candidate. */
  async loadCandidate(id: number): Promise<MarginCandidate> {
    return readJson<MarginCandidate>(await fetch(MARGIN_API + '/candidate' + query({ id })))
  }
}
