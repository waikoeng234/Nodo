import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readPanelSource } from './helpers/client-source.js'
import { Script, createContext } from 'node:vm'

const plain = value => JSON.parse(JSON.stringify(value))
const client = readPanelSource()
const find = (tree, type) => tree?.type === type ? tree : tree?.children?.map(child => find(child, type)).find(Boolean)

function harness({ defaultRole = 'a', readOnly = null, sourceSessionId } = {}) {
  const roles = ['a', 'b'].map(id => ({ id, name: `角色 ${id}`, engine: 'dsh',
    sessions: id === 'a' ? [{ id: 'history', engine: 'dsh', driverSessionId: 'native-a', model: 'previous', thinking: 'high' }] : [] }))
  const view = { profiles: roles, workspaces: [{ id: 'project' }], readOnly }
  let navigation = {}, state = { active: true, legacy: false, drafting: true, draft: { id: 'draft', profile: defaultRole, workspace: 'project' } }
  if (sourceSessionId) state.draft = undefined
  const calls = [], prompts = [], opened = [], lifecycle = [], storage = new Map(), legacy = []
  let failure, bindingFailure, onPrompt, sequence = 0
  const ctx = {
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: sourceSessionId }) } } },
    sessions: { using: async (id, options, callback) => {
      assert.equal(options.source, 'controllerOperation')
      lifecycle.push(['retain', id])
      try { return await callback({ ready: Promise.resolve({ session: { prompt: async (content, mode) => {
        prompts.push({ id, content: plain(content), mode })
        await onPrompt?.()
        return failure ? { ok: false, error: { message: failure } } : { ok: true, value: { accepted: true } }
      } } }) }) } finally { lifecycle.push(['release', id]) }
    } },
  }
  const space = { getSnapshot: () => state,
    open: id => { opened.push(id); state = { ...state, draft: undefined } },
    showLegacy: () => { legacy.push(true); state = { ...state, legacy: true, draft: undefined } } }
  const cells = []
  let cursor = 0
  const context = createContext({
    h: (type, props, ...children) => ({ type, props, children: children.flat() }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState: initial => {
      const at = cursor++
      cells[at] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [cells[at].value, update => { cells[at].value = typeof update === 'function' ? update(cells[at].value) : update }]
    },
    useRef: current => { const at = cursor++; cells[at] ??= { current }; return cells[at] },
    useStateView: () => ({ view, error: '' }),
    subscribeNavigation: () => () => {}, readNavigation: () => navigation,
    setNavigation: update => { navigation = update(navigation) },
    readDrafts: () => JSON.parse(storage.get('nodo.drafts') ?? '{}'), heldImages: {},
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    Composer: 'Composer', RolePicker: 'RolePicker', NodoLogo: 'Logo', readImage: async image => image,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    call: async (endpoint, payload) => {
      calls.push({ endpoint, ...plain(payload) })
      if (endpoint === 'session-create') return { id: `session-${++sequence}` }
      if (endpoint === 'session-open') return { sessionId: `native-${payload.profile}`, conversationId: payload.session }
      if (endpoint === 'reference-bind') {
        if (bindingFailure) throw new Error(bindingFailure)
        return { id: `${payload.id}-bound`, target: payload.target }
      }
      if (endpoint === 'send') return { mode: 'turn' }
      if (endpoint === 'attachment-save') return { images: [], files: (payload.files ?? []).map((file, index) => ({ id: `file-${index + 1}`, name: file.name })) }
      if (endpoint === 'attachment-place') return { files: ['/tmp/attached'], text: '## Attached files (user provided)\n- "/tmp/attached"' }
      throw new Error(`Unexpected ${endpoint}`)
    },
  })
  new Script(`${client.match(/^const nativeRole = .*$/m)[0]}\n${readFileSync(new URL('../src/client/new-conversation.js', import.meta.url), 'utf8')}`).runInContext(context)
  const { NewConversation } = context.createNewConversation(ctx, space, 'ReferenceDialog')
  const draft = state.draft
  const render = () => { cursor = 0; return NewConversation({ draft, sourceSessionId }) }
  const composer = () => find(render(), 'Composer').props
  const send = async () => { composer().onSend(); await new Promise(resolve => setImmediate(resolve)) }
  return { roles, view, calls, prompts, opened, lifecycle, legacy, render, composer, send, storage,
    remount: () => { cells.length = 0 },
    navigation: () => navigation, fail: message => { failure = message }, failBinding: message => { bindingFailure = message }, duringPrompt: callback => { onPrompt = callback },
    pickReference: (id = 'snapshot') => {
      composer().onReference()
      const dialog = find(render(), 'ReferenceDialog').props
      dialog.onPick({ id, source: { profileName: 'Planner', sessionName: 'Plan' } }); dialog.onClose()
      return dialog
    } }
}

