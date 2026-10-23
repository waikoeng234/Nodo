// Creating or editing a workspace uses the same modal as the role dialog, so no
// rail entry ever replaces the conversation with a form page.
function WorkspaceDialog({ workspace = null, onSaved, onCancel }) {
  const [draft, setDraft] = useState({ name: workspace?.name ?? '', cwd: workspace?.cwd ?? '' })
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const edit = key => event => setDraft(current => ({ ...current, [key]: event.target.value }))
  const choose = async () => {
    if (busy || picking || !nativePickDirectory) return
    setPicking(true)
    setError('')
    try {
      const path = await nativePickDirectory()
      if (path) setDraft(current => ({ ...current, cwd: path }))
    } catch (failure) { setError(failure.message) }
    finally { setPicking(false) }
  }
  const submit = async (event) => {
    event.preventDefault()
    if (busy || draft.name.trim() === '' || draft.cwd.trim() === '') return
    setBusy(true)
    setError('')
    try {
      const values = { name: draft.name.trim(), cwd: draft.cwd.trim() }
      const saved = await call(workspace ? 'workspace-update' : 'workspace-create', workspace ? { id: workspace.id, changes: values } : values)
      await onSaved(saved)
    } catch (failure) {
      setError(failure.message)
      setBusy(false)
    }
  }
  return h(Modal, {
    open: true, onClose: () => { if (!busy) onCancel() }, closeLabel: '关闭',
    title: workspace ? '编辑工作区' : '新建工作区',
    description: '工作区是本机上的一个目录，角色在其中工作。',
    className: 'nodo-dialog',
    footer: [
      h(Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: onCancel }, '取消'),
      h(Button, {
        key: 'save', type: 'submit', form: WORKSPACE_FORM, variant: 'primary',
        disabled: busy || !draft.name.trim() || !draft.cwd.trim(),
      }, busy ? '保存中…' : workspace ? '保存修改' : '创建工作区'),
    ],
  },
  h('form', { id: WORKSPACE_FORM, className: 'nodo-dialog-fields', onSubmit: submit, 'aria-label': workspace ? '编辑工作区' : '新建工作区' },
    h(Field, { label: '名字' }, h('input', {
      className: 'nodo-dialog-input', 'data-modal-autofocus': true, disabled: busy, value: draft.name, onChange: edit('name'),
      required: true, maxLength: 40, placeholder: '例如 Website',
    })),
    h(Field, { label: '工作区目录' },
      nativePickDirectory
        ? h('div', { className: 'nodo-dialog-pick' },
          h(Button, { variant: 'outline', disabled: busy || picking, onClick: () => void choose() },
            picking ? '选择中…' : '选择目录…'),
          h('p', { className: 'nodo-dialog-path', title: draft.cwd }, draft.cwd || '尚未选择目录'))
        : h('input', {
          className: 'nodo-dialog-input', disabled: busy, value: draft.cwd, onChange: edit('cwd'),
          required: true, placeholder: '/absolute/path (created if missing)',
        })),
    error && h('p', { className: 'nodo-dialog-error', role: 'alert' }, error)))
}

