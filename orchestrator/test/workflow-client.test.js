import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'
import { withHost, until } from './helpers/host.js'
const profile = { id: 'role', name: '开发伙伴', engine: 'echo', activeSessionId: 'session', sessions: [{ id: 'session', name: '开发会话', workspaceRef: 'project' }] }
const viewOf = () => ({ profiles: [structuredClone(profile)], workspaces: [{ id: 'project', name: '项目', cwd: '/tmp' }], workflows: { definitions: [], running: null }, runs: [], approvals: [] })
const draftOf = () => ({ name: '开发与验收', nodes: [
  { id: 'start', name: '开始', kind: 'start' },
  { id: 'work', name: '编码实现', kind: 'agent', profileId: 'role', task: '实现并验证' },
  { id: 'review', name: '人工验收', kind: 'human', options: [{ id: 'accept', label: '接受并完成' }, { id: 'revise', label: '返回修改' }] },
  { id: 'end', name: '完成交付', kind: 'end', deliver: 'work' },
], edges: [{ from: 'start', exit: 'done', to: 'work' }, { from: 'work', exit: 'done', to: 'review' }, { from: 'review', exit: 'accept', to: 'end' }, { from: 'review', exit: 'revise', to: 'work', back: { max: 2 } }] })
const all = tree => tree && typeof tree === 'object' ? [tree, ...[...(tree.children ?? []), tree.props?.tools].flatMap(all)] : []
const text = tree => all(tree).flatMap(node => node.children.filter(child => typeof child === 'string')).join('')
const button = (tree, label) => all(tree).find(node => node.type === 'Button' && node.children.includes(label))
const named = (tree, name) => all(tree).find(node => node.type?.name === name)
const saveButton = tree => all(tree).find(node => node.type === 'Button' && node.props['aria-label'] === '保存')
const saveMenu = tree => all(tree).find(node => node.type === 'Menu' && node.props.items?.some(item => item.id === 'saveAs'))
const newFlow = tree => all(tree).find(node => node.type === 'button' && node.props['aria-label'] === '新建流程')

async function harness({ draft = draftOf(), definition, readOnly = false, api = async () => [], globals = {}, uiShared = {}, react = {} } = {}) {
  let cursor = 0, pending = [], states = []
  const view = viewOf(), calls = [], storage = new Map()
  if (definition) view.workflows.definitions = [definition]
  const saved = { draft, source: definition ? { id: definition.id, revision: definition.revision, content: JSON.stringify({ name: definition.name, nodes: definition.nodes, edges: definition.edges }) } : null, selected: 'work', positions: {} }
  storage.set('nodo.workflow.draft', JSON.stringify(saved))
  const effects = new Map(), cleanups = new Map()
  const state = initial => {
    const at = cursor++
    if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial
    return [states[at], update => { states[at] = typeof update === 'function' ? update(states[at]) : update }]
  }
  const loaded = await loadClient(['avatar.tsx', 'running.js', 'workflow.js', 'workflow-composer.js', 'composer.js'], {
    uiShared: {
      call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return api(endpoint, payload, view) },
      sessionTime: () => '刚刚', readImage: async file => file,
      useStateView: () => ({ view, refresh: async () => {} }),
      layoutService: null, ...uiShared,
    },
    stubs: { 'session-rail.tsx': { workspacePicker: props => ({ type: 'WorkspacePicker', props, children: [] }) } },
    react: {
      useState: state, useRef: initial => state(() => ({ current: initial }))[0], useId: () => 'test',
      useEffect: (effect, deps) => {
        const at = cursor++, before = effects.get(at)
        if (!before || deps.some((value, i) => value !== before[i])) { effects.set(at, deps); pending.push(() => { cleanups.get(at)?.(); cleanups.set(at, effect()) }) }
      },
      ...react,
    },
    globals: { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, ...globals },
  })
  const flushEffects = () => { const run = pending; pending = []; run.forEach(effect => effect()) }
  return { loaded, view, calls, storage,
    remount() { for (const cleanup of cleanups.values()) cleanup?.(); states = []; effects.clear(); cleanups.clear() },
    render() { cursor = 0; const tree = loaded.WorkflowPage({ view, readOnly, refresh: async () => {}, onOpenSession() {} }); flushEffects(); return tree },
    side() { this.render(); return loaded.wfSidebarSnapshot() },
    canvas(props) { cursor = 0; const tree = loaded.WorkflowCanvas(props); flushEffects(); return tree },
    task(props) { cursor = 0; const tree = loaded.WorkflowTaskComposer({ view, ...props }); flushEffects(); return tree },
    duration(run) { cursor = 0; const tree = loaded.WorkflowRunDuration({ run }); flushEffects(); return tree },
    async flush() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) },
    dispose() { for (const cleanup of cleanups.values()) cleanup?.() },
  }
}

test('the sidebar cast shows three avatars and an ellipsis for the rest', async () => {
  const definition = { ...draftOf(), id: 'flow', revision: 1 }
  definition.nodes = definition.nodes.slice(0, 1).concat(['a', 'b', 'c', 'd'].map(id => ({ id, name: id, kind: 'agent', profileId: id, task: 't' })), definition.nodes.at(-1))
  const h = await harness({ definition })
  h.view.profiles = ['a', 'b', 'c', 'd'].map(id => ({ ...profile, id, name: `角色${id}` }))
  h.render()
  const cast = all(h.loaded.wfSidebarSnapshot()).find(node => node.props.className === 'nodo-wf-cast')
  assert.equal(cast.children.filter(node => node.type === h.loaded.RoleAvatar).length, 3)
  assert.equal(text(cast), '…')
  assert.equal(cast.props.title, '角色a、角色b、角色c、角色d', 'the full cast stays readable on hover')
  h.dispose()
})

test('a saved flow is deleted from its rail row after confirming, and the open draft stays unsaved', async () => {
  const definition = { ...draftOf(), id: 'flow', revision: 1 }
  const h = await harness({ definition, api: async (endpoint, payload, view) => {
    if (endpoint === 'workflow-delete') view.workflows.definitions = view.workflows.definitions.filter(item => item.id !== payload.id)
    return endpoint === 'workflow-delete' ? true : []
  } })
  h.render()
  const remove = all(h.loaded.wfSidebarSnapshot()).find(node => node.props['aria-label'] === `删除流程“${definition.name}”`)
  remove.props.onClick()
  const dialog = all(h.render()).find(node => node.type === 'Modal')
  assert.match(dialog.props.title, /删除流程/)
  assert.equal(h.calls.some(call => call.endpoint === 'workflow-delete'), false, 'nothing is deleted before confirming')
  dialog.props.footer.find(node => node.children.includes('删除')).props.onClick(); await h.flush()
  assert.equal(h.calls.find(call => call.endpoint === 'workflow-delete').payload.id, 'flow')
  const after = h.render()
  assert.equal(all(after).some(node => node.type === 'Modal'), false)
  assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).source, null)
  assert.equal(saveButton(h.render()).props.disabled, false, 'the deleted flow’s graph can be saved again as a new one')
  h.dispose()
})

test('workflow navigation is published to the original rail instead of a second sidebar or logo', async () => {
  const definition = { ...draftOf(), id: 'flow', revision: 1 }, h = await harness({ definition })
  const tree = h.render(), { wfSidebarSnapshot, wfSubscribeSidebar, wfPublishSidebar } = h.loaded
  assert.equal(all(tree).some(node => node.props.className === 'nodo-wf-navigation'), false)
  assert.equal(all(tree).some(node => node.type === 'NodoLogo'), false)
  const toolbar = all(tree).find(node => node.props.className === 'nodo-wf-toolbar')
  assert.deepEqual(toolbar.children.map(node => node.props['aria-label']), ['保存', '运行'], 'save sits beside run in the header')
  assert.deepEqual(Array.from(saveMenu(toolbar).props.items, item => item.label), ['保存', '另存为新流程…'])
  assert.equal(all(named(tree, 'WorkflowCanvas').props.tools).some(node => node.props.role === 'group'), false, 'the canvas keeps only 添加节点')
  const navigation = wfSidebarSnapshot()
  assert.deepEqual(all(navigation).filter(node => node.props.role === 'group').map(group => [group.props['aria-label'], ...all(group).filter(node => node.type === 'Button').map(text)]), [
    ['视图', '编排', '运行记录'],
  ], 'the view switch leads the rail and saving lives in the header')
  assert.equal(navigation.children[0].props['aria-label'], '视图')
  assert.ok(all(navigation).find(node => node.props.className === 'nodo-wf-side-title').children.includes(newFlow(navigation)), '新建流程 sits beside the flow list title')
  assert.equal(navigation.props['aria-label'], '流程')
  assert.equal(text(navigation).includes('最近运行'), false, 'edit view lists flows only')
  const cast = all(navigation).find(node => node.props.className === 'nodo-wf-cast')
  assert.equal(cast.children.filter(node => node.type === h.loaded.RoleAvatar).length, 1)
  assert.equal(text(cast), '', 'no ellipsis for a short cast')
  assert.ok(text(navigation).includes(definition.name))
  const select = all(navigation).find(node => node.type === 'button' && text(node) === definition.name)
  select.props.onClick()
  assert.equal(named(h.render(), 'WorkflowInspector').props.node.id, 'start', 'the reused rail controls the main editor')
  let notifications = 0
  const unsubscribe = wfSubscribeSidebar(() => { notifications++ })
  wfPublishSidebar(null)
  assert.equal(wfSidebarSnapshot(), null)
  assert.equal(notifications, 1)
  unsubscribe()
  wfPublishSidebar(navigation)
  assert.equal(notifications, 1)
  h.dispose()
})

test('the single top title follows the workflow view while switching preserves the editable draft', async () => {
  const h = await harness()
  let tree = h.render()
  const workspace = tree.children.find(node => node.props?.className === 'nodo-wf-workspace')
  const drawer = tree.children.find(node => node.props?.className === 'nodo-wf-drawer')
  assert.ok(workspace.children.some(node => node.props?.className === 'nodo-wf-header'))
  assert.ok(workspace.children.some(node => node.props?.className === 'nodo-wf-body'))
  assert.equal(drawer.children[0].props.className, 'nodo-wf-drawer-chrome', 'the full-height drawer starts at the page top beside the workspace')
  const title = all(tree).find(node => node.props['aria-label'] === '流程名称')
  title.props.onChange({ target: { value: '顶部流程名称' } })
  tree = h.render()
  button(h.side(), '运行记录').props.onClick()
  tree = h.render()
  const header = all(tree).find(node => node.type === 'header' && node.props.className === 'nodo-wf-header')
  assert.equal(text(all(header).find(node => node.type === 'h1')), '运行记录')
  assert.equal(button(h.side(), '运行记录').props['aria-pressed'], true)
  const rail = h.loaded.wfSidebarSnapshot()
  assert.equal(rail.props['aria-label'], '运行记录')
  assert.ok(text(rail).includes('最近运行'))
  assert.equal(all(rail).some(node => node.props?.className === 'nodo-wf-definitions'), false, 'run view hides saved flows')
  assert.equal(newFlow(rail), undefined)
  assert.equal(saveButton(tree), undefined, 'run view has no save group')
  assert.ok(button(rail, '编排'), 'the view switch stays in the run rail')
  button(h.side(), '编排').props.onClick()
  tree = h.render()
  assert.equal(all(tree).find(node => node.props['aria-label'] === '流程名称').props.value, '顶部流程名称')
  assert.equal(button(h.side(), '编排').props['aria-pressed'], true)
  h.dispose()
})

