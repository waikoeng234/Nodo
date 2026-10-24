function Field({ label, children, group = false, required = false }) {
  return h(group ? 'div' : 'label', { className: 'nodo-field', role: group ? 'group' : undefined,
    'aria-label': group ? label : undefined },
  h('span', null, label, required && h('span', { className: 'nodo-field-required', 'aria-hidden': true }, '*')), children)
}

function ProfileDialog({ profile = null, avatarSeed = 0, enabledEngines = null, savedIdentities = null, refresh = null, onSaved, onCancel, onDeleted }) {
  // Saved identities ride prefs, so the picker offers them to every later new
  // role and a deleted role card never takes its saved identity along.
  const saved = Array.isArray(savedIdentities) ? savedIdentities : []
  const allPresets = [...ROLE_PRESETS, ...saved]
  const [draft, setDraft] = useState({
    name: profile?.name ?? '', engine: profile?.engine ?? '', role: profile?.role ?? '',
    instructions: profile?.instructions ?? '',
    avatarTemplate: profile ? avatarTemplateOf(profile).id : AVATAR_TEMPLATES[avatarSeed % AVATAR_TEMPLATES.length].id,
    identity: allPresets.find(item => item.instructions === profile?.instructions)?.name ?? 'custom',
    model: profile?.model ?? '', thinking: profile?.thinking ?? '',
  })
  const [previewRunning, setPreviewRunning] = useState(false)
  const [engines, setEngines] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // null keeps the inline "存为身份配置" row closed; a string is the name being typed.
  const [identityName, setIdentityName] = useState(null)
  const [deletingIdentity, setDeletingIdentity] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const scanned = useRef(new Set())
  const engine = engines.find(item => item.id === draft.engine)
  const customIdentity = !allPresets.some(item => item.name === draft.identity)
  const savedSelected = saved.find(item => item.name === draft.identity)
  const knownIdentity = allPresets.some(item => item.role === draft.role && item.instructions === draft.instructions)
  const savable = !knownIdentity && (draft.role.trim() !== '' || draft.instructions.trim() !== '')
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

  const disabled = busy
  const edit = key => event => {
    const value = event.target.value
    setDraft(current => ({ ...current, [key]: value }))
  }
  // Engines own separate model tables: a switch restarts the pair instead of
  // carrying one engine's ids onto the next engine's catalog.
  const chooseEngine = event => setDraft(current => ({ ...current, engine: event.target.value, model: '', thinking: '' }))
  // A preset fills the whole identity; "+ 自定义" clears preset text the user left untouched.
  const chooseIdentity = (name) => {
    const preset = allPresets.find(item => item.name === name)
    setDraft((current) => {
      if (preset) return { ...current, identity: name, role: preset.role, instructions: preset.instructions }
      const held = allPresets.find(item => item.name === current.identity)
      const untouched = held !== undefined && current.role === held.role && current.instructions === held.instructions
      return { ...current, identity: name, ...(untouched ? { role: '', instructions: '' } : {}) }
    })
  }
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
    setDraft(current => ({ ...current, model: id,
      thinking: (next?.thinking ?? []).some(level => level.id === current.thinking) ? current.thinking : '' }))
  }
  const submit = async (event) => {
    event.preventDefault()
    if (disabled || loading || !engine || draft.name.trim() === '') return
    setBusy(true)
    setError('')
    try {
      const values = { ...draft, name: draft.name.trim(), model, thinking: draft.thinking }
      delete values.identity
      const saved = await call(profile ? 'profile-update' : 'profile-create', profile ? { id: profile.id, changes: values } : values)
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
      setDraft(current => ({ ...current, identity: identityTitle }))
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
  const template = avatarTemplateOf(draft)
  const identityTag = customIdentity ? '自定义' : savable ? `${draft.identity} · 已修改` : draft.identity
  const cardMeta = [engine?.label ?? draft.engine, selectedModel ? modelLabel(selectedModel) : model || '默认模型',
    sessions > 0 && `${sessions} 个会话`].filter(Boolean).join(' · ')

  return h(Fragment, null,
    h(Modal, {
      open: true, onClose: () => { if (!busy) onCancel() }, closeLabel: '关闭',
      title: profile ? '配置角色' : '添加角色',
      className: 'nodo-dialog nodo-role-dialog', contentClassName: 'nodo-role-shell',
      footer: confirming ? [
        h('p', { key: 'confirm', className: 'nodo-role-confirm', role: 'alert' },
          `将把“${profile.name}”及其 ${sessions} 个插件内会话记录移除。项目目录和文件会保留。`),
        h(Button, { key: 'keep', variant: 'outline', disabled, onClick: () => setConfirming(false) }, '取消'),
        h(Button, { key: 'delete', variant: 'outline', className: 'nodo-dialog-danger', disabled, onClick: () => void removeProfile() },
          busy ? '删除中…' : '删除角色'),
      ] : [
        profile && h(Button, { key: 'delete', variant: 'outline', className: 'nodo-dialog-danger nodo-dialog-leading',
          disabled, onClick: () => setConfirming(true) }, '删除角色'),
        h(Button, { key: 'cancel', variant: 'outline', disabled, onClick: onCancel }, '取消'),
        h(Button, {
          key: 'save', type: 'submit', form: ROLE_FORM, variant: 'primary',
          disabled: disabled || loading || !engine || !draft.name.trim(),
        }, busy ? '保存中…' : profile ? '保存角色' : '创建角色'),
      ],
    },
    h('form', { id: ROLE_FORM, className: 'nodo-dialog-fields nodo-role-fields', onSubmit: submit, 'aria-label': profile ? '配置角色' : '添加角色' },
      h('div', { className: 'nodo-role-layout' },
        h('aside', { className: 'nodo-role-aside' },
          h('div', { className: 'nodo-role-card', 'aria-hidden': true },
            h('div', { className: 'nodo-role-card-art', style: { background: `${template.color}40` } },
              h(RoleAvatar, { profile: draft, size: 72, running: previewRunning })),
            h('div', { className: 'nodo-role-card-body' },
              h('div', { className: 'nodo-role-card-title' },
                h('strong', { 'data-empty': draft.name.trim() ? undefined : 'true' }, draft.name.trim() || '未命名角色'),
                h('span', { className: 'nodo-role-card-tag' }, identityTag)),
              h('p', { 'data-empty': draft.role.trim() ? undefined : 'true' }, draft.role.trim() || '尚未填写职责概述'),
              h('p', { className: 'nodo-role-card-meta' }, cardMeta))),
          h(Field, { label: '头像模板', group: true },
            h('label', { className: 'nodo-avatar-preview-toggle' },
              h('input', { type: 'checkbox', checked: previewRunning, disabled,
                onChange: event => setPreviewRunning(event.target.checked) }), '运行动画'),
            h('div', { className: 'nodo-avatar-picker' },
              ...AVATAR_TEMPLATES.map(item => h('button', { key: item.id, type: 'button', className: 'nodo-avatar-option',
                disabled, 'aria-pressed': draft.avatarTemplate === item.id,
                onClick: () => setDraft(current => ({ ...current, avatarTemplate: item.id })) },
              h(RoleAvatar, { profile: { avatarTemplate: item.id }, size: 30 }), item.label))))),
        h('div', { className: 'nodo-role-main' },
          h(Field, { label: '名字', required: true }, h('input', {
            className: 'nodo-dialog-input', 'data-modal-autofocus': true, disabled, value: draft.name, onChange: edit('name'),
            required: true, maxLength: 40, placeholder: '例如 Coder 或 Reviewer',
          })),
          h(Field, { label: '身份', group: true },
            h('div', { className: 'nodo-identity-options' },
              ...allPresets.map(item => h('button', { key: item.name, type: 'button', className: 'nodo-identity-option', disabled,
                'data-saved': saved.includes(item) ? 'true' : undefined, 'aria-pressed': draft.identity === item.name,
                onClick: () => chooseIdentity(item.name) }, item.name)),
              h('button', { type: 'button', className: 'nodo-identity-option', 'data-custom': 'true', disabled,
                'aria-pressed': customIdentity, onClick: () => chooseIdentity('custom') }, '+ 自定义')),
            customIdentity
              ? h('div', { className: 'nodo-dialog-counted' },
                h('input', { className: 'nodo-dialog-input', disabled, value: draft.role, onChange: edit('role'), maxLength: 80,
                  'aria-label': '职责概述', placeholder: '一句话职责概述，会显示在角色卡上' }),
                h('span', { className: 'nodo-dialog-count', 'aria-hidden': true }, `${draft.role.length}/80`))
              : h('div', { className: 'nodo-identity-summary' },
                h('p', { className: 'nodo-dialog-hint' }, draft.role),
                savedSelected && h(Button, { variant: 'outline', size: 'sm', className: 'nodo-dialog-danger', disabled,
                  onClick: () => setDeletingIdentity(true) }, '删除此配置'))),
          h(Field, { label: '身份信息', group: true },
            savable && identityName === null && h(Button, { variant: 'outline', size: 'sm', className: 'nodo-identity-save-open', disabled,
              onClick: () => setIdentityName('') }, '存为身份配置'),
            h('div', { className: 'nodo-dialog-counted' },
              h('textarea', {
                className: 'nodo-dialog-input nodo-dialog-textarea', 'aria-label': '身份信息', disabled, value: draft.instructions,
                onChange: edit('instructions'), maxLength: 8000, rows: 7, placeholder: '职责、工作范围与要求\n\n建议结构：职责 / 边界 / 交付',
              }),
              h('span', { className: 'nodo-dialog-count', 'aria-hidden': true }, `${draft.instructions.length}/8000`)),
            savable && identityName !== null && h('div', { className: 'nodo-identity-save', role: 'group', 'aria-label': '存为身份配置' },
              h('input', { className: 'nodo-dialog-input', 'aria-label': '配置名称', autoFocus: true, disabled, value: identityName,
                maxLength: 40, placeholder: '配置名称，例如 审查员', onChange: event => setIdentityName(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void saveIdentity() } } }),
              h(Button, { variant: 'outline', size: 'sm', disabled, onClick: () => setIdentityName(null) }, '取消'),
              h(Button, { variant: 'primary', size: 'sm', disabled: disabled || identityTitle === '', onClick: () => void saveIdentity() },
                busy ? '保存中…' : '保存配置'),
              h('p', { className: 'nodo-dialog-hint' },
                identityTaken ? '已有同名配置，保存将覆盖它。' : '保存后新建角色时可直接复用；删除角色不影响这里保存的配置。')),
            sessions > 0 && (identityDirty
              ? h('p', { className: 'nodo-role-notice', role: 'status' }, `身份已修改，保存后将于下轮生效 · 影响 ${sessions} 个会话`)
              : h('p', { className: 'nodo-dialog-hint' }, `${sessions} 个会话正在使用此角色 · 身份修改将于下轮生效`))),
          h('div', { className: 'nodo-role-run', role: 'group', 'aria-label': '运行' },
            h(Field, { label: '调用 Agent' },
              h('select', { className: 'nodo-dialog-input nodo-dialog-select', disabled: disabled || loading || profile !== null,
                title: profile ? '创建后不可更换 Agent' : undefined, value: draft.engine, onChange: chooseEngine },
                !engine && h('option', { value: draft.engine }, loading ? '正在加载 Agent…' : `不可用：${draft.engine}`),
                ...engines.map(item => h('option', { key: item.id, value: item.id }, item.label))),
              profile && h('p', { className: 'nodo-dialog-hint' }, '创建后不可更换')),
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
                  level.id === selectedModel.defaultThinking ? `${level.label ?? level.id}（模型默认）` : level.label ?? level.id))))))),
      error && h('p', { className: 'nodo-dialog-error', role: 'alert' }, error)),
    deletingIdentity && savedSelected && h(IdentityDeleteDialog, { identity: savedSelected, onCancel: () => setDeletingIdentity(false),
      onDeleted: name => { setDeletingIdentity(false); setDraft(current => current.identity === name ? { ...current, identity: 'custom' } : current); void refresh?.(true) } })))
}

function IdentityDeleteDialog({ identity, onDeleted, onCancel }) {
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
    open: true, onClose: () => { if (!busy) onCancel() }, closeLabel: '关闭', title: '删除身份配置',
    description: `将删除身份配置“${identity.name}”。用它创建的角色不受影响。`,
    footer: [
      h(Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: onCancel }, '取消'),
      h(Button, { key: 'delete', variant: 'outline', className: 'nodo-dialog-danger', disabled: busy, onClick: () => void remove() }, '删除配置'),
    ],
  },
  busy && h('div', { className: 'nodo-dialog-status', role: 'status' }, '正在删除配置…'),
  error !== '' && h('div', { className: 'nodo-dialog-error', role: 'alert' }, error))
}
