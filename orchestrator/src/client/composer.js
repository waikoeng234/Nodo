// The composer is the host's InputBar: one card on the composer surface with the
// text surface on top and the control row below it, Enter sending, Shift+Enter
// breaking the line, and the same round primary button that turns into stop while
// a turn runs.
// One row of the composer's command-style cards: name, alias and description.
const addRow = (name, alias, description) => h('span', { className: 'nodo-add-row' },
  h('span', { className: 'nodo-add-name' }, name),
  alias && h('span', { className: 'nodo-add-alias' }, alias),
  description && h('span', { className: 'nodo-add-desc' }, description))

// The file mention being typed: an '@' at the start or after a space, with no
// space after it yet. Its text is the search for the file card.
const mentionOf = value => {
  const at = value.lastIndexOf('@')
  if (at === -1 || (at > 0 && !/\s/.test(value[at - 1])) || /\s/.test(value.slice(at + 1))) return null
  return { at, query: value.slice(at + 1) }
}

// The command token being typed: a '/' or '$' at the start or after whitespace,
// running to the end of the draft — the native trigger's word-boundary rule, so
// a slash inside a word or a path stays plain text. The character itself is
// never swallowed; `start` keys Escape dismissal while the token keeps growing.
const triggerOf = value => {
  const cut = /\s\S*$/.exec(value)
  const start = cut === null ? 0 : cut.index + 1
  const token = value.slice(start)
  if (!token.startsWith('/') && !token.startsWith('$')) return null
  return { char: token[0], start, query: token.slice(1) }
}

