import {
  h, Fragment, useState, useEffect, call, ENGINE_FORM, Modal, Button, StateDot,
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconRefreshOutlineRegular,
} from './ui-shared.js'
import { Field } from './profile-dialogs.js'
import { EngineMark, engineDisplayName } from './engine-logos.js'

// Settings is the host's modal too: the same card and field metrics as the role
// dialog, with the primary action submitting the form inside it
// through the form attribute. The registry is shown in two groups — engines
// detected on this machine first, then the ones that need a CLI path — and a
// detected engine can be toggled into (or out of) the enabled set the role
// dialog offers.
export function EngineSettingsDialog({ view, workspace = null, refresh, readOnly, onClose }) {
  const seed = engineId => {
    const source = view.prefs?.engineConfigs?.[engineId]
    return { engineOptions: { ...source?.engineOptions } }
  }
  const [engines, setEngines] = useState([])
  const [enabled, setEnabled] = useState(() => view?.prefs?.enabledEngines ?? null)
  const [selected, setSelected] = useState('')
  const [draft, setDraft] = useState(() => seed(''))
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState('')
  const [checks, setChecks] = useState({})
  const [checking, setChecking] = useState('')
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const pick = engineId => {
    setSelected(engineId); setDraft(seed(engineId))
    setSaved(false); setError('')
  }
  const scan = async (id) => {
    if (id === '' || scanning !== '') return
    setScanning(id)
    setError('')
    try {
      const catalog = await call('engine-scan', { engine: id })
      setEngines(current => current.map(item => item.id === id ? { ...item, catalog } : item))
    } catch (failure) { setError(failure.message) }
    finally { setScanning('') }
  }
  useEffect(() => {
    let live = true
    void call('engine-detect').then(items => { if (live) setEngines(items) })
      .catch(failure => { if (live) setError(failure.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])
  const engine = engines.find(item => item.id === selected)
  const locked = busy || checking !== '' || scanning !== ''
  const detected = engines.filter(item => item.usable)
  const others = engines.filter(item => !item.usable)
  const enabledSet = enabled ?? detected.map(item => item.id)
  const toggleEnabled = async item => {
    if (locked || readOnly) return
    const next = enabledSet.includes(item.id) ? enabledSet.filter(id => id !== item.id) : [...enabledSet, item.id]
    setEnabled(next); setError('')
    try {
      const saved2 = await call('engine-enable-set', { engines: next })
      setEnabled(saved2.enabledEngines ?? next)
      await refresh(true)
    } catch (failure) { setError(failure.message); setEnabled(enabled) }
  }
  const checkKey = id => JSON.stringify([id, workspace?.id])
  const check = checks[checkKey(selected)]
  const inspect = async (all = false) => {
    if (locked || (!all && !engine)) return
    setChecking(all ? 'all' : selected); setError('')
    try {
      const items = all ? engines : [engine]
      await Promise.all(items.map(async item => {
        const key = checkKey(item.id)
        const result = await call('engine-check', { engine: item.id, ...seed(item.id), cwd: workspace?.cwd })
          .catch(failure => ({ ok: false, checks: [{ label: '检查失败', ok: false, message: failure.message }] }))
        setChecks(current => ({ ...current, [key]: result }))
      }))
    } finally { setChecking('') }
  }
  const editField = field => event => {
    const value = event.target.value
    setSaved(false)
    setDraft(current => ({ ...current, engineOptions: { ...current.engineOptions, [field.name]: value } }))
  }
  const run = async event => {
    event.preventDefault()
    if (locked || engine === undefined || readOnly) return
    setBusy(true); setError(''); setSaved(false)
    try {
      const values = { engine: engine.id, engineOptions: draft.engineOptions }
      await call('engine-config-set', values)
      await refresh(true)
      setChecks(current => Object.fromEntries(Object.entries(current).filter(([key]) => JSON.parse(key)[0] !== selected)))
      setSaved(true)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const fields = (engine?.fields ?? []).filter(field => field.target === 'engineOptions').map(field =>
    h(Field, { key: field.name, label: ({ bin: 'CLI 可执行文件', socket: '共享 Codex Socket' })[field.name] ?? field.label },
      field.type === 'select'
        ? h('select', { className: 'nodo-dialog-input nodo-dialog-select', disabled: locked || readOnly, value: draft.engineOptions[field.name] ?? field.default ?? '', onChange: editField(field) },
          ...field.choices.map(choice => h('option', { key: choice.value, value: choice.value }, choice.label)))
        : h('input', { className: 'nodo-dialog-input', disabled: locked || readOnly, value: draft.engineOptions[field.name] ?? '', onChange: editField(field),
          placeholder: field.name === 'bin' ? '自动检测' : field.placeholder, maxLength: 1000 })))
  const card = item => {
    const expanded = selected === item.id
    const result = checks[checkKey(item.id)]
    const on = item.usable && enabledSet.includes(item.id)
    // The card shows a bare version number whatever the CLI prints around it
    // ("codex-cli 0.163.0", "opencode v2.0.28"); a line with no version token
    // keeps the engine's own words.
    const rawVersion = result?.ok ? String(result.version || '').replace(/\s*\([^)]*\)/g, '').trim() : ''
    const version = result?.ok ? (/(?:^|\s)v?(\d[\w.]*(?:[-+][\w.]+)?)(?:\s|$)/.exec(rawVersion)?.[1] ?? rawVersion) : ''
    const caption = checking === 'all' || checking === item.id ? '检查中…'
      : result ? (result.ok ? version || '环境就绪' : '环境需要处理')
      : !item.usable || item.executable ? ''
      : item.nativeRuntime ? '原生' : '自定义路径'
    const title = engineDisplayName(item)
    return h('section', { key: item.id, className: 'nodo-engine-card', 'data-expanded': expanded ? '' : undefined, 'data-muted': item.usable ? undefined : '' },
      h('div', { className: 'nodo-engine-row' },
        h('button', { type: 'button', className: 'nodo-engine-toggle', disabled: locked,
          'aria-expanded': expanded, 'aria-controls': `nodo-engine-${item.id}`, onClick: () => pick(expanded ? '' : item.id) },
          h('span', { className: 'nodo-engine-mark', 'aria-hidden': true }, h(EngineMark, { engine: item.id })),
          h('span', { className: 'nodo-engine-name' }, h('strong', null, title),
            caption && h('span', { className: 'nodo-engine-caption', 'data-bad': result?.ok === false ? '' : undefined }, caption)),
          h('span', { className: 'nodo-chevron', 'data-open': expanded ? '' : undefined }, h(IconChevronDownOutlineRegular, { size: 14 }))),
        item.usable && h('button', { type: 'button', className: 'nodo-engine-switch', 'aria-pressed': on,
          'aria-label': `${on ? '停用' : '启用'} ${title}`, disabled: locked || readOnly,
          onClick: () => void toggleEnabled(item) })),
      expanded && h('div', { id: `nodo-engine-${item.id}`, className: 'nodo-engine-detail' },
        h('div', { className: 'nodo-engine-connection' },
          h('strong', null, h(StateDot, { state: check ? check.ok ? 'done' : 'error' : 'idle', size: 8 }), check ? check.ok ? '环境就绪' : '环境需要处理' : '未检查'),
          h(Button, { variant: 'outline', size: 'sm', disabled: locked || (engine.requiresCwd && !workspace), onClick: () => void inspect() },
            checking === selected ? '检查中…' : '检查连接')),
        h('form', { id: ENGINE_FORM, className: 'nodo-dialog-fields nodo-engine-fields', onSubmit: run, 'aria-label': '配置 Agent' },
          (fields.length > 0 || engine.executable || readOnly) && h('div', { className: 'nodo-engine-section' },
            fields.length > 0 && h('div', { className: 'nodo-engine-config' }, fields),
            engine.executable && h('p', { className: 'nodo-dialog-path' }, engine.executable),
            readOnly && h('p', { className: 'nodo-dialog-hint', role: 'status' }, '当前为只读模式。')),
          check && h('dl', { className: 'nodo-engine-section nodo-engine-check', role: 'status' },
            ...check.checks.map((entry, index) => h('div', { key: index, className: 'nodo-engine-check-row' },
              h('dt', null, h(StateDot, { state: entry.ok === null ? 'idle' : entry.ok ? 'done' : 'error', size: 6 }), entry.label),
              h('dd', { className: entry.ok === false ? 'nodo-bad' : undefined }, entry.message)))),
          h('div', { className: 'nodo-engine-section nodo-engine-scan' },
            h('strong', null, '模型清单', h('span', null, engine.catalog ? `${engine.catalog.models?.length ?? 0} 个` : '未扫描')),
            h(Button, { variant: 'outline', size: 'sm', disabled: locked || readOnly, onClick: () => void scan(selected) }, scanning === selected ? '扫描中…' : '扫描')),
          saved && h('p', { className: 'nodo-ok', role: 'status' }, 'Agent 配置已保存'))))
  }
  const heading = (title, items) => h('h3', { key: title, className: 'nodo-engine-group' }, title, h('span', null, items.length))
  const grid = (key, items) => items.length > 0 && h('div', { key, className: 'nodo-engine-grid' }, ...items.map(item => card(item)))
  return h(Modal, {
    open: true, onClose: () => { if (!locked) onClose() }, closeLabel: '关闭',
    title: '模型提供方与 Agent',
    className: 'nodo-dialog nodo-engine-dialog',
    contentClassName: 'nodo-engine-shell',
    footer: engine ? [
      h(Button, {
        key: 'run', type: 'submit', form: ENGINE_FORM, variant: 'primary', size: 'sm',
        disabled: locked || readOnly,
      }, busy ? '保存中…' : '保存'),
    ] : undefined,
  },
  h('div', { className: 'nodo-engine-content' },
    h('div', { className: 'nodo-engine-toolbar' },
      loading ? h('span', null, '正在检测本机 Agent…') : heading('已检测', detected),
      h(Button, { variant: 'ghost', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 14 }), title: '检查所有 Agent 的默认配置', disabled: locked || loading || !engines.length, onClick: () => void inspect(true) },
        checking === 'all' ? '检查中…' : '重新检查')),
    !loading && !engines.length && !error && h('p', { className: 'nodo-dialog-hint', role: 'status' }, '暂无可用 Agent'),
    grid('detected', detected),
    others.length > 0 && heading('未检测到', others),
    grid('others', others),
    error !== '' && h('p', { className: 'nodo-dialog-error', role: 'alert' }, error)))
}

// First-run onboarding: the engines we adapt and detected on this machine, one
// tap each to choose which to enable. Skipping (or closing) keeps them all —
// the host only marks onboarding done when the list arrives empty.
export function OnboardingDialog({ onDone }) {
  const [engines, setEngines] = useState(null)
  const [picked, setPicked] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void call('engine-detect').then(items => {
      if (!live) return
      const detected = items.filter(item => item.usable)
      setEngines(detected)
      setPicked(new Set(detected.map(item => item.id)))
    }).catch(failure => { if (live) { setEngines([]); setError(failure.message) } })
    return () => { live = false }
  }, [])
  // Closing must always hand back to the page: the write is best-effort, so an
  // old or read-only host cannot trap the user behind this dialog.
  const finish = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await call('engine-enable-set', { engines: picked ? [...picked] : [] }) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
    onDone()
  }
  const toggle = id => setPicked(current => {
    if (current.has(id) && current.size === 1) return current
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  return h(Modal, {
    open: true, onClose: () => void finish(), closeLabel: '跳过',
    title: '欢迎使用 Nodo',
    description: '检测到本机已安装 Nodo 适配的编码智能体。选择要启用的 Agent，随时可在设置中调整。',
    className: 'nodo-dialog nodo-onboard-dialog',
    contentClassName: 'nodo-engine-shell',
    footer: [
      h('span', { key: 'hint', className: 'nodo-dialog-leading nodo-dialog-hint' }, '新角色默认使用第一个启用的 Agent'),
      h(Button, { key: 'go', variant: 'primary', disabled: busy || picked === null || picked.size === 0, onClick: () => void finish() },
        busy ? '保存中…' : '开始使用'),
    ],
  },
  h('div', { className: 'nodo-engine-content' },
    engines === null && h('p', { className: 'nodo-dialog-hint', role: 'status' }, '正在检测本机 Agent…'),
    engines !== null && [
      h('h3', { key: 'group', className: 'nodo-engine-group' }, '在系统中已检测', h('span', null, engines.length)),
      h('div', { key: 'grid', className: 'nodo-engine-grid' }, ...engines.map(item => {
        const on = picked?.has(item.id) === true
        return h('button', { key: item.id, type: 'button', className: 'nodo-engine-card nodo-engine-pick', 'aria-pressed': on, disabled: busy, onClick: () => toggle(item.id) },
          h('span', { className: 'nodo-engine-mark', 'aria-hidden': true }, h(EngineMark, { engine: item.id })),
          h('span', { className: 'nodo-engine-name' }, h('strong', null, engineDisplayName(item)),
            h('span', { className: 'nodo-engine-caption' }, item.nativeRuntime ? '原生 Agent' : item.executable ? '已检测到' : '已配置自定义路径')),
          h('span', { className: 'nodo-engine-switch', 'aria-hidden': true }, on && h(IconCheckOutlineRegular, { size: 12 })))
      })),
      engines.length === 0 && h('p', { className: 'nodo-dialog-hint' }, '未检测到已适配的 Agent；安装 CLI 或在设置的 Agent 卡片中填写路径后即可使用。'),
    ],
    error !== '' && h('p', { className: 'nodo-dialog-error', role: 'alert' }, error)))
}