function WorktreeDialog({ workspace, profile, onCreated, onCancel }) {
  const [refs, setRefs] = useState(null)
  const [refsError, setRefsError] = useState('')
  const [mode, setMode] = useState('new')
  const [base, setBase] = useState('HEAD')
  const [baseOpen, setBaseOpen] = useState(false)
  const [branch, setBranch] = useState(() => `worktree-${Date.now().toString(36)}`)
  const [existing, setExisting] = useState('')
  const [workOpen, setWorkOpen] = useState(false)
  const [existingQuery, setExistingQuery] = useState('')
  const [name, setName] = useState('')
  const [sessionName, setSessionName] = useState('')
  const [openSession, setOpenSession] = useState(profile != null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    call('worktree-refs', { workspace: workspace.id }).then(result => {
      if (!live) return
      setRefs(result)
      setBase(current => current === 'HEAD' && result.head?.name ? result.head.name : current)
      setExisting(current => current || result.branches.find(item => item.name === result.head?.name && !item.checkedOutAt)?.name
        || result.branches.find(item => !item.checkedOutAt)?.name || '')
    }).catch(failure => { if (live) setRefsError(failure.message) })
    return () => { live = false }
  }, [workspace.id])
  const branches = refs?.branches ?? []
  const tags = refs?.tags ?? []
  const effectiveExisting = existing || branches.find(item => !item.checkedOutAt)?.name || ''
  const existingMode = mode === 'existing'
  const workBranch = existingMode ? effectiveExisting : branch.trim()
  const canSubmit = !busy && workBranch !== '' && (existingMode || base.trim() !== '')
  const root = refs?.repositoryRoot ?? workspace.cwd
  const target = workBranch === '' ? '…' : workBranch
  const baseItems = [
    ...branches.map(item => ({ id: `base:branch:${item.name}`, label: `${item.name}${item.name === refs?.head?.name ? '（当前）' : ''}` })),
    ...tags.map(item => ({ id: `base:tag:${item.name}`, label: `${item.name}（标签）` })),
  ]
  const branchMatches = branches.filter(item => existingQuery.trim() === '' || item.name.toLowerCase().includes(existingQuery.trim().toLowerCase()))
  const branchItems = branchMatches.map(item => ({
    id: `branch:${item.name}`,
    label: item.checkedOutAt === undefined ? item.name : `${item.name} · 已检出`,
    disabled: item.checkedOutAt !== undefined,
  }))
  const pickBase = id => {
    if (!id.startsWith('base:')) return
    setBase(id.slice(id.indexOf(':', 5) + 1))
    setBaseOpen(false)
  }
  const submit = async event => {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      const created = await call('worktree-create', existingMode
        ? { workspace: workspace.id, mode: 'existing', branch: workBranch,
          ...(name.trim() === '' ? {} : { name: name.trim() }) }
        : { workspace: workspace.id, mode: 'new', branch: workBranch, from: base.trim(),
          ...(name.trim() === '' ? {} : { name: name.trim() }) })
      await onCreated({ ...created, openSession: openSession && profile != null, sessionName: sessionName.trim() })
    } catch (failure) {
      setError(failure.message)
      setBusy(false)
    }
  }
  const chooseMode = next => {
    if (busy) return
    setMode(next)
    setBaseOpen(false)
    setWorkOpen(false)
    setExistingQuery('')
    setError('')
  }
  return h(Modal, {
    open: true, onClose: () => { if (!busy) onCancel() }, closeLabel: '关闭',
    title: '新建工作树',
    description: '从当前项目创建独立检出，并作为新的工作区继续工作。',
    className: 'nodo-dialog',
    footer: [
      h(Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: onCancel }, '取消'),
      h(Button, {
        key: 'save', type: 'submit', form: WORKTREE_FORM, variant: 'primary',
        disabled: !canSubmit,
      }, busy ? '创建中…' : openSession && profile != null ? '创建并打开' : '创建工作区'),
    ],
  },
  h('form', { id: WORKTREE_FORM, className: 'nodo-dialog-fields', onSubmit: submit, 'aria-label': '新建工作树' },
    h(Field, { label: '源项目' },
      h('p', { className: 'nodo-dialog-path', title: workspace.cwd }, workspace.cwd)),
    h(Field, { label: '创建方式', group: true },
      h('div', { className: 'nodo-worktree-modes', role: 'group', 'aria-label': '工作树创建方式' },
        h(Button, { type: 'button', variant: existingMode ? 'outline' : 'primary', size: 'sm', disabled: busy,
          onClick: () => chooseMode('new') }, '新建分支'),
        h(Button, { type: 'button', variant: existingMode ? 'primary' : 'outline', size: 'sm', disabled: busy,
          onClick: () => chooseMode('existing') }, '使用已有分支'))),
    existingMode
      ? h(Field, { label: '工作分支' },
        h(Menu, {
          open: workOpen, onClose: () => { setWorkOpen(false); setExistingQuery('') }, portal: true, align: 'start', className: 'nodo-branch-menu',
          items: branchItems.length ? branchItems : [{ type: 'label', id: 'empty',
            text: refsError || (refs === null ? '正在读取分支…' : branches.length ? '没有匹配的分支' : '没有可用的本地分支') }],
          onSelect: id => {
            if (!id.startsWith('branch:')) return
            setExisting(id.slice('branch:'.length)); setExistingQuery(''); setWorkOpen(false)
          },
          anchor: h('div', { className: 'nodo-branch-input' },
            h('input', {
              className: 'nodo-dialog-input', value: workOpen ? existingQuery : effectiveExisting, disabled: busy,
              onChange: event => setExistingQuery(event.target.value),
              onFocus: () => { if (!busy) { setExistingQuery(''); setWorkOpen(true) } },
              onKeyDown: event => {
                if (event.key !== 'Enter' || !workOpen) return
                event.preventDefault()
                const first = branchMatches.find(item => item.checkedOutAt === undefined)
                if (first !== undefined) { setExisting(first.name); setExistingQuery(''); setWorkOpen(false) }
              },
              placeholder: effectiveExisting || '搜索已有分支', 'aria-label': '搜索或选择已有分支', autoComplete: 'off',
            }),
            h('button', {
              type: 'button', className: 'nodo-branch-toggle', disabled: busy,
              'aria-label': '选择已有分支', 'aria-haspopup': 'menu', 'aria-expanded': workOpen,
              onClick: () => { setExistingQuery(''); setWorkOpen(open => !open) },
            }, h(IconChevronDownOutlineRegular, { size: 14 }))),
        }),
        h('p', { className: 'nodo-dialog-hint' }, refsError !== '' ? refsError
          : refs !== null && effectiveExisting === '' ? '没有未被占用的本地分支；请改用“新建分支”。'
            : '已检出的分支不能重复检出；main 可直接在当前项目工作，或从它新建分支。'))
      : h(Fragment, null,
        h(Field, { label: '基准' },
          h(Menu, {
            open: baseOpen, onClose: () => setBaseOpen(false), portal: true, align: 'start', className: 'nodo-branch-menu',
            items: baseItems.length ? baseItems : [{ type: 'label', id: 'empty', text: refsError || (refs === null ? '正在读取分支…' : '没有可用的本地引用') }],
            onSelect: pickBase,
            anchor: h('div', { className: 'nodo-branch-input' },
              h('input', {
                className: 'nodo-dialog-input', value: base, disabled: busy,
                onChange: event => setBase(event.target.value), onFocus: () => { if (!busy) setBaseOpen(true) },
                placeholder: '分支、tag 或 commit', 'aria-label': '基准分支或 revision', autoComplete: 'off',
              }),
              h('button', {
                type: 'button', className: 'nodo-branch-toggle', disabled: busy,
                'aria-label': '选择基准分支', 'aria-haspopup': 'menu', 'aria-expanded': baseOpen,
                onClick: () => setBaseOpen(open => !open),
              }, h(IconChevronDownOutlineRegular, { size: 14 }))),
          })),
        h('p', { className: 'nodo-dialog-hint' }, refsError !== ''
          ? `无法读取分支列表，可直接输入分支名、tag 或 commit。${refsError}`
          : refs?.truncated ? '下拉只列出最近 200 个引用，可直接输入完整名称。'
            : '从本地分支、标签或 commit 开始；不会 fetch 远端。'),
        h(Field, { label: '新分支' }, h('input', {
          className: 'nodo-dialog-input', value: branch, disabled: busy, required: true, maxLength: 200,
          onChange: event => setBranch(event.target.value), placeholder: '例如 feature/login',
        }))),
    h(Field, { label: '工作区名称' }, h('input', {
      className: 'nodo-dialog-input', value: name, disabled: busy, maxLength: 40,
      onChange: event => setName(event.target.value), placeholder: (existingMode ? effectiveExisting : branch.trim()) || '默认使用分支名',
    })),
    h(Field, { label: '会话名称' }, h('input', {
      className: 'nodo-dialog-input', value: sessionName, disabled: busy, maxLength: 80,
      onChange: event => setSessionName(event.target.value), placeholder: '可选，默认沿用自动命名',
    })),
    h('p', { className: 'nodo-dialog-hint' }, existingMode
      ? `将在 ${root}/.nodo/worktrees/${target} 检出已有分支 ${target}；已被其他工作树检出的分支不可重复选择。`
      : `将从 ${base.trim() || 'HEAD'} 创建分支 ${target}，检出到 ${root}/.nodo/worktrees/${target}。未提交文件和依赖不会复制。`),
    h('label', { className: 'nodo-worktree-toggle' },
      h('input', {
        type: 'checkbox', checked: openSession && profile != null, disabled: busy || profile == null,
        onChange: event => setOpenSession(event.target.checked),
      }), '创建后在新工作树中新建会话'),
    profile == null && h('p', { className: 'nodo-dialog-hint' }, '当前没有选中角色；工作树创建后可在左侧选择角色，再新建会话。'),
    error !== '' && h('p', { className: 'nodo-dialog-error', role: 'alert' }, error)))
}

