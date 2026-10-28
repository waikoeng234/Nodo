import { h, Fragment, useState, useEffect, useRef, call, Menu, Modal, Button, ROLE_FORM, IconEditOutlineRegular, IconEllipsisOutlineRegular } from './ui-shared.js'
import { avatarTemplateOf, RoleAvatar } from './avatar.tsx'
import { engineDisplayName } from './engine-logos.js'
import { modelChoices, thinkingAfterModelChange, thinkingOptions } from './model-options.js'
import AVATAR_TEMPLATES from '../../core/shared/avatar-templates.json'
import ROLE_PRESETS from '../../core/shared/role-presets.json'

export function Field({ label, children, group = false, required = false }) {
  return h(group ? 'div' : 'label', { className: 'nodo-field', role: group ? 'group' : undefined,
    'aria-label': group ? label : undefined },
  h('span', null, label, required && h('span', { className: 'nodo-field-required', 'aria-hidden': true }, '*')), children)
}

// A role card as the editor sees it.
/**
 * @typedef {{ id?: string, name?: string, identity?: string, engine?: string, role?: string, instructions?: string,
 *   lead?: boolean, avatarTemplate?: string, model?: string, thinking?: string,
 *   taskTypes?: string[], hard?: Record<string, string>, sessions?: { id: string, draftedAt?: number, briefSent?: boolean }[] }} RoleCard
 */

/**
 * @param {{ profile?: RoleCard | null, avatarSeed?: number, enabledEngines?: string[] | null,
 *   savedIdentities?: unknown[] | null, refresh?: ((force?: boolean) => Promise<void>) | null, readOnly?: boolean,
 *   onSaved: (saved: { id: string }) => Promise<void> | void, onCancel: () => void,
 *   onDeleted: (item: { id: string }) => Promise<void> | void, onDirtyChange?: ((dirty: boolean) => void) | null,
 *   deleteReason?: string, deleteHint?: string }} props
 */
