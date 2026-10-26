import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'lightningcss'

const source = await readFile(new URL('../src/client/ReadingList.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/client/readingStyles.ts', import.meta.url), 'utf8')
const css = styles.slice(styles.indexOf('`') + 1, styles.lastIndexOf('`'))

// The live Theme inspect contract: unsupported aliases previously lost borders
// and secondary text in this panel. Keep the styles on the public token surface.
const themeTokens = new Set([
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay', '--dsw-alias-border-l1', '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary', '--dsw-specific-sidebar-fill',
])

test('reading page CSS compiles and references only inspected theme tokens', () => {
  assert.ok(transform({ filename: 'reading.css', code: Buffer.from(css) }).code.length > 0)
  for (const [, token] of css.matchAll(/var\((--[\w-]+)/g)) assert.ok(themeTokens.has(token), token)
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|\brgba?\(/i)
})

test('reading page controls do not import Harness client implementation modules', () => {
  assert.doesNotMatch(source, /import\s+(?!type\b).*from ['"]@deepseek-ai\/dsh-client/)
  assert.match(source, /<style>\{readingStyles\}<\/style>/)
})

test('reading page retains accessible filters and safe Margin reader links', () => {
  assert.match(source, /aria-pressed=\{active\}/)
  assert.match(source, /aria-label=\{t\('list.searchPlaceholder'\)\}/)
  assert.match(source, /href=\{marginUrl\}/)
  assert.match(source, /rel="noopener noreferrer"/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /@media \(max-width: 640px\)/)
})
