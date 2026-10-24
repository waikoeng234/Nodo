import { h, useState, useRef, useSyncExternalStore, useStateView, call, readImage, NodoLogo } from './ui-shared.js'
import { Composer } from './composer.js'
import { RolePicker } from './role-seat.js'
import { nativeRole, readDrafts, heldImages, subscribeNavigation, readNavigation, setNavigation } from './page.js'

export function createNewConversation(ctx, space, ReferenceDialog) {
  const readOptions = () => {
    try { return JSON.parse(localStorage.getItem('nodo.draft-options')) ?? {} } catch { return {} }
  }
  const saveOptions = (key, value) => {
    const options = readOptions()
    if (value) options[key] = value
    else delete options[key]
    try { localStorage.setItem('nodo.draft-options', JSON.stringify(options)) } catch {}
  }
  function NewConversation({ draft, sourceSessionId }) {
    const { view, error: loadError } = useStateView()
    const navigation = useSyncExternalStore(subscribeNavigation, readNavigation)
    const key = `new:${draft?.id ?? sourceSessionId}`
    const [text, setText] = useState(() => readDrafts()[key] ?? '')
    const [images, setImages] = useState(() => heldImages[key] ?? [])
    const [selection, setSelection] = useState(() => {
      const saved = readOptions()[key] ?? { profile: draft?.profile, choices: {} }
      return { ...saved, referenceDraft: saved.referenceDraft ?? crypto.randomUUID() }
    })
    const choices = selection.choices
    const references = selection.references ?? []
    const files = selection.files ?? []
    const [reference, setReference] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const pending = useRef(false), created = useRef(null), uploading = useRef(false)
    const sourceRole = sourceSessionId && view?.profiles.find(role => role.sessions.some(session =>
      (session.engine === 'dsh' ? session.driverSessionId : undefined) === sourceSessionId))
    const sourceSession = sourceRole?.sessions.find(session => (session.engine === 'dsh' ? session.driverSessionId : undefined) === sourceSessionId)
    const profile = view?.profiles.find(role => role.id === (selection.profile ?? sourceRole?.id ?? (!draft ? navigation.profile : undefined)))
    const workspace = view?.workspaces.find(item => item.id === (draft?.workspace ?? sourceSession?.workspaceRef ?? navigation.workspace)) ?? view?.workspaces[0]
    const disabled = busy || !view || view.readOnly != null
    const active = () => space.getSnapshot().active && (draft
      ? space.getSnapshot().drafting && space.getSnapshot().draft?.id === draft.id : ctx.uiSession.adapter.current.getSnapshot().key === sourceSessionId)
    const changeText = value => {
      setText(value)
      try { localStorage.setItem('nodo.drafts', JSON.stringify({ ...readDrafts(), [key]: value })) } catch {}
    }
    const changeImages = value => {
      const next = typeof value === 'function' ? value(heldImages[key] ?? []) : value
      heldImages[key] = next; setImages(next)
    }
    const updateSelection = value => setSelection(current => {
      const next = typeof value === 'function' ? value(current) : value
      saveOptions(key, next)
      return next
    })
    const chooseRole = id => { updateSelection(current => ({ ...current, profile: id, choices: {} })); setError('') }
    // The card's model and thinking seed a new conversation; the tier still carries
    // over from the role's last conversation that chose one.
    const held = profile && { permission: profile.sessions.slice().reverse().find(session =>
      !(session.draftedAt && !session.briefSent) && session.permission !== undefined)?.permission ?? profile.permission }
    const composerProfile = profile && { ...profile, ...held, ...choices }
    const clearDraft = () => { changeText(''); changeImages([]); setSelection(current => ({ ...current, references: [], files: [] })); saveOptions(key, null); if (draft) space.endDraft(draft.id) }
    // The picker's files split the way the workflow composer's do: images ride
    // the draft inline, documents become stored references that only turn into
    // workspace paths — the one address every engine can read — when sent.
    const attach = async picked => {
      if (disabled || uploading.current || !picked.length) return
      uploading.current = true; setError('')
      try {
        const data = await Promise.all(picked.map(readImage))
        const added = data.filter(item => item.mediaType.startsWith('image/'))
        const documents = data.filter(item => !item.mediaType.startsWith('image/'))
        if (added.length + images.length > 8 || documents.length + files.length > 8) throw new Error('每条消息最多添加 8 张图片和 8 个文件。')
        if (added.length) changeImages(current => [...current, ...added])
        if (documents.length) {
          const saved = await call('attachment-save', { images: [],
            files: documents.map(item => ({ name: item.name, mediaType: item.mediaType, data: item.dataUrl.slice(item.dataUrl.indexOf(',') + 1) })) })
          updateSelection(current => ({ ...current, files: [...(current.files ?? []), ...saved.files] }))
        }
      } catch (failure) { setError(failure.message) }
      finally { uploading.current = false }
    }
    const send = async () => {
      if (disabled || pending.current || (!text.trim() && !images.length && !references.length && !files.length)) return
      if (!profile) { setError('请选择接收消息的角色。'); return }
      if (!workspace) { setError('请先添加或选择项目。'); return }
      pending.current = true; setBusy(true); setError('')
      try {
        const signature = JSON.stringify([profile.id, workspace.id, choices])
        if (created.current?.signature !== signature) {
          const session = await call('session-create', { profile: profile.id, workspace: workspace.id, lazy: true, choices })
          created.current = { signature, session }
        }
        if (!active()) return
        const session = created.current.session
        if (nativeRole(profile)) {
          const placed = files.length ? await call('attachment-place', { files, workspace: workspace.id }) : { text: '' }
          const opened = await call('session-open', { profile: profile.id, session: session.id, workspace: workspace.id })
          await ctx.sessions.using(opened.sessionId, { source: 'controllerOperation' }, async reference => {
            const binding = await reference.ready
            if (!active()) return
            const bound = await Promise.all(references.map(item => call('reference-bind', { id: item.id, draft: selection.referenceDraft, target: opened.sessionId })))
            if (!active()) return
            const input = [text, placed.text, ...bound.map(item => `[引用会话](nodo-reference:${item.id})`)].filter(Boolean).join('\n')
            const result = await binding.session.prompt([
              ...(input.trim() ? [{ type: 'text', text: input }] : []),
              ...images.map(image => ({ type: 'image', mediaType: image.mediaType, name: image.name,
                data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) })),
            ], 'queue')
            if (!result.ok) throw new Error(result.error.message)
            setNavigation(value => ({ ...value, profile: profile.id, workspace: workspace.id,
              sessions: { ...value.sessions, [`${workspace.id}:${profile.id}`]: session.id } }))
            if (active()) space.open(opened.sessionId)
            clearDraft()
          })
        } else {
          const bound = await Promise.all(references.map(item => call('reference-bind', { id: item.id, draft: selection.referenceDraft, target: session.id })))
          if (!active()) return
          await call('send', { profile: profile.id, session: session.id,
            text: text || (references.length ? '请参考引用的会话结果。' : ''),
            ...(files.length ? { files } : {}),
            ...(bound.length ? { references: bound.map(item => ({ id: item.id })) } : {}),
            images: images.map(image => ({ mediaType: image.mediaType, name: image.name, data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) })) })
          setNavigation(value => ({ ...value, profile: profile.id, workspace: workspace.id,
            sessions: { ...value.sessions, [`${workspace.id}:${profile.id}`]: session.id } }))
          if (active()) space.showLegacy()
          clearDraft()
        }
      } catch (failure) { setError(failure.message) }
      finally { pending.current = false; setBusy(false) }
    }
    return h('section', { className: 'nodo-welcome', 'data-nodo-new-conversation': true },
      h('div', { className: 'nodo-welcome-body' },
        h('header', { className: 'nodo-welcome-hero' }, h(NodoLogo, { width: 160 })),
        h(Composer, {
          profile: composerProfile, workspace, value: text, images, files, references, busy, readOnly: disabled, modelDisabled: disabled,
          onChange: changeText, onSend: () => void send(),
          onAttachFiles: attach,
          onRemoveImage: index => changeImages(images.filter((_, position) => position !== index)),
          onRemoveFile: index => updateSelection(current => ({ ...current, files: (current.files ?? []).filter((_, at) => at !== index) })),
          onInsert: profile ? value => changeText(`${text}${text && !/\s$/.test(text) ? ' ' : ''}${value}`) : undefined,
          onGoal: () => setError('请在角色配置中修改职责说明。'), onCompact: () => setError('发送后可压缩会话上下文。'),
          onModelChange: profile ? changes => updateSelection(current => ({ ...current, profile: profile.id, choices: { ...current.choices, ...changes,
            ...(changes.permission === '' && profile.engine !== 'dsh' ? { permission: 'workspace' } : {}) } })) : undefined,
          rolePicker: h(RolePicker, { profiles: view?.profiles ?? [], profile, disabled, onSelect: chooseRole }),
          onReference: value => { if (!disabled) setReference(value?.id ? value : {}) },
          onRemoveReference: id => { if (!disabled) updateSelection(current => ({ ...current, references: (current.references ?? []).filter(item => item.id !== id) })) },
        }),
        reference && h(ReferenceDialog, { draft: selection.referenceDraft, workspaceId: workspace?.id, snapshot: reference.id ? reference : undefined,
          count: references.length, onClose: () => setReference(null), onPick: value => {
            if (!active() || disabled) return false
            updateSelection(current => ({ ...current, references: [...(current.references ?? []),
              { id: value.id, label: `${value.source.profileName} · ${value.source.sessionName}` }] }))
          } }),
        (error || loadError) && h('p', { className: 'nodo-error-line', role: 'alert' }, error || loadError)))
  }
  return { NewConversation }
}
