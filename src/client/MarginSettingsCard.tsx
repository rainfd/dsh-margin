/**
 * The dsh-margin settings card: one plugin card inside 插件 → dsh-margin
 * (plugins.bundle.config).
 *
 * Data path: reads/writes the host JSON store through the /api/dsh-margin
 * routes — the runtime source is ~/.dsh/dsh-margin.json (0600). The route
 * never returns the token, only whether one is set.
 */

// Keep the slot contract available to consumers of the emitted declarations.
export type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'

import { useEffect, useState, type CSSProperties } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarginApi } from './api.ts'
import type { MarginConfigView } from '../protocol.ts'

/** The registration-side face the slot entry injects. */
export interface MarginSettingsFace {
  api: MarginApi
}

/** Props the section renderer binds for the card. */
export type MarginSettingsCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'dsh-margin'>
  & InjectFace<MarginSettingsFace>

interface Form {
  baseUrl: string
  token: string
  timeoutMs: string
  tokenSet: boolean
}

const EMPTY: Form = { baseUrl: '', token: '', timeoutMs: '15000', tokenSet: false }

const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0', borderTop: '1px solid var(--dsw-alias-border-l2)' }
const labelStyle: CSSProperties = { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const hintStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.55 }
const inputStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-3)',
  height: 34,
  borderRadius: 8,
  padding: '0 12px',
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary)',
  outline: 'none',
}
const buttonStyle: CSSProperties = {
  height: 32,
  padding: '0 14px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-3)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  cursor: 'pointer',
}

/** One labelled text field. */
function TextField(props: {
  id: string
  label: string
  hint: string
  value: string
  disabled: boolean
  password?: boolean
  placeholder?: string
  onEdit: (value: string) => void
}) {
  return (
    <div style={fieldStyle}>
      <label style={labelStyle} htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        style={inputStyle}
        type={props.password === true ? 'password' : 'text'}
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        autoComplete="off"
        onChange={event => props.onEdit(event.target.value)}
      />
      <div style={hintStyle}>{props.hint}</div>
    </div>
  )
}

/** The settings card. */
export function MarginSettingsCard(props: MarginSettingsCardProps) {
  const { api, t } = props
  const [form, setForm] = useState<Form>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testDetail, setTestDetail] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api.loadConfig()
      .then((view: MarginConfigView) => {
        if (cancelled) return
        setForm({
          baseUrl: view.baseUrl,
          token: '',
          timeoutMs: String(view.timeoutMs),
          tokenSet: view.tokenSet,
        })
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '读取配置失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const parsed = Number(form.timeoutMs)
      const view = await api.saveConfig({
        baseUrl: form.baseUrl,
        // An untouched password field must not clear the stored token.
        ...(form.token === '' ? {} : { token: form.token }),
        ...(Number.isFinite(parsed) && parsed > 0 ? { timeoutMs: parsed } : {}),
      })
      setForm(current => ({ ...current, token: '', tokenSet: view.tokenSet }))
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestDetail('')
    try {
      const result = await api.test()
      setTestDetail(result.detail)
    } catch (cause) {
      setTestDetail(cause instanceof Error ? cause.message : '测试失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div>
      <div style={{ paddingBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{t('settings.title')}</div>
        <div style={{ ...hintStyle, marginTop: 4 }}>{t('settings.description')}</div>
      </div>
      <TextField
        id="dsh-margin-base-url"
        label={t('settings.baseUrl')}
        hint={t('settings.baseUrlHint')}
        value={form.baseUrl}
        disabled={loading}
        placeholder="http://127.0.0.1:3000"
        onEdit={value => setForm(current => ({ ...current, baseUrl: value }))}
      />
      <TextField
        id="dsh-margin-token"
        label={t('settings.token')}
        hint={t('settings.tokenHint')}
        value={form.token}
        disabled={loading}
        password
        placeholder={form.tokenSet ? t('settings.tokenSet') : t('settings.tokenUnset')}
        onEdit={value => setForm(current => ({ ...current, token: value }))}
      />
      <TextField
        id="dsh-margin-timeout"
        label={t('settings.timeout')}
        hint=""
        value={form.timeoutMs}
        disabled={loading}
        onEdit={value => setForm(current => ({ ...current, timeoutMs: value }))}
      />
      <div style={{ display: 'flex', gap: 8, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)', alignItems: 'center' }}>
        <button type="button" style={buttonStyle} disabled={saving || loading} onClick={() => { void save() }}>
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
        <button type="button" style={buttonStyle} disabled={testing || loading} onClick={() => { void test() }}>
          {testing ? t('settings.testing') : t('settings.test')}
        </button>
        {saved && <span style={{ ...hintStyle, color: 'var(--dsw-alias-label-secondary)' }}>{t('settings.saved')}</span>}
      </div>
      {testDetail !== '' && <div style={{ ...hintStyle, paddingTop: 8 }}>{testDetail}</div>}
      {error !== '' && <div style={{ ...hintStyle, paddingTop: 8, color: 'var(--dsw-alias-label-error, #d33)' }}>{error}</div>}
    </div>
  )
}