test('opening an unbound new conversation without a role creates nothing', async () => {
  const h = harness({ defaultRole: null })
  assert.equal(h.composer().rolePicker.props.profile, undefined)
  h.composer().onChange('hello')
  await h.send()
  assert.deepEqual(h.calls, [])
  assert.match(JSON.stringify(h.render()), /请选择接收消息的角色/)
})

test('role selection keeps text and images in the unbound draft and creates nothing', async () => {
  const h = harness()
  h.composer().onChange('请审查')
  const image = { name: 'photo', mediaType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }
  h.composer().onAttachFiles([image])
  await new Promise(resolve => setImmediate(resolve))
  h.composer().rolePicker.props.onSelect('b')
  assert.equal(h.composer().profile.id, 'b')
  assert.equal(h.composer().value, '请审查')
  assert.deepEqual(plain(h.composer().images), [image])
  assert.deepEqual(h.calls, [])
  assert.equal(h.composer().rolePicker.props.profile.name, '角色 b')
  await h.send()
  assert.deepEqual(h.prompts[0].content[1], { type: 'image', mediaType: 'image/png', name: 'photo', data: 'AAAA' })
})

test('the final chosen role wins over the sidebar default on the first send', async () => {
  const h = harness()
  assert.equal(h.composer().profile.id, 'a')
  h.composer().onChange('给 B 的消息')
  h.composer().rolePicker.props.onSelect('b')
  await h.send()
  assert.deepEqual(h.calls, [
    { endpoint: 'session-create', profile: 'b', workspace: 'project', lazy: true, choices: {} },
    { endpoint: 'session-open', profile: 'b', session: 'session-1', workspace: 'project' },
  ])
  assert.deepEqual(h.prompts, [{ id: 'native-b', content: [{ type: 'text', text: '给 B 的消息' }], mode: 'queue' }])
  assert.deepEqual(h.opened, ['native-b'])
  assert.deepEqual(h.lifecycle, [['retain', 'native-b'], ['release', 'native-b']])
  assert.equal(h.navigation().profile, 'b')
  assert.equal(h.navigation().sessions['project:b'], 'session-1')
  assert.equal(JSON.parse(h.storage.get('nodo.drafts'))['new:draft'], '')
})

test('a native draft with picked files prompts the host session with the placed paths', async () => {
  const h = harness()
  h.composer().onChange('Review the spec')
  await h.composer().onAttachFiles([{ name: 'spec.pdf', mediaType: 'application/pdf', dataUrl: 'data:application/pdf;base64,Qg==' }])
  await h.send()
  assert.deepEqual(h.calls.find(call => call.endpoint === 'attachment-place'), { endpoint: 'attachment-place',
    files: [{ id: 'file-1', name: 'spec.pdf' }], workspace: 'project' })
  assert.deepEqual(h.prompts[0].content, [{ type: 'text', text: 'Review the spec\n## Attached files (user provided)\n- "/tmp/attached"' }])
})

test('sending with the default role creates a fresh session for that role', async () => {
  const h = harness()
  h.composer().onChange('new task')
  await h.send()
  assert.equal(h.calls[0].profile, 'a')
  assert.equal(h.calls[0].session, undefined, 'history is never selected for a new task')
  assert.equal(h.prompts[0].id, 'native-a')
})

test('DSH drafts preserve an explicit clear of inherited permissions on first send', async () => {
  const h = harness({ defaultRole: 'b' })
  h.roles[1].permission = 'workspace'
  h.composer().onModelChange({ permission: '' })
  assert.equal(h.composer().profile.permission, '')
  h.composer().onChange('use engine defaults')
  await h.send()
  assert.deepEqual(h.calls[0], { endpoint: 'session-create', profile: 'b', workspace: 'project', lazy: true, choices: { permission: '' } })
})

