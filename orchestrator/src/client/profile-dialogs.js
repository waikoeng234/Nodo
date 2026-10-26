import { h, Fragment, useState, useEffect, useRef, call, Menu, Modal, Button, ROLE_FORM, IconEditOutlineRegular, IconEllipsisOutlineRegular } from './ui-shared.js'
import { avatarTemplateOf, RoleAvatar } from './avatar.tsx'
import { engineDisplayName } from './engine-logos.js'
import { route } from '../../core/shared/route.js'
import AVATAR_TEMPLATES from '../../core/shared/avatar-templates.json'
import ROLE_PRESETS from '../../core/shared/role-presets.json'

export function Field({ label, children, group = false, required = false }) {
  return h(group ? 'div' : 'label', { className: 'nodo-field', role: group ? 'group' : undefined,
    'aria-label': group ? label : undefined },
  h('span', null, label, required && h('span', { className: 'nodo-field-required', 'aria-hidden': true }, '*')), children)
}

// A role card as the editor sees it: the saved fields it reads plus the draft-only
// hardOn key the save body consumes.
/**
 * @typedef {{ id?: string, name?: string, engine?: string, role?: string, instructions?: string,
 *   lead?: boolean, avatarTemplate?: string, model?: string, thinking?: string,
 *   taskTypes?: string[], hard?: Record<string, string>, hardOn?: boolean, sessions?: { id: string }[] }} RoleCard
 */

/**
 * @param {{ profile?: RoleCard | null, avatarSeed?: number, enabledEngines?: string[] | null,
 *   savedIdentities?: unknown[] | null, taskTypes?: { id?: string, name: string, when?: string }[] | null,
 *   roster?: RoleCard[] | null, refresh?: ((force?: boolean) => Promise<void>) | null, readOnly?: boolean,
 *   onSaved: (saved: { id: string }) => Promise<void> | void, onCancel: () => void,
 *   onDeleted: (item: { id: string }) => Promise<void> | void, onDirtyChange?: ((dirty: boolean) => void) | null }} props
 */