test('the floating task composer has no heading or collapse control and the drawer preserves node edits', async () => {
  const h = await harness()
  let tree = h.render()
  assert.equal(all(tree).some(item => item.props.className === 'nodo-wf-validation'), false)
  assert.equal(text(h.canvas({ graph: draftOf(), view: h.view, positions: {}, onSelect() {} })).includes('拖动安排位置'), false)
  tree = h.render()
  const composer = named(tree, 'WorkflowTaskComposer')
  assert.equal(composer.props.node.id, 'work')
  composer.props.onChange({ task: '第一节点的新任务', choices: { model: 'node-model' } })
  tree = h.render()
  const dock = all(tree).find(item => item.props.className === 'nodo-wf-task-dock')
  assert.equal(dock.children.length, 1)
  assert.equal(dock.children[0].type.name, 'WorkflowTaskComposer')
  assert.equal(all(dock).some(item => item.type === 'button' || item.type === 'strong'), false)
  const drawer = all(tree).find(item => item.props['aria-label'] === '收起节点侧栏')
  drawer.props.onClick()
  tree = h.render()
  assert.equal(all(tree).find(item => item.props.id === 'nodo-workflow-inspector').props.hidden, true)
  assert.ok(all(tree).some(item => item.props['aria-label'] === '展开节点侧栏'))
  named(tree, 'WorkflowCanvas').props.onSelect('review')
  tree = h.render()
  assert.equal(named(tree, 'WorkflowTaskComposer'), undefined, 'a decision is configured as a question, not an agent message')
  named(tree, 'WorkflowCanvas').props.onSelect('work')
  tree = h.render()
  assert.equal(named(tree, 'WorkflowTaskComposer').props.node.task, '第一节点的新任务')
  assert.equal(named(tree, 'WorkflowTaskComposer').props.node.choices.model, 'node-model')
  h.dispose()
})

test('task updates stay on their original node after selection changes and do not dispatch', async () => {
  const draft = draftOf(); draft.nodes.splice(2, 0, { id: 'other', name: '另一任务', kind: 'agent', profileId: 'role', task: '原任务' })
  const h = await harness({ draft })
  const first = named(h.render(), 'WorkflowTaskComposer').props.onChange
  named(h.render(), 'WorkflowCanvas').props.onSelect('other')
  first(current => ({ files: [...(current.files ?? []), { id: 'file', name: 'plan.md' }] }))
  let tree = h.render()
  assert.equal(named(tree, 'WorkflowTaskComposer').props.node.files, undefined)
  named(tree, 'WorkflowCanvas').props.onSelect('work')
  tree = h.render()
  assert.equal(named(tree, 'WorkflowTaskComposer').props.node.files[0].name, 'plan.md')
  assert.equal(h.calls.some(call => /send|workflow-run|session-create/.test(call.endpoint)), false)
  h.dispose()
})

