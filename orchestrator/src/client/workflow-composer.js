import { h, Fragment, useState, useEffect, useRef, call, readImage } from './ui-shared.js'
import { Composer } from './composer.js'
import { RolePicker } from './role-seat.js'
import { wfWorkspace, wfCurrentSession } from './workflow.js'

export function WorkflowTaskComposer({ node, view, disabled, onChange, onBusy }) {
  const [previews, setPreviews] = useState({}), [error, setError] = useState('')
  const uploading = useRef(false)
  const profile = view.profiles.find(item => !item.deletedAt && item.id === node.profileId)
  const workspace = wfWorkspace(view, profile, wfCurrentSession(profile))
  // The card's model and thinking seed a node's session; the tier still carries
  // over from the role's last conversation that chose one.
  const held = profile && { permission: profile.sessions.slice().reverse().find(session =>
    !(session.draftedAt && !session.briefSent) && session.permission !== undefined)?.permission ?? profile.permission }
  const composerProfile = profile && { ...profile, ...held, ...node.choices }
  const refs = node.images ?? []
  useEffect(() => {
    let live = true
    void Promise.all(refs.map(async image => {
      if (previews[image.id]) return [image.id, previews[image.id]]
      const value = await call('attachment', image)
      return [image.id, `data:${value.mediaType};base64,${value.data}`]
    })).then(entries => { if (live) setPreviews(Object.fromEntries(entries)) }).catch(failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [JSON.stringify(refs)])
  const attach = async files => {
    if (disabled || uploading.current || !files.length) return
    uploading.current = true; onBusy(true); setError('')
    try {
      const data = await Promise.all(files.map(readImage))
      const images = data.filter(file => file.mediaType.startsWith('image/'))
      const documents = data.filter(file => !file.mediaType.startsWith('image/'))
      if (images.length + refs.length > 8 || documents.length + (node.files?.length ?? 0) > 8) throw new Error('每个节点最多添加 8 张图片和 8 个文件。')
      const payload = file => ({ name: file.name, mediaType: file.mediaType, data: file.dataUrl.slice(file.dataUrl.indexOf(',') + 1) })
      const saved = await call('attachment-save', { images: images.map(payload), files: documents.map(payload) })
      onChange(current => ({ images: [...(current.images ?? []), ...saved.images], files: [...(current.files ?? []), ...saved.files] }))
    } catch (failure) { setError(failure.message) }
    finally { uploading.current = false; onBusy(false) }
  }
  return h(Fragment, null,
    h(Composer, {
      profile: composerProfile, workspace, value: node.task ?? '', images: refs.map(image => ({ ...image, dataUrl: previews[image.id] })), files: node.files ?? [],
      readOnly: disabled, busy: disabled, modelDisabled: disabled || !profile,
      placeholder: '输入节点任务，/ 选择指令，@ 引用项目文件；可粘贴图片或文件',
      onChange: task => onChange({ task }),
      onAttach: attach, onAttachFiles: attach,
      onRemoveImage: index => onChange(current => ({ images: (current.images ?? []).filter((_, at) => at !== index) })),
      onRemoveFile: index => onChange(current => ({ files: (current.files ?? []).filter((_, at) => at !== index) })),
      onInsert: profile ? text => onChange(current => ({ task: `${current.task ?? ''}${current.task && !/\s$/.test(current.task) ? ' ' : ''}${text}` })) : undefined,
      onModelChange: profile ? selected => onChange(current => ({ choices: { ...current.choices, ...selected,
        ...(selected.permission === '' ? { permission: 'workspace' } : {}) } })) : undefined,
      rolePicker: h(RolePicker, { profiles: view.profiles, profile, disabled,
        onSelect: profileId => onChange({ profileId, choices: {} }) }),
    }),
    error && h('p', { className: 'nodo-wf-input-error', role: 'alert' }, error))
}