export function RoleEditor({ profile = null, avatarSeed = 0, enabledEngines = null, savedIdentities = null, refresh = null, readOnly = false, onSaved, onCancel, onDeleted, onDirtyChange, deleteReason, deleteHint }) {
  // Saved identities ride prefs, so the picker offers them to every later new
  // role and a deleted role card never takes its saved identity along.
  const lead = profile?.lead === true
  const saved = !lead && Array.isArray(savedIdentities) ? savedIdentities : []
  const presets = ROLE_PRESETS.filter(item => (item.name === 'leader') === lead)
  const allPresets = [...presets, ...saved]
  const [draft, setDraft] = useState({
    name: profile?.name ?? '', identity: profile?.identity ?? '', engine: profile?.engine ?? '', role: profile?.role ?? '',
    instructions: profile?.instructions ?? '',
    avatarTemplate: profile ? avatarTemplateOf(profile).id : AVATAR_TEMPLATES[avatarSeed % AVATAR_TEMPLATES.length].id,
    model: profile?.model ?? '', thinking: profile?.thinking ?? '',
  })
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // The template a click just filled in, with the text it replaced for 撤销.
  const [filled, setFilled] = useState(null)
  const [engines, setEngines] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // null keeps the inline "存为模板" row closed; a string is the name being typed.
  const [identityName, setIdentityName] = useState(null)
  const [deletingIdentity, setDeletingIdentity] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  const scanned = useRef(new Set())
  const engine = engines.find(item => item.id === draft.engine)
  const matches = item => item.name === draft.identity && item.role === draft.role && item.instructions === draft.instructions
  const current = allPresets.find(matches)
  const savable = current === undefined && (draft.role.trim() !== '' || draft.instructions.trim() !== '')
  const sessions = profile?.sessions?.filter(session => !session.draftedAt || session.briefSent).length ?? 0
  const identityDirty = profile !== null && (draft.role !== (profile.role ?? '') || draft.instructions !== (profile.instructions ?? ''))
  const identityTitle = (identityName ?? '').trim()
  const identityTaken = saved.some(item => item.name.trim().toLowerCase() === identityTitle.toLowerCase())
  useEffect(() => {
    let live = true
    void call('engine-catalog').then((items) => {
      if (!live) return
      // Onboarding's enabled set scopes new roles; an existing role keeps its
      // own engine selectable even when it is not in the set.
      const scoped = profile === null && enabledEngines !== null
        ? items.filter(item => enabledEngines.includes(item.id))
        : items
      const choices = scoped.length > 0 ? scoped : items
      setEngines(choices)
      setDraft(current => ({ ...current, engine: current.engine || choices[0]?.id || '' }))
    }).catch(failure => { if (live) setError(failure.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])
  // The model list is the engine's local scan; an engine never scanned is scanned once.
  useEffect(() => {
    if (!engine || engine.catalog || scanned.current.has(engine.id)) return
    scanned.current.add(engine.id)
    setScanning(true)
    void call('engine-scan', { engine: engine.id })
      .then(catalog => setEngines(current => current.map(item => item.id === engine.id ? { ...item, catalog } : item)))
      .catch(failure => setError(failure.message))
      .finally(() => setScanning(false))
  }, [engine])
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty])

  const disabled = busy || readOnly
  // Every user edit reports the card as changed; the engine-catalog fill above
  // writes the state directly so loading never counts as one.
  const update = patch => { setDirty(true); setDraft(current => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) })) }
  const edit = key => event => update({ [key]: event.target.value })
  // Engines own separate model tables: a switch restarts the pair instead of
  // carrying one engine's ids onto the next engine's catalog.
  const chooseEngine = event => update(current => ({ ...current, engine: event.target.value, model: '', thinking: '' }))
  const applyTemplate = (item) => {
    if (matches(item)) return
    setFilled({ name: item.name, before: { identity: draft.identity, role: draft.role, instructions: draft.instructions } })
    update({ identity: item.name, role: item.role, instructions: item.instructions })
  }
  // The model list is the engine's catalog; an unset pair reads the model's own
  // defaults, and an empty thinking choice means "follow the model default".
  const models = engine?.catalog?.models ?? []
  const { selected: selectedModel, value: model, levels: modelLevels, options: modelOptions } = modelChoices(models, draft.model, engine?.catalog?.defaultModel)
  // A level belongs to its model: an explicit level survives a model switch only
  // while the next model lists it; otherwise the model's own default applies.
  const chooseModel = event => {
    const id = event.target.value
    update(current => ({ ...current, model: id,
      thinking: thinkingAfterModelChange(models, id, current.thinking) }))
  }
  const submit = async (event) => {
    event.preventDefault()
    if (disabled || loading || !engine || draft.name.trim() === '') return
    setBusy(true)
    setError('')
    try {
      const values = { name: draft.name.trim(), identity: draft.identity, engine: draft.engine, role: draft.role, instructions: draft.instructions,
        avatarTemplate: draft.avatarTemplate, model, thinking: draft.thinking }
      const saved = await call(profile ? 'profile-update' : 'profile-create', profile ? { id: profile.id, changes: values } : values)
      setBusy(false)
      setDirty(false)
      await onSaved(saved)
    } catch (failure) {
      setError(failure.message)
      setBusy(false)
    }
  }
  // Saving a customized identity files it beside the built-in presets in the
  // host's prefs; saving over an existing name updates that entry.
  const saveIdentity = async () => {
    if (busy || identityTitle === '') return
    setBusy(true)
    setError('')
    try {
      await call('role-preset-save', { name: identityName, role: draft.role, instructions: draft.instructions })
      setIdentityName(null)
      void refresh?.(true)
    } catch (failure) {
      setError(failure.message)
    }
    setBusy(false)
  }
  const removeProfile = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await onDeleted(profile) } catch (failure) { setError(failure.message); setBusy(false) }
  }

  const meta = [engine ? engineDisplayName(engine) : draft.engine, profile && (sessions > 0 ? `${sessions} 个会话` : '还没有会话')].filter(Boolean).join('，')
  const templateCard = item => {
    const own = saved.includes(item)
    return h('span', { key: `${own ? 'saved' : 'preset'}:${item.name}`, className: 'nodo-template', 'data-saved': own ? 'true' : undefined },
      h('button', { type: 'button', className: 'nodo-template-pick', disabled, 'aria-pressed': matches(item), title: item.role,
        onClick: () => applyTemplate(item) },
      h('span', { className: 'nodo-template-name' }, item.name)),
      own && h('button', { type: 'button', className: 'nodo-template-remove', disabled, 'aria-label': `删除模板 ${item.name}`,
        onClick: () => setDeletingIdentity(item) },
      h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M6 6l12 12M18 6L6 18' }))))
  }

  return h(Fragment, null,
    h('form', { id: ROLE_FORM, className: 'nodo-role-editor', onSubmit: submit, 'aria-label': profile ? '配置角色' : '添加角色' },
      h('header', { className: 'nodo-role-head' },
        h('span', { className: 'nodo-role-avatar-slot' },
          h('button', { type: 'button', className: 'nodo-role-avatar', 'aria-label': '更换头像', 'aria-expanded': avatarOpen, disabled,
            onClick: () => setAvatarOpen(open => !open) },
          h(RoleAvatar, { profile: draft, size: 44 }),
          h('span', { className: 'nodo-role-avatar-edit', 'aria-hidden': true }, h(IconEditOutlineRegular, { size: 10 }))),
          avatarOpen && h('div', { className: 'nodo-avatar-pop', role: 'group', 'aria-label': '头像',
            onKeyDown: (event) => { if (event.key === 'Escape') setAvatarOpen(false) } },
          h('div', { className: 'nodo-avatar-picker' },
            ...AVATAR_TEMPLATES.map(item => h('button', { key: item.id, type: 'button', className: 'nodo-avatar-option',
              disabled, 'aria-pressed': draft.avatarTemplate === item.id,
              onClick: () => { update({ avatarTemplate: item.id }); setAvatarOpen(false) } },
            h(RoleAvatar, { profile: { avatarTemplate: item.id }, size: 30 }), item.label))))),
        h('div', { className: 'nodo-role-head-copy' },
          h('h2', { 'data-empty': draft.name.trim() ? undefined : 'true' }, draft.name.trim() || '未命名角色',
            h('span', { className: 'nodo-tag', 'data-tone': lead ? 'accent' : undefined }, lead ? '主控' : '执行角色')),
          h('p', null, meta)),
        h('div', { className: 'nodo-role-actions' },
          profile && h(Menu, { open: menuOpen, onClose: () => setMenuOpen(false), portal: true,
            items: [{ id: 'delete', label: '删除角色', disabled: disabled || !!deleteReason }],
            onSelect: () => { if (!deleteReason) { setMenuOpen(false); setConfirming(true) } },
            anchor: h('button', { type: 'button', className: 'nodo-row-action nodo-role-more', 'aria-haspopup': 'menu', 'aria-expanded': menuOpen,
              'aria-label': '更多操作', disabled: disabled || !!deleteReason, title: deleteReason, onClick: () => setMenuOpen(open => !open) }, h(IconEllipsisOutlineRegular, { size: 16 })) }),
          h(Button, { type: 'button', variant: 'outline', disabled, onClick: onCancel }, '取消'),
          h(Button, { type: 'submit', form: ROLE_FORM, variant: 'primary',
            disabled: disabled || loading || !engine || !draft.name.trim() || !dirty,
          }, busy ? '保存中…' : profile ? '保存' : '创建角色'))),
      confirming && h('div', { className: 'nodo-role-confirm-row', role: 'alert' },
        h('p', { className: 'nodo-role-confirm' }, `将删除角色“${profile.name}”，其 ${sessions} 个会话会自动归档，可在「已移除」中查看。项目目录和文件会保留。${deleteHint ?? ''}`),
        h(Button, { type: 'button', variant: 'outline', disabled, onClick: () => setConfirming(false) }, '取消'),
        h(Button, { type: 'button', variant: 'outline', className: 'nodo-dialog-danger', disabled: disabled || !!deleteReason, title: deleteReason, onClick: () => void removeProfile() },
          busy ? '删除中…' : '删除角色')),
      h('div', { className: 'nodo-field nodo-templates', role: 'group', 'aria-label': '模板' },
        h('div', { className: 'nodo-templates-head' },
          h('span', null, '模板'),
          !lead && h('button', { type: 'button', className: 'nodo-text-button', disabled: disabled || !savable || identityName !== null,
            onClick: () => setIdentityName(draft.name.trim()) }, '存为模板')),
        h('div', { className: 'nodo-templates-row' },
          ...presets.map(templateCard),
          saved.length > 0 && h('span', { className: 'nodo-templates-divider', 'aria-hidden': true }),
          ...saved.map(templateCard)),
        identityName !== null && h('div', { className: 'nodo-identity-save', role: 'group', 'aria-label': '存为模板' },
          h('input', { className: 'nodo-dialog-input', 'aria-label': '模板名称', autoFocus: true, disabled, value: identityName,
            maxLength: 40, placeholder: '模板名称', onChange: event => setIdentityName(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void saveIdentity() } } }),
          h(Button, { type: 'button', variant: 'outline', size: 'sm', disabled, onClick: () => setIdentityName(null) }, '取消'),
          h(Button, { type: 'button', variant: 'primary', size: 'sm', disabled: disabled || identityTitle === '', onClick: () => void saveIdentity() },
            busy ? '保存中…' : '保存'),
          identityTaken && h('p', { className: 'nodo-dialog-hint' }, '将覆盖同名模板')),
        filled && current?.name === filled.name && h('p', { className: 'nodo-template-filled', role: 'status' },
          `已用「${filled.name}」填写身份、职责概述和身份信息`,
          h('button', { type: 'button', className: 'nodo-text-button', disabled,
            onClick: () => { update(filled.before); setFilled(null) } }, '撤销'))),
      h('div', { className: 'nodo-role-names' },
        h(Field, { label: '名字', required: true }, h('input', {
          className: 'nodo-dialog-input', 'data-modal-autofocus': true, disabled, value: draft.name, onChange: edit('name'),
          required: true, maxLength: 40, placeholder: '例如 Coder 或 Reviewer',
        })),
        h(Field, { label: '身份' }, h('input', {
          className: 'nodo-dialog-input nodo-role-identity', disabled, value: draft.identity, onChange: edit('identity'), maxLength: 40,
        }))),
      h('div', { className: 'nodo-role-run', role: 'group', 'aria-label': '运行' },
        h(Field, { label: 'Agent' },
          h('select', { className: 'nodo-dialog-input nodo-dialog-select', disabled: disabled || loading || profile !== null,
            title: profile ? '创建后不能更换 Agent' : undefined, value: draft.engine, onChange: chooseEngine },
            !engine && h('option', { value: draft.engine }, loading ? '正在加载 Agent…' : `不可用：${draft.engine}`),
            ...engines.map(item => h('option', { key: item.id, value: item.id }, engineDisplayName(item))))),
        h(Field, { label: '模型' },
          models.length
            ? h('select', { className: 'nodo-dialog-input nodo-dialog-select', disabled, value: model, onChange: chooseModel },
              !model && h('option', { value: '' }, '选择模型'),
              ...modelOptions)
            : h('input', { className: 'nodo-dialog-input', disabled, value: draft.model, onChange: edit('model'), maxLength: 200, placeholder: '使用 Agent 默认' }),
          scanning && h('p', { className: 'nodo-dialog-hint', role: 'status' }, '扫描模型…')),
        modelLevels.length > 0 && h(Field, { label: '思考档位' },
          h('select', { className: 'nodo-dialog-input nodo-dialog-select', disabled, value: draft.thinking, onChange: edit('thinking') },
            h('option', { value: '' }, '跟随模型默认'),
            ...thinkingOptions(selectedModel, draft.thinking)))),
      h(Field, { label: '职责概述' },
        h('div', { className: 'nodo-dialog-counted' },
          h('input', { className: 'nodo-dialog-input', disabled, value: draft.role, onChange: edit('role'), maxLength: 80,
            placeholder: '一句话说明这个角色做什么' }),
          h('span', { className: 'nodo-dialog-count', 'aria-hidden': true }, `${draft.role.length}/80`))),
      h(Field, { label: '身份信息', group: true },
        h('div', { className: 'nodo-dialog-counted' },
          h('textarea', {
            className: 'nodo-dialog-input nodo-dialog-textarea', 'aria-label': '身份信息', disabled, value: draft.instructions,
            onChange: edit('instructions'), maxLength: 8000, rows: 12, placeholder: '职责、边界和交付要求',
          }),
          h('span', { className: 'nodo-dialog-count', 'aria-hidden': true }, `${draft.instructions.length}/8000`)),
        sessions > 0 && identityDirty && h('p', { className: 'nodo-role-notice', role: 'status' }, `身份已修改，保存后将于下轮生效 · 影响 ${sessions} 个会话`)),
      error && h('p', { className: 'nodo-dialog-error', role: 'alert' }, error)),
    deletingIdentity && h(IdentityDeleteDialog, { identity: deletingIdentity, onCancel: () => setDeletingIdentity(null),
      onDeleted: () => { setDeletingIdentity(null); void refresh?.(true) } }))
}

export function IdentityDeleteDialog({ identity, onDeleted, onCancel }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const remove = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await call('role-preset-delete', { name: identity.name })
      onDeleted(identity.name)
    } catch (failure) {
      setError(failure.message)
      setBusy(false)
    }
  }
  return h(Modal, {
    open: true, onClose: () => { if (!busy) onCancel() }, closeLabel: '关闭', title: '删除模板',
    description: `将删除模板“${identity.name}”。用它填写的角色不受影响。`,
    footer: [
      h(Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: onCancel }, '取消'),
      h(Button, { key: 'delete', variant: 'outline', className: 'nodo-dialog-danger', disabled: busy, onClick: () => void remove() }, '删除模板'),
    ],
  },
  busy && h('div', { className: 'nodo-dialog-status', role: 'status' }, '正在删除模板…'),
  error !== '' && h('div', { className: 'nodo-dialog-error', role: 'alert' }, error))
}