test('task composer reuses file intake and keeps choices local to the selected node', async () => {
  const ref = { id: 'image-id', mediaType: 'image/png', name: 'shot.png' }, file = { id: 'file-id', name: 'requirements.pdf' }
  const h = await harness({ api: async endpoint => endpoint === 'attachment-save' ? { images: [ref], files: [file] }
    : endpoint === 'attachment' ? { mediaType: 'image/png', data: 'AAAA' } : [] })
  let node = draftOf().nodes[1], busy = []
  const props = () => ({ node, disabled: false, onBusy: value => busy.push(value),
    onChange: changes => { node = { ...node, ...(typeof changes === 'function' ? changes(node) : changes) } } })
  let composer = all(h.task(props())).find(item => item.type === h.loaded.Composer).props
  composer.onChange('编辑后的任务')
  composer.onModelChange({ model: 'picked', thinking: 'high', permission: '' })
  assert.equal(node.task, '编辑后的任务')
  assert.deepEqual(JSON.parse(JSON.stringify(node.choices)), { model: 'picked', thinking: 'high', permission: 'workspace' })
  assert.equal(h.view.profiles[0].model, undefined)
  await composer.onAttachFiles([
    { name: 'shot.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
    { name: 'requirements.pdf', mediaType: 'application/pdf', dataUrl: 'data:application/pdf;base64,Qg==' },
  ])
  assert.deepEqual(busy, [true, false])
  assert.equal(node.images[0].id, ref.id)
  assert.equal(node.files[0].id, file.id)
  assert.equal(h.calls.find(call => call.endpoint === 'attachment-save').payload.files[0].data, 'Qg==')
  h.task(props()); await h.flush()
  composer = all(h.task(props())).find(item => item.type === h.loaded.Composer).props
  assert.equal(composer.images[0].dataUrl, 'data:image/png;base64,AAAA')
  assert.equal(composer.files[0].name, 'requirements.pdf')
  assert.equal(composer.onSend, undefined, 'the node composer has no save or send button')
  composer.onRemoveFile(0)
  assert.equal(node.files.length, 0)
  assert.equal(h.calls.some(call => call.endpoint === 'profile-update' || call.endpoint === 'send'), false)
  h.dispose()
})

test('node edits persist to the browser draft without a save button and survive switching nodes and remounting', async () => {
  const h = await harness()
  let tree = h.render()
  const composer = () => named(tree, 'WorkflowTaskComposer').props
  const stored = () => JSON.parse(h.storage.get('nodo.workflow.draft')).draft.nodes.find(node => node.id === 'work')
  assert.equal('onSave' in composer(), false)
  composer().onChange({ task: '静默写入的任务' })
  composer().onChange(current => ({ images: [{ id: 'image-id', mediaType: 'image/png', name: 'shot.png' }], files: [{ id: 'file-id', name: 'requirements.pdf' }] }))
  composer().onChange({ choices: { model: 'picked', thinking: 'high', permission: 'workspace' } })
  tree = h.render()
  assert.equal(stored().task, '静默写入的任务')
  assert.equal(stored().images[0].id, 'image-id')
  assert.equal(stored().files[0].name, 'requirements.pdf')
  assert.deepEqual(stored().choices, { model: 'picked', thinking: 'high', permission: 'workspace' })
  named(tree, 'WorkflowCanvas').props.onSelect('review')
  tree = h.render()
  named(tree, 'WorkflowCanvas').props.onSelect('work')
  tree = h.render()
  assert.equal(composer().node.task, '静默写入的任务')
  assert.equal(composer().node.images[0].name, 'shot.png')
  button(h.side(), '运行记录').props.onClick()
  tree = h.render()
  assert.equal(named(tree, 'WorkflowTaskComposer'), undefined, 'the run view has no task composer')
  h.remount()
  tree = h.render()
  assert.equal(composer().node.id, 'work', 'the selected node comes back with the page')
  assert.equal(composer().node.task, '静默写入的任务')
  assert.equal(composer().node.images[0].id, 'image-id')
  assert.equal(composer().node.files[0].id, 'file-id')
  assert.deepEqual(JSON.parse(JSON.stringify(composer().node.choices)), { model: 'picked', thinking: 'high', permission: 'workspace' })
  assert.equal(h.calls.some(call => /send|workflow-run|session-create|workflow-create/.test(call.endpoint)), false)
  h.dispose()
})

test('entering workflow keeps an expanded rail and clears its content on exit without toggling it closed', async () => {
  for (const collapsed of [false, true]) {
    let toggles = 0, cleanup
    const h = await harness({
      globals: { document: { querySelector: () => collapsed ? {} : null } },
      uiShared: { layoutService: { toggleSidebar() { toggles++ } } },
      react: { useEffect: effect => { cleanup = effect() } },
    })
    h.loaded.WorkflowEntry()
    assert.equal(toggles, collapsed ? 1 : 0)
    h.loaded.wfPublishSidebar({ test: true })
    cleanup()
    assert.equal(h.loaded.wfSidebarSnapshot(), null)
    assert.equal(toggles, collapsed ? 1 : 0)
  }
})

test('editor validates connected exits, options-only questions, deliver sources and bounded back edges', async () => {
  const h = await harness(); const { wfValidate } = h.loaded
  assert.equal(wfValidate(draftOf(), h.view).length, 0)
  for (const max of [0, 6, 1.5]) {
    const draft = draftOf(); draft.edges.at(-1).back.max = max
    assert.ok(wfValidate(draft, h.view).some(error => error.message.includes('1～5')))
  }
  const legacy = draftOf(); legacy.nodes[2].allowText = true
  assert.equal(wfValidate(legacy, h.view).length, 0, 'a question has no free-text exit')
  const bare = draftOf(); bare.nodes[2].options = []
  assert.ok(wfValidate(bare, h.view).some(error => error.message.includes('至少提供一个选项')))
  const loop = draftOf(); delete loop.edges.at(-1).back
  assert.ok(wfValidate(loop, h.view).some(error => error.message.includes('形成环')))
  const deliver = draftOf(); deliver.nodes.at(-1).deliver = 'start'
  assert.ok(wfValidate(deliver, h.view).some(error => error.message.includes('交付来源')))
  const missing = draftOf(); missing.nodes[1].profileId = 'gone'
  assert.ok(wfValidate(missing, h.view).some(error => error.message.includes('已有角色')))
  const long = draftOf(); long.nodes[1].task = 'a'.repeat(32001)
  assert.ok(wfValidate(long, h.view).some(error => error.message.includes('32000')))
})

test('node removal cleans references', async () => {
  const h = await harness(); const { wfRemove } = h.loaded
  const draft = draftOf(), removed = wfRemove(draft, 'work')
  assert.equal(removed.nodes.at(-1).deliver, '')
  assert.ok(removed.edges.every(edge => edge.from !== 'work' && edge.to !== 'work'))
  assert.equal(draft.nodes.length, 4, 'the original is preserved')
})

test('the add bar collapses into one dropdown and the canvas context menu adds and removes nodes', async () => {
  const h = await harness()
  const tree = h.render()
  const addbar = named(tree, 'WorkflowCanvas').props.tools
  assert.equal(addbar.props.className, 'nodo-wf-addbar', 'the add bar is the canvas tool row')
  const dropdown = all(addbar).find(node => node.type === 'Menu')
  assert.equal(text(dropdown.props.anchor), '+ 添加节点')
  assert.deepEqual(Array.from(dropdown.props.items, item => item.label), ['添加执行节点', '添加人工节点', '添加结束节点'])
  dropdown.props.onSelect('human')
  let next = h.render()
  assert.equal(named(next, 'WorkflowInspector').props.node.id, 'human_4')
  named(next, 'WorkflowCanvas').props.onContext({ clientX: 500, clientY: 300, plane: { x: 500, y: 300 }, node: null })
  next = h.render()
  const menu = all(next).filter(node => node.type === 'Menu').find(node => node.props.anchor?.props?.style?.position === 'fixed')
  assert.deepEqual(Array.from(menu.props.items, item => item.id), ['add:agent', 'add:human', 'add:end', 'delete'], 'an empty-canvas right-click still offers deleting the selected node')
  assert.deepEqual({ ...menu.props.getAnchorRect() }, { left: 500, top: 300, right: 500, bottom: 300, width: 0, height: 0 },
    'the menu anchors at the pointer, not at its in-flow wrapper')
  menu.props.onSelect('add:end')
  next = h.render()
  let saved = JSON.parse(h.storage.get('nodo.workflow.draft'))
  assert.equal(saved.draft.nodes.find(node => node.id === 'end_5')?.kind, 'end')
  assert.deepEqual(saved.positions.end_5, { x: 398, y: 252 }, 'the node is created under the pointer')
  named(next, 'WorkflowCanvas').props.onContext({ clientX: 400, clientY: 160, plane: { x: 400, y: 160 }, node: 'work' })
  next = h.render()
  const withDelete = all(next).filter(node => node.type === 'Menu').find(node => node.props.anchor?.props?.style?.position === 'fixed')
  assert.deepEqual(Array.from(withDelete.props.items, item => item.id), ['add:agent', 'add:human', 'add:end', 'delete'])
  withDelete.props.onSelect('delete')
  next = h.render()
  saved = JSON.parse(h.storage.get('nodo.workflow.draft')).draft
  assert.equal(saved.nodes.some(node => node.id === 'work'), false)
  assert.equal(saved.edges.some(edge => edge.from === 'work' || edge.to === 'work'), false)
  assert.equal(named(next, 'WorkflowInspector').props.node.id, 'start')
  named(next, 'WorkflowCanvas').props.onContext({ clientX: 100, clientY: 150, plane: { x: 100, y: 150 }, node: 'start' })
  next = h.render()
  const onStart = all(next).filter(node => node.type === 'Menu').find(node => node.props.anchor?.props?.style?.position === 'fixed')
  assert.deepEqual(Array.from(onStart.props.items, item => item.id), ['add:agent', 'add:human', 'add:end'], 'the start node is never deletable')
  h.dispose()
})

test('dragging a wire into empty canvas offers creation and connects the selected node at that position', async () => {
  for (const kind of ['agent', 'human', 'end']) {
    const page = await harness(), canvas = await harness()
    let tree = page.render()
    const props = named(tree, 'WorkflowCanvas').props
    const original = JSON.parse(page.storage.get('nodo.workflow.draft')).draft
    let graph = canvas.canvas(props)
    const output = () => all(graph).find(node => node.props['data-kind'] === 'start').children.find(node => node.props['data-exit'] === 'done')
    output().props.onPointerDown({ button: 0, clientX: 268, clientY: 168, pointerId: 1, preventDefault() {}, stopPropagation() {}, currentTarget: { setPointerCapture() {} } })
    graph = canvas.canvas(props)
    output().props.onPointerUp({ clientX: 1100, clientY: 700 })
    tree = page.render()
    const menuOf = () => all(tree).find(node => node.type === 'Menu' && node.props.anchor?.props?.style?.position === 'fixed')
    assert.deepEqual(Array.from(menuOf().props.items, item => item.id), ['add:agent', 'add:human', 'add:end'])
    assert.equal(menuOf().props.getAnchorRect().left, 1100)
    assert.equal(menuOf().props.getAnchorRect().top, 700)
    assert.deepEqual(JSON.parse(page.storage.get('nodo.workflow.draft')).draft, original, 'opening the menu preserves all existing nodes and wires')
    if (kind === 'agent') {
      menuOf().props.onClose()
      tree = page.render()
      assert.equal(menuOf(), undefined)
      assert.deepEqual(JSON.parse(page.storage.get('nodo.workflow.draft')).draft, original, 'cancel creates nothing')
      props.onContext({ clientX: 1100, clientY: 700, plane: { x: 1100, y: 700 }, node: null, connection: { from: 'start', exit: 'done' } })
      tree = page.render()
    }
    menuOf().props.onSelect(`add:${kind}`)
    tree = page.render()
    const saved = JSON.parse(page.storage.get('nodo.workflow.draft')), id = `${kind}_4`
    assert.equal(saved.draft.nodes.length, original.nodes.length + 1)
    assert.equal(saved.selected, id)
    assert.deepEqual(saved.positions[id], { x: 998, y: 652 })
    assert.deepEqual(saved.draft.edges.filter(edge => edge.from === 'start'), [{ from: 'start', exit: 'done', to: id }])
    assert.deepEqual(saved.draft.edges.filter(edge => edge.from !== 'start'), original.edges.filter(edge => edge.from !== 'start'))
    page.dispose(); canvas.dispose()
  }
})

test('node ports drag wires to targets, offer empty-drop creation and refuse starts and self', async () => {
  const h = await harness()
  const connects = [], contexts = []
  const base = { graph: draftOf(), view: h.view, selected: 'work', positions: {}, onSelect() {}, onPosition() {}, onConnect: (...args) => connects.push(args), onContext: info => contexts.push(info) }
  let live = h.canvas(base)
  const outs = () => all(live).filter(node => node.props.className === 'nodo-wf-port nodo-wf-port-out')
  assert.equal(outs().length, 5, 'declared exits and an unused rework interface are available')
  assert.equal(all(live).filter(node => node.props.className === 'nodo-wf-port nodo-wf-port-in').length, 4, 'each incoming wire has its own input')
  const press = (port, x, y) => port.props.onPointerDown({ button: 0, clientX: x, clientY: y, pointerId: 1, preventDefault() {}, stopPropagation() {}, currentTarget: { setPointerCapture() {} } })
  // wfPositions places start at (64,120) and the agent node at (320,120); ports sit on the node edges.
  press(outs()[0], 268, 168)
  live = h.canvas(base)
  assert.equal(all(live).some(node => node.props.className === 'nodo-wf-wire-preview'), true)
  outs()[0].props.onPointerMove({ clientX: 500, clientY: 150 })
  live = h.canvas(base)
  assert.equal(all(live).find(node => node.props['data-link-target'] === '')?.props['data-kind'], 'agent')
  outs()[0].props.onPointerUp({ clientX: 500, clientY: 150 })
  assert.deepEqual(connects, [['start', 'done', 'work']])
  for (const [x, y] of [[100, 150], [268, 168], [900, 700]]) {
    press(outs()[0], 268, 168)
    live = h.canvas(base)
    outs()[0].props.onPointerUp({ clientX: x, clientY: y })
    live = h.canvas(base)
  }
  assert.equal(connects.length, 1, 'drops on the start node, the source itself and empty space add nothing')
  assert.equal(contexts.length, 1, 'an empty drop opens the creation menu')
  assert.deepEqual(JSON.parse(JSON.stringify(contexts[0])), { clientX: 900, clientY: 700, plane: { x: 900, y: 700 }, node: null, connection: { from: 'start', exit: 'done' } })
  live.props.onContextMenu({ clientX: 5, clientY: 5, preventDefault() {} })
  assert.equal(contexts.length, 2)
  assert.equal(contexts[1].clientX, 5)
  assert.deepEqual({ ...contexts[1].plane }, { x: 5, y: 5 })
  assert.equal(contexts[1].node, null)
  for (const state of [{ busy: true }, { history: true }]) {
    live = h.canvas({ ...base, ...state })
    assert.equal(outs().length, 4, 'ports remain visible for reading the graph')
    assert.ok(outs().every(port => port.props['aria-disabled'] === true))
    press(outs()[0], 268, 168)
    live = h.canvas({ ...base, ...state })
    assert.equal(all(live).some(node => node.props.className === 'nodo-wf-wire-preview'), false)
  }
  h.dispose()
})

test('node drags and right-click creation are unbounded toward the top left', async () => {
  const h = await harness()
  const moved = []
  const base = { graph: draftOf(), view: h.view, selected: 'work', positions: {}, onSelect() {}, onPosition: (id, p) => moved.push([id, p]), onConnect() {}, onContext() {} }
  const tree = h.canvas(base)
  const start = all(tree).find(node => node.props['data-kind'] === 'start')
  start.props.onPointerDown({ button: 0, clientX: 0, clientY: 0, pointerId: 1, currentTarget: { setPointerCapture() {} } })
  start.props.onPointerMove({ clientX: -2000, clientY: -2000 })
  assert.equal(moved.at(-1)[0], 'start')
  assert.deepEqual({ ...moved.at(-1)[1] }, { x: 64 - 2000, y: 120 - 2000 }, 'a node follows the pointer past the plane origin')
  h.dispose()
  const page = await harness()
  let tree2 = page.render()
  named(tree2, 'WorkflowCanvas').props.onContext({ clientX: 0, clientY: 0, plane: { x: -400, y: -260 }, node: null })
  tree2 = page.render()
  const menu = all(tree2).filter(node => node.type === 'Menu').find(node => node.props.anchor?.props?.style?.position === 'fixed')
  menu.props.onSelect('add:agent')
  tree2 = page.render()
  const saved = JSON.parse(page.storage.get('nodo.workflow.draft'))
  assert.deepEqual(saved.positions.agent_4, { x: -502, y: -308 }, 'a node created at a negative position keeps it')
  page.dispose()
})

test('the canvas pans with the middle button and zooms without being bounded by the window', async () => {
  const h = await harness()
  const base = { graph: draftOf(), view: h.view, positions: {}, onSelect() {}, onPosition() {} }
  let live = h.canvas(base)
  const viewport = () => all(live).find(node => node.props.className === 'nodo-wf-viewport')
  const plane = () => all(live).find(node => node.props.className === 'nodo-wf-plane')
  assert.equal(plane().props.style.transform, 'translate(0px, 0px) scale(1)')
  button(live, '+').props.onClick()
  live = h.canvas(base)
  assert.equal(plane().props.style.transform, 'translate(0px, 0px) scale(1.1)')
  for (let i = 0; i < 12; i++) button(live, '+').props.onClick()
  live = h.canvas(base)
  assert.equal(plane().props.style.transform, 'translate(0px, 0px) scale(2.5)')
  const middle = { button: 1, clientX: 400, clientY: 300, pointerId: 7, preventDefault() {}, currentTarget: { setPointerCapture() {} } }
  viewport().props.onPointerDown(middle)
  live = h.canvas(base)
  viewport().props.onPointerMove({ clientX: 340, clientY: 380 })
  live = h.canvas(base)
  assert.equal(plane().props.style.transform, 'translate(-60px, 80px) scale(2.5)')
  viewport().props.onPointerUp()
  live = h.canvas(base)
  assert.equal(plane().props.style.transform, 'translate(-60px, 80px) scale(2.5)', 'the pan persists after release')
  viewport().props.onPointerDown({ ...middle, button: 0 })
  live = h.canvas(base)
  viewport().props.onPointerMove({ clientX: 100, clientY: 100 })
  live = h.canvas(base)
  assert.equal(plane().props.style.transform, 'translate(-60px, 80px) scale(2.5)', 'left drags on the viewport never pan')
  h.dispose()
})

test('backspace or delete removes the selected node unless focus is in a field', async () => {
  const h = await harness()
  let tree = h.render()
  const fire = (key, target = {}) => tree.props.onKeyDown({ key, target, preventDefault() {} })
  named(tree, 'WorkflowCanvas').props.onSelect('work')
  tree = h.render()
  fire('Backspace')
  tree = h.render()
  let saved = JSON.parse(h.storage.get('nodo.workflow.draft')).draft
  assert.equal(saved.nodes.some(node => node.id === 'work'), false)
  assert.equal(saved.edges.some(edge => edge.from === 'work' || edge.to === 'work'), false)
  named(tree, 'WorkflowCanvas').props.onSelect('review')
  tree = h.render()
  fire('Delete', { closest: () => ({}) })
  tree = h.render()
  assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).draft.nodes.some(node => node.id === 'review'), true, 'focus inside a field keeps the node')
  fire('Delete')
  tree = h.render()
  assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).draft.nodes.some(node => node.id === 'review'), false)
  named(tree, 'WorkflowCanvas').props.onSelect('start')
  tree = h.render()
  fire('Backspace')
  tree = h.render()
  assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).draft.nodes.some(node => node.id === 'start'), true, 'the start node is never deleted')
  h.dispose()
})