export function RoleEditor({ profile = null, avatarSeed = 0, enabledEngines = null, savedIdentities = null, taskTypes = null, roster = null, refresh = null, readOnly = false, onSaved, onCancel, onDeleted, onDirtyChange }) {
  // Saved identities ride prefs, so the picker offers them to every later new
  // role and a deleted role card never takes its saved identity along.
  const saved = Array.isArray(savedIdentities) ? savedIdentities : []
  const allPresets = [...ROLE_PRESETS, ...saved]
  const [draft, setDraft] = useState({
    name: profile?.name ?? '', engine: profile?.engine ?? '', role: profile?.role ?? '',
    instructions: profile?.instructions ?? '',
    lead: profile?.lead === true,
    avatarTemplate: profile ? avatarTemplateOf(profile).id : AVATAR_TEMPLATES[avatarSeed % AVATAR_TEMPLATES.length].id,
    model: profile?.model ?? '', thinking: profile?.thinking ?? '',
    taskTypes: profile?.taskTypes ?? [],
    hard: profile?.hard ?? {},
    hardOn: profile?.hard !== undefined,
  })
  const [tab, setTab] = useState(() => !profile || profile.lead === true || !profile.instructions ? 'identity' : 'assign')
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
  const matches = item => item.role === draft.role && item.instructions === draft.instructions
  const current = allPresets.find(matches)
  const savable = current === undefined && (draft.role.trim() !== '' || draft.instructions.trim() !== '')
  const sessions = profile?.sessions.length ?? 0
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
    setFilled({ name: item.name, before: { role: draft.role, instructions: draft.instructions } })
    update({ role: item.role, instructions: item.instructions })
  }
  const chooseLead = (lead) => {
    if (draft.lead === lead) return
    update({ lead })
    if (lead && tab === 'assign') setTab('identity')
  }
  const chooseTaskType = id => update(current => ({ ...current,
    taskTypes: current.taskTypes.includes(id) ? current.taskTypes.filter(item => item !== id) : [...current.taskTypes, id] }))
  // The model list is the engine's catalog; an unset pair reads the model's own
  // defaults, and an empty thinking choice means "follow the model default".
  const models = engine?.catalog?.models ?? []
  const selectedModel = models.find(item => item.id === (draft.model || engine?.catalog?.defaultModel))
  const model = selectedModel?.id ?? draft.model
  const modelLevels = selectedModel?.thinking ?? []
  // The option shows the model's own name; its route stays the title hint.
  const modelLabel = item => item.label ?? item.id
  // Models are sectioned by provider the way the host's own picker lists them:
  // a native optgroup keeps the groups apart with one row per model.
  const providers = new Map()
  for (const item of models) providers.set(item.group ?? '', [...(providers.get(item.group ?? '') ?? []), item])
  const modelOptions = [...providers].flatMap(([group, items]) => {
    const options = items.map(item => h('option', { key: item.id, value: item.id, title: item.id }, modelLabel(item)))
    return group === '' ? options : [h('optgroup', { key: `group:${group}`, label: group }, ...options)]
  })
  // A level belongs to its model: an explicit level survives a model switch only
  // while the next model lists it; otherwise the model's own default applies.
  const chooseModel = event => {
    const id = event.target.value
    const next = models.find(item => item.id === id)
    update(current => ({ ...current, model: id,
      thinking: (next?.thinking ?? []).some(level => level.id === current.thinking) ? current.thinking : '' }))
  }
  // Hard-task settings follow the same tables: an unset pick means the card's
  // own model or its default level, and the level list follows the hard model.
  const hardSelected = models.find(item => item.id === (draft.hard.model || model))
  const hardLevels = hardSelected?.thinking ?? []
  const chooseHardModel = event => {
    const id = event.target.value
    const next = models.find(item => item.id === id)
    update(current => ({ ...current, hard: { ...current.hard, model: id,
      thinking: (next?.thinking ?? []).some(level => level.id === current.hard.thinking) ? current.hard.thinking : undefined } }))
  }
  const hardModel = draft.hard.model || undefined
  const hardThinking = draft.hard.thinking || undefined
  const submit = async (event) => {
    event.preventDefault()
    if (disabled || loading || !engine || draft.name.trim() === '') return
    setBusy(true)
    setError('')
    try {
      const hard = draft.hardOn
        ? Object.fromEntries([['model', hardModel], ['thinking', hardThinking]].filter(([, value]) => value !== undefined))
        : null
      const values = { name: draft.name.trim(), engine: draft.engine, role: draft.role, instructions: draft.instructions,
        lead: draft.lead, avatarTemplate: draft.avatarTemplate, model, thinking: draft.thinking,
        ...(draft.lead ? {} : { taskTypes: draft.taskTypes, hard }) }
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

  // Routing previews run the core's own rule over the roster order, with this
  // card's draft standing in for its saved copy.
  const typeName = id => (taskTypes ?? []).find(item => item.id === id)?.name ?? id
  const self = { id: profile?.id ?? '', name: draft.name.trim() || '未命名角色', taskTypes: draft.taskTypes, ...(draft.hardOn ? { hard: {} } : {}) }
  const executors = (roster ?? []).filter(item => item.lead !== true || item.id === profile?.id)
  const seated = profile && executors.some(item => item.id === profile.id)
    ? executors.map(item => item.id === profile.id ? self : item) : [...executors, self]
  const reach = (taskTypes ?? []).filter(item => draft.taskTypes.includes(item.id)).map((item) => {
    const routine = route({ type: item.id, hard: false }, seated)
    const hard = route({ type: item.id, hard: true }, seated)
    const wins = [routine.profile === self && '常规', hard.profile === self && '难题'].filter(Boolean)
    const notes = [routine.profile !== self && `常规交给${routine.profile.name}`,
      hard.profile !== self && (hard.miss ? '难题无人承接' : `难题交给${hard.profile.name}`)].filter(Boolean)
    return { id: item.id, name: item.name, wins, note: notes.join('，') }
  })
  // Turning a card into a lead drops it from every roster: say who takes over
  // each type it used to win.
  const leaving = draft.lead && profile !== null && profile.lead !== true
  const impact = leaving ? (profile.taskTypes ?? []).flatMap((type) => {
    const staying = (roster ?? []).filter(item => item.lead !== true)
    const without = staying.filter(item => item.id !== profile.id)
    return [false, true].flatMap((hard) => {
      if (route({ type, hard }, staying).profile?.id !== profile.id) return []
      const next = route({ type, hard }, without)
      const kind = hard ? '难题' : '常规任务'
      return [next.miss ? { text: `${typeName(type)}的${kind}将无人承接`, warn: true } : { text: `${typeName(type)}的${kind}改由${next.profile.name}接`, warn: false }]
    })
  }) : []

  const template = avatarTemplateOf(draft)
  const meta = [engine ? engineDisplayName(engine) : draft.engine, profile && (sessions > 0 ? `${sessions} 个会话` : '还没有会话')].filter(Boolean).join('，')
  const tabs = [['identity', '身份', draft.instructions.trim() === ''], ['run', '运行', false],
    ...(draft.lead ? [] : [['assign', '承接任务', draft.taskTypes.length === 0 && !draft.hardOn]])]
  const panel = (key, ...children) => h('div', { key, role: 'tabpanel', id: `nodo-role-panel-${key}`, 'aria-labelledby': `nodo-role-tab-${key}`,
    className: 'nodo-role-panel', hidden: tab !== key }, ...children)
  const templateCard = item => {
    const own = saved.includes(item)
    return h('span', { key: `${own ? 'saved' : 'preset'}:${item.name}`, className: 'nodo-template', 'data-saved': own ? 'true' : undefined },
      h('button', { type: 'button', className: 'nodo-template-pick', disabled, 'aria-pressed': matches(item), title: item.role,
        onClick: () => applyTemplate(item) },
      h('span', { className: 'nodo-template-name' }, item.name),
      h('span', { className: 'nodo-template-duty' }, item.role)),
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
            style: { background: `${template.color}33` }, onClick: () => setAvatarOpen(open => !open) },
          h(RoleAvatar, { profile: draft, size: 32 }),
          h('span', { className: 'nodo-role-avatar-edit', 'aria-hidden': true }, h(IconEditOutlineRegular, { size: 10 }))),
          avatarOpen && h('div', { className: 'nodo-avatar-pop', role: 'group', 'aria-label': '头像',
            onKeyDown: (event) => { if (event.key === 'Escape') setAvatarOpen(false) } },
          h('div', { className: 'nodo-avatar-picker' },
            ...AVATAR_TEMPLATES.map(item => h('button', { key: item.id, type: 'button', className: 'nodo-avatar-option',
              disabled, 'aria-pressed': draft.avatarTemplate === item.id,
              onClick: () => { update({ avatarTemplate: item.id }); setAvatarOpen(false) } },
            h(RoleAvatar, { profile: { avatarTemplate: item.id }, size: 30 }), item.label))))),
        h('div', { className: 'nodo-role-head-copy' },
          h('h2', { 'data-empty': draft.name.trim() ? undefined : 'true' }, draft.name.trim() || '未命名角色'),
          h('p', null, meta)),
        h('div', { className: 'nodo-role-actions' },
          profile && h(Menu, { open: menuOpen, onClose: () => setMenuOpen(false), portal: true,
            items: [{ id: 'delete', label: '删除角色', disabled }],
            onSelect: () => { setMenuOpen(false); setConfirming(true) },
            anchor: h('button', { type: 'button', className: 'nodo-row-action nodo-role-more', 'aria-haspopup': 'menu', 'aria-expanded': menuOpen,
              'aria-label': '更多操作', disabled, onClick: () => setMenuOpen(open => !open) }, h(IconEllipsisOutlineRegular, { size: 16 })) }),
          h(Button, { type: 'button', variant: 'outline', disabled, onClick: onCancel }, '取消'),
          h(Button, { type: 'submit', form: ROLE_FORM, variant: 'primary',
            disabled: disabled || loading || !engine || !draft.name.trim() || !dirty,
          }, busy ? '保存中…' : profile ? '保存' : '创建角色'))),
      confirming && h('div', { className: 'nodo-role-confirm-row', role: 'alert' },
        h('p', { className: 'nodo-role-confirm' }, `将把“${profile.name}”及其 ${sessions} 个插件内会话记录移除。项目目录和文件会保留。`),
        h(Button, { type: 'button', variant: 'outline', disabled, onClick: () => setConfirming(false) }, '取消'),
        h(Button, { type: 'button', variant: 'outline', className: 'nodo-dialog-danger', disabled, onClick: () => void removeProfile() },
          busy ? '删除中…' : '删除角色')),
      h('div', { className: 'nodo-role-tabbar' },
        h('div', { className: 'nodo-role-tabs', role: 'tablist', 'aria-label': '角色设置' },
          ...tabs.map(([key, label, todo]) => h('button', { key, type: 'button', role: 'tab', id: `nodo-role-tab-${key}`,
            className: 'nodo-role-tab', 'aria-selected': tab === key, 'aria-controls': `nodo-role-panel-${key}`, onClick: () => setTab(key) },
          label, todo && h('span', { className: 'nodo-role-tab-dot', role: 'img', 'aria-label': '待设置' })))),
        h('div', { className: 'nodo-role-kind', role: 'radiogroup', 'aria-label': '角色定位' },
          ...[['执行角色', false], ['主控', true]].map(([label, lead]) => h('button', { key: label, type: 'button', role: 'radio',
            'aria-checked': draft.lead === lead, disabled, onClick: () => chooseLead(lead) }, label)))),
      leaving && h('div', { className: 'nodo-role-lead-note', role: 'status' },
        h('p', null, '主控负责拆分任务和派活，自己不再接任务'),
        ...impact.map(line => h('p', { key: line.text, 'data-warn': line.warn ? 'true' : undefined }, line.text))),
      panel('identity',
        h(Field, { label: '名字', required: true }, h('input', {
          className: 'nodo-dialog-input', 'data-modal-autofocus': true, disabled, value: draft.name, onChange: edit('name'),
          required: true, maxLength: 40, placeholder: '例如 Coder 或 Reviewer',
        })),
        h('div', { className: 'nodo-field nodo-templates', role: 'group', 'aria-label': '模板' },
          h('div', { className: 'nodo-templates-head' },
            h('span', null, '模板'),
            h('button', { type: 'button', className: 'nodo-text-button', disabled: disabled || !savable || identityName !== null,
              onClick: () => setIdentityName(draft.name.trim()) }, '存为模板')),
          h('div', { className: 'nodo-templates-row' },
            ...ROLE_PRESETS.map(templateCard),
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
            `已用「${filled.name}」填写职责概述和身份信息`,
            h('button', { type: 'button', className: 'nodo-text-button', disabled,
              onClick: () => { update(filled.before); setFilled(null) } }, '撤销'))),
        h(Field, { label: '职责概述' },
          h('div', { className: 'nodo-dialog-counted' },
            h('input', { className: 'nodo-dialog-input', disabled, value: draft.role, onChange: edit('role'), maxLength: 80,
              placeholder: '一句话说明这个角色做什么' }),
            h('span', { className: 'nodo-dialog-count', 'aria-hidden': true }, `${draft.role.length}/80`))),
        h(Field, { label: '身份信息', group: true },
          h('div', { className: 'nodo-dialog-counted' },
            h('textarea', {
              className: 'nodo-dialog-input nodo-dialog-textarea', 'aria-label': '身份信息', disabled, value: draft.instructions,
              onChange: edit('instructions'), maxLength: 8000, rows: 7, placeholder: '职责、边界和交付要求',
            }),
            h('span', { className: 'nodo-dialog-count', 'aria-hidden': true }, `${draft.instructions.length}/8000`)),
          sessions > 0 && identityDirty && h('p', { className: 'nodo-role-notice', role: 'status' }, `身份已修改，保存后将于下轮生效 · 影响 ${sessions} 个会话`))),
      panel('run',
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
                ...(model && !selectedModel ? [h('option', { key: model, value: model }, `不在清单：${model}`)] : []),
                ...modelOptions)
              : h('input', { className: 'nodo-dialog-input', disabled, value: draft.model, onChange: edit('model'), maxLength: 200, placeholder: '使用 Agent 默认' }),
            scanning && h('p', { className: 'nodo-dialog-hint', role: 'status' }, '扫描模型…')),
          modelLevels.length > 0 && h(Field, { label: '思考档位' },
            h('select', { className: 'nodo-dialog-input nodo-dialog-select', disabled, value: draft.thinking, onChange: edit('thinking') },
              h('option', { value: '' }, '跟随模型默认'),
              ...(draft.thinking && !modelLevels.some(level => level.id === draft.thinking) ? [h('option', { key: draft.thinking, value: draft.thinking }, `不在清单：${draft.thinking}`)] : []),
              ...modelLevels.map(level => h('option', { key: level.id, value: level.id, title: level.id },
                level.id === selectedModel.defaultThinking ? `${level.label ?? level.id}（模型默认）` : level.label ?? level.id)))))),
      !draft.lead && panel('assign',
        h(Field, { label: '任务类型', group: true },
          h('div', { className: 'nodo-identity-options' },
            ...(taskTypes ?? []).map(item => h('button', { key: item.id, type: 'button', className: 'nodo-identity-option', disabled,
              'aria-pressed': draft.taskTypes.includes(item.id), title: item.when || undefined, onClick: () => chooseTaskType(item.id) }, item.name)),
            !(taskTypes ?? []).length && h('p', { className: 'nodo-dialog-hint' }, '暂无任务类型'))),
        h('div', { className: 'nodo-role-reach', 'aria-live': 'polite' },
          h('p', { className: 'nodo-role-reach-title' }, `排在第 ${seated.indexOf(self) + 1} 位，按现在的设置会接到`),
          !reach.length && h('p', { className: 'nodo-role-reach-empty' }, '还没有勾选任务类型'),
          ...reach.map(row => h('div', { key: row.id, className: 'nodo-role-reach-row' },
            h('span', { className: 'nodo-role-reach-name' }, row.name),
            h('span', { className: 'nodo-role-reach-result' },
              ...row.wins.map(win => h('span', { key: win, className: 'nodo-role-reach-win', 'data-hard': win === '难题' ? 'true' : undefined }, win)),
              row.note && h('span', { className: 'nodo-role-reach-note' }, row.note))))),
        h('div', { className: 'nodo-role-assign', role: 'group', 'aria-label': '难题' },
          h(Field, { label: '可接难题' },
            h('input', { type: 'checkbox', role: 'switch', 'aria-label': '可接难题', checked: draft.hardOn, disabled,
              onChange: event => update({ hardOn: event.target.checked }) })),
          draft.hardOn && h(Field, { label: '难题模型' },
            h('select', { className: 'nodo-dialog-input nodo-dialog-select', disabled, value: hardModel ?? '', onChange: chooseHardModel },
              h('option', { value: '' }, '同角色设置'),
              ...(hardModel && !models.some(item => item.id === hardModel) ? [h('option', { key: hardModel, value: hardModel }, `不在清单：${hardModel}`)] : []),
              ...modelOptions)),
          draft.hardOn && hardLevels.length > 0 && h(Field, { label: '难题思考档位' },
            h('select', { className: 'nodo-dialog-input nodo-dialog-select', disabled, value: hardThinking ?? '',
              onChange: event => update(current => ({ ...current, hard: { ...current.hard, thinking: event.target.value } })) },
              h('option', { value: '' }, '同角色设置'),
              ...(hardThinking && !hardLevels.some(level => level.id === hardThinking) ? [h('option', { key: hardThinking, value: hardThinking }, `不在清单：${hardThinking}`)] : []),
              ...hardLevels.map(level => h('option', { key: level.id, value: level.id, title: level.id },
                level.id === hardSelected.defaultThinking ? `${level.label ?? level.id}（模型默认）` : level.label ?? level.id)))))),
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