test('a native blank entry supplies only a default recipient until send', () => {
  const h = harness({ sourceSessionId: 'native-a', defaultRole: undefined })
  assert.equal(h.composer().profile.id, 'a')
  h.composer().rolePicker.props.onSelect('b')
  assert.equal(h.composer().profile.id, 'b')
  assert.deepEqual(h.calls, [])
})

test('a native blank entry keeps its own project when the recipient changes', async () => {
  const h = harness({ sourceSessionId: 'native-a' })
  h.roles[0].sessions[0].workspaceRef = 'other-project'
  h.view.workspaces.push({ id: 'other-project' })
  h.composer().rolePicker.props.onSelect('b')
  h.composer().onChange('same project')
  await h.send()
  assert.equal(h.calls[0].workspace, 'other-project')
})

test('draft model choices come from the card, reset when the recipient changes, and travel on creation', async () => {
  const h = harness()
  h.roles[0].engine = 'codex'
  h.roles[0].model = 'card'; h.roles[0].thinking = 'medium'
  assert.deepEqual({ model: h.composer().profile.model, thinking: h.composer().profile.thinking }, { model: 'card', thinking: 'medium' },
    'the card seeds a new conversation, not the previous session')
  h.composer().onModelChange({ model: 'picked', thinking: 'low', permission: '' })
  assert.equal(h.roles[0].model, 'card', 'a pick in the draft never rewrites the card')
  assert.equal(h.composer().profile.model, 'picked')
  assert.equal(h.composer().profile.permission, 'workspace', 'outside DSH a cleared tier falls back to workspace')
  h.composer().rolePicker.props.onSelect('b')
  assert.equal(h.composer().profile.model, undefined)
  h.composer().onModelChange({ model: 'b-model', thinking: 'medium', permission: '' })
  h.composer().onChange('with choices')
  await h.send()
  assert.deepEqual(h.calls[0].choices, { model: 'b-model', thinking: 'medium', permission: '' })
})

test('a refused first prompt preserves the draft and retries the same created session', async () => {
  const h = harness()
  h.composer().onChange('retain me')
  h.pickReference()
  h.fail('模型暂不可用')
  await h.send()
  assert.equal(h.composer().value, 'retain me')
  assert.equal(h.composer().references.length, 1)
  assert.deepEqual(h.opened, [])
  assert.match(JSON.stringify(h.render()), /模型暂不可用/)
  h.fail(undefined)
  await h.send()
  assert.equal(h.calls.filter(call => call.endpoint === 'session-create').length, 1)
  assert.deepEqual(h.opened, ['native-a'])
})

test('remounting the same draft retains the chosen recipient and its local model', async () => {
  const h = harness()
  h.composer().onChange('persisted task')
  h.composer().rolePicker.props.onSelect('b')
  h.composer().onModelChange({ model: 'b-pick' })
  h.remount()
  assert.equal(h.composer().profile.id, 'b')
  assert.equal(h.composer().profile.model, 'b-pick')
  assert.equal(h.composer().value, 'persisted task')
  assert.deepEqual(h.calls, [])
  await h.send()
  assert.equal(h.calls[0].profile, 'b')
})

test('read-only and repeated send cannot create extra conversations', async () => {
  const readonly = harness({ readOnly: 'viewer' })
  readonly.composer().onChange('blocked')
  await readonly.send()
  assert.deepEqual(readonly.calls, [])
  const h = harness()
  let release
  const gate = new Promise(resolve => { release = resolve })
  h.duringPrompt(() => gate)
  h.composer().onChange('only once')
  const send = h.composer().onSend
  send(); send()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.filter(call => call.endpoint === 'session-create').length, 1)
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.prompts.length, 1)
})

test('new drafts keep references across recipient changes and remounts without creating a conversation', async () => {
  const h = harness({ defaultRole: null })
  const dialog = h.pickReference()
  assert.equal(dialog.draft, '00000000-0000-4000-8000-000000000001')
  assert.equal(dialog.target, undefined)
  assert.deepEqual(h.calls, [])
  h.composer().rolePicker.props.onSelect('b')
  h.remount()
  assert.deepEqual(plain(h.composer().references), [{ id: 'snapshot', label: 'Planner · Plan' }])
  await h.send()
  assert.equal(h.calls.find(call => call.endpoint === 'session-create').profile, 'b')
  assert.deepEqual(h.calls.find(call => call.endpoint === 'reference-bind'), {
    endpoint: 'reference-bind', id: 'snapshot', draft: dialog.draft, target: 'native-b',
  })
  assert.deepEqual(h.prompts[0].content, [{ type: 'text', text: '[引用会话](nodo-reference:snapshot-bound)' }])
  assert.deepEqual(plain(h.composer().references), [])
})