test('wiring selects the explicit exit, replaces its destination and infers bounded upstream rework', async () => {
  const h = await harness()
  const wire = named(h.render(), 'WorkflowCanvas').props.onConnect
  wire('review', 'accept', 'work')
  wire('review', 'revise', 'end')
  wire('review', 'missing', 'end')
  wire('work', 'done', 'work')
  wire('work', 'done', 'start')
  h.render()
  const saved = JSON.parse(h.storage.get('nodo.workflow.draft')).draft
  assert.equal(saved.edges.length, 4)
  assert.deepEqual(saved.edges.filter(edge => edge.from === 'review'), [
    { from: 'review', exit: 'accept', to: 'work', back: { max: 2 } },
    { from: 'review', exit: 'revise', to: 'end' },
  ])
  assert.deepEqual(saved.edges.find(edge => edge.from === 'work'), { from: 'work', exit: 'done', to: 'review' })
  named(h.render(), 'WorkflowCanvas').props.onSelect('review')
  const inspector = named(h.render(), 'WorkflowInspector')
  const tree = h.loaded.WorkflowInspector(inspector.props)
  assert.equal(all(tree).some(item => item.type === 'Field' && item.props.label === '下一节点'), false)
  assert.ok(text(tree).includes('↺ 编码实现'))
  assert.equal(button(tree, '断开连线'), undefined, 'wires are removed on the canvas')
  const step = label => all(tree).find(item => item.type === 'Button' && item.props['aria-label'] === label)
  assert.ok(text(tree).includes('2 次'))
  step('增加返工次数').props.onClick()
  h.render()
  assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).draft.edges.find(edge => edge.back).back.max, 3, 'the stepper raises the rework limit')
  h.dispose()
})

test('the ready-to-drag rework interface creates agent conditions while keeping the normal destination', async () => {
  const draft = draftOf()
  draft.nodes[2] = { id: 'review', name: '代码审查', kind: 'agent', profileId: 'role', task: '检查实现' }
  draft.edges = draft.edges.slice(0, 2).concat({ from: 'review', exit: 'done', to: 'end' })
  const page = await harness({ draft }), canvas = await harness()
  const connect = named(page.render(), 'WorkflowCanvas').props.onConnect
  const base = { graph: draft, view: page.view, positions: {}, onSelect() {}, onPosition() {}, onConnect: connect }
  let tree = canvas.canvas(base)
  const node = () => all(tree).find(item => item.props['aria-label'] === '代码审查，执行节点')
  const rework = () => all(node()).find(item => item.props['data-exit'] === '$rework')
  assert.ok(all(node()).some(item => item.props.className === 'nodo-wf-port nodo-wf-port-in'))
  assert.ok(all(node()).some(item => item.props['data-exit'] === 'done'))
  assert.equal(rework().props.style.top, node().props.style.height, 'the rework interface is available before any condition is configured')
  assert.equal(draft.nodes[2].exits, undefined)
  rework().props.onPointerDown({ button: 0, clientX: 0, clientY: 0, pointerId: 1, preventDefault() {}, stopPropagation() {}, currentTarget: { setPointerCapture() {} } })
  tree = canvas.canvas(base)
  assert.equal(node().props['data-link-source'], '', 'captured dragging keeps the interfaces visible')
  const work = all(tree).find(item => item.props['aria-label'] === '编码实现，执行节点')
  rework().props.onPointerUp({ clientX: work.props.style.left + 10, clientY: work.props.style.top + 10 })
  page.render()
  let saved = JSON.parse(page.storage.get('nodo.workflow.draft')).draft
  assert.deepEqual(saved.nodes[2].exits, [{ id: 'done', when: '任务要求的产出已完成\n结果已验证，没有阻塞问题' }, { id: 'rework', when: '存在阻塞问题或未满足任务要求\n缺少继续所需的信息或材料' }])
  assert.deepEqual(saved.edges.filter(edge => edge.from === 'review'), [
    { from: 'review', exit: 'done', to: 'end' }, { from: 'review', exit: 'rework', to: 'work', back: { max: 2 } },
  ])
  assert.equal(page.loaded.wfValidate(saved, page.view).length, 0)
  connect('review', '$rework', 'work')
  page.render()
  const repeated = JSON.parse(page.storage.get('nodo.workflow.draft')).draft
  assert.deepEqual(repeated, saved, 'duplicate drops are idempotent')
  assert.equal(page.calls.some(call => /workflow-create|workflow-run|send/.test(call.endpoint)), false)
  page.dispose(); canvas.dispose()
})

test('the rework interface wires a review forward to a fixer that loops back', async () => {
  const draft = draftOf()
  draft.nodes[2] = { id: 'review', name: '代码审查', kind: 'agent', profileId: 'role', task: '检查实现' }
  draft.nodes.push({ id: 'fix', name: '修复', kind: 'agent', profileId: 'role', task: '修复问题' })
  draft.edges = draft.edges.slice(0, 2).concat({ from: 'review', exit: 'done', to: 'end' })
  const page = await harness({ draft })
  const connect = (...args) => named(page.render(), 'WorkflowCanvas').props.onConnect(...args)
  const saved = () => JSON.parse(page.storage.get('nodo.workflow.draft')).draft
  connect('review', '$rework', 'fix')
  page.render()
  assert.deepEqual(saved().nodes.find(node => node.id === 'review').exits.map(exit => exit.id), ['done', 'rework'])
  assert.deepEqual(saved().edges.find(edge => edge.from === 'review' && edge.exit === 'rework'), { from: 'review', exit: 'rework', to: 'fix' })
  const review = () => all(page.canvas({ graph: saved(), view: page.view, positions: {}, onSelect() {}, onPosition() {}, onConnect() {} }))
    .find(item => item.props['aria-label'] === '代码审查，执行节点')
  assert.equal(all(review()).some(item => item.props['data-exit'] === '$rework'), false, 'a forward rework exit replaces the bottom interface')
  assert.ok(all(review()).some(item => item.props['aria-label'] === '代码审查：不通过输出'))
  const wires = all(page.canvas({ graph: saved(), view: page.view, positions: {}, onSelect() {}, onPosition() {}, onConnect() {} }))
  assert.ok(text(wires.find(item => item.props.key === 'review.rework')).includes('不通过'), 'a forward rework wire reads as not passed')
  const before = saved()
  connect('review', '$rework', 'fix')
  page.render()
  assert.deepEqual(saved(), before, 'a repeated drop keeps the conditions')
  connect('fix', 'done', 'review')
  page.render()
  assert.deepEqual(saved().edges.filter(edge => edge.to === 'fix' || edge.from === 'fix'), [
    { from: 'review', exit: 'rework', to: 'fix', back: { max: 2 } }, { from: 'fix', exit: 'done', to: 'review' },
  ], 'closing the loop turns the rework wire back and keeps the fixer forward')
  assert.equal(page.loaded.wfValidate(saved(), page.view).length, 0)
  page.dispose()
})

test('midpoint deletion removes rework configuration and restores the normal single exit', async () => {
  const draft = draftOf()
  draft.nodes[2] = { id: 'review', name: '代码审查', kind: 'agent', profileId: 'role', task: '检查实现' }
  draft.edges = draft.edges.slice(0, 2).concat({ from: 'review', exit: 'done', to: 'end' })
  const page = await harness({ draft }), canvas = await harness()
  named(page.render(), 'WorkflowCanvas').props.onConnect('review', '$rework', 'work')
  const props = named(page.render(), 'WorkflowCanvas').props
  let tree = canvas.canvas(props)
  const wire = all(tree).find(item => item.props.key === 'review.rework')
  const remove = all(wire).find(item => item.props.className === 'nodo-wf-wire-delete')
  assert.ok(remove)
  assert.equal(all(tree).filter(item => item.props.className === 'nodo-wf-wire-delete').length, 4)
  assert.equal(remove.props.type, 'button')
  assert.ok(remove.props['aria-label'].includes('代码审查 → 编码实现'))
  const action = wire.children.find(item => item.type === 'foreignObject')
  const label = wire.children.find(item => item.type === 'text')
  assert.equal(action.props.x + 12, label.props.x)
  assert.ok(action.props.y > label.props.y, 'the deletion icon sits below the line label')
  let stopped = 0
  remove.props.onPointerDown({ stopPropagation() { stopped++ } })
  remove.props.onClick({ stopPropagation() { stopped++ } })
  assert.equal(stopped, 2)
  page.render()
  const saved = JSON.parse(page.storage.get('nodo.workflow.draft')).draft
  assert.deepEqual(saved, draft, 'deleting an automatic rework restores the original graph and task')
  assert.equal(page.loaded.wfValidate(saved, page.view).length, 0)
  remove.props.onClick({ stopPropagation() {} })
  page.render()
  assert.deepEqual(JSON.parse(page.storage.get('nodo.workflow.draft')).draft, draft, 'repeated deletion is harmless')
  for (const mode of [{ history: true }, { busy: true }, { onDisconnect: undefined }]) {
    tree = canvas.canvas({ ...props, ...mode })
    assert.equal(all(tree).some(item => item.props.className === 'nodo-wf-wire-delete'), false)
  }
  named(page.render(), 'WorkflowCanvas').props.onConnect('review', '$rework', 'work')
  named(page.render(), 'WorkflowCanvas').props.onDisconnect({ from: 'review', exit: 'done', to: 'end' })
  page.render()
  assert.ok(JSON.parse(page.storage.get('nodo.workflow.draft')).draft.nodes[2].exits.some(exit => exit.id === 'done'), 'the normal port remains available after its wire is deleted')
  named(page.render(), 'WorkflowCanvas').props.onConnect('review', 'done', 'end')
  page.render()
  assert.equal(page.loaded.wfValidate(JSON.parse(page.storage.get('nodo.workflow.draft')).draft, page.view).length, 0)
  page.dispose(); canvas.dispose()
})

test('deleting a named wire removes its rework conditions or human option and ignores stale targets', async () => {
  const draft = draftOf()
  draft.nodes[1].exits = [{ id: 'done', when: '通过' }, { id: 'rework', when: '返工' }]
  draft.edges.push({ from: 'work', exit: 'rework', to: 'end' })
  const h = await harness({ draft })
  const disconnect = named(h.render(), 'WorkflowCanvas').props.onDisconnect
  disconnect({ from: 'work', exit: 'rework', to: 'review' })
  h.render()
  assert.deepEqual(JSON.parse(h.storage.get('nodo.workflow.draft')).draft, draft, 'a stale target cannot delete a rewired exit')
  disconnect({ from: 'work', exit: 'rework', to: 'end' })
  disconnect({ from: 'review', exit: 'revise', to: 'work' })
  h.render()
  const saved = JSON.parse(h.storage.get('nodo.workflow.draft')).draft
  assert.equal(saved.nodes[1].exits, undefined, 'without its rework wire the step has a single exit again')
  assert.deepEqual(saved.nodes[2].options, [{ id: 'accept', label: '接受并完成' }])
  assert.equal(saved.nodes[2].question, draft.nodes[2].question)
  assert.deepEqual(saved.edges, draft.edges.filter(edge => edge.exit !== 'rework' && edge.exit !== 'revise'))
  assert.equal(h.loaded.wfValidate(saved, h.view).length, 0)
  const readOnly = await harness({ draft, readOnly: true })
  named(readOnly.render(), 'WorkflowCanvas').props.onDisconnect(draft.edges[0])
  readOnly.render()
  assert.deepEqual(JSON.parse(readOnly.storage.get('nodo.workflow.draft')).draft, draft)
  h.dispose(); readOnly.dispose()
})