// Rename a workspace by name alone, like dsh's own dialog: the folder itself is
// not touched, and the name has to stay unique across the list.
function WorkspaceRenameDialog({ workspace, names, onCancel, onSaved }) {
  const [draft, setDraft] = useState(workspace.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const composing = useRef(false)
  const name = draft.trim()
  const conflict = names.some(item => item.id !== workspace.id && item.name.trim() === name)
  const blocked = busy || name === '' || name === workspace.name || conflict
  const submit = async () => {
    if (blocked) return
    setBusy(true)
    setError('')
    try { await onSaved(workspace.id, name) } catch (failure) { setError(failure.message); setBusy(false) }
  }
  return h(Modal, {
    open: true, onClose: () => { if (!busy) onCancel() }, closeLabel: '关闭', title: '重命名工作区',
    footer: [
      h(Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: onCancel }, '取消'),
      h(Button, { key: 'save', variant: 'primary', disabled: blocked, onClick: () => void submit() }, '重命名'),
    ],
  },
  h('input', {
    className: 'nodo-dialog-input', value: draft, 'aria-label': '工作区名称', 'data-modal-autofocus': true, disabled: busy,
    onFocus: event => event.target.select(),
    onChange: event => { setDraft(event.target.value); setError('') },
    onCompositionStart: () => { composing.current = true },
    onCompositionEnd: () => { composing.current = false },
    onKeyDown: event => {
      if (event.key !== 'Enter' || composing.current) return
      event.preventDefault()
      void submit()
    },
  }),
  conflict && h('div', { className: 'nodo-dialog-error', role: 'alert' }, `已存在名为“${name}”的工作区。`),
  error !== '' && h('div', { className: 'nodo-dialog-error', role: 'alert' }, error))
}