test('new drafts route references through native DSH or direct external sends', async () => {
  for (const engine of ['codex', 'claude', 'zcode', 'opencode', 'codebuddy', 'qoder', 'pi', 'dsh']) {
    const h = harness()
    h.roles[0].engine = engine
    h.composer().onChange('Review this')
    h.pickReference()
    await h.send()
    const native = engine === 'dsh'
    assert.deepEqual(h.calls.map(call => call.endpoint), native
      ? ['session-create', 'session-open', 'reference-bind'] : ['session-create', 'reference-bind', 'send'], engine)
    assert.equal(h.calls[0].session, undefined, 'a new draft never selects a historical role session')
    const bound = h.calls.find(call => call.endpoint === 'reference-bind')
    assert.equal(bound.target, native ? 'native-a' : 'session-1')
    if (native) {
      assert.equal(h.calls[1].session, 'session-1')
      assert.equal(h.prompts[0].id, h.opened[0])
      assert.deepEqual(h.legacy, [])
    } else {
      assert.equal(h.prompts.length, 0)
      assert.deepEqual(h.opened, [])
      assert.deepEqual(h.calls.at(-1).references, [{ id: 'snapshot-bound' }])
      assert.equal(h.calls.at(-1).text, 'Review this')
      assert.equal(h.calls.at(-1).session, 'session-1')
      assert.equal(h.legacy.length, 1)
    }
  }
})

test('a reference binding failure keeps the draft for retry and does not send an incomplete task', async () => {
  const h = harness()
  h.composer().onChange('Review this')
  h.pickReference()
  h.failBinding('快照暂不可用')
  await h.send()
  assert.equal(h.prompts.length, 0)
  assert.equal(h.composer().value, 'Review this')
  assert.equal(h.composer().references.length, 1)
  h.failBinding(undefined)
  await h.send()
  assert.equal(h.calls.filter(call => call.endpoint === 'session-create').length, 1)
  assert.equal(h.prompts[0].content[0].text, 'Review this\n[引用会话](nodo-reference:snapshot-bound)')
})

test('draft references can be previewed, removed and sent to a legacy recipient', async () => {
  const h = harness()
  h.roles[0].engine = 'echo'
  h.pickReference('first')
  h.pickReference('second')
  h.composer().onReference(h.composer().references[0])
  assert.equal(find(h.render(), 'ReferenceDialog').props.snapshot.id, 'first')
  h.composer().onRemoveReference('first')
  assert.deepEqual(plain(h.composer().references).map(item => item.id), ['second'])
  await h.send()
  assert.equal(h.calls.find(call => call.endpoint === 'reference-bind').target, 'session-1')
  const sent = h.calls.find(call => call.endpoint === 'send')
  assert.deepEqual(sent.references, [{ id: 'second-bound' }])
  assert.equal(sent.text, '请参考引用的会话结果。')
  assert.equal(h.prompts.length, 0)
})

test('role picker displays avatar/name and established sessions expose only a fixed hint', () => {
  const context = createContext({
    h: (type, props, ...children) => ({ type, props, children }),
    useState: value => [value, () => {}], Menu: 'Menu', RoleAvatar: 'Avatar', IconChevronDownOutlineRegular: 'Chevron',
  })
  new Script(readFileSync(new URL('../src/client/role-seat.js', import.meta.url), 'utf8')).runInContext(context)
  const profile = { id: 'a', name: 'Coder' }, selected = []
  const tree = context.RolePicker({ profiles: [profile], profile, onSelect: id => selected.push(id) })
  assert.equal(tree.type, 'Menu')
  assert.equal(tree.props.items[0].icon.type, 'Avatar')
  tree.props.onSelect('a')
  assert.deepEqual(selected, ['a'])
  const fixed = context.RolePicker({ profiles: [profile], profile })
  assert.equal(fixed.type, 'span')
  assert.match(fixed.props['aria-label'], /Coder，不可修改/)
  assert.equal(fixed.props.onClick, undefined)
  assert.equal(fixed.children[0].type, 'Avatar')
})