test('branch outputs and converging inputs use distinct anchors for previews and saved wires', async () => {
  const h = await harness(), graph = draftOf(), connects = []
  const base = { graph, view: h.view, positions: { review: { x: 500, y: 200 }, work: { x: 200, y: 200 } }, onSelect() {}, onPosition() {}, onConnect: (...args) => connects.push(args) }
  let tree = h.canvas(base)
  const review = () => all(tree).find(node => node.props.className === 'nodo-wf-node' && node.props['data-kind'] === 'human')
  const outputs = () => all(review()).filter(node => node.props.className === 'nodo-wf-port nodo-wf-port-out')
  assert.deepEqual(outputs().map(port => [port.props['data-exit'], port.props.style.top]), [['accept', 108], ['revise', 148]])
  assert.equal(outputs()[1].props['data-back'], '')
  assert.equal(outputs()[1].props.style.left, 95, 'rework output is centered on the bottom edge')
  const paths = all(tree).filter(node => node.props.className === 'nodo-wf-wire-hit').map(node => node.props.d)
  assert.ok(paths.some(path => path.startsWith('M704,308 ')))
  assert.ok(paths.includes('M602,348 C602,448 268,448 268,348'), 'rework curves below both bottom ports')
  const back = all(tree).find(node => node.props.className === 'nodo-wf-wire nodo-wf-back')
  assert.ok(back.children.find(node => node.props.markerEnd)?.props.markerEnd.endsWith('-back)'), 'rework uses its own red arrow marker')
  const target = all(tree).find(node => node.props.className === 'nodo-wf-node' && node.props['data-kind'] === 'agent')
  const input = all(target).find(node => node.props.className === 'nodo-wf-port nodo-wf-port-in' && node.props['data-back'] === '')
  assert.equal(input.props.style.top, target.props.style.height)
  assert.equal(input.props.style.left, 61, 'the incoming rework leaves room for the target’s own rework output')
  outputs()[1].props.onPointerDown({ button: 0, clientX: 602, clientY: 348, pointerId: 1, preventDefault() {}, stopPropagation() {}, currentTarget: { setPointerCapture() {} } })
  tree = h.canvas(base)
  const svg = all(tree).find(node => node.type === 'svg' && node.props['aria-label'] === '节点连线')
  const preview = svg.children.find(node => node.props.className === 'nodo-wf-wire-preview')
  assert.ok(preview.props.d.startsWith('M602,348 C602,448 '), 'the preview starts at the bottom port inside SVG')
  assert.equal(preview.props['data-back'], '', 'the rework preview uses the red dashed style')
  outputs()[1].props.onPointerUp({ clientX: 268, clientY: 354 })
  assert.deepEqual(connects, [['review', 'revise', 'work']])
  h.dispose()
})

test('multiple rework inputs and outputs occupy separate bottom ports in history too', async () => {
  const h = await harness(), graph = draftOf()
  graph.nodes.push({ id: 'decision', name: '裁定', kind: 'agent', profileId: 'role', exits: [{ id: 'pass', when: '通过' }, { id: 'revise', when: '返工' }] })
  graph.edges.push({ from: 'decision', exit: 'revise', to: 'review', back: { max: 2 } })
  for (const history of [false, true]) {
    const tree = h.canvas({ graph, view: h.view, positions: {}, history, onSelect() {}, onConnect() {} })
    const review = all(tree).find(node => node.props.className === 'nodo-wf-node' && node.props['data-kind'] === 'human')
    const bottom = all(review).filter(node => node.props['data-back'] === '')
    assert.deepEqual(bottom.map(port => port.props.style.left).sort((a, b) => a - b), [61, 129])
    assert.ok(bottom.every(port => port.props.style.top === review.props.style.height))
  }
  h.dispose()
})

test('legacy steps convert without mutation and old history never borrows a same-named definition', async () => {
  const h = await harness(); const { wfGraph, wfHistoryGraph } = h.loaded
  const legacy = { id: 'old', name: '流程', steps: [{ name: '执行', profileId: 'role', task: '任务' }, { name: '验收', decide: true, question: '通过？' }] }
  const graph = wfGraph(legacy)
  assert.equal(graph.nodes.at(-1).deliver, 's1')
  assert.equal(legacy.nodes, undefined)
  const definition = { ...draftOf(), id: 'original' }
  const run = { workflowId: 'original', tasks: [{ id: 't1', name: '编码实现', kind: 'agent' }, { id: 't2', name: '编码实现', kind: 'agent' }] }
  assert.equal(wfHistoryGraph([definition], run).tasks.get('work').length, 2)
  assert.equal(wfHistoryGraph([{ ...definition, id: 'replacement' }], run), null)
  const duplicate = structuredClone(definition); duplicate.nodes[2].name = '编码实现'
  assert.equal(wfHistoryGraph([duplicate], run), null)
  assert.equal(wfHistoryGraph([definition], { ...run, tasks: [{ name: '未知节点', kind: 'agent' }] }), null)
})

test('missing workspace still blocks launch and explains the association in the run control', async () => {
  const definition = { ...draftOf(), id: 'flow', revision: 1 }
  const h = await harness({ definition }); h.view.workspaces = []
  const tree = h.render()
  assert.equal(button(tree, '运行').props.disabled, true)
  assert.match(button(tree, '运行').props.title, /需要已有的工作区和角色/)
  assert.equal(all(tree).some(item => item.props.className === 'nodo-wf-validation'), false)
  assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).draft.name, definition.name)
  h.dispose()
})

test('an unused default session retains its real project association even when hidden from session lists', async () => {
  const h = await harness()
  h.view.profiles = [{ id: 'role', name: '伙伴', workspaceId: 'project', activeSessionId: 'role', sessions: [] }]
  const participant = h.loaded.wfParticipants(draftOf(), h.view)[0]
  assert.equal(participant.workspace.id, 'project')
  assert.equal(participant.session.id, 'role')
  assert.equal(participant.session.name, '默认会话')
})

test('delivery shows the last completed source task and keeps acceptance separate', async () => {
  const h = await harness(), definition = { ...draftOf(), id: 'flow' }
  const run = { workflowId: 'flow', status: 'done', tasks: [
    { id: 'old', kind: 'agent', name: '编码实现', status: 'done', output: '第一版' },
    { id: 'new', kind: 'agent', name: '编码实现', status: 'done', output: '返工后的实现' },
    { id: 'accept', kind: 'human', name: '人工验收', status: 'done', output: '接受并完成' },
  ] }
  const graph = h.loaded.wfHistoryGraph([definition], run)
  assert.equal(graph.taken.has('review.accept'), true, 'a single completed end can be mapped despite its omitted task')
  assert.equal(h.loaded.wfDelivery(graph, run).id, 'new')
  assert.equal(h.loaded.wfDelivery(null, run), null)
  assert.equal(h.loaded.wfDelivery(graph, { ...run, status: 'running' }), null)
  graph.nodes.push({ id: 'other_end', kind: 'end', deliver: 'review' })
  assert.equal(h.loaded.wfDelivery(graph, run), null, 'the API cannot identify which of several end nodes was taken')
})

test('editing changes exit identifiers without losing destinations and persists across reopening', async () => {
  const h = await harness(), first = h.render(), inspector = named(first, 'WorkflowInspector')
  inspector.props.onChange({ exits: [{ id: 'complete', when: '完成' }] })
  const next = h.render(), changed = named(next, 'WorkflowInspector').props.draft
  assert.equal(changed.edges.find(edge => edge.from === 'work').exit, 'complete')
  assert.equal(changed.edges.find(edge => edge.from === 'work').to, 'review')
  assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).draft.nodes[1].exits[0].id, 'complete')
  h.dispose()
})

test('the canvas picks the workspace the flow runs in, saved with the flow', async () => {
  const h = await harness({ api: async (endpoint, payload) => endpoint === 'workflow-create' ? { ...payload, id: 'saved', revision: 1 } : [] })
  h.view.workspaces.push({ id: 'other', name: '另一个项目', cwd: '/other' })
  const picker = () => named(h.render(), 'WorkflowCanvas').props.trailing.props
  assert.equal(picker().workspace, undefined, 'a new flow follows each role\'s conversation')
  assert.equal(picker().none, '跟随角色会话')
  assert.equal(picker().button, true)
  picker().onSelect('other')
  assert.equal(picker().workspace.id, 'other')
  assert.equal(h.loaded.wfParticipants(JSON.parse(h.storage.get('nodo.workflow.draft')).draft, h.view)[0].workspace.id, 'other', 'every step checks against the flow\'s workspace')
  saveButton(h.render()).props.onClick(); await h.flush()
  assert.equal(h.calls.find(call => call.endpoint === 'workflow-create').payload.workspaceId, 'other')
  assert.equal(saveButton(h.render()).props.disabled, true, 'the saved workspace is not a change')
  picker().onSelect('')
  assert.equal(picker().workspace, undefined)
  assert.equal(saveButton(h.render()).props.disabled, false)
  h.dispose()
})

test('saving new graphs uses only workflow-create and strips empty choice arrays', async () => {
  const h = await harness({ api: async (endpoint, payload) => endpoint === 'workflow-create' ? { ...payload, id: 'saved', revision: 1 } : [] })
  const tree = h.render()
  assert.equal(button(tree, '运行').props.disabled, false, 'an unsaved draft may run')
  assert.equal(button(tree, '运行').props.title, '运行前会先保存当前修改。')
  assert.equal(saveMenu(h.render()).props.items.find(item => item.id === 'saveAs').disabled, true, 'a new draft has nothing to copy')
  saveButton(h.render()).props.onClick(); await h.flush()
  const create = h.calls.find(call => call.endpoint === 'workflow-create')
  assert.equal(create.payload.nodes.length, 4)
  assert.equal(create.payload.edges.at(-1).back.max, 2)
  assert.equal(button(h.render(), '运行').props.title, undefined)
  assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).source.id, 'saved')
  h.dispose()
})

