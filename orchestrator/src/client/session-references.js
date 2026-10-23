function createSessionReferences(ctx, space) {
  const source = 'nodo-reference'
  let dialog = null
  const listeners = new Set()
  const publish = value => { dialog = value; for (const listener of listeners) listener() }
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const inputFor = id => ctx.conversation.input.for(ctx.sessions.scope(id))
  const enabled = () => space.getSnapshot().active && !space.getSnapshot().legacy
  const open = (target, snapshot) => publish({ target, snapshot })
  if (ctx.commandUi && ctx.inputTriggers && ctx.conversation) ctx.effect(() => {
    const stops = [
      ctx.commandUi.register({ name: source, label: () => '引用会话', description: () => '选择其他角色的一条完整回复作为参考',
        icon: IconUsersOutlineRegular, available: enabled, ui: { kind: 'action', run: session => open(session.sessionId) } }),
      ctx.inputTriggers.registerSource({ name: source, trigger: '@', candidates: async () => [], onPick: () => undefined,
        codec: {
          clipboardText: ref => `[引用会话](nodo-reference:${JSON.parse(ref).id})`,
          serialize: async (ref, signal) => {
            signal.throwIfAborted()
            // A failed snapshot read must keep the native draft available for retry.
            const snapshot = await call('reference-read', JSON.parse(ref))
            signal.throwIfAborted()
            return `[引用会话](nodo-reference:${snapshot.id})`
          },
        },
        openReference: (session, reference) => { open(session.sessionId, { id: JSON.parse(reference.ref).id }); return true },
      }),
      space.subscribe(() => { if (!enabled()) publish(null) }),
      ctx.uiSession.adapter.current.subscribe(() => {
        if (dialog && dialog.target !== ctx.uiSession.adapter.current.getSnapshot().key) publish(null)
      }),
    ]
    return () => { for (const stop of stops) stop(); listeners.clear() }
  }, 'nodo: session references')

  function ReferenceDialog({ target, draft, snapshot, inputActions, onPick, count = 0, workspaceId, onClose }) {
    const [view, setView] = useState(null)
    const [workspace, setWorkspace] = useState('')
    const [role, setRole] = useState('')
    const [query, setQuery] = useState('')
    const [selected, setSelected] = useState(null)
    const [result, setResult] = useState(null)
    const [messageId, setMessageId] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    useEffect(() => {
      let live = true
      if (snapshot) void call('reference-read', { id: snapshot.id, target, draft }).then(value => {
        if (live) { setResult(value); setMessageId(value.messages[0].id) }
      }).catch(failure => { if (live) setError(failure.message) })
      else void call('state').then(value => {
        if (!live) return
        setView(value)
        const current = value.profiles.flatMap(profile => profile.sessions).find(session => (session.nativeSessionId ?? session.driverSessionId) === target)
        setWorkspace(workspaceId ?? current?.workspaceRef ?? '')
      }).catch(failure => { if (live) setError(failure.message) })
      return () => { live = false }
    }, [target, draft, snapshot?.id, workspaceId])
    useEffect(() => {
      if (!selected) return
      let live = true
      setResult(null); setError(''); setMessageId('')
      void call('reference-replies', selected).then(value => {
        if (live) { setResult(value); setMessageId(value.messages[0]?.id ?? '') }
      }).catch(failure => { if (live) setError(failure.message) })
      return () => { live = false }
    }, [selected?.profile, selected?.session])
    const message = result?.messages.find(item => item.id === messageId)
    const add = async () => {
      if (!message || busy) return
      const input = onPick ? null : inputFor(target)
      if ((onPick ? count : input.state.getSnapshot().occurrences.filter(item => item.source === source).length) >= 4) return setError('一条消息最多引用四条回复。')
      const span = inputActions?.captureInsertion()
      setBusy(true); setError('')
      try {
        const value = await call('reference-create', { target, draft, ...selected, messageId })
        if (onPick) { if (onPick(value) !== false) onClose(); return }
        if (ctx.uiSession.adapter.current.getSnapshot().key !== target || !enabled()) return
        const label = `${value.source.profileName} · ${value.source.sessionName}`
        if (!input.insertReference({ source, ref: JSON.stringify({ id: value.id, target }), label, appearance: 'session', clipboardText: `[引用会话](nodo-reference:${value.id})` }, span)) {
          throw new Error('草稿已变化，请再次点击引用。')
        }
        onClose(); input.focus()
      } catch (failure) { setError(failure.message) }
      finally { setBusy(false) }
    }
    const rows = view?.profiles.flatMap(profile => profile.sessions.filter(session => !session.archivedAt
      && (target === undefined || (session.nativeSessionId ?? (session.engine === 'dsh' ? session.driverSessionId : undefined)) !== target))
      .map(session => ({ profile, session }))).filter(row => (!workspace || row.session.workspaceRef === workspace) && (!role || row.profile.id === role)
        && `${row.profile.name} ${row.session.name}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .sort((a, b) => b.session.updatedAt - a.session.updatedAt) ?? []
    return h(Modal, { open: true, onClose, title: snapshot ? '查看会话引用' : '引用会话', closeLabel: '关闭',
      description: snapshot ? '这是选中回复的固定快照。' : '选择一条完整回复，作为本次任务的参考。', className: 'nodo-reference-dialog',
      footer: h(Fragment, null, h(Button, { onClick: onClose }, snapshot ? '关闭' : '取消'),
        !snapshot && h(Button, { variant: 'primary', disabled: !message || busy, onClick: () => void add() }, busy ? '正在引用…' : '引用这条回复')) },
      h('div', { className: 'nodo-reference-layout' },
        !snapshot && h('section', { className: 'nodo-reference-sources', 'aria-label': '来源会话' },
          h('div', { className: 'nodo-reference-scope' },
            h('select', { value: workspace, 'aria-label': '来源项目', onChange: event => setWorkspace(event.target.value) },
              h('option', { value: '' }, '全部项目'), ...(view?.workspaces ?? []).map(item => h('option', { key: item.id, value: item.id }, item.name))),
            h('select', { value: role, 'aria-label': '来源角色', onChange: event => setRole(event.target.value) },
              h('option', { value: '' }, '全部角色'), ...(view?.profiles ?? []).map(item => h('option', { key: item.id, value: item.id }, item.name)))),
          h(Input, { type: 'search', value: query, 'data-modal-autofocus': true, placeholder: '搜索角色或会话…', 'aria-label': '搜索来源会话', onChange: event => setQuery(event.target.value) }),
          h('div', { className: 'nodo-reference-list' }, rows.map(({ profile, session }) => h('button', {
            key: session.id, type: 'button', className: 'nodo-reference-row', 'aria-pressed': selected?.session === session.id,
            onClick: () => setSelected({ profile: profile.id, session: session.id }) },
          h('strong', null, `${profile.name} · ${session.name}`), h('time', null, session.updatedAt ? new Date(session.updatedAt).toLocaleString() : ''))),
          h('p', { className: 'nodo-note' }, !view ? '正在读取会话…' : !rows.length ? '没有匹配的会话' : ''))),
        h('section', { className: 'nodo-reference-preview', 'aria-label': '回复预览' },
          result?.messages.length > 0 && h('select', { value: messageId, 'aria-label': '选择回复', onChange: event => setMessageId(event.target.value) },
            result.messages.map((item, index) => h('option', { key: item.id, value: item.id }, `${index === 0 ? '最近回复' : `较早回复 ${index}`} · ${new Date(item.at).toLocaleString()} · ${item.text.slice(0, 30)}`))),
          message ? h(MarkdownText, { text: message.text, labels: MARKDOWN_LABELS })
            : h('p', { className: 'nodo-note' }, result ? '该会话还没有可引用的完整回复。' : selected || snapshot ? '正在读取回复…' : '选择左侧会话，预览要引用的回复。'))),
      error && h('p', { role: 'alert', className: 'nodo-error-line' }, error))
  }

  function ReferenceDock({ sessionId, useInput, inputActions }) {
    const current = useSyncExternalStore(subscribe, () => dialog)
    const state = useSyncExternalStore(space.subscribe, space.getSnapshot)
    const input = useInput(value => value)
    useEffect(() => {
      if (!state.active || state.legacy || input.phase !== 'plain') return
      const token = [...input.draft.matchAll(/\[引用会话\]\(nodo-reference:([\da-f-]{36})\)/g)]
        .find(match => !input.occurrences.some(item => match.index >= item.offset && match.index < item.offset + item.length))
      if (!token) return
      let live = true
      void call('reference-read', { id: token[1], target: sessionId }).then(value => {
        if (!live) return
        const start = token.index - input.occurrences.filter(item => item.offset < token.index).reduce((total, item) => total + item.length - 1, 0)
        inputFor(sessionId).insertReference({ source, ref: JSON.stringify({ id: value.id, target: sessionId }),
          label: `${value.source.profileName} · ${value.source.sessionName}`, appearance: 'session', clipboardText: token[0] },
        { start, end: start + token[0].length, draftRev: input.draftRev })
      }).catch(failure => { if (live) inputFor(sessionId).notify('error', failure.message) })
      return () => { live = false }
    }, [sessionId, state.active, state.legacy, input.draftRev, input.phase])
    if (!state.active || state.legacy) return null
    const references = input.occurrences.filter(item => item.source === source)
    const remove = reference => {
      // The editor represents each chip by one character in insertion coordinates.
      const offset = reference.offset - input.occurrences.filter(item => item.offset < reference.offset).reduce((total, item) => total + item.length - 1, 0)
      inputActions.insertText('', { start: offset, end: offset + 1, draftRev: input.draftRev })
    }
    return h(Fragment, null,
      references.length > 0 && h('div', { className: 'nodo-reference-rail', 'aria-label': '本次消息引用' }, references.map(item => h('span', { key: item.occurrenceId, className: 'nodo-reference-tag' },
        h('button', { type: 'button', onClick: () => open(sessionId, { id: JSON.parse(item.ref).id }) }, item.label),
        h('button', { type: 'button', 'aria-label': `移除引用 ${item.label}`, onClick: () => remove(item) }, '×')))),
      current?.target === sessionId && h(ReferenceDialog, { key: `${sessionId}:${current.snapshot?.id ?? 'pick'}`, ...current, inputActions, onClose: () => publish(null) }))
  }
  const installHistory = () => {
    const stops = []
    for (const key of ['user', 'steering']) {
      const native = ctx.slots.entries?.('conversation.chat.node').find(entry => entry.options.key === key)
      if (!native) continue
      function ReferencedMessage(props) {
        const [references, setReferences] = useState([])
        const { sessionId, node } = props
        const hasReferences = node.data.referenceLabels?.length > 0
        useEffect(() => {
          let live = true
          if (hasReferences) void call('reference-history', { target: sessionId, seq: node.data.seq })
            .then(value => { if (live) setReferences(value) }).catch(() => {})
          return () => { live = false }
        }, [sessionId, node.data.seq, hasReferences])
        return h(Fragment, null, h(native.component, props), references.length > 0 && h('details', { className: 'nodo-reference-history' },
          h('summary', null, `查看本条消息的引用（${references.length}）`),
          references.map(value => h('section', { key: value.id }, h('strong', null, `${value.source.profileName} · ${value.source.sessionName}`),
            h(MarkdownText, { text: value.messages.map(message => message.text).join('\n\n'), labels: MARKDOWN_LABELS })))))
      }
      stops.push(ctx.slots.register({ name: 'conversation.chat.node', key, priority: -100, locale: native.locale, inject: native.inject }, ReferencedMessage))
    }
    return () => { for (const stop of stops) stop() }
  }
  return { ReferenceDock, ReferenceDialog, installHistory }
}

// The two panes scroll on their own inside a fixed-height layout: the card
// itself must never scroll, or a long reply moves the whole dialog.
const REFERENCE_CSS = `
.nodo-reference-dialog{width:min(900px,calc(100vw - 32px));max-height:calc(100vh - 120px)}
.nodo-reference-layout{display:flex;gap:16px;height:min(50vh,560px);min-height:180px}
.nodo-reference-sources{display:flex;flex-direction:column;gap:10px;width:280px;flex:none;min-width:0}
.nodo-reference-list{overflow:auto;min-height:0;flex:1}
.nodo-reference-row{display:flex;flex-direction:column;gap:4px;width:100%;text-align:left;padding:10px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.nodo-reference-row:hover,.nodo-reference-row[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-reference-row strong{font-size:13px;font-weight:500;overflow-wrap:anywhere}
.nodo-reference-row time{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.nodo-reference-layout select{width:100%;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit}
.nodo-reference-scope{display:flex;gap:8px;min-width:0}
.nodo-reference-scope select{flex:1;min-width:0}
.nodo-reference-preview{display:flex;flex-direction:column;gap:12px;overflow:auto;min-width:0;min-height:0;flex:1;padding:0 6px;overflow-wrap:anywhere}
.nodo-reference-rail{display:flex;flex-wrap:wrap;gap:6px;width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto 8px;padding:0 16px;box-sizing:border-box}
.nodo-reference-tag{display:inline-flex;max-width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden}
.nodo-reference-tag button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:5px 7px;cursor:pointer;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.nodo-reference-tag button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-reference-history{margin:6px 0 14px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font-size:13px;overflow-wrap:anywhere}
.nodo-reference-history summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}
.nodo-reference-history section{margin-top:12px}
@media(max-width:640px){.nodo-reference-layout{flex-direction:column;height:min(70vh,520px)}.nodo-reference-sources{width:auto;height:180px}.nodo-reference-preview{min-height:0}}
`