function SessionRenameDialog({ session, onCancel, onSaved }) {
  const [draft, setDraft] = useState(session.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const composing = useRef(false)
  const name = draft.trim()
  const blocked = busy || name === '' || name === session.name
  const submit = async () => {
    if (blocked) return
    setBusy(true)
    setError('')
    try { await onSaved(name) } catch (failure) { setError(failure.message); setBusy(false) }
  }
  return h(Modal, {
    open: true, onClose: () => { if (!busy) onCancel() }, closeLabel: '关闭', title: '修改会话名称',
    footer: [
      h(Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: onCancel }, '取消'),
      h(Button, { key: 'save', variant: 'primary', disabled: blocked, onClick: () => void submit() }, '保存'),
    ],
  },
  h('input', {
    className: 'nodo-dialog-input', value: draft, 'aria-label': '会话名称', 'data-modal-autofocus': true, disabled: busy, maxLength: 80,
    onFocus: event => event.target.select(),
    onChange: event => { setDraft(event.target.value); setError('') },
    onCompositionStart: () => { composing.current = true },
    onCompositionEnd: () => { composing.current = false },
    onKeyDown: event => {
      if (event.key !== 'Enter' || composing.current) return
      event.preventDefault()
      void submit()
    },
  }),
  error !== '' && h('div', { className: 'nodo-dialog-error', role: 'alert' }, error))
}

function WorkspaceDeleteDialog({ workspace, onCancel, onDeleted }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const remove = async () => {
    setBusy(true)
    setError('')
    try { await onDeleted(workspace.id) } catch (failure) { setError(failure.message); setBusy(false) }
  }
  return h(Modal, {
    open: true, onClose: () => { if (!busy) onCancel() }, closeLabel: '关闭', title: '删除工作区',
    description: workspace.worktree
      ? `将把“${workspace.name}”从工作区列表移除。工作树目录和分支会保留；仍有角色或会话用它时无法删除。`
      : `将把“${workspace.name}”从工作区列表移除。目录本身不会被删除；仍有角色或会话用它时无法删除。`,
    footer: [
      h(Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: onCancel }, '取消'),
      h(Button, { key: 'delete', variant: 'outline', className: 'nodo-dialog-danger', disabled: busy, onClick: () => void remove() }, '删除工作区'),
    ],
  },
  busy && h('div', { className: 'nodo-dialog-status', role: 'status' }, '正在删除工作区…'),
  error !== '' && h('div', { className: 'nodo-dialog-error', role: 'alert' }, error))
}