test('an incomplete draft saves while launch names its first problem; a blank new flow has nothing to save', async () => {
  const draft = draftOf(); draft.nodes[1].task = ''
  const h = await harness({ draft, api: async (endpoint, payload) => endpoint === 'workflow-create' ? { ...payload, id: 'draft', revision: 1 } : [] })
  const tree = h.render()
  assert.equal(saveButton(h.render()).props.disabled, false)
  assert.equal(saveButton(h.render()).props.title, '保存')
  assert.equal(button(tree, '运行').props.disabled, true)
  assert.match(button(tree, '运行').props.title, /请填写任务说明/)
  saveButton(h.render()).props.onClick(); await h.flush()
  assert.equal(h.calls.find(call => call.endpoint === 'workflow-create').payload.nodes[1].task, '')
  assert.equal(button(h.render(), '运行').props.disabled, true, 'launch still waits for the task after saving')
  assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).source.id, 'draft')
  const blank = await harness({ draft: h.loaded.wfNew() })
  h.dispose()
  const fresh = blank.render()
  assert.equal(saveButton(blank.render()).props.disabled, true)
  assert.equal(all(fresh).some(node => node.props.className === 'nodo-wf-save-state'), false)
  newFlow(blank.loaded.wfSidebarSnapshot()).props.onClick()
  assert.equal(all(blank.render()).some(node => node.type === 'Modal' && node.props.title === '替换当前草稿？'), false, 'a blank flow is replaced without asking')
  blank.dispose()
})

test('saving a modified source refuses a stale or deleted version without replacing the draft', async () => {
  const definition = { ...draftOf(), id: 'flow', revision: 1 }
  for (const fresh of [[], [{ ...definition, revision: 2 }]]) {
    const draft = draftOf(); draft.name = '保存的修改'
    const h = await harness({ draft, definition, api: async endpoint => endpoint === 'state' ? { workflows: { definitions: fresh } } : [] })
    saveButton(h.render()).props.onClick(); await h.flush()
    assert.equal(h.calls.some(call => /workflow-(create|update)/.test(call.endpoint)), false)
    assert.match(text(h.render()), /草稿已保留/)
    assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).draft.name, draft.name)
    button(h.render(), '转为独立草稿').props.onClick()
    const independent = h.render()
    assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).source, null)
    assert.equal(saveButton(h.render()).props.disabled, false)
    h.dispose()
  }
})

test('save overwrites the current flow at its revision; save-as copies it and switches to the copy', async () => {
  const definition = { ...draftOf(), id: 'old', revision: 1 }, draft = draftOf(); draft.nodes[1].task = '修改后的任务'
  const h = await harness({ definition, draft, api: async (endpoint, payload) => endpoint === 'state' ? { workflows: { definitions: [definition] } }
    : endpoint === 'workflow-update' ? { ...payload, revision: payload.revision + 1 } : endpoint === 'workflow-create' ? { ...payload, id: 'new', revision: 1 } : [] })
  assert.equal(text(h.render()).includes('有未保存修改'), true)
  saveButton(h.render()).props.onClick(); await h.flush()
  const saved = h.calls.find(call => call.endpoint === 'workflow-update').payload
  assert.equal(saved.id, 'old'); assert.equal(saved.revision, 1); assert.equal(saved.nodes[1].task, '修改后的任务')
  h.render()
  assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).source.revision, 2)
  assert.equal(saveButton(h.render()).props.disabled, true, 'nothing left to save')
  saveMenu(h.render()).props.onSelect('saveAs')
  const dialog = () => all(h.render()).find(node => node.type === 'Modal' && node.props.title === '另存为新流程')
  const field = () => all(dialog()).find(node => node.type === 'input')
  const confirmSave = () => dialog().props.footer.find(node => node.children.includes('保存'))
  assert.equal(field().props.value, '开发与验收 副本', 'save-as asks for a name and suggests an unused one')
  assert.equal(h.calls.some(call => call.endpoint === 'workflow-create'), false)
  field().props.onChange({ target: { value: ' 开发与验收 ' } })
  assert.equal(confirmSave().props.disabled, true, 'a used name is refused')
  assert.match(text(dialog()), /已有同名流程/)
  field().props.onChange({ target: { value: '开发副本' } })
  confirmSave().props.onClick(); await h.flush()
  h.render()
  assert.equal(h.calls.filter(call => call.endpoint === 'workflow-create').length, 1)
  assert.equal(h.calls.find(call => call.endpoint === 'workflow-create').payload.name, '开发副本')
  assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).source.id, 'new')
  h.dispose()
})

test('pending cards float over the run canvas instead of the narrow drawer, whichever step is picked', async () => {
  const definition = { ...draftOf(), id: 'flow', revision: 1 }
  const asking = { id: 'run', workflowId: 'flow', workflowName: definition.name, status: 'running', createdAt: 1, tasks: [
    { id: 't1', name: '编码实现', kind: 'agent', status: 'done', output: '实现完成', attempts: [{ id: 'a', n: 1, sessionId: 's', profileId: 'role' }] },
    { id: 't2', name: '人工验收', kind: 'human', status: 'active', card: 'run:run:q', attempts: [] }] }
  const h = await harness({ definition, api: async endpoint => endpoint === 'run-list' ? [asking] : endpoint === 'run-get' ? asking : [] })
  h.view.approvals = [{ id: 'run:run:q', kind: 'question', detail: { exits: [] } }, { id: 'perm', kind: 'permission', profileId: 's' }, { id: 'other', kind: 'permission', profileId: 'elsewhere' }]
  button(h.side(), '运行记录').props.onClick(); h.render(); await h.flush(); h.render()
  all(h.loaded.wfSidebarSnapshot()).find(node => node.type === 'button' && node.props.className === 'nodo-runs-row').props.onClick()
  h.render(); await h.flush()
  const docked = () => {
    const tree = h.render(), canvas = named(tree, 'WorkflowCanvas')
    assert.equal(all(tree).some(node => node.props.className === 'nodo-wf-inspector nodo-wf-run-inspector' && all(node).some(item => item.type === 'ApprovalCard')), false)
    return { canvas, ids: canvas.props.dock.children.map(card => card.props.card.id) }
  }
  let { canvas, ids } = docked()
  assert.deepEqual(ids, ['run:run:q', 'perm'])
  canvas.props.onSelect('work')
  assert.deepEqual(docked().ids, ['run:run:q', 'perm'], 'a picked step does not hide what still waits')
  h.dispose()
})

test('a run without its original definition keeps its pending cards in the main area', async () => {
  const orphan = { id: 'run', workflowId: 'gone', workflowName: '已删除', status: 'running', createdAt: 1, tasks: [
    { id: 't1', name: '编码实现', kind: 'agent', status: 'done', output: '实现完成', attempts: [{ id: 'a', n: 1, sessionId: 's', profileId: 'role' }] },
    { id: 't2', name: '人工验收', kind: 'human', status: 'active', card: 'run:run:q', attempts: [] }] }
  const h = await harness({ api: async endpoint => endpoint === 'run-list' ? [orphan] : endpoint === 'run-get' ? orphan : [] })
  h.view.approvals = [{ id: 'run:run:q', kind: 'question', detail: { exits: [] } }]
  button(h.side(), '运行记录').props.onClick(); h.render(); await h.flush(); h.render()
  all(h.loaded.wfSidebarSnapshot()).find(node => node.type === 'button' && node.props.className === 'nodo-runs-row').props.onClick()
  h.render(); await h.flush()
  const tree = h.render()
  assert.match(text(tree), /原定义已删除或节点名称无法唯一对应/)
  assert.equal(named(tree, 'WorkflowCanvas'), undefined, 'nothing is projected without the original definition')
  const dock = all(tree).find(node => node.props.className === 'nodo-wf-task-dock nodo-wf-card-dock')
  assert.equal(dock.props['aria-label'], '待处理')
  assert.deepEqual(dock.children.map(card => card.props.card.id), ['run:run:q'])
  assert.equal(all(tree).some(node => node.props.className === 'nodo-wf-inspector nodo-wf-run-inspector' && all(node).some(item => item.type === 'ApprovalCard')), false)
  h.dispose()
})

test('the run drawer shows the whole run until one step is picked, and only that step afterwards', async () => {
  const definition = { ...draftOf(), id: 'flow', revision: 1 }
  const done = { id: 'run', workflowId: 'flow', workflowName: definition.name, status: 'done', createdAt: 1, tasks: [
    { id: 't1', name: '编码实现', kind: 'agent', status: 'done', output: '实现完成', attempts: [{ id: 'a', n: 1, sessionId: 's' }] },
    { id: 't2', name: '人工验收', kind: 'human', status: 'done', output: 'accept', attempts: [] }] }
  const h = await harness({ definition, api: async endpoint => endpoint === 'run-list' ? [done] : endpoint === 'run-get' ? done : [] })
  button(h.side(), '运行记录').props.onClick(); h.render(); await h.flush(); h.render()
  all(h.loaded.wfSidebarSnapshot()).find(node => node.type === 'button' && node.props.className === 'nodo-runs-row').props.onClick()
  h.render(); await h.flush()
  const drawer = () => { const tree = h.render(); return { tree, aside: all(tree).find(node => node.props.className === 'nodo-wf-inspector nodo-wf-run-inspector'), detail: named(tree, 'RunDetail') ?? all(tree).find(node => node.type === 'RunDetail') } }
  let { tree, aside, detail } = drawer()
  assert.equal(aside.props['aria-label'], '运行概览')
  assert.equal(named(aside, 'WorkflowRunDuration').props.run, done)
  assert.match(text(aside), /交付结果.*编码实现.*实现完成/)
  assert.equal(detail.props.step, false)
  assert.equal(detail.props.run.tasks.length, 2, 'the overview lists every step')
  detail.props.onPick('t2')
  ;({ tree, aside, detail } = drawer())
  assert.equal(aside.props['aria-label'], '步骤详情')
  assert.equal(named(aside, 'WorkflowRunDuration'), undefined)
  assert.doesNotMatch(text(aside), /交付结果/)
  assert.deepEqual([detail.props.step, detail.props.onPick, [...detail.props.run.tasks.map(task => task.id)]], [true, undefined, ['t2']])
  named(tree, 'WorkflowCanvas').props.onSelect('end')
  assert.equal(drawer().aside.props['aria-label'], '运行概览', 'picking the delivery returns to the whole run')
  named(drawer().tree, 'WorkflowCanvas').props.onSelect('work')
  button(drawer().aside, '查看全流程').props.onClick()
  assert.equal(drawer().aside.props['aria-label'], '运行概览')
  h.dispose()
})

test('the overview clock advances through waits, freezes at the end and resumes with the run', async () => {
  let now = 100_000, nextTimer = 0
  const timers = new Map(), h = await harness({ globals: {
    Date: { now: () => now },
    setInterval: (callback, ms) => { assert.equal(ms, 1000); timers.set(++nextTimer, callback); return nextTimer },
    clearInterval: id => timers.delete(id),
  } })
  const run = { id: 'run', status: 'running', createdAt: 35_000 }
  assert.equal(text(h.duration(run)), '已运行 1m 5s')
  now += 2000
  for (const timer of timers.values()) timer()
  assert.equal(text(h.duration(run)), '已运行 1m 7s')
  run.status = 'waiting_human'
  now += 3600_000
  for (const timer of timers.values()) timer()
  assert.equal(text(h.duration(run)), '已运行 1h 1m 7s')
  for (const status of ['done', 'failed', 'cancelled']) {
    Object.assign(run, { status, endedAt: 107_000 })
    assert.equal(text(h.duration(run)), '总时长 1m 12s')
    assert.equal(timers.size, 0)
    now += 10_000
    assert.equal(text(h.duration(run)), '总时长 1m 12s')
  }
  run.status = 'running'
  assert.equal(text(h.duration(run)), '已运行 1h 1m 37s', 'a resumed run ignores its earlier end time')
  assert.equal(timers.size, 1)
  delete run.endedAt
  Object.assign(run, { status: 'done', updatedAt: 37_000 })
  assert.equal(text(h.duration(run)), '总时长 2s', 'older records can use their last update')
  assert.equal(timers.size, 0)
  assert.equal(text(h.duration({ id: 'future', status: 'running', createdAt: now + 1000 })), '已运行 0s')
  h.dispose()
  assert.equal(timers.size, 0)
})