function Composer({ profile, workspace, value, images, running, busy, readOnly, modelDisabled, onChange, onSend, onStop, onModelChange, onAttach, onRemoveImage, onInsert, onGoal, onCompact, onReference, references = [], onRemoveReference, rolePicker, files: attachedFiles = [], onAttachFiles, onRemoveFile, placeholder = '发消息或创建任务，/ 调用指令，@ 文件或对话' }) {
  const box = useRef(null)
  const card = useRef(null)
  const picker = useRef(null)
  const row = useRef(null)
  const [preview, setPreview] = useState(null)
  const submitBlocked = busy || readOnly || (!running && value.trim() === '' && images.length === 0 && attachedFiles.length === 0 && references.length === 0)
  useEffect(() => {
    const node = box.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 336)}px`
  }, [value])
  // The add menu hangs from this card's top edge (`.nodo-add` pins it there), so
  // the room above the card is what bounds the menu — the same anchored
  // max-height the native command menu works out in JS. The card grows and moves
  // as the draft grows, and moves again when the window is resized.
  useEffect(() => {
    const node = card.current
    if (node === null || typeof window === 'undefined') return
    const fit = () => node.style.setProperty('--nodo-add-space', `${Math.max(120, node.getBoundingClientRect().top - 88)}px`)
    fit()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
    observer?.observe(node)
    window.addEventListener('resize', fit)
    return () => { observer?.disconnect(); window.removeEventListener('resize', fit) }
  }, [])
  // As in the native InputBar, the model trigger drops to its icon once the
  // row's groups no longer fit on one line.
  useEffect(() => {
    const node = row.current
    if (node === null || typeof ResizeObserver !== 'function' || typeof MutationObserver !== 'function') return
    const measure = () => {
      node.removeAttribute('data-model-compact')
      const style = getComputedStyle(node)
      const widths = Array.from(node.children, child => child.getBoundingClientRect().width).filter(width => width > 0)
      const needed = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * parseFloat(style.columnGap)
      node.toggleAttribute('data-model-compact', needed > node.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
    }
    const resize = new ResizeObserver(measure)
    resize.observe(node)
    for (const child of node.children) resize.observe(child)
    const mutation = new MutationObserver(measure)
    mutation.observe(node, { subtree: true, childList: true, characterData: true })
    measure()
    return () => { resize.disconnect(); mutation.disconnect() }
  }, [])
  // The file card follows the '@' being typed: the text after it is the search,
  // Enter takes the first match and Escape leaves the typed text as it is.
  const mention = mentionOf(value)
  const trigger = triggerOf(value)
  const [dismissed, setDismissed] = useState(null)
  const [files, setFiles] = useState(null)
  const fileOpen = !!workspace && mention !== null && dismissed !== mention.at
  useEffect(() => {
    if (!fileOpen) return
    let live = true
    const timer = setTimeout(() => {
      call('workspace-files', { workspace: workspace.id, query: mention.query })
        .then(result => { if (live) setFiles(result.files) })
        .catch(() => { if (live) setFiles([]) })
    }, 150)
    return () => { live = false; clearTimeout(timer) }
  }, [fileOpen, mention?.query, workspace?.id])
  const pickFile = file => { onChange(`${value.slice(0, mention.at)}@${file} `); setDismissed(null) }
  // A command picked while its token is half-typed replaces the token from its
  // start; the button flow appends like any other insertion.
  const insertToken = text => trigger !== null && onChange(`${value.slice(0, trigger.start)}${text}`)
  const keydown = (event) => {
    if (event.nativeEvent?.isComposing) return
    if (fileOpen && event.key === 'Enter' && !event.shiftKey && files?.length) { event.preventDefault(); pickFile(files[0]); return }
    if (fileOpen && event.key === 'Escape') { event.preventDefault(); setDismissed(mention.at); return }
    if (onSend && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!submitBlocked) onSend(); return }
  }
  // Not a flex item: the card rides the composer's top edge like the add menu,
  // and the wrapper leaves the textarea and buttons to the pointer.
  const fileMenu = h(Menu, {
    open: fileOpen, onClose: () => setDismissed(mention?.at ?? null), className: 'nodo-file-anchor', listClassName: 'nodo-add',
    items: [...(onReference ? [{ id: 'reference', icon: h(IconUsersOutlineRegular), label: addRow('引用会话', '', '选择其他角色的一条回复') }] : []), ...(files === null ? [{ type: 'label', id: 'hint', text: '正在搜索…' }]
      : files.length ? files.map(file => ({ id: `file:${file}`, label: addRow(file.split('/').pop(), '', file) }))
        : [{ type: 'label', id: 'hint', text: '没有匹配的文件' }])],
    onSelect: id => {
      if (id === 'reference') { setDismissed(mention.at); onChange(value.slice(0, mention.at)); onReference(); return }
      pickFile(id.slice(5))
    },
    anchor: h('span', { className: 'nodo-file-slot' }),
  })
  // The host keeps the draft focused when a control in the row is pressed.
  const keepFocus = () => box.current?.focus({ preventScroll: true })
  const paste = event => {
    const pasted = Array.from(event.clipboardData?.items ?? []).filter(item => item.kind === 'file' && (onAttachFiles || item.type.startsWith('image/'))).map(item => item.getAsFile()).filter(Boolean)
    if (pasted.length === 0 || readOnly || busy) return
    event.preventDefault()
    ;(onAttachFiles ?? onAttach)(pasted)
  }
  return h('form', {
    ref: card, className: 'nodo-composer', onSubmit: event => { event.preventDefault(); if (onSend && !submitBlocked) onSend() },
    onDragOver: onAttachFiles ? event => { if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault() } : undefined,
    onDrop: onAttachFiles ? event => {
      const dropped = Array.from(event.dataTransfer.files)
      if (!dropped.length) return
      event.preventDefault()
      if (!readOnly && !busy) onAttachFiles(dropped)
    } : undefined,
  },
  fileMenu,
  references.length > 0 && h('div', { className: 'nodo-composer-files', 'aria-label': '本次消息引用' }, references.map(item => h('span', { key: item.id, className: 'nodo-reference-tag' },
    h('button', { type: 'button', disabled: readOnly || busy, onClick: () => onReference(item) }, item.label),
    h('button', { type: 'button', disabled: readOnly || busy, 'aria-label': `移除引用 ${item.label}`, onClick: () => onRemoveReference(item.id) }, '×')))),
  onAttachFiles && h('input', { ref: picker, type: 'file', multiple: true, hidden: true, disabled: readOnly || busy, 'aria-label': '上传图片或文件',
    onChange: event => { const picked = Array.from(event.target.files); event.target.value = ''; if (picked.length && !readOnly && !busy) onAttachFiles(picked) } }),
  attachedFiles.length > 0 && h('div', { className: 'nodo-composer-files' }, attachedFiles.map((file, index) => h('span', { key: file.id ?? index, className: 'nodo-composer-file' },
    h(IconPaperclipOutlineRegular, { size: 14 }), h('span', { title: file.name }, file.name),
    h('button', { type: 'button', disabled: readOnly || busy, 'aria-label': `移除文件 ${file.name}`, onClick: () => onRemoveFile(index) }, '×')))),
  images.length > 0 && h('div', { className: 'nodo-composer-images' },
    images.map((image, index) => h('div', { key: index, className: 'nodo-composer-image' },
      h('button', { type: 'button', className: 'nodo-composer-image-open', title: '查看原图', disabled: !image.dataUrl, onClick: () => setPreview(image) },
        h('img', { src: image.dataUrl, alt: image.name })),
      h('button', { type: 'button', className: 'nodo-composer-image-remove', disabled: readOnly || busy, 'aria-label': `移除图片 ${image.name}`, onClick: () => onRemoveImage(index) }, '×')))),
  preview?.dataUrl && h(ImageLightbox, { src: preview.dataUrl, alt: preview.name ?? '原图', labels: { dialog: '图片预览', close: '关闭预览' }, onClose: () => setPreview(null) }),
  h('div', { className: 'nodo-composer-scroll' },
    h('textarea', {
      ref: box, rows: 1, value, disabled: readOnly, onChange: event => onChange(event.target.value), onKeyDown: keydown, onPaste: paste,
      'aria-label': placeholder, placeholder,
    })),
    h('div', { ref: row, className: 'nodo-composer-row', onMouseDown: keepFocus },
    h('span', { className: 'nodo-composer-tools' },
      (onInsert || onReference) && h(AddMenu, { key: profile?.engine, profile: profile ?? { engine: '' }, workspace, disabled: readOnly || busy, trigger, onInsert, onToken: insertToken, onGoal, onModelChange, onCompact, onReference,
        onUpload: onAttachFiles ? () => picker.current?.click() : undefined }),
      onModelChange && h(PermissionMenu, { profile, disabled: modelDisabled, onChange: onModelChange })),
    h('span', { className: 'nodo-composer-target' }, rolePicker,
      onModelChange && h(ModelPicker, { profile, disabled: modelDisabled, onChange: onModelChange })),
    onSend && h(Tooltip, {
      label: running ? '停止生成' : '发送消息', side: 'top', align: 'end', delayMs: 500,
      children: h('button', {
        type: running ? 'button' : 'submit', className: 'nodo-send',
        disabled: submitBlocked,
        'aria-label': running ? '停止生成' : '发送消息',
        onClick: running ? onStop : undefined,
      }, ComposerGlyph(running)),
    })))
}

// The composer's add menu, a copy of the host's own trigger menu
// (dsh-client-ui-input-trigger): sectioned rows with the kit's icons and the
// native zh faces. 添加 holds the workspace's files, the role's responsibilities
// and the plan tier; 指令 holds the host's compact command and the engine's
// invocable commands, scanned per engine like the model catalog. Files and
// skills land in the draft as plain text — paths and slash lines are what every
// agent resolves — while goal, plan and compact act on the profile and session
// themselves, and an engine without a scannable source says so. Every listed
// command sits in the engine's own scan roots, so its slash line resolves once
// sent; the menu never offers a skill the engine would read as literal text.
function AddMenu({ profile, workspace, disabled, trigger, onInsert, onToken, onGoal, onModelChange, onCompact, onUpload, onReference }) {
  const [manual, setManual] = useState(false)
  const [dismissed, setDismissed] = useState(null)
  const [pane, setPane] = useState('root')
  const [scan, setScan] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [catalog, setCatalog] = useState(null)
  const loaded = useRef(false)
  const load = () => {
    if (loaded.current) return
    loaded.current = true
    if (!profile.engine) { setScan({ source: 'unsupported', commands: [] }); setCatalog([]); return }
    setScanning(true)
    void call('engine-commands', { engine: profile.engine, workspace: workspace?.id })
      .then(value => setScan(value))
      .catch(() => setScan({ source: 'unavailable', commands: [] }))
      .finally(() => setScanning(false))
    void call('engine-catalog', {})
      .then(value => setCatalog(value))
      .catch(() => setCatalog([]))
  }
  // A live trigger token in the draft (a typed / or $) holds the menu open;
  // Escape or an outside click dismisses it at its token, whitespace or
  // deletion ends it, and a token typed anew opens the menu again.
  const open = manual || (trigger !== null && trigger.start !== dismissed)
  useEffect(() => {
    if (trigger === null) { setDismissed(null); return }
    if (!open || trigger.start === dismissed) return
    setPane(trigger.char === '$' ? 'commands' : 'root')
    load()
  }, [open, trigger === null, trigger?.start, dismissed])
  const close = () => { setManual(false); setDismissed(trigger?.start ?? null); setPane('root') }
  const openMenu = () => {
    if (open) return close()
    setManual(true)
    setPane('root')
    load()
  }
  const pick = id => {
    if (id === 'file') { close(); onInsert('@'); return }
    if (id === 'upload') { close(); onUpload(); return }
    if (id === 'reference') { close(); onReference(); return }
    if (id === 'goal') { close(); onGoal(); return }
    if (id === 'plan') { close(); onModelChange({ permission: (profile.permission || 'workspace') === 'plan' ? '' : 'plan' }); return }
    if (id === 'compact') { close(); onCompact(); return }
    if (typeof id === 'string' && id.startsWith('cmd:')) {
      close()
      const line = `/${id.slice(4)} `
      trigger === null ? onInsert(line) : onToken(line)
    }
  }
  const row = addRow
  const engine = (catalog ?? []).find(item => item.id === profile.engine)
  const commands = scan?.commands ?? []
  // The draft keeps typing while the menu is up, so the text after the trigger
  // narrows the command rows (compact among them); with nothing scanned the
  // scan state still speaks, and a query matching nothing says so.
  const query = trigger === null ? '' : trigger.query.trim().toLowerCase()
  const scopeLabel = { project: '项目', plugin: '插件' }
  const candidates = [
    ...(onCompact && engine?.capabilities?.compact === true ? [{ id: 'compact', icon: h(IconCompactOutlineRegular), label: row('压缩', 'compact', '压缩以上对话内容') }] : []),
    ...commands.map(command => ({ id: `cmd:${command.id}`, label: row(command.id, scopeLabel[command.scope] ?? '', command.description) })),
  ]
  const matched = query === '' ? candidates
    : candidates.filter(item => (item.id.startsWith('cmd:') ? item.id.slice(4) : item.id).toLowerCase().includes(query))
  const commandSection = !profile.engine ? [{ type: 'label', id: 'hint', text: '选择接收角色后可使用指令' }] : query === ''
    ? commands.length === 0
      ? [{ type: 'label', id: 'hint', text: scanning || scan === null ? '正在扫描技能…'
        : scan.source === 'unsupported' || scan.source === 'unavailable'
          ? `「${profile.engine}」没有可扫描的指令来源，可直接在文本里输入斜杠指令`
          : `没有扫描到本机指令（${scan.source}）` }]
      : matched
    : matched.length === 0 ? [{ type: 'label', id: 'hint', text: '没有匹配的指令' }] : matched
  const items = pane === 'root' && query === '' ? [
    { type: 'label', id: 'add-title', text: '添加' },
    { id: 'file', icon: h(IconPaperclipOutlineRegular), label: row('文件', 'file'), disabled: !workspace || !onInsert },
    ...(onReference ? [{ id: 'reference', icon: h(IconUsersOutlineRegular), label: row('引用会话', '', '选择其他角色的一条回复') }] : []),
    ...(onUpload ? [{ id: 'upload', icon: h(IconPaperclipOutlineRegular), label: row('上传图片或文件') }] : []),
    ...(onGoal ? [{ id: 'goal', icon: h(IconGoalOutlineRegular), label: row('职责', 'goal', '设置或查看角色职责') }] : []),
    ...(engine?.capabilities?.permissionModes?.includes('plan') ? [{ id: 'plan', icon: h(IconPlanOutlineRegular), label: row('计划', 'plan', '进入或退出计划模式') }] : []),
    { type: 'label', id: 'cmd-title', text: '指令' },
    ...commandSection,
  ] : [{ type: 'label', id: 'cmd-title', text: '指令' }, ...commandSection]
  // Not portaled: the card hangs from the composer card's own top edge at its
  // width (`.nodo-add`), the way the native command menu rides the input card —
  // it never covers the draft and follows the card as it grows. No autoFocus:
  // the draft keeps the keyboard while a typed token holds the menu open.
  return h(Menu, {
    open, onClose: close, className: 'nodo-add-anchor', listClassName: 'nodo-add',
    items, onSelect: pick,
    anchor: h('button', { type: 'button', className: 'nodo-add-trigger', disabled,
      'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': '添加上下文或指令', title: '添加上下文或指令', onClick: openMenu },
    h(IconPlusOutlineRegular, { size: 16 })),
  })
}

// The @-context picker: the workspace's own files, searched host-side and
// bounded there; picking one inserts its relative path into the draft. The
// agent reads the path with its own file tools, so no engine protocol is
// involved and every engine gets the same answer.
// The composer's permission control, a copy of the host's own PermissionSelect
// (dsh-client-ui-permission-presets): the kit's permission glyphs and trigger
// metrics, the same menu, and the same risk confirmation gating the top tier.
// Tiers map per engine at session open; only the declared tiers are offered.
const PERMISSION_LABELS = { '': 'Agent 默认权限', plan: '仅可查看', workspace: '工作区内修改', full: '完全权限' }
const PERMISSION_GLYPHS = { plan: PermissionIconReadOnlyRegular, workspace: PermissionIconWorkspaceWriteRegular, full: PermissionIconFullAccessRegular }
const FULL_ACCESS_CONFIRM = {
  title: '确认启用完全权限？',
  description: '启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
  acknowledgeLabel: '我已了解风险，并愿意继续',
  cancelLabel: '取消',
  closeLabel: '关闭',
  confirmLabel: '启用完全权限',
}
function PermissionMenu({ profile, disabled, onChange }) {
  const [open, setOpen] = useState(false)
  const [modes, setModes] = useState(null)
  const [confirming, setConfirming] = useState(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const loaded = useRef(null)
  const current = profile.permission || (profile.engine === 'dsh' ? '' : 'workspace')
  const openMenu = () => {
    if (open || confirming !== null) return setOpen(false)
    setOpen(true)
    // The tiers are one engine's declaration; a role moved to another engine
    // re-reads them instead of offering tiers it never declared.
    if (loaded.current === profile.engine) return
    loaded.current = profile.engine
    setModes(null)
    void call('engine-catalog').then(items => {
      const offered = items.find(item => item.id === profile.engine)?.capabilities?.permissionModes
      setModes(Array.isArray(offered) ? offered : ['workspace'])
    }).catch(() => setModes(['workspace']))
  }
  const apply = mode => { setOpen(false); setConfirming(null); setAcknowledged(false); onChange({ permission: mode === 'workspace' && profile.engine !== 'dsh' ? '' : mode }) }
  const pick = mode => {
    setOpen(false)
    if (mode === current) return
    // The native control gates the top tier behind the same risk acknowledgment.
    if (mode === 'full') { setAcknowledged(false); setConfirming('full'); return }
    apply(mode)
  }
  const offered = profile.engine === 'dsh' && modes?.length === 0 ? [''] : modes ?? (current ? [current] : [])
  const items = offered.map(mode => ({ id: mode, label: PERMISSION_LABELS[mode] ?? mode,
    ...(PERMISSION_GLYPHS[mode] ? { icon: h(PERMISSION_GLYPHS[mode]) } : {}) }))
  return h(Fragment, null,
    h(Menu, {
      open, onClose: () => setOpen(false), portal: true, side: 'top', align: 'start', autoFocus: true, className: 'nodo-perm',
      selectedId: current, items, onSelect: pick,
      anchor: h('button', { type: 'button', className: 'nodo-perm-trigger', disabled,
        'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': `访问模式，当前：${PERMISSION_LABELS[current] ?? current}`, onClick: openMenu },
      PERMISSION_GLYPHS[current] && h('span', { className: 'nodo-perm-icon', 'aria-hidden': true }, h(PERMISSION_GLYPHS[current])),
      h('span', { className: 'nodo-perm-label' }, PERMISSION_LABELS[current] ?? current),
      h('span', { className: `nodo-perm-chevron${open ? ' nodo-perm-chevron-open' : ''}`, 'aria-hidden': true }, h(IconChevronDownOutlineRegular))),
    }),
    confirming !== null && h(RiskConfirmation, {
      open: true, ...FULL_ACCESS_CONFIRM, acknowledged, disabled,
      onAcknowledgedChange: setAcknowledged,
      onCancel: () => { setConfirming(null); setAcknowledged(false) },
      onConfirm: () => apply('full'),
    }))
}

// Responsibilities use the same identity injection as the role text.
function GoalDialog({ profile, onSaved, onCancel }) {
  const [goal, setGoal] = useState(profile.goal ?? '')
  const [busy, setBusy] = useState(false)
  const submit = event => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    void onSaved(goal.trim())
  }
  return h(Modal, {
    open: true, onClose: () => { if (!busy) onCancel() }, closeLabel: '关闭',
    title: '角色职责', description: '说明这个角色负责什么、工作范围和交付要求，随身份说明用于该角色的会话。',
    className: 'nodo-dialog',
    footer: [
      h(Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: onCancel }, '取消'),
      h(Button, { key: 'save', type: 'submit', form: GOAL_FORM, variant: 'primary', disabled: busy }, busy ? '保存中…' : '保存职责'),
    ],
  },
  h('form', { id: GOAL_FORM, className: 'nodo-dialog-fields', onSubmit: submit, 'aria-label': '角色职责' },
    h('label', { className: 'nodo-field' },
      h('span', null, '职责'),
      h('textarea', { className: 'nodo-dialog-input nodo-dialog-textarea', rows: 4, value: goal,
        placeholder: '例如：负责代码审查，检查实现是否满足需求，识别缺陷与风险并给出修改建议',
        onChange: event => setGoal(event.target.value), 'data-modal-autofocus': true }))))
}