const launchApi = definition => async (endpoint, payload) => {
  if (endpoint === 'state') return { workflows: { definitions: [definition] } }
  if (endpoint === 'workflow-update') return Object.assign(definition, { ...payload, revision: payload.revision + 1 })
  if (endpoint === 'workflow-run') return { runId: 'run' }
  return endpoint === 'run-get' ? { id: 'run', workflowId: 'flow', tasks: [], status: 'running' } : []
}
const confirmLaunch = async h => {
  button(h.render(), '运行').props.onClick()
  const modal = all(h.render()).find(node => node.type === 'Modal' && node.props.title === '启动流程')
  const action = modal.props.footer.find(node => node.children.includes('确认运行'))
  action.props.onClick(); action.props.onClick(); await h.flush()
  return modal
}

test('launch sends the flow ID and task title once, then clears the step tasks from the saved flow', async () => {
  const definition = { ...draftOf(), id: 'flow', revision: 1 }
  definition.nodes[1].files = [{ id: 'f', name: 'spec.md' }]
  const h = await harness({ definition: structuredClone(definition), draft: structuredClone(definition), api: launchApi(definition) })
  await confirmLaunch(h)
  const calls = h.calls.filter(call => call.endpoint === 'workflow-run')
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)), { id: 'flow', title: '实现并验证' })
  const cleared = h.calls.filter(call => call.endpoint === 'workflow-update')
  assert.equal(cleared.length, 1, 'an unchanged flow is not saved before running')
  assert.equal(cleared[0].payload.nodes[1].task, ''); assert.equal(cleared[0].payload.nodes[1].files, undefined)
  assert.equal(cleared[0].payload.nodes[2].options[0].label, '接受并完成', 'only step tasks are per-run input')
  h.render()
  const kept = JSON.parse(h.storage.get('nodo.workflow.draft'))
  assert.equal(kept.draft.nodes[1].task, ''); assert.equal(kept.source.revision, 2)
  assert.equal(text(h.render()).includes('有未保存修改'), false)
  h.dispose()
})

test('the launch task title is editable, required and independent of the saved flow name', async () => {
  const definition = { ...draftOf(), id: 'flow', revision: 1 }
  const h = await harness({ definition: structuredClone(definition), api: launchApi(definition) })
  button(h.render(), '运行').props.onClick()
  const modal = () => all(h.render()).find(node => node.type === 'Modal' && node.props.title === '启动流程')
  const field = () => all(modal()).find(node => node.props['aria-label'] === '本次任务标题')
  assert.equal(field().props.value, '实现并验证')
  field().props.onChange({ target: { value: '   ' } })
  assert.equal(modal().props.footer.find(node => node.children.includes('确认运行')).props.disabled, true)
  field().props.onChange({ target: { value: '  修复登录白屏  ' } })
  modal().props.footer.find(node => node.children.includes('确认运行')).props.onClick()
  await h.flush()
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(call => call.endpoint === 'workflow-run').payload)), { id: 'flow', title: '修复登录白屏' })
  assert.equal(definition.name, '开发与验收')
  assert.equal(h.calls.find(call => call.endpoint === 'workflow-update').payload.name, '开发与验收')
  h.dispose()
})

test('run navigation and its heading show the task title with the flow kept as source information', async () => {
  const definition = { ...draftOf(), id: 'flow', revision: 1 }
  const run = { id: 'run', title: '修复登录白屏', workflowId: definition.id, workflowName: definition.name, createdAt: 1, status: 'done', tasks: [] }
  const h = await harness({ definition, api: async endpoint => endpoint === 'run-list' ? [run] : endpoint === 'run-get' ? run : [] })
  h.render(); await h.flush()
  button(h.side(), '运行记录').props.onClick()
  const row = all(h.side()).find(node => node.type === 'button' && node.props.className === 'nodo-runs-row')
  const title = all(row).find(node => node.type === 'strong')
  assert.equal(text(title), run.title)
  assert.match(title.props.title, /流程：开发与验收/)
  row.props.onClick(); h.render(); await h.flush()
  const tree = h.render(), header = all(tree).find(node => node.type === 'header' && node.props.className === 'nodo-wf-header')
  assert.equal(text(all(header).find(node => node.type === 'h1')), run.title)
  assert.match(text(header), /流程：开发与验收/)
  h.dispose()
})

test('launching an unsaved draft creates the flow, runs it and saves the cleared tasks back', async () => {
  let saved = null
  const h = await harness({ api: async (endpoint, payload) => {
    if (endpoint === 'workflow-create') { saved = { ...payload, id: 'saved', revision: 1 }; return saved }
    if (endpoint === 'state') return { workflows: { definitions: saved ? [saved] : [] } }
    if (endpoint === 'workflow-run') return { runId: 'run' }
    if (endpoint === 'workflow-update') return { ...payload, id: 'saved', revision: payload.revision + 1 }
    return endpoint === 'run-get' ? { id: 'run', workflowId: 'saved', tasks: [], status: 'running' } : []
  } })
  await confirmLaunch(h)
  assert.deepEqual(h.calls.filter(call => /workflow-(create|run|update)/.test(call.endpoint)).map(call => call.endpoint),
    ['workflow-create', 'workflow-run', 'workflow-update'])
  const cleared = h.calls.find(call => call.endpoint === 'workflow-update')
  assert.deepEqual([cleared.payload.id, cleared.payload.revision], ['saved', 1])
  assert.equal(cleared.payload.nodes[1].task, '')
  h.render()
  assert.equal(JSON.parse(h.storage.get('nodo.workflow.draft')).source.id, 'saved')
  h.dispose()
})

test('the launch card lists every step in wire order with its role and routes', async () => {
  const agent = (id, name) => ({ id, name, kind: 'agent', profileId: 'role', task: 't', exits: id === 'review' ? [{ id: 'done', when: 'ok' }, { id: 'rework', when: 'bad' }] : undefined })
  const draft = { name: '修复', nodes: [{ id: 'start', name: '开始', kind: 'start' }, agent('commit', 'commit'), agent('docs', '同步文档'), agent('fix', 'fixbug'), agent('review', 'review'),
    { id: 'gate', name: '人工验收', kind: 'human', options: [{ id: 'go', label: '继续' }] }, { id: 'end', name: '完成交付', kind: 'end', deliver: 'commit' }],
  edges: [{ from: 'start', exit: 'done', to: 'review' }, { from: 'review', exit: 'done', to: 'docs' }, { from: 'review', exit: 'rework', to: 'fix' }, { from: 'fix', exit: 'done', to: 'docs' },
    { from: 'fix', exit: '$rework', to: 'review', back: { max: 2 } }, { from: 'docs', exit: 'done', to: 'gate' }, { from: 'gate', exit: 'go', to: 'commit' }, { from: 'commit', exit: 'done', to: 'end' }] }
  const h = await harness({ draft })
  button(h.render(), '运行').props.onClick()
  const modal = all(h.render()).find(node => node.type === 'Modal' && node.props.title === '启动流程')
  const list = all(modal).find(node => node.props?.className === 'nodo-dialog-fields nodo-wf-steps'), steps = list.children
  assert.ok(steps.every(step => step.props.className === 'nodo-wf-association'), 'the steps scroll inside the dialog body')
  assert.deepEqual(steps.map(step => text(step.children[0])), ['1. review', '2. fixbug', '3. 同步文档', '4. 人工验收', '5. commit'])
  assert.match(text(steps[0]), /开发伙伴 · echo · 项目/)
  assert.match(text(steps[0]), /通过 → 同步文档；不通过 → fixbug/)
  assert.match(text(steps[1]), /返工 ↺ review/)
  assert.match(text(steps[3]), /人工节点 · 查看上一步产出并选择下一步继续 → commit/)
  h.dispose()
})

test('launching a modified flow saves it in place first and runs that version', async () => {
  const definition = { ...draftOf(), id: 'flow', revision: 1 }, draft = draftOf(); draft.nodes[1].task = '本次的新任务'
  const h = await harness({ definition: structuredClone(definition), draft, api: launchApi(definition) })
  assert.equal(button(h.render(), '运行').props.disabled, false)
  const modal = await confirmLaunch(h)
  assert.match(text(modal), /运行前先把修改保存到当前流程/)
  const order = h.calls.map(call => call.endpoint).filter(endpoint => /workflow-(create|update|run)/.test(endpoint))
  assert.deepEqual(order, ['workflow-update', 'workflow-run', 'workflow-update'])
  assert.equal(h.calls.find(call => call.endpoint === 'workflow-update').payload.nodes[1].task, '本次的新任务')
  assert.equal(h.calls.findLast(call => call.endpoint === 'workflow-update').payload.revision, 2)
  h.dispose()
})

test('read-only mode requests no records and disables workflow writes', async () => {
  const h = await harness({ readOnly: true })
  const tree = h.render(); await h.flush()
  assert.equal(h.calls.length, 0)
  assert.equal(saveButton(h.render()).props.disabled, true)
  assert.equal(button(tree, '运行').props.disabled, true)
  assert.match(text(tree), /只读窗口不读取运行记录/)
  h.dispose()
})

test('options-only workflow questions hide custom text; stale answers refresh pending requests', async () => {
  let refreshed = 0
  const h = await harness()
  const rejected = async () => { throw new Error('This card is no longer open') }
  const frozen = await loadClient('run-cards.js', {
    react: { useState: value => [value, () => {}], useEffect: () => {} }, call: rejected,
  })
  const card = { id: 'run:r:q:1', kind: 'question', reason: '是否通过？', detail: { options: ['通过', '修改'], allowText: false } }
  let tree = frozen.ApprovalCard({ card, refresh: async () => { refreshed++ }, readOnly: false })
  assert.equal(all(tree).some(node => node.type === 'textarea'), false)
  all(tree).find(node => node.props.role === 'radio').props.onClick()
  // ApprovalCard has its own hook sequence when called directly.
  const independent = await loadClient('run-cards.js', {
    react: { useState: initial => [typeof initial === 'boolean' ? false : typeof initial === 'number' ? 0 : typeof initial === 'string' ? '' : { answer: '通过' }, () => {}] },
    call: rejected,
  })
  tree = independent.ApprovalCard({ card, refresh: async () => { refreshed++ }, readOnly: false })
  button(tree, '提交').props.onClick(); await h.flush()
  assert.equal(refreshed, 1)
})

test('editor graph is accepted by the real host and retains configured back edges', async () => {
  await withHost(async host => {
    const workspace = await host.api('workspace-create', { name: '工作区', cwd: '/tmp' })
    const role = await host.api('profile-create', { name: '伙伴', engine: 'echo', workspace: workspace.id })
    const draft = draftOf(); draft.nodes[1].profileId = role.id
    draft.edges = draft.edges.filter(edge => !edge.back)
    draft.nodes[2].options = draft.nodes[2].options.slice(0, 1)
    const h = await harness({ draft })
    named(h.render(), 'WorkflowCanvas').props.onConnect('review', '$rework', 'work')
    h.render()
    const wired = JSON.parse(h.storage.get('nodo.workflow.draft')).draft
    const view = await host.api('state')
    assert.equal(h.loaded.wfValidate(wired, view).length, 0)
    const definition = await host.api('workflow-create', wired)
    assert.equal(definition.edges.at(-1).back.max, 2)
    assert.deepEqual(definition.nodes.find(node => node.id === 'review').options.at(-1), { id: 'rework', label: '返工' })
    const { runId } = await host.api('workflow-run', { id: definition.id })
    await until(async () => (await host.api('run-get', { id: runId })).tasks.some(task => task.card))
    let run = await host.api('run-get', { id: runId })
    const asking = run.tasks.find(task => task.card)
    await host.api('approval-answer', { id: asking.card, decision: 'answer', value: '接受并完成' })
    await until(async () => (await host.api('run-get', { id: runId })).status === 'done')
    run = await host.api('run-get', { id: runId })
    assert.ok(h.loaded.wfHistoryGraph([definition], run))
    assert.equal(run.tasks.find(task => task.kind === 'human').output, 'Decision "人工验收": 接受并完成')
  })
})

test('a question card shows the step report, takes an exit with a note and sends back even after its definition is deleted', async () => {
  await withHost(async host => {
    const workspace = await host.api('workspace-create', { name: '工作区', cwd: '/tmp' })
    const role = await host.api('profile-create', { name: '伙伴', engine: 'echo', workspace: workspace.id })
    const draft = draftOf(); draft.nodes[1].profileId = role.id
    const definition = await host.api('workflow-create', draft)
    const { runId } = await host.api('workflow-run', { id: definition.id })
    await until(async () => (await host.api('run-get', { id: runId })).tasks.some(task => task.card))
    await host.api('workflow-delete', { id: definition.id })
    const state = await host.api('state')
    const card = state.approvals.find(item => item.id.startsWith(`run:${runId}:`))
    assert.deepEqual(card.detail.exits, [{ id: 'accept', label: '接受并完成' }, { id: 'revise', label: '返回修改' }])
    assert.deepEqual([card.detail.back, card.detail.report.step], ['编码实现', '编码实现'])
    const h = await harness()
    const detail = await host.api('run-get', { id: runId })
    assert.equal(h.loaded.wfHistoryGraph(state.workflows.definitions, detail).nodes.length, 4, 'a run draws the graph it snapshotted')
    assert.deepEqual(detail.tasks.find(task => task.kind === 'agent').input, { text: '实现并验证' }, 'the run record keeps the task it was given')
    const cards = await loadClient('run-cards.js', { call: async () => ({}) })
    assert.equal(cards.ApprovalCard({ card, refresh: async () => {}, readOnly: false }).type, cards.DecisionCard)
    const sent = [], slots = []
    let at = 0
    const own = await loadClient('run-cards.js', {
      react: { useState: initial => { const i = at++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value }] } },
      call: async (endpoint, body) => { sent.push(body) },
    })
    const decide = () => { at = 0; return own.DecisionCard({ card, refresh: async () => {}, readOnly: false }) }
    let tree = decide()
    assert.match(text(all(tree).find(node => node.props?.className === 'nodo-question-report')), /编码实现 的产出/)
    button(tree, '退回「编码实现」').props.onClick(); await h.flush()
    assert.equal(sent.length, 0, 'sending back needs a note')
    all(tree).find(node => node.props?.role === 'radio').props.onClick()
    all(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: '补充测试' } })
    tree = decide()
    button(tree, '提交').props.onClick(); await h.flush()
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ id: card.id, decision: 'answer', exit: 'accept', value: '补充测试' }])
    await host.api('run-cancel', { id: runId })
  })
})

test('a legacy question card offers going back or cancelling, not an answer', async () => {
  const h = await harness()
  const decide = async card => {
    const sent = [], slots = []
    let at = 0
    const own = await loadClient('run-cards.js', {
      react: { useState: initial => { const i = at++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] } },
      call: async (endpoint, body) => { sent.push(body) },
    })
    return { sent, tree: own.DecisionCard({ card, refresh: async () => {}, readOnly: false }) }
  }
  const shown = await decide({ id: 'run:r:q:1', reason: '查看「编码实现」的产出', detail: { exits: [], legacy: true, back: '编码实现', report: { step: '编码实现', text: '产出文字' } } })
  const hint = all(shown.tree).find(node => node.props?.className === 'nodo-dialog-hint')
  assert.match(text(hint), /不再支持/)
  assert.match(text(hint), /取消这条运行/)
  assert.equal(all(shown.tree).some(node => node.props?.role === 'radio'), false)
  assert.equal(all(shown.tree).some(node => node.type === 'textarea'), false)
  assert.equal(button(shown.tree, '提交'), undefined)
  assert.notEqual(button(shown.tree, '退回「编码实现」'), undefined, 'sending the report back still works')
  const bare = await decide({ id: 'run:r:q:2', reason: '选择下一步', detail: { exits: [], legacy: true } })
  assert.equal(all(bare.tree).some(node => node.type === 'Button'), false, 'with no step to send back to, the run can only be cancelled elsewhere')
  assert.equal(bare.sent.length, 0)
  h.dispose()
})

test('a damaged browser draft drops what it cannot show and opens with its errors', async () => {
  const draft = draftOf()
  draft.nodes.push(null, 'node', { id: 'gone', kind: 'unknown' }, { kind: 'agent' })
  draft.nodes[1].name = undefined
  draft.nodes[1].images = 'invalid'
  draft.nodes[1].files = [null, { id: 'kept', name: 4 }]
  draft.nodes[1].choices = []
  draft.nodes[2].options.push(null, { id: 3, label: 4 })
  draft.edges.push(null, { from: 'work' })
  const h = await harness({ draft })
  const tree = h.render()
  const saved = JSON.parse(h.storage.get('nodo.workflow.draft')).draft
  assert.deepEqual(saved.nodes.map(node => node.id), ['start', 'work', 'review', 'end'])
  assert.equal(saved.edges.length, 4)
  assert.deepEqual(saved.nodes[1].images, [])
  assert.deepEqual(saved.nodes[1].files, [{ id: 'kept', name: '4' }])
  assert.deepEqual(saved.nodes[2].options.at(-1), { id: '3', label: '4' })
  const errors = h.loaded.wfValidate(saved, h.view).map(error => error.message)
  assert.ok(errors.some(message => message.includes('请填写节点名称')))
  assert.ok(tree)
  h.dispose()
})

test('a question has no prompt field and lists each option as an exit group like a step\'s conditions', async () => {
  const h = await harness({ draft: draftOf() })
  named(h.render(), 'WorkflowCanvas').props.onSelect('review')
  const inspector = () => h.loaded.WorkflowInspector(named(h.render(), 'WorkflowInspector').props)
  const group = title => all(inspector()).find(node => node.props.role === 'group' && node.props['aria-label'] === title)
  const field = title => all(group(title)).find(node => node.type === 'input')
  const options = () => h.render() && JSON.parse(h.storage.get('nodo.workflow.draft')).draft.nodes[2].options
  assert.doesNotMatch(text(inspector()), /向用户提问|出口标识|选项文字|移除此选项|文本回答/)
  assert.equal(all(inspector()).some(node => node.type === 'textarea'), false)
  assert.equal(all(inspector()).filter(node => node.props.className === 'nodo-wf-checks').length, 2, 'one group per option, as for pass and rework')
  assert.deepEqual([field('选项 1').props.value, field('选项 2').props.value], ['接受并完成', '返回修改'])
  assert.equal(group('选项 2').props['data-exit'], 'rework', 'an option wired back takes the rework tone')
  field('选项 1').props.onChange({ target: { value: '通过' } })
  button(inspector(), '+ 添加选项').props.onClick()
  assert.deepEqual(options().map(option => option.id), ['accept', 'revise', 'choice_3'])
  all(group('选项 2')).find(node => node.props['aria-label'] === '删除选项 2').props.onClick()
  assert.deepEqual(options(), [{ id: 'accept', label: '通过' }, { id: 'choice_3', label: '' }])
  assert.equal(h.loaded.wfValidate(JSON.parse(h.storage.get('nodo.workflow.draft')).draft, h.view).some(error => error.message.includes('问题')), false, 'a question needs no prompt')
  h.dispose()
})

test('a step with a rework wire lists pass and rework conditions in one card, suggestions shown as placeholders', async () => {
  const draft = draftOf()
  draft.nodes[2] = { id: 'review', name: '代码审查', kind: 'agent', profileId: 'role', task: '检查实现' }
  draft.edges = draft.edges.slice(0, 2).concat({ from: 'review', exit: 'done', to: 'end' })
  const h = await harness({ draft })
  named(h.render(), 'WorkflowCanvas').props.onSelect('review')
  const inspector = () => h.loaded.WorkflowInspector(named(h.render(), 'WorkflowInspector').props)
  const group = title => all(inspector()).find(node => node.props['aria-label'] === title)
  const inputs = title => all(group(title)).filter(node => node.type === 'input')
  const exits = () => h.render() && JSON.parse(h.storage.get('nodo.workflow.draft')).draft.nodes[2].exits
  assert.equal(group('通过条件'), undefined)
  assert.match(text(inspector()), /从节点底部「返工」端口拖线到上游节点或修复节点/)
  assert.equal(button(inspector(), '+ 添加条件出口'), undefined)
  named(h.render(), 'WorkflowCanvas').props.onConnect('review', '$rework', 'work')
  assert.deepEqual(inputs('通过条件').map(input => [input.props.value, input.props.placeholder]), [['', '任务要求的产出已完成'], ['', '结果已验证，没有阻塞问题']])
  assert.deepEqual(inputs('返工条件').map(input => input.props.placeholder), ['存在阻塞问题或未满足任务要求', '缺少继续所需的信息或材料'])
  assert.equal(all(inspector()).filter(node => node.props.className === 'nodo-wf-choice').length, 1, 'pass and rework share one card')
  assert.equal(all(inspector()).some(node => node.type === 'span' && /^\d+\.$/.test(node.children.join(''))), false, 'conditions are not numbered')
  assert.equal(button(inspector(), '断开连线'), undefined)
  inputs('通过条件')[0].props.onChange({ target: { value: '功能符合需求' } })
  button(group('返工条件'), '+ 添加返工条件').props.onClick()
  h.render()
  assert.ok(h.loaded.wfValidate(JSON.parse(h.storage.get('nodo.workflow.draft')).draft, h.view).some(error => error.message.includes('请填写每一条通过和返工条件')))
  inputs('返工条件')[2].props.onChange({ target: { value: '测试失败' } })
  assert.deepEqual(exits(), [{ id: 'done', when: '功能符合需求\n结果已验证，没有阻塞问题' }, { id: 'rework', when: '存在阻塞问题或未满足任务要求\n缺少继续所需的信息或材料\n测试失败' }])
  inputs('通过条件')[0].props.onChange({ target: { value: '' } })
  assert.equal(inputs('通过条件')[0].props.value, '', 'a cleared condition falls back to its suggestion')
  all(group('返工条件')).find(node => node.props['aria-label'] === '删除返工条件 1').props.onClick()
  assert.deepEqual(exits(), [{ id: 'done', when: '任务要求的产出已完成\n结果已验证，没有阻塞问题' }, { id: 'rework', when: '缺少继续所需的信息或材料\n测试失败' }])
  h.dispose()
})
