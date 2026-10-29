import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))
const target = { profile: 'role', session: 'first', cwd: '/workspace' }
const button = (tree, label) => nodes(tree).find(node => node.props['aria-label'] === label)
const unavailable = async endpoint => { assert.equal(endpoint, 'list'); return { available: false, terminals: [] } }
const changesSource = (path = '/workspace/src/x.ts') => ({ revision: 1,
  body: { scope: 'edit-tools', cwd: '/workspace', fileCount: 1, files: [{ path, edits: [{ operation: 'update', diffText: '@@ -8 +8 @@\n-before\n+after\n' }] }] },
  renderFile: (file, patch, panel) => ({ type: 'file-detail', props: { path: file.path, patch, panel }, children: [] }),
})

function measurement() {
  const disposed = [], element = { clientWidth: 380, clientHeight: 500, appendChild() {} }
  class Terminal { loadAddon() {} open() {} dispose() { disposed.push(true) } }
  class Fit { proposeDimensions() { return { cols: 91, rows: 29 } } }
  return { element, disposed,
    modules: { '@xterm/xterm': 'export const Terminal = globalThis.MeasuringTerminal', '@xterm/addon-fit': 'export const FitAddon = globalThis.MeasuringFit' },
    globals: { MeasuringTerminal: Terminal, MeasuringFit: Fit, document: { createElement: () => ({ style: {}, remove() {} }) } },
    createElement(type, props, ...children) {
      if (props?.className === 'nodo-right-content') props.ref.current = element
      return { type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== false && child != null) }
    },
  }
}

function renderer() {
  const cells = [], jobs = [], cleanups = new Map()
  let cursor = 0
  const effect = (run, deps) => {
    const at = cursor++
    if (!cells[at] || deps.some((value, index) => !Object.is(value, cells[at][index]))) jobs.push({ at, run })
    cells[at] = deps
  }
  return {
    react: {
      useState(initial) {
        const at = cursor++
        if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
        return [cells[at], value => { cells[at] = typeof value === 'function' ? value(cells[at]) : value }]
      },
      useRef(initial) { const at = cursor++; return cells[at] ??= { current: initial } },
      useEffect: effect,
      useLayoutEffect: effect,
    },
    render(run) {
      cursor = 0
      const tree = run()
      for (const { at, run } of jobs.splice(0)) { cleanups.get(at)?.(); cleanups.set(at, run()) }
      return tree
    },
    dispose() { for (const cleanup of cleanups.values()) cleanup?.(); cleanups.clear(); cells.length = 0 },
  }
}

function host() {
  const registrations = [], presentations = [], mounts = new Map()
  return {
    registrations, presentations,
    ctx: {
      slots: {
        inject(name, run) { assert.ok(['rightbar', 'shell.overlay'].includes(name)); mounts.set(name, run) },
        register(options, component) {
          const entry = { options, component }
          registrations.push(entry)
          return () => registrations.splice(registrations.indexOf(entry), 1)
        },
      },
      layout: {
        openRightbar: (...args) => presentations.push(['open', ...args]),
        closeRightbar: () => presentations.push(['close']),
      },
    },
    mount() {
      const disposers = [...mounts.values()].map(run => run())
      return () => { for (const dispose of disposers.reverse()) dispose() }
    },
  }
}

function mountedTree() {
  let current, root
  const counts = { mounts: 0, unmounts: 0 }
  const dispose = node => {
    if (!node || typeof node !== 'object') return
    for (const child of node.children) dispose(child)
    node.hooks?.dispose()
    if (node.props.className === 'nodo-right-toggle') counts.unmounts++
  }
  const reconcile = (previous, element) => {
    if (!element || typeof element !== 'object') { dispose(previous); return typeof element === 'string' ? element : null }
    if (previous?.type !== element.type || previous?.props.key !== element.props.key) {
      dispose(previous)
      previous = { type: element.type, props: element.props, children: [], hooks: typeof element.type === 'function' ? renderer() : null }
      if (element.props.className === 'nodo-right-toggle') counts.mounts++
    }
    previous.props = element.props
    let children = element.children ?? []
    if (previous.hooks) {
      current = previous.hooks
      children = [current.render(() => element.type(element.props))]
    }
    const before = previous.children, remaining = new Set(before)
    previous.children = children.map((child, index) => {
      const key = child?.props?.key
      const match = key == null ? before[index]?.props?.key == null ? before[index] : undefined
        : before.find(node => node?.props?.key === key)
      remaining.delete(match)
      return reconcile(match, child)
    }).filter(child => child !== null)
    for (const child of remaining) dispose(child)
    return previous
  }
  return {
    counts,
    react: Object.fromEntries(['useState', 'useRef', 'useEffect', 'useLayoutEffect'].map(name => [name, (...args) => current.react[name](...args)])),
    render: run => root = reconcile(root, run()),
    dispose: () => { dispose(root); root = null },
  }
}

test('changes use one replaceable tab, retain files and browser neighbors, and follow target lifetimes including archives', async () => {
  const loaded = await loadClient('right-panel.tsx', { call: unavailable, globals: { URL } })
  const panel = loaded.createRightPanel(host().ctx), first = changesSource()
  panel.openChanges(first)
  assert.equal(panel.getSnapshot().tabs.length, 0, 'unbound panels cannot open changes')
  const leave = panel.bind(target); await tick()
  panel.openFiles(); panel.newBrowser(); panel.openChanges(first, first.body.files[0].path)
  let state = panel.getSnapshot()
  assert.equal(state.active, 'changes')
  assert.equal(state.expanded, true)
  assert.equal(state.tabs.at(-1).source, first)
  const previous = state.tabs.at(-1).version
  const second = changesSource('/workspace/other.ts')
  panel.openChanges(second)
  state = panel.getSnapshot()
  assert.deepEqual(plain(state.tabs.map(tab => tab.kind)), ['files', 'browser', 'changes'])
  assert.equal(state.tabs.at(-1).source, second)
  assert.equal(state.tabs.at(-1).path, undefined)
  assert.notEqual(state.tabs.at(-1).version, previous, 'replacement resets the detail view and pending loader')
  const tree = loaded.RightPanel({ panel, width: 320 })
  const tab = nodes(tree).find(node => node.props.id === 'nodo-right-tab-changes')
  assert.equal(tab.children.at(-1), '变更')
  assert.equal(tab.children[0].type, 'IconBranchOutlineRegular')
  assert.equal(nodes(tree).find(node => node.props.id === 'nodo-right-pane-changes').children[0].props.source, second)
  leave(); panel.bind({ ...target, session: 'archived', readOnly: true }); await tick()
  assert.equal(panel.getSnapshot().tabs.at(-1).source, second)
  panel.openChanges(first)
  assert.equal(panel.getSnapshot().tabs.at(-1).source, first, 'archives can open changes')
  panel.bind({ ...target, cwd: '/other', readOnly: true }); await tick()
  assert.deepEqual(plain(panel.getSnapshot().tabs.map(tab => tab.kind)), ['files'], 'cwd changes discard comparisons')
  panel.openChanges(second)
  await panel.closeTab('changes')
  assert.deepEqual(plain(panel.getSnapshot().tabs.map(tab => tab.kind)), ['files'])
})

test('changes list shows every file and totals, opens detail, returns to list, and previews current files independently', async () => {
  const mounted = mountedTree()
  const loaded = await loadClient('right-panel.tsx', { react: mounted.react, call: unavailable })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); await tick()
  const source = changesSource()
  source.body.files = Array.from({ length: 5 }, (_, index) => ({ ...source.body.files[0], path: `/workspace/deep/src/${index}.ts` }))
  source.body.fileCount = 5
  panel.openChanges(source)
  const render = () => mounted.render(() => ({ type: loaded.RightPanel, props: { panel, width: 320 }, children: [] }))
  let tree = render()
  assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-changes-row').length, 5)
  assert.ok(button(tree, '新增 5 行，删除 5 行'))
  assert.equal(nodes(tree).find(node => node.props.className === 'nodo-changes-directory').children[0], 'deep/src/')
  button(tree, '查看 deep/src/3.ts 的变更').props.onClick()
  tree = render()
  const detail = nodes(tree).find(node => node.type === 'file-detail')
  assert.equal(detail.props.path, '/workspace/deep/src/3.ts')
  assert.equal(detail.props.panel, true)
  button(tree, '返回变更列表').props.onClick()
  tree = render()
  assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-changes-row').length, 5)
  button(tree, '打开文件 deep/src/3.ts').props.onClick()
  assert.equal(panel.getSnapshot().active, 'files')
  assert.equal(panel.getSnapshot().selected, '/workspace/deep/src/3.ts')
  panel.selectTab('changes')
  panel.openChanges(source, '/workspace/deep/src/1.ts')
  tree = render()
  assert.equal(nodes(tree).find(node => node.type === 'file-detail').props.path, '/workspace/deep/src/1.ts')
  button(tree, '打开文件 deep/src/1.ts').props.onClick()
  assert.equal(panel.getSnapshot().selected, '/workspace/deep/src/1.ts')
  mounted.dispose()
})

test('changes totals center their counts and only interactive list rows receive hover fill', async () => {
  const { CHANGES_PANEL_CSS } = await loadClient('changes-panel.tsx')
  assert.match(CHANGES_PANEL_CSS, /\.nodo-changes-total>\.nodo-tag\{display:inline-flex;align-items:center;height:28px/)
  assert.match(CHANGES_PANEL_CSS, /\.nodo-changes-list>\.nodo-changes-row:hover/)
  assert.ok(!CHANGES_PANEL_CSS.includes('\n.nodo-changes-row:hover'))
})

test('changes load full lists, show errors and retry, and ignore late answers after replacement or close', async () => {
  const mounted = mountedTree(), first = Promise.withResolvers(), second = Promise.withResolvers()
  const loaded = await loadClient('right-panel.tsx', { react: mounted.react, call: unavailable })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); await tick()
  const source = changesSource(), complete = { ...source.body, files: [source.body.files[0], { path: '/workspace/extra.ts', edits: [] }], fileCount: 2 }
  let loads = 0
  source.load = () => { loads++; return loads === 1 ? first.promise : second.promise }
  panel.openChanges(source)
  const render = () => mounted.render(() => ({ type: loaded.RightPanel, props: { panel, width: 320 }, children: [] }))
  assert.match(JSON.stringify(render()), /加载中…/)
  assert.equal(loads, 1)
  first.reject(new Error('saved details unavailable')); await tick()
  let tree = render()
  assert.match(JSON.stringify(tree), /saved details unavailable/)
  nodes(tree).find(node => node.type === 'Button' && node.children.includes('重试')).props.onClick()
  render()
  assert.equal(loads, 2)
  second.resolve(complete); await tick()
  tree = render()
  assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-changes-row').length, 2)
  const late = Promise.withResolvers()
  panel.openChanges({ ...source, load: () => late.promise }); render()
  panel.openChanges(changesSource('/workspace/replacement.ts'))
  render(); late.resolve(complete); await tick()
  assert.ok(button(render(), '查看 replacement.ts 的变更'))
  assert.equal(button(render(), '查看 extra.ts 的变更'), undefined)
  const closed = Promise.withResolvers()
  panel.openChanges({ ...source, load: () => closed.promise }); render()
  await panel.closeTab('changes'); render(); closed.resolve(complete); await tick()
  assert.equal(panel.getSnapshot().tabs.some(tab => tab.kind === 'changes'), false)
  mounted.dispose()
})

test('rightbar and overlay register only for a displayed session and release both host slots on leave', async () => {
  const hooks = renderer()
  const loaded = await loadClient('right-panel.tsx', { react: hooks.react, call: unavailable })
  const h = host(), panel = loaded.createRightPanel(h.ctx)
  const unmount = h.mount()
  const commit = () => hooks.render(() => h.registrations[0].component({ width: 320 }))
  assert.equal(h.registrations.length, 0)
  assert.deepEqual(h.presentations, [])
  const leaveFirst = panel.bind(target)
  assert.equal(h.registrations.length, 2)
  assert.deepEqual(plain(h.registrations[0].options), { name: 'rightbar', priority: -100 })
  assert.deepEqual(plain(h.registrations[1].options), { name: 'shell.overlay', id: 'nodo.right-toggle' })
  commit()
  assert.deepEqual(h.presentations.at(-1), ['close'])
  panel.toggle()
  commit()
  assert.deepEqual(h.presentations.at(-1), ['open', true, false])
  const owner = h.registrations[0]
  const overlay = h.registrations[1]
  const leaveSecond = panel.bind({ ...target, session: 'second' })
  leaveFirst()
  assert.equal(h.registrations[0], owner, 'a stale cleanup cannot remove the new session')
  assert.equal(h.registrations[1], overlay, 'a stale cleanup cannot remove its overlay')
  assert.equal(panel.getSnapshot().target.session, 'second')
  panel.toggle()
  commit()
  assert.deepEqual(h.presentations.at(-1), ['close'])
  panel.toggle()
  commit()
  leaveSecond()
  await tick()
  hooks.dispose()
  assert.equal(h.registrations.length, 0)
  assert.deepEqual(h.presentations.at(-1), ['close'])
  panel.bind(target)
  h.ctx.layout.closeRightbar()
  commit()
  assert.deepEqual(h.presentations.at(-1), ['open', true, false], 'expanded state stays in memory across navigation')
  unmount()
  hooks.dispose()
  assert.equal(h.registrations.length, 0)
  assert.deepEqual(h.presentations.at(-1), ['close'])
  panel.bind({ ...target, session: 'after-disposal' })
  assert.equal(h.registrations.length, 0, 'disposed injections no longer register either slot')
})

test('slots declared after a session is bound register both entries and clean up on plugin disposal', async () => {
  const loaded = await loadClient('right-panel.tsx', { call: unavailable })
  const h = host(), panel = loaded.createRightPanel(h.ctx)
  panel.bind(target)
  assert.equal(h.registrations.length, 0)
  const unmount = h.mount()
  assert.deepEqual(h.registrations.map(entry => entry.options.name), ['rightbar', 'shell.overlay'])
  unmount()
  assert.equal(h.registrations.length, 0)
})

test('deferred release and owner cleanup cannot close a native rightbar that has taken over', async () => {
  const hooks = renderer(), h = host()
  const loaded = await loadClient('right-panel.tsx', { react: hooks.react, call: unavailable })
  const panel = loaded.createRightPanel(h.ctx), unmount = h.mount()
  h.ctx.layout.openRightbar(true, false)
  const leave = panel.bind(target)
  panel.toggle()
  hooks.render(() => h.registrations[0].component({ width: 320 }))
  const beforeCleanup = h.presentations.length
  leave()
  hooks.dispose()
  assert.equal(h.presentations.length, beforeCleanup, 'the outgoing Owner never closes another owner during unmount')
  h.ctx.layout.openRightbar(true, false)
  const native = h.presentations.length
  await tick()
  assert.equal(h.registrations.length, 0)
  assert.equal(h.presentations.length, native, 'the queued release leaves the restored native track open')
  unmount()
  assert.equal(h.presentations.length, native)
})

test('read-only targets keep files and browsers without restoring or operating terminals', async () => {
  const requests = []
  const loaded = await loadClient('right-panel.tsx', { globals: { URL }, call: async (op, payload) => {
    requests.push({ op, ...payload })
    return { cwd: target.cwd, available: true, terminals: [{ id: 'shared' }] }
  } })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); await tick()
  panel.openFiles(); panel.newBrowser('3000')
  panel.bind({ ...target, readOnly: true }); await tick()
  assert.equal(panel.getSnapshot().error, '')
  assert.equal(panel.getSnapshot().available, false)
  assert.deepEqual(plain(panel.getSnapshot().tabs.map(tab => tab.kind)), ['files', 'browser'])
  await panel.newTerminal(null)
  await panel.closeTab('shared')
  assert.deepEqual(requests.map(request => request.op), ['list'])
  panel.openHome()
  const tree = loaded.RightPanel({ panel, width: 320 })
  assert.ok(nodes(tree).some(node => node.type === loaded.WorkspaceFiles))
  assert.ok(nodes(tree).some(node => node.props.className === 'nodo-right-card' && JSON.stringify(node).includes('浏览器')))
  assert.doesNotMatch(JSON.stringify(tree), /新建终端|无法加载终端列表|正在重试/)
  panel.bind(target); await tick()
  assert.ok(panel.getSnapshot().tabs.some(tab => tab.kind === 'terminal' && tab.id === 'shared'), 'writable views recover the host terminal')
})

test('the file entry card opens a closable file tab and the final close returns to the entry page', async () => {
  const loaded = await loadClient('right-panel.tsx', { call: unavailable })
  const h = host(), panel = loaded.createRightPanel(h.ctx)
  panel.bind(target)
  panel.toggle()
  const render = () => loaded.RightPanel({ panel, width: 380 })
  let tree = render()
  assert.equal(tree.props.style.width, 380)
  const cards = nodes(tree).filter(node => node.props.className === 'nodo-right-card')
  assert.equal(cards.length, 2)
  const content = tree.children.find(node => node.props.className === 'nodo-right-content')
  assert.ok(nodes(content).includes(cards[0]), 'the entry card sits inside the content card below the header')
  assert.match(JSON.stringify(cards), /项目文件/)
  assert.doesNotMatch(JSON.stringify(tree), /终端|⌘/)
  cards[0].props.onClick()
  tree = render()
  assert.ok(nodes(tree).some(node => node.type === loaded.WorkspaceFiles))
  assert.ok(nodes(tree.children.find(node => node.props.className === 'nodo-right-content')).some(node => node.type === loaded.WorkspaceFiles))
  assert.equal(nodes(tree).some(node => node.props.className === 'nodo-right-card'), false)
  button(tree, '关闭项目文件').props.onClick()
  assert.equal(nodes(render()).filter(node => node.props.className === 'nodo-right-card').length, 2)
  assert.equal(nodes(render()).some(node => node.type === loaded.RightPanelToggle), false)
  assert.equal(nodes(render()).some(node => node.type === 'IconChevronRightOutlineRegular'), false)
  panel.toggle()
  assert.equal(render().props.hidden, true)
})

test('workspace welcomes retain tabs, previews, expansion and host slots on same-cwd conversation handoff', async () => {
  const calls = []
  const loaded = await loadClient('right-panel.tsx', { globals: { URL }, call: async (op, body) => {
    calls.push({ op, ...body })
    assert.equal(body.cwd, undefined)
    return { cwd: '/workspace', available: true, terminals: [{ id: 'shared' }] }
  } })
  const h = host(), panel = loaded.createRightPanel(h.ctx), unmount = h.mount()
  const leave = panel.bind({ workspace: 'project', cwd: '/alias' })
  await tick()
  panel.openFile('/workspace/src/main.ts')
  panel.newBrowser('3000')
  const before = panel.getSnapshot(), registrations = [...h.registrations]
  const files = () => nodes(loaded.RightPanel({ panel, width: 320 })).find(node => node.type === loaded.WorkspaceFiles)
  const key = files().props.key
  leave()
  const leaveSession = panel.bind(target)
  await tick()
  assert.deepEqual(h.registrations, registrations, 'handoff never unregisters either host slot')
  assert.deepEqual(plain(panel.getSnapshot().tabs), plain(before.tabs))
  assert.equal(panel.getSnapshot().expanded, true)
  assert.equal(panel.getSnapshot().active, before.active)
  assert.equal(files().props.key, key, 'the file tree stays mounted')
  assert.equal(files().props.selected, '/workspace/src/main.ts')
  files().props.onSelect('')
  assert.equal(panel.getSnapshot().selected, '', 'back returns to the cached tree')
  leaveSession()
  const leaveWelcome = panel.bind({ workspace: 'project', cwd: '/alias' })
  await tick()
  assert.deepEqual(plain(panel.getSnapshot().tabs), plain(before.tabs), 'the canonical cwd also matches the welcome alias')
  assert.equal(calls[0].workspace, 'project')
  assert.equal(calls[0].profile, undefined)
  assert.equal(calls[1].profile, 'role')
  panel.openFile('relative.ts')
  assert.equal(panel.getSnapshot().active, 'files')
  assert.equal(panel.getSnapshot().selected, 'relative.ts')
  leaveWelcome(); await tick()
  assert.equal(h.registrations.length, 0, 'leaving for a native view releases both slots')
  assert.equal(calls.some(call => call.op === 'close'), false, 'leaving a view never closes host terminals')
  unmount()
})

test('a real-path session retains every tab when a previously unseen workspace alias resolves to the same cwd', async () => {
  const pending = Promise.withResolvers()
  const loaded = await loadClient('right-panel.tsx', { globals: { URL }, call: async (_op, payload) => payload.workspace
    ? pending.promise : { cwd: '/workspace', available: true, terminals: [{ id: 'shared' }] } })
  const h = host(), panel = loaded.createRightPanel(h.ctx), unmount = h.mount()
  const leave = panel.bind(target); await tick()
  panel.openFile('src/main.ts'); panel.newBrowser('3000')
  const before = panel.getSnapshot(), registrations = [...h.registrations]
  panel.bind({ workspace: 'project', cwd: '/unseen-alias' }); leave()
  assert.deepEqual(plain(panel.getSnapshot().tabs), plain(before.tabs), 'normalization never speculatively clears tabs')
  pending.resolve({ cwd: '/workspace', available: true, terminals: [{ id: 'shared' }] }); await tick()
  assert.deepEqual(plain(panel.getSnapshot().tabs), plain(before.tabs))
  assert.equal(panel.getSnapshot().selected, before.selected)
  assert.equal(panel.getSnapshot().active, before.active)
  assert.equal(panel.getSnapshot().expanded, true)
  assert.equal(panel.getSnapshot().target.cwd, '/workspace')
  assert.equal(panel.getSnapshot().target.workspace, 'project')
  assert.deepEqual(h.registrations, registrations)
  unmount()
})

test('a legacy session without a cwd quietly disables terminals', async () => {
  const loaded = await loadClient('right-panel.tsx', { call: async () => ({ available: false, terminals: [] }) })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind({ profile: 'old', session: 'old-session' }); await tick()
  assert.equal(panel.getSnapshot().error, '')
  assert.equal(panel.getSnapshot().available, false)
  assert.deepEqual(plain(panel.getSnapshot().tabs), [])
  assert.doesNotMatch(JSON.stringify(loaded.RightPanel({ panel, width: 320 })), /新建终端|无法加载终端列表/)
})

test('terminal cards create multiple tabs, switch without removing panes, close through the host and return home', async () => {
  const requests = [], terminals = []
  const measure = measurement()
  const loaded = await loadClient('right-panel.tsx', { ...measure, globals: { ...measure.globals, fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    requests.push(body)
    let value
    if (body.op === 'list') value = { available: true, terminals: [...terminals] }
    if (body.op === 'create') { value = { id: `term-${terminals.length}`, shell: 'zsh' }; terminals.push(value) }
    if (body.op === 'close') terminals.splice(terminals.findIndex(item => item.id === body.id), 1)
    return { json: async () => ({ ok: true, value }) }
  } } })
  const h = host(), panel = loaded.createRightPanel(h.ctx)
  panel.bind(target); panel.toggle(); await tick()
  const render = () => loaded.RightPanel({ panel, width: 380 })
  assert.equal(nodes(render()).filter(node => node.props.className === 'nodo-right-card').length, 3)
  nodes(render()).find(node => node.props.className === 'nodo-right-card' && JSON.stringify(node).includes('新建终端')).props.onClick()
  await tick()
  assert.equal(panel.getSnapshot().active, 'term-0')
  assert.deepEqual(plain(requests[1]), { op: 'create', profile: 'role', session: 'first', cols: 91, rows: 29 })
  assert.equal(measure.disposed.length, 1, 'the measuring xterm is disposed before spawning')
  button(render(), '新建标签页').props.onClick()
  assert.equal(panel.getSnapshot().active, '', 'the plus button reveals the entry page without creating a terminal')
  assert.equal(requests.filter(item => item.op === 'create').length, 1)
  assert.deepEqual(nodes(render()).filter(node => node.props.className === 'nodo-right-pane').map(node => node.props.hidden), [true], 'the terminal pane hides behind the entry page')
  nodes(render()).find(node => node.props.className === 'nodo-right-card' && JSON.stringify(node).includes('新建终端')).props.onClick()
  await tick()
  assert.equal(panel.getSnapshot().active, 'term-1')
  const bar = nodes(render()).find(node => node.props.className === 'nodo-right-tabs')
  assert.equal(bar.children.at(-1).props['aria-label'], '新建标签页', 'the plus button follows the last tab')
  assert.equal(bar.children.at(-2).props.className, 'nodo-right-tab')
  const tabs = nodes(render()).filter(node => node.props.role === 'tab')
  tabs[0].props.onClick()
  const panes = nodes(render()).filter(node => node.props.className === 'nodo-right-pane')
  assert.deepEqual(panes.map(node => node.props.hidden), [false, true])
  assert.equal(panes[1].children[0].props.id, 'term-1', 'inactive terminal remains mounted')
  const close = button(render(), '关闭zsh')
  assert.equal(close.type, 'Button')
  assert.equal(close.props.icon.type, 'IconCloseOutlineRegular')
  assert.equal(close.children.length, 0)
  close.props.onClick()
  assert.equal(panel.getSnapshot().tabs.length, 1, 'click removes the tab synchronously')
  await tick()
  assert.equal(panel.getSnapshot().active, 'term-1')
  button(render(), '关闭zsh').props.onClick(); await tick()
  assert.equal(panel.getSnapshot().tabs.length, 0)
  assert.equal(nodes(render()).filter(node => node.props.className === 'nodo-right-card').length, 3)
  assert.deepEqual(requests.filter(item => item.op === 'close').map(item => item.id), ['term-0', 'term-1'])
  assert.ok(requests.filter(item => item.op === 'close').every(item => item.profile === 'role' && item.session === 'first'))
})

test('terminal tabs are named by the shell basename and repeated shells get numbers', async () => {
  const loaded = await loadClient('right-panel.tsx', { globals: { fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    return { json: async () => ({ ok: true, value: body.op === 'list' ? { available: true,
      terminals: [{ id: 'a', shell: 'zsh' }, { id: 'b', shell: 'zsh' }, { id: 'c', shell: 'bash' }, { id: 'd' }] } : null }) }
  } } })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); await tick()
  const tree = loaded.RightPanel({ panel, width: 320 })
  const tabs = nodes(tree).filter(node => node.props.role === 'tab')
  assert.deepEqual(tabs.map(node => node.children.at(-1)), ['zsh', 'zsh 2', 'bash', '终端'])
  assert.deepEqual(nodes(tree).filter(node => node.props.className === 'nodo-right-tab-close').map(node => node.props['aria-label']),
    ['关闭zsh', '关闭zsh 2', '关闭bash', '关闭终端'])
})

test('the entry page over existing tabs opens a files tab or reactivates the existing one', async () => {
  const measure = measurement()
  const requests = []
  const loaded = await loadClient('right-panel.tsx', { ...measure, globals: { ...measure.globals, fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    requests.push(body)
    if (body.op === 'create') return { json: async () => ({ ok: true, value: { id: 'term-0' } }) }
    return { json: async () => ({ ok: true, value: { available: true, terminals: [] } }) }
  } } })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); panel.toggle(); await tick()
  const render = () => loaded.RightPanel({ panel, width: 320 })
  const card = name => nodes(render()).find(node => node.props.className === 'nodo-right-card' && JSON.stringify(node).includes(name))
  card('新建终端').props.onClick(); await tick()
  button(render(), '新建标签页').props.onClick()
  card('项目文件').props.onClick()
  assert.deepEqual(plain(panel.getSnapshot().tabs), [{ kind: 'terminal', id: 'term-0', cols: 91, rows: 29 }, { kind: 'files' }])
  assert.equal(panel.getSnapshot().active, 'files', 'the card opens a files tab and keeps the terminal tab')
  button(render(), '新建标签页').props.onClick()
  card('项目文件').props.onClick()
  assert.deepEqual(plain(panel.getSnapshot().tabs), [{ kind: 'terminal', id: 'term-0', cols: 91, rows: 29 }, { kind: 'files' }])
  assert.equal(panel.getSnapshot().active, 'files', 'an existing files tab is reactivated instead of duplicated')
  assert.equal(requests.filter(item => item.op === 'create').length, 1)
})

test('closing tabs while the entry page shows keeps the entry page', async () => {
  const measure = measurement()
  const loaded = await loadClient('right-panel.tsx', { ...measure, globals: { ...measure.globals, fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.op === 'create') return { json: async () => ({ ok: true, value: { id: 'term-0', shell: 'zsh' } }) }
    if (body.op === 'list') return { json: async () => ({ ok: true, value: { available: true, terminals: [] } }) }
    return { json: async () => ({ ok: true }) }
  } } })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); panel.toggle(); await tick()
  const render = () => loaded.RightPanel({ panel, width: 320 })
  const cards = () => nodes(render()).filter(node => node.props.className === 'nodo-right-card')
  nodes(render()).find(node => node.props.className === 'nodo-right-card' && JSON.stringify(node).includes('新建终端')).props.onClick()
  await tick()
  panel.openFiles()
  button(render(), '新建标签页').props.onClick()
  button(render(), '关闭zsh').props.onClick(); await tick()
  assert.equal(panel.getSnapshot().active, '', 'closing a background tab keeps the entry page')
  assert.deepEqual(plain(panel.getSnapshot().tabs), [{ kind: 'files' }])
  assert.equal(cards().length, 3)
  button(render(), '关闭项目文件').props.onClick(); await tick()
  assert.deepEqual(plain(panel.getSnapshot().tabs), [])
  assert.equal(panel.getSnapshot().active, '')
  assert.equal(cards().length, 3)
})

test('the entry page only hides terminal panes and their xterm instances stay alive', async () => {
  const mounted = mountedTree()
  const instances = [], screen = { clientWidth: 300, clientHeight: 400 }
  class FakeTerminal {
    options = {}; disposed = false
    constructor() { instances.push(this) }
    loadAddon() {} open() {} onData() { return { dispose() {} } } write(_bytes, done) { done() } resize() {}
    dispose() { this.disposed = true }
  }
  class FakeFit { proposeDimensions() { return { cols: 80, rows: 24 } } }
  class Observer { observe() {} disconnect() {} }
  const loaded = await loadClient('right-panel.tsx', { react: mounted.react,
    modules: { '@xterm/xterm': 'export const Terminal = globalThis.FakeTerminal', '@xterm/addon-fit': 'export const FitAddon = globalThis.FakeFit' },
    createElement(type, props, ...children) {
      if (props?.className === 'nodo-right-content') props.ref.current = { clientWidth: 380, clientHeight: 500, appendChild() {} }
      if (props?.className === 'nodo-terminal-screen') props.ref.current = screen
      return { type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== false && child != null) }
    },
    globals: { FakeTerminal, FakeFit, ResizeObserver: Observer, MutationObserver: Observer,
      document: { documentElement: {}, createElement: () => ({ style: {}, remove() {} }) },
      getComputedStyle: () => ({ getPropertyValue: () => '#111111' }),
      requestAnimationFrame: () => 0, cancelAnimationFrame() {}, setTimeout: () => 0, clearTimeout() {},
      AbortController, TextDecoder, URLSearchParams, atob,
      fetch: async (_url, options) => {
        const body = options?.body ? JSON.parse(options.body) : {}
        if (body.op === 'list') return { json: async () => ({ ok: true, value: { available: true, terminals: [] } }) }
        if (body.op === 'create') return { json: async () => ({ ok: true, value: { id: 'term-0' } }) }
        return { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}) }) } }
      },
    },
  })
  const h = host(), panel = loaded.createRightPanel(h.ctx)
  const unmount = h.mount()
  panel.bind(target)
  const render = () => mounted.render(() => ({ type: 'frame', props: {}, children: h.registrations.map(entry => (
    { type: entry.component, props: { key: entry.options.name, width: 320 }, children: [] }
  )) }))
  panel.toggle()
  render(); await tick()
  nodes(render()).find(node => node.props.className === 'nodo-right-card' && JSON.stringify(node).includes('新建终端')).props.onClick()
  await tick()
  render(); await tick()
  assert.equal(panel.getSnapshot().active, 'term-0')
  const view = instances.at(-1)
  assert.equal(view.disposed, false)
  assert.deepEqual(nodes(render()).filter(node => node.props.className === 'nodo-right-pane').map(node => node.props.hidden), [false])
  button(render(), '新建标签页').props.onClick()
  let tree = render()
  assert.ok(nodes(tree).some(node => node.props.className === 'nodo-right-home'), 'the entry page shows over the existing tab')
  assert.deepEqual(nodes(tree).filter(node => node.props.className === 'nodo-right-pane').map(node => node.props.hidden), [true])
  assert.equal(view.disposed, false, 'the xterm instance survives behind the entry page')
  panel.selectTab('term-0')
  tree = render()
  assert.deepEqual(nodes(tree).filter(node => node.props.className === 'nodo-right-pane').map(node => node.props.hidden), [false])
  assert.equal(view.disposed, false, 'returning to the tab keeps the same instance')
  unmount()
  mounted.dispose()
  assert.equal(view.disposed, true, 'unmounting the panel still disposes the view')
})

test('closing a tab immediately removes its pane and ignores stale lists while the close request is pending', async () => {
  const gate = Promise.withResolvers(), list = Promise.withResolvers()
  let lists = 0, closes = 0
  const loaded = await loadClient('right-panel.tsx', { globals: { fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.op === 'close') { closes++; await gate.promise; return { json: async () => ({ ok: true }) } }
    if (++lists > 1) await list.promise
    return { json: async () => ({ ok: true, value: { available: true, terminals: [{ id: 'slow', shell: 'zsh' }] } }) }
  } } })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); panel.toggle(); await tick()
  panel.bind(target)
  const render = () => loaded.RightPanel({ panel, width: 320 })
  const close = button(render(), '关闭zsh')
  close.props.onClick()
  close.props.onClick()
  assert.deepEqual(plain(panel.getSnapshot().tabs), [])
  assert.equal(nodes(render()).some(node => node.props.className === 'nodo-right-pane'), false)
  assert.equal(closes, 1)
  gate.resolve(); await tick()
  list.resolve(); await tick()
  assert.deepEqual(plain(panel.getSnapshot().tabs), [], 'an older list cannot restore a closed terminal')
  assert.equal(nodes(render()).filter(node => node.props.className === 'nodo-right-card').length, 3)
})

test('a late close failure does not restore a tab or show an error in a different session', async () => {
  const gate = Promise.withResolvers()
  const loaded = await loadClient('right-panel.tsx', { globals: { fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.op === 'close') { await gate.promise; return { json: async () => ({ ok: false }) } }
    return { json: async () => ({ ok: true, value: { available: true, terminals: body.session === 'first' ? [{ id: 'old' }] : [] } }) }
  } } })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); await tick()
  const closing = panel.closeTab('old')
  assert.deepEqual(plain(panel.getSnapshot().tabs), [])
  panel.bind({ ...target, session: 'second' }); await tick()
  gate.resolve(); await closing
  assert.deepEqual(plain(panel.getSnapshot().tabs), [])
  assert.equal(panel.getSnapshot().error, '')
})

test('binding and refreshing a panel recover host terminals; stale session lists are ignored', async () => {
  const pending = []
  const loaded = await loadClient('right-panel.tsx', { globals: { fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    return new Promise(resolve => pending.push({ body, resolve: value => resolve({ json: async () => ({ ok: true, value }) }) }))
  } } })
  const h = host(), panel = loaded.createRightPanel(h.ctx)
  const leave = panel.bind(target)
  panel.bind({ ...target, session: 'next' }); leave()
  pending[1].resolve({ available: true, terminals: [{ id: 'next-term', exited: { code: 0 } }] })
  await tick()
  pending[0].resolve({ available: true, terminals: [{ id: 'old-term' }] }); await tick()
  assert.deepEqual(plain(panel.getSnapshot().tabs), [{ kind: 'terminal', id: 'next-term' }])
  const fresh = loaded.createRightPanel(host().ctx)
  fresh.bind({ ...target, session: 'next' })
  pending[2].resolve({ available: true, terminals: [{ id: 'next-term' }] }); await tick()
  assert.deepEqual(plain(fresh.getSnapshot().tabs), [{ kind: 'terminal', id: 'next-term' }])
})

test('unavailable terminal service hides the entry card and failed close retains the managed tab', async () => {
  let available = false
  const loaded = await loadClient('right-panel.tsx', { globals: { fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    return { json: async () => body.op === 'close' ? { ok: false } : { ok: true,
      value: { available, terminals: available ? [{ id: 'kept' }] : [] } } }
  } } })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); await tick()
  let tree = loaded.RightPanel({ panel, width: 320 })
  assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-right-card').length, 2)
  assert.doesNotMatch(JSON.stringify(tree), /新建终端/)
  assert.equal(button(tree, '新建标签页'), undefined, 'no plus button without tabs')
  panel.openFiles()
  tree = loaded.RightPanel({ panel, width: 320 })
  const plus = button(tree, '新建标签页')
  assert.ok(plus, 'the plus button shows with tabs even when terminals are unavailable')
  plus.props.onClick()
  tree = loaded.RightPanel({ panel, width: 320 })
  assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-right-card').length, 2, 'the entry page still lacks a terminal card')
  assert.doesNotMatch(JSON.stringify(tree), /新建终端/)
  await panel.closeTab('files')
  available = true; panel.bind(target); await tick()
  await panel.closeTab('kept')
  assert.equal(panel.getSnapshot().tabs[0].id, 'kept')
  tree = loaded.RightPanel({ panel, width: 320 })
  assert.match(JSON.stringify(tree), /无法关闭终端/)
})

test('missing terminal responses remove tabs for close and streamed views', async () => {
  const loaded = await loadClient('right-panel.tsx', { globals: { fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    return body.op === 'close' ? { status: 404, json: async () => ({ ok: false, error: { code: 'terminal/not-found' } }) }
      : { json: async () => ({ ok: true, value: { available: true, terminals: [{ id: 'gone' }] } }) }
  } } })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); await tick(); await panel.closeTab('gone')
  assert.deepEqual(plain(panel.getSnapshot().tabs), [])
  const restored = loaded.createRightPanel(host().ctx)
  restored.bind(target); await tick()
  const view = nodes(loaded.RightPanel({ panel: restored, width: 320 })).find(node => node.props.id === 'gone')
  view.props.onGone()
  assert.deepEqual(plain(restored.getSnapshot().tabs), [])
})

for (const recover of [false, true]) test(`failed list retains tabs and retries once (${recover ? 'recovered' : 'still unavailable'})`, async () => {
  let calls = 0
  const pending = []
  const loaded = await loadClient('right-panel.tsx', { globals: { fetch: async () => {
    calls++
    if (calls === 1 || recover && calls === 3) return { json: async () => ({ ok: true, value: { available: true, terminals: [{ id: 'kept' }] } }) }
    return new Promise((_resolve, reject) => pending.push(reject))
  } } })
  const panel = loaded.createRightPanel(host().ctx)
  const leave = panel.bind(target); await tick(); leave()
  panel.bind(target)
  assert.equal(panel.getSnapshot().tabs[0].id, 'kept')
  pending.shift()(new Error('fixture list failure')); await tick()
  assert.equal(calls, 3)
  if (!recover) { pending.shift()(new Error('fixture retry failure')); await tick() }
  assert.deepEqual(plain(panel.getSnapshot().tabs), [{ kind: 'terminal', id: 'kept' }])
  assert.equal(panel.getSnapshot().active, 'kept')
  assert.equal(panel.getSnapshot().available, recover)
  assert.equal(panel.getSnapshot().error, recover ? '' : '无法加载终端列表')
})

test('leaving during terminal creation keeps it recoverable from the host and never adds it to another session', async () => {
  let resolveCreate
  const measure = measurement()
  const loaded = await loadClient('right-panel.tsx', { ...measure, globals: { ...measure.globals, fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.op === 'create') return new Promise(resolve => { resolveCreate = () => resolve({ json: async () => ({ ok: true, value: { id: 'late' } }) }) })
    return { json: async () => ({ ok: true, value: { available: true, terminals: body.session === 'first' && resolveCreate ? [{ id: 'late' }] : [] } }) }
  } } })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); await tick()
  const creating = panel.newTerminal(measure.element)
  await tick()
  panel.bind({ ...target, session: 'other' }); await tick()
  resolveCreate(); await creating
  assert.deepEqual(plain(panel.getSnapshot().tabs), [])
  panel.bind(target); await tick()
  assert.deepEqual(plain(panel.getSnapshot().tabs), [{ kind: 'terminal', id: 'late' }])
})

async function terminalView({ get, post, initialSize } = {}) {
  const hooks = renderer(), instances = [], requests = [], observers = [], themes = []
  const screen = { clientWidth: 300, clientHeight: 400 }
  const frames = new Map(), timers = new Map(), delays = []
  let controller, next = 0, size = { cols: 90, rows: 25 }, removed = 0
  class FakeTerminal {
    cols = 90; rows = 25; options = {}; bytes = []; disposed = false
    constructor(options) { this.cols = options.cols ?? 80; this.rows = options.rows ?? 24; instances.push(this) }
    loadAddon(addon) { this.addon = addon }
    open(element) { assert.equal(element, screen) }
    onData(run) { this.input = run; return { dispose: () => { this.inputDisposed = true } } }
    write(bytes, done) { this.bytes.push(...bytes); done() }
    reset() { this.bytes = [] }
    resize(cols, rows) { this.cols = cols; this.rows = rows }
    dispose() { this.disposed = true }
  }
  class FakeFit { fits = 0; proposeDimensions() { this.fits++; return size } }
  class Observer {
    constructor(run) { this.run = run; observers.push(this) }
    observe() {}
    disconnect() { this.disconnected = true }
  }
  const loaded = await loadClient('terminal.tsx', { react: hooks.react,
    modules: { '@xterm/xterm': 'export const Terminal = globalThis.FakeTerminal', '@xterm/addon-fit': 'export const FitAddon = globalThis.FakeFit' },
    createElement(type, props, ...children) {
      if (props?.className === 'nodo-terminal-screen') props.ref.current = screen
      return { type, props: props ?? {}, children: children.flat().filter(Boolean) }
    },
    globals: { FakeTerminal, FakeFit, ResizeObserver: Observer, MutationObserver: Observer,
      document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: name => { themes.push(name); return '#aaaaaa' } }),
      AbortController, TextDecoder, URLSearchParams, atob,
      requestAnimationFrame: run => { frames.set(++next, run); return next }, cancelAnimationFrame: id => frames.delete(id),
      setTimeout: (run, delay) => { delays.push(delay); timers.set(++next, run); return next }, clearTimeout: id => timers.delete(id),
      fetch: async (url, options) => {
        if (options?.method === 'POST') {
          const body = JSON.parse(options.body)
          requests.push(body)
          if (post) return post(body)
          return { json: async () => ({ ok: true, value: null }) }
        }
        requests.push({ url })
        if (get) return get(url)
        return new Response(new ReadableStream({ start(value) {
          controller = value
          options.signal.addEventListener('abort', () => { try { value.close() } catch {} }, { once: true })
        } }))
      },
    },
  })
  const render = (active = true, scope = target) => hooks.render(() => loaded.TerminalView({ id: 'term', target: scope, initialSize, active, onGone: () => removed++ }))
  const flush = async () => { await tick(); const runs = [...frames.values()]; frames.clear(); for (const run of runs) run(); await tick() }
  const retry = async () => { const [id, run] = timers.entries().next().value; timers.delete(id); run(); await tick() }
  return { hooks, instances, requests, observers, themes, screen, frames, timers, delays, render, flush, retry,
    get controller() { return controller }, get removed() { return removed }, setSize: value => { size = value } }
}

test('xterm survives welcome and same-cwd session handoffs and uses the latest target for input and reconnect', async () => {
  const f = await terminalView()
  try {
    f.render(true, { workspace: 'project', cwd: target.cwd }); await f.flush()
    const terminal = f.instances[0]
    assert.match(f.requests.find(request => request.url).url, /workspace=project/)
    terminal.input('welcome'); await tick()
    f.render(true, target)
    terminal.input('first'); await tick()
    f.render(true, { ...target, session: 'second' })
    terminal.input('second'); await tick()
    assert.equal(f.instances.length, 1)
    assert.equal(terminal.disposed, false)
    assert.deepEqual(f.requests.filter(request => request.op === 'write').map(({ data, workspace, profile, session }) =>
      ({ data, workspace, profile, session })), [
      { data: 'welcome', workspace: 'project', profile: undefined, session: undefined },
      { data: 'first', workspace: undefined, profile: 'role', session: 'first' },
      { data: 'second', workspace: undefined, profile: 'role', session: 'second' },
    ])
    f.controller.close(); await tick(); await f.retry()
    assert.match(f.requests.filter(request => request.url).at(-1).url, /session=second/)
    assert.equal(f.instances.length, 1)
  } finally { f.hooks.dispose() }
})

test('xterm fits, writes input, follows theme, survives tab switches and reconnects by byte offset without duplicates', async () => {
  const f = await terminalView(), { hooks, instances, requests, observers, themes, render, flush } = f
  render(true); await flush()
  assert.equal(instances.length, 1)
  const terminal = instances[0]
  assert.deepEqual(requests.find(item => item.op === 'resize'), { op: 'resize', profile: 'role', session: 'first', id: 'term', cols: 90, rows: 25 })
  assert.equal(terminal.options.theme.foreground, '#aaaaaa')
  assert.ok(themes.includes('--dsw-alias-bg-base'))
  terminal.input('one'); terminal.input('two'); await tick()
  assert.deepEqual(requests.filter(item => item.op === 'write').map(item => item.data), ['one', 'two'])
  const output = JSON.stringify({ type: 'output', from: 0, seq: 3, data: Buffer.from('你').toString('base64') }) + '\n'
  f.controller.enqueue(new TextEncoder().encode(output.slice(0, 10)))
  f.controller.enqueue(new TextEncoder().encode(output.slice(10)))
  await tick()
  assert.deepEqual(terminal.bytes, [...Buffer.from('你')])
  render(false); render(true)
  assert.equal(instances.length, 1); assert.equal(terminal.disposed, false)
  observers[0].run(); observers[1].run(); await flush()
  assert.equal(terminal.addon.fits, 2)
  assert.equal(requests.filter(item => item.op === 'resize').length, 1, 'unchanged dimensions do not send another resize')
  f.controller.error(new Error('fixture disconnect')); await tick()
  assert.match(JSON.stringify(render(true)), /正在重连/)
  await f.retry()
  const query = new URL(requests.filter(item => item.url).at(-1).url, 'http://host').searchParams
  assert.equal(query.get('since'), '3'); assert.equal(query.get('profile'), 'role'); assert.equal(query.get('session'), 'first')
  f.controller.enqueue(new TextEncoder().encode(output)); await tick()
  assert.deepEqual(terminal.bytes, [...Buffer.from('你')], 'replayed byte ranges are not written twice')
  f.controller.enqueue(new TextEncoder().encode([
    { type: 'reset', seq: 5 }, { type: 'output', from: 5, seq: 8, data: Buffer.from('new').toString('base64') },
  ].map(frame => JSON.stringify(frame) + '\n').join(''))); await tick()
  assert.deepEqual(terminal.bytes, [...Buffer.from('new')], 'a buffer gap resets the old screen before replay')
  f.controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'exit', seq: 8, code: 7 }) + '\n'))
  f.controller.close(); await tick()
  assert.match(JSON.stringify(render(true)), /已退出 \(7\)/)
  hooks.dispose()
  assert.equal(terminal.disposed, true)
  assert.equal(terminal.inputDisposed, true)
  assert.ok(observers.every(observer => observer.disconnected))
  assert.equal(requests.some(item => item.op === 'close'), false, 'unmount disconnects the view and leaves the host terminal recoverable')
})

test('large terminal pastes preserve Unicode and send ordered chunks below the host limit', async () => {
  const f = await terminalView()
  try {
    f.render(); await f.flush()
    const data = 'A'.repeat(262143) + '😀' + '你'.repeat(400000)
    f.instances[0].input(data); await tick()
    const writes = f.requests.filter(item => item.op === 'write')
    assert.ok(writes.length > 1)
    assert.ok(writes.every(item => Buffer.byteLength(item.data) <= 1024 * 1024 && item.profile === 'role' && item.session === 'first'))
    assert.equal(writes.map(item => item.data).join(''), data)
    assert.ok(writes.every(item => !item.data.includes('\ufffd')))
  } finally { f.hooks.dispose() }
})

test('resize coalesces per animation frame, skips unchanged sizes and retries failures before resizing xterm', async () => {
  let fail = false
  const f = await terminalView({ initialSize: { cols: 90, rows: 25 }, post: async () => ({ json: async () => ({ ok: !fail, value: null }) }) })
  try {
    f.render(); await f.flush()
    assert.equal(f.requests.filter(item => item.op === 'resize').length, 0)
    assert.equal(f.instances[0].cols, 90)
    f.setSize({ cols: 1200, rows: 1100 }); fail = true
    for (let i = 0; i < 10; i++) f.observers[0].run()
    assert.equal(f.frames.size, 1)
    await f.flush()
    assert.equal(f.requests.filter(item => item.op === 'resize').length, 1)
    assert.equal(f.instances[0].cols, 90, 'failed PTY resize keeps the acknowledged screen size')
    assert.match(JSON.stringify(f.render()), /尺寸同步失败/)
    f.setSize({ cols: 1300, rows: 1200 }); f.observers[0].run(); await f.flush()
    assert.equal(f.requests.filter(item => item.op === 'resize').length, 1)
    fail = false; await f.retry(); await f.flush()
    assert.equal(f.instances[0].cols, 1300)
    assert.equal(f.instances[0].rows, 1200)
    assert.equal(f.requests.filter(item => item.op === 'resize').at(-1).cols, 1300)
    for (let i = 0; i < 10; i++) f.observers[0].run()
    await f.flush()
    assert.equal(f.requests.filter(item => item.op === 'resize').length, 2)
  } finally { f.hooks.dispose() }
})

test('missing terminal GET removes its tab immediately without reconnecting', async () => {
  const f = await terminalView({ get: async () => new Response(null, { status: 404 }) })
  try {
    f.render(); await f.flush()
    assert.equal(f.removed, 1)
    assert.equal(f.requests.filter(item => item.url).length, 1)
    assert.equal(f.timers.size, 0)
  } finally { f.hooks.dispose() }
})

test('stream failures use exponential backoff and stop after five reconnect attempts', async () => {
  const f = await terminalView({ get: async () => new Response(null, { status: 503 }) })
  try {
    f.render(); await tick()
    for (let i = 0; i < 5; i++) await f.retry()
    assert.deepEqual(f.delays, [1000, 2000, 4000, 8000, 16000])
    assert.equal(f.requests.filter(item => item.url).length, 6)
    assert.equal(f.timers.size, 0)
    assert.match(JSON.stringify(f.render()), /连接已中断/)
  } finally { f.hooks.dispose() }
})

test('the one overlay toggle keeps its mounted instance throughout opening, closing and track resizing', async () => {
  const mounted = mountedTree()
  const loaded = await loadClient('right-panel.tsx', { react: mounted.react, call: unavailable })
  const h = host(), panel = loaded.createRightPanel(h.ctx)
  const unmount = h.mount()
  let width = 320
  const render = () => mounted.render(() => ({ type: 'frame', props: {}, children: h.registrations.map(entry => (
    { type: entry.component, props: { key: entry.options.name, width }, children: [] }
  )) }))
  assert.equal(button(render(), '展开右侧栏'), undefined)
  const leave = panel.bind(target)
  let tree = render()
  const first = button(tree, '展开右侧栏')
  const overlay = nodes(tree).find(node => node.props.className === 'nodo-right-control')
  const registration = h.registrations.find(entry => entry.options.name === 'shell.overlay')
  assert.ok(first)
  assert.ok(nodes(overlay).includes(first))
  for (const expanded of [true, false, true, false]) {
    first.props.onClick()
    for (width of [0, 180, 320, 400]) {
      tree = render()
      const toggle = button(tree, expanded ? '收起右侧栏' : '展开右侧栏')
      assert.equal(toggle, first, 'the mounted button instance is preserved')
      assert.equal(nodes(tree).find(node => node.props.className === 'nodo-right-control'), overlay, 'the button stays in its original parent')
      assert.equal(h.registrations.find(entry => entry.options.name === 'shell.overlay'), registration)
      assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-right-toggle').length, 1)
      assert.equal(toggle.props['aria-expanded'], expanded)
      assert.equal(toggle.props.icon.type, 'IconPanelLeftOutlineRegular')
      assert.equal(toggle.props.icon.props.className, 'nodo-right-glyph')
      const head = nodes(tree).find(node => node.props.className === 'nodo-right-head')
      assert.equal(nodes(head).some(node => node.props.className === 'nodo-right-toggle'), false)
    }
  }
  assert.deepEqual(mounted.counts, { mounts: 1, unmounts: 0 })
  leave()
  await tick()
  tree = render()
  assert.equal(nodes(tree).some(node => node.props.className === 'nodo-right-toggle'), false)
  assert.deepEqual(mounted.counts, { mounts: 1, unmounts: 1 })
  unmount()
  mounted.dispose()
})

test('the panel anchors to the right edge independently of the animated track width', async () => {
  const { CSS } = await loadClient('styles.js')
  const rule = selector => CSS.split('\n').find(line => line.startsWith(`${selector}{`))?.slice(selector.length + 1, -1) ?? ''
  const panel = rule('.nodo-right-panel')
  for (const declaration of ['position:absolute', 'top:0', 'bottom:0', 'right:0', 'box-sizing:border-box', 'overflow:hidden']) {
    assert.ok(panel.split(';').includes(declaration), declaration)
  }
  assert.doesNotMatch(panel, /(?:^|;)(?:max-width|left):/, 'the panel must keep its own width even while the track is zero')
  assert.match(rule('.nodo-right-control'), /position:absolute;top:calc\(var\(--dsh-frame-chrome-top,0px\) \+ 10px\);right:12px/)
  assert.match(rule('.nodo-right-control'), /height:30px;pointer-events:auto;-webkit-app-region:no-drag/)
  assert.match(rule('.nodo-right-toggle'), /width:30px;height:30px/)
  assert.match(rule('.nodo-head'), /padding:10px 50px 0 20px/)
  assert.match(rule('.nodo-right-head'), /padding:10px 50px 0 8px/)
  assert.match(rule('.nodo-head'), /min-height:var\(--dsh-frame-top-clearance,0px\)/)
  assert.match(rule('.nodo-right-head'), /min-height:var\(--dsh-frame-top-clearance,0px\)/)
  assert.match(rule('.nodo-right-head button'), /-webkit-app-region:no-drag/)
  assert.match(rule('.nodo-right-tab-close'), /flex:none;width:20px;height:20px/)
  assert.match(rule('.nodo-right-tabs>button'), /flex:none;width:28px;height:28px/)
  for (const declaration of ['flex:none', 'height:28px', 'border-radius:var(--dsw-radius-sm)']) {
    assert.ok(rule('.nodo-right-tab').split(';').includes(declaration), declaration)
  }
  assert.match(rule('.nodo-right-tab:hover,.nodo-right-tab[data-active]'), /background:var\(--dsw-alias-interactive-bg-hover\)/)
  assert.doesNotMatch(rule('.nodo-right-tab[data-active]'), /box-shadow/, 'the active tab is a filled chip without an underline')
  assert.doesNotMatch(CSS, /padding-right:calc\(12px - var\(--nodo-frame-gap/)
  assert.doesNotMatch(rule('.nodo-right-tabs'), /justify-content:flex-end/, 'tabs align to the start of the row')
  assert.match(rule('.nodo-right-tabs'), /overflow-x:auto/)
  for (const selector of ['.nodo-right-directory', '.nodo-right-preview-body']) {
    assert.match(rule(selector), /overflow:auto/, 'content scrolls below the header instead of narrowing it')
  }
})

test('the macOS content card shares the conversation frame geometry and concentric inner radii', async () => {
  const { CSS } = await loadClient('styles.js')
  const mac = 'html[data-platform=darwin][data-nodo-space] '
  const rule = selector => CSS.split('\n').find(line => line.startsWith(`${selector}{`))?.slice(selector.length + 1, -1) ?? ''
  const frame = rule(`${mac}:has(> [data-rightbar-col])`)
  assert.match(frame, /--nodo-frame-gap:8px/)
  assert.match(frame, /--nodo-card-radius:var\(--dsw-radius-lg\)/)
  assert.match(frame, /--nodo-card-edge:\.5px solid var\(--dsw-alias-border-l3\)/)
  assert.match(rule(`${mac}.nodo-right-panel`), /border:0;background:transparent/)
  assert.match(rule(`${mac}:has(+ [data-rightbar-col])`), /margin:0 var\(--nodo-frame-gap\) 8px 0/)
  const content = rule(`${mac}.nodo-right-content`)
  assert.match(content, /margin:0 var\(--nodo-frame-gap\) var\(--nodo-frame-gap\) 0/)
  assert.match(content, /border:var\(--nodo-card-edge\);border-radius:var\(--nodo-card-radius\);background:var\(--dsw-alias-bg-base\)/)
  assert.match(rule(`${mac}:is(.nodo-right-files,.nodo-right-directory,.nodo-right-preview)`), /calc\(var\(--nodo-card-radius\) - \.5px\)/)
  assert.match(rule(`${mac}:is(.nodo-right-card,.nodo-right-image)`), /calc\(var\(--nodo-card-radius\) - 12px - \.5px\)/)
  assert.match(rule(`${mac}.nodo-right-file`), /calc\(var\(--nodo-card-radius\) - 8px - \.5px\)/)
  assert.match(rule('.nodo-right-home'), /padding:12px 12px 40px/)
  assert.match(rule('.nodo-right-directory'), /padding:8px/)
  assert.match(rule('.nodo-right-preview-body'), /padding:12px/)
  assert.doesNotMatch(rule('.nodo-right-content'), /(?:margin|border|background):/, 'other platforms keep the existing flat conversation surface')
})

test('the entry page centers its cards optically and keeps every card the same height', async () => {
  const { CSS } = await loadClient('styles.js')
  const rule = selector => CSS.split('\n').find(line => line.startsWith(`${selector}{`))?.slice(selector.length + 1, -1) ?? ''
  const home = rule('.nodo-right-home')
  assert.match(home, /display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto/, 'the card stack scrolls instead of being clipped when the content area is short')
  assert.match(home, /padding:12px 12px 40px/, 'the bottom whitespace exceeds the top so the stack sits slightly above center')
  assert.match(rule('.nodo-right-home>.nodo-right-card:first-child'), /margin-top:auto/)
  assert.match(rule('.nodo-right-home>.nodo-right-card:last-child'), /margin-bottom:auto/, 'auto margins center the stack and collapse to 0 on overflow, keeping the first card reachable')
  assert.match(rule('.nodo-right-home>.nodo-right-card+.nodo-right-card'), /margin-top:8px/)
  const card = rule('.nodo-right-card')
  assert.match(card, /flex:none/, 'cards keep their natural height instead of being squeezed by the flex column')
  assert.match(card, /min-height:75px/, 'a title-only card matches the 20px title + 2px gap + 20px subtitle + 32px padding + 1px borders height')
})

test('the macOS rightbar track stays transparent while its hidden panel leaves the host track closing', async () => {
  const { CSS } = await loadClient('styles.js')
  const mac = 'html[data-platform=darwin][data-nodo-space] '
  const rule = selector => CSS.split('\n').find(line => line.startsWith(`${selector}{`))?.slice(selector.length + 1, -1) ?? ''
  assert.equal(rule(`${mac}[data-rightbar-col]:has(.nodo-right-panel)`), 'background:transparent', 'the override remains active with the hidden panel during the track animation')
  assert.equal(rule(`${mac}.nodo-right-panel`), 'border:0;background:transparent')
  assert.match(rule(`${mac}.nodo-right-content`), /background:var\(--dsw-alias-bg-base\)/, 'only the rounded content card supplies a white surface')
})

test('the macOS rightbar stays separated from the conversation with rounded cards and the frame gap', async () => {
  const { CSS } = await loadClient('styles.js')
  const mac = 'html[data-platform=darwin][data-nodo-space] '
  const rule = selector => CSS.split('\n').find(line => line.startsWith(`${selector}{`))?.slice(selector.length + 1, -1) ?? ''
  assert.doesNotMatch(CSS, /:has\(\+ \[data-rightbar-col\] \.nodo-right-panel:not\(\[hidden\]\)\)/, 'opening the rightbar does not remove the gap or flatten either card')
  assert.match(rule(`${mac}.nodo-right-content`), /margin:0 var\(--nodo-frame-gap\) var\(--nodo-frame-gap\) 0;border:var\(--nodo-card-edge\);border-radius:var\(--nodo-card-radius\)/)
  const column = `${mac}:has(+ [data-rightbar-col])`
  assert.match(rule(column), /margin:0 var\(--nodo-frame-gap\) 8px 0/, 'the conversation keeps an 8px gap in both rightbar states')
  assert.match(rule(`${column}::before,${column}::after`), /border-radius:0 var\(--nodo-card-radius\) var\(--nodo-card-radius\) 0/)
  assert.equal(rule(`${column}::after`), 'z-index:1;border:var(--nodo-card-edge);border-left:0', 'the conversation keeps its foreground right border')
  const collapsed = `${mac}[data-sidebar-collapsed]>:has(+ [data-rightbar-col])`
  assert.equal(rule(`${collapsed}::before,${collapsed}::after`), 'border-radius:var(--nodo-card-radius)', 'collapsing the left sidebar preserves the outer left corners on both layers')
  assert.equal(rule(`${collapsed}::after`), 'border-left:var(--nodo-card-edge)')
  assert.equal(rule(`${mac}:is(.nodo-right-files,.nodo-right-directory,.nodo-right-preview)`), 'border-radius:max(0px,calc(var(--nodo-card-radius) - .5px))', 'inner areas follow all four rounded corners')
})

test('directory tree lazily loads each expanded level, caches expansion, marks truncation and returns from preview', async () => {
  const requests = [], hooks = renderer()
  const loaded = await loadClient('right-panel.tsx', { react: hooks.react, call: async (endpoint, payload) => {
    requests.push({ endpoint, ...payload })
    return payload.path === '' ? { entries: [{ name: 'src', kind: 'dir' }, { name: 'note.txt', kind: 'file' }], truncated: true }
      : { entries: [{ name: 'index.ts', kind: 'file' }] }
  } })
  const render = () => hooks.render(() => loaded.WorkspaceFiles({ target }))
  render(); await tick()
  let tree = render()
  assert.deepEqual(requests.map(item => item.path), [''])
  assert.match(JSON.stringify(tree), /目录已截断/)
  const dir = () => nodes(render()).find(node => node.props.title === 'src')
  dir().props.onClick(); render(); await tick()
  tree = render()
  assert.deepEqual(requests.map(item => item.path), ['', 'src'])
  assert.equal(dir().props['aria-expanded'], true)
  assert.ok(nodes(tree).some(node => node.props.title === 'src/index.ts'))
  dir().props.onClick(); render()
  assert.equal(dir().props['aria-expanded'], false)
  dir().props.onClick(); render(); await tick()
  assert.equal(requests.length, 2, 'reopening uses the cached level')
  nodes(render()).find(node => node.props.title === 'src/index.ts').props.onClick()
  tree = render()
  const preview = nodes(tree).find(node => node.type === loaded.FilePreview)
  assert.equal(preview.props.path, 'src/index.ts')
  preview.props.onBack()
  assert.equal(dir().props['aria-expanded'], true)
  assert.equal(nodes(render()).some(node => node.type === loaded.FilePreview), false)
  hooks.dispose()
})

test('switching sessions remounts the file tree for the new workspace and retains the open tab', async () => {
  const requests = [], loaded = await loadClient('right-panel.tsx', { call: async (endpoint, payload) => {
    if (endpoint === 'list') return { available: false, terminals: [] }
    requests.push(payload)
    return { entries: [{ name: `${payload.session}.txt`, kind: 'file' }] }
  } })
  const h = host(), panel = loaded.createRightPanel(h.ctx)
  panel.bind(target); panel.openFiles(); panel.toggle()
  const files = () => nodes(loaded.RightPanel({ panel, width: 320 })).find(node => node.type === loaded.WorkspaceFiles)
  const first = files()
  panel.bind({ profile: 'other', session: 'next', cwd: '/worktree' })
  await tick()
  const next = files()
  assert.notEqual(first.props.key, next.props.key)
  assert.deepEqual(plain(next.props.target), { profile: 'other', session: 'next', cwd: '/worktree' })
  const hooks = renderer()
  const nextLoaded = await loadClient('right-panel.tsx', { react: hooks.react, call: async (_endpoint, payload) => {
    requests.push(payload); return { entries: [{ name: 'next.txt', kind: 'file' }] }
  } })
  const render = () => hooks.render(() => nextLoaded.WorkspaceFiles(next.props))
  render(); await tick()
  assert.equal(requests[0].session, 'next')
  assert.equal(requests[0].profile, 'other')
  assert.match(JSON.stringify(render()), /next.txt/)
  assert.doesNotMatch(JSON.stringify(render()), /first.txt/)
  panel.bind({ ...next.props.target, cwd: '/moved' })
  await tick()
  assert.notEqual(files().props.key, next.props.key, 'a changed cwd also clears the tree')
  hooks.dispose()
})

async function preview(path, value, failure = false) {
  const hooks = renderer(), requests = []
  const loaded = await loadClient('right-panel.tsx', { react: hooks.react, call: async (endpoint, payload) => {
    requests.push({ endpoint, ...payload })
    if (failure) throw new Error('Fixture failure')
    return value
  } })
  const render = () => hooks.render(() => loaded.FilePreview({ target, path, onBack() {} }))
  assert.match(JSON.stringify(render()), /加载中/)
  await tick()
  assert.deepEqual(requests.map(item => [item.endpoint, item.profile, item.session, item.path]), [['workspace-file', 'role', 'first', path]])
  return { render, dispose: hooks.dispose }
}

test('text and code previews use CodeBlock with inferred language', async () => {
  for (const [path, lang] of [['src/app.ts', 'typescript'], ['notes.txt', 'text']]) {
    const p = await preview(path, { text: 'const value = 1' })
    const code = nodes(p.render()).find(node => node.type === 'CodeBlock')
    assert.equal(code.props.lang, lang)
    assert.equal(code.props.code, 'const value = 1')
    p.dispose()
  }
})

test('Markdown defaults to rendering and can switch to source and back', async () => {
  const p = await preview('README.md', { text: '# Heading' })
  let tree = p.render()
  assert.equal(nodes(tree).find(node => node.type === 'MarkdownText').props.text, '# Heading')
  nodes(tree).find(node => node.children.includes('源码')).props.onClick()
  tree = p.render()
  assert.equal(nodes(tree).find(node => node.type === 'CodeBlock').props.lang, 'markdown')
  assert.equal(nodes(tree).some(node => node.type === 'MarkdownText'), false)
  nodes(tree).find(node => node.children.includes('预览')).props.onClick()
  assert.ok(nodes(p.render()).some(node => node.type === 'MarkdownText'))
  p.dispose()
})

test('image preview opens and closes the host ImageLightbox', async () => {
  const dataUrl = 'data:image/png;base64,AA=='
  const p = await preview('image.png', { image: { mediaType: 'image/png', dataUrl } })
  assert.equal(nodes(p.render()).find(node => node.type === 'img').props.src, dataUrl)
  button(p.render(), '放大图片').props.onClick()
  const lightbox = nodes(p.render()).find(node => node.type === 'ImageLightbox')
  assert.equal(lightbox.props.src, dataUrl)
  lightbox.props.onClose()
  assert.equal(nodes(p.render()).some(node => node.type === 'ImageLightbox'), false)
  p.dispose()
})

test('truncated text and Markdown retain their available body and show a short state', async () => {
  for (const [path, component] of [['file.txt', 'CodeBlock'], ['README.md', 'MarkdownText']]) {
    const p = await preview(path, { truncated: true, text: 'partial body' })
    const tree = p.render()
    assert.equal(nodes(tree).find(node => node.props.role === 'status').children[0], '文件已截断')
    const body = nodes(tree).find(node => node.type === component)
    assert.equal(body.props[component === 'CodeBlock' ? 'code' : 'text'], 'partial body')
    p.dispose()
  }
})

test('invalid image content shows a short state instead of a broken image', async () => {
  const p = await preview('x.png', { image: { mediaType: 'image/png', dataUrl: 'data:image/png;base64,bm90LWFuLWltYWdl' } })
  button(p.render(), '放大图片').props.onClick()
  nodes(p.render()).find(node => node.type === 'img').props.onError()
  const tree = p.render()
  assert.equal(nodes(tree).find(node => node.props.role === 'status').children[0], '无法显示')
  assert.equal(nodes(tree).some(node => node.type === 'img' || node.type === 'ImageLightbox'), false)
  assert.equal(button(tree, '放大图片'), undefined)
  p.dispose()
})

test('binary, missing and unavailable files show only a short state', async () => {
  for (const [value, text, failure] of [
    [{ binary: true }, '二进制文件'],
    [{ missing: true }, '文件不存在'], [null, '文件不可用', true],
  ]) {
    const p = await preview('file.txt', value, failure)
    const tree = p.render()
    assert.equal(nodes(tree).find(node => node.props.role === 'status').children[0], text)
    assert.equal(nodes(tree).some(node => ['CodeBlock', 'MarkdownText', 'img'].includes(node.type)), false)
    p.dispose()
  }
})

test('unmounted file previews ignore late answers', async () => {
  const hooks = renderer()
  let answer
  const loaded = await loadClient('right-panel.tsx', { react: hooks.react, call: () => new Promise(resolve => { answer = resolve }) })
  const render = () => hooks.render(() => loaded.FilePreview({ target, path: 'old.txt', onBack() {} }))
  render(); hooks.dispose()
  answer({ text: 'stale answer' }); await tick()
  assert.doesNotMatch(JSON.stringify(render()), /stale answer/)
})

test('the page binds the displayed main session and releases the rightbar for native session views', async () => {
  const hooks = renderer(), bindings = []
  const ownerHooks = renderer(), h = host()
  const { createRightPanel } = await loadClient('right-panel.tsx', { react: ownerHooks.react, call: unavailable })
  const panel = createRightPanel(h.ctx)
  const unmount = h.mount()
  const session = { id: 'lead-session', name: 'Round', workspaceRef: 'branch', cwd: '/worktree' }
  const view = { profiles: [
    { id: 'lead', engine: 'codex', lead: true, sessions: [session] },
    { id: 'worker', engine: 'codex', sessions: [{ id: 'worker-session', source: { kind: 'lead', leadSessionId: session.id } }] },
  ], workspaces: [{ id: 'branch', cwd: '/base' }], work: {}, stats: {}, prefs: { onboardedAt: 1 } }
  const space = { active: true, legacy: true }
  const loaded = await loadClient('page.js', {
    react: hooks.react,
    uiShared: {
      useStateView: () => ({ view, refresh: async () => {} }),
      nativeSpace: { subscribe() {}, getSnapshot: () => space, showLegacy() {} },
      completionTracker: { subscribe() {}, getSnapshot: () => ({}) },
      subscribeNativeSession() {}, readNativeSession: () => null,
      rightPanelService: { bind(value) {
        bindings.push(value)
        const unbind = panel.bind(value)
        return () => { bindings.push(null); unbind() }
      } },
    },
    globals: {
      document: { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} },
      window: { addEventListener() {}, removeEventListener() {} },
      localStorage: { getItem: key => key === 'nodo.navigation' ? JSON.stringify({ profile: 'lead', workspace: 'branch' }) : null, setItem() {} },
    },
  })
  hooks.render(() => loaded.NodoPage({ sidebarOnly: true }))
  assert.deepEqual(bindings, [])
  const page = hooks.render(() => loaded.NodoPage({ contentOnly: true }))
  assert.equal(nodes(page).some(node => node.type?.name === 'RightPanelToggle' || node.props.className === 'nodo-right-toggle'), false, 'the main title row no longer contributes a toggle')
  assert.deepEqual(plain(bindings.at(-1)), { profile: 'lead', session: 'lead-session', cwd: '/worktree' })
  panel.toggle()
  ownerHooks.render(() => h.registrations[0].component({ width: 320 }))
  assert.deepEqual(h.presentations.at(-1), ['open', true, false])
  assert.equal(h.registrations.length, 2)
  const callsBefore = h.presentations.length
  space.legacy = false
  hooks.render(() => loaded.NodoPage({ contentOnly: true }))
  await tick()
  assert.equal(panel.getSnapshot().target, null)
  assert.equal(h.registrations.length, 0, 'the native conversation view restores the host rightbar occupant')
  assert.deepEqual(h.presentations.slice(callsBefore), [['close']])
  assert.equal(bindings.at(-1), null)
  ownerHooks.dispose()
  space.legacy = true
  hooks.render(() => loaded.NodoPage({ contentOnly: true }))
  session.cwd = undefined
  hooks.render(() => loaded.NodoPage({ contentOnly: true }))
  assert.deepEqual(plain(bindings.at(-1)), { profile: 'lead', session: 'lead-session', cwd: '/base' })
  space.active = false
  hooks.render(() => loaded.NodoPage({ contentOnly: true }))
  assert.equal(bindings.at(-1), null)
  space.active = true
  hooks.render(() => loaded.NodoPage({ contentOnly: true }))
  session.archivedAt = 1
  hooks.render(() => loaded.NodoPage({ contentOnly: true }))
  assert.deepEqual(plain(bindings.at(-1)), { workspace: 'branch', cwd: '/base' }, 'the legacy shell without a session binds its project')
  loaded.setNavigation({ profile: 'lead', workspace: 'branch', archivedSession: session.id })
  hooks.render(() => loaded.NodoPage({ contentOnly: true }))
  assert.deepEqual(plain(bindings.at(-1)), { profile: 'lead', session: session.id, cwd: '/base', readOnly: true })
  view.profiles[0].deletedAt = 1
  hooks.render(() => loaded.NodoPage({ contentOnly: true }))
  assert.equal(panel.getSnapshot().target.readOnly, true, 'deleted-role history keeps the file and browser panel')
  hooks.dispose()
  unmount()
})

function browserHost(acquire) {
  const acquired = [], released = [], unsubscribed = [], guests = [], attached = [], opens = new Map()
  const browser = {
    async acquire(workspace) {
      acquired.push(workspace)
      return acquire ? acquire(workspace) : { lease: `lease-${acquired.length}`, partition: 'mock-partition' }
    },
    async release(lease) { released.push(lease) },
    onOpenRequested(lease, listener) {
      opens.set(lease, listener)
      return () => { unsubscribed.push(lease); opens.delete(lease) }
    },
  }
  return {
    acquired, released, unsubscribed, guests, attached, opens,
    globals: { URL, dshDesktop: { browser }, document: { createElement(type) {
      assert.equal(type, 'webview')
      const events = new Map()
      const guest = {
        attributes: {}, loads: [], actions: [], url: 'about:blank', title: '', back: false, forward: false, removed: false,
        setAttribute(name, value) { this.attributes[name] = value },
        addEventListener(name, listener) { events.set(name, listener) },
        emit(name, event = {}) { events.get(name)?.(event) },
        async loadURL(url) { this.loads.push(url); this.url = url; this.emit('did-navigate') },
        getURL() { return this.url }, getTitle() { return this.title },
        canGoBack() { return this.back }, canGoForward() { return this.forward },
        goBack() { this.actions.push('back') }, goForward() { this.actions.push('forward') }, reload() { this.actions.push('reload') },
        clearHistory() { this.actions.push('clear'); this.back = this.forward = false },
        remove() { this.removed = true },
      }
      guests.push(guest)
      return guest
    } } },
    createElement(type, props, ...children) {
      if (props?.className === 'nodo-browser-viewport') props.ref.current = { appendChild(guest) { attached.push({ ...guest.attributes }) } }
      return { type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== false && child != null) }
    },
  }
}

const enterAddress = (render, value) => {
  button(render(), '网页地址').props.onChange({ currentTarget: { value } })
  nodes(render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
}

test('the browser card opens multiple closable tabs with short, numbered page titles in memory', async () => {
  const loaded = await loadClient('right-panel.tsx', { call: unavailable, globals: { URL } })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); await tick()
  const render = () => loaded.RightPanel({ panel, width: 320 })
  const card = () => nodes(render()).find(node => node.props.className === 'nodo-right-card' && JSON.stringify(node).includes('浏览器'))
  assert.deepEqual(card().children.map(node => node.type), ['IconGlobeOutlineRegular', 'span'])
  assert.equal(nodes(card()).filter(node => node.type === 'small').length, 0, 'the card carries no explanatory subtitle')
  assert.doesNotMatch(JSON.stringify(card()), /⌘|快捷键/)
  card().props.onClick()
  assert.equal(panel.getSnapshot().active, 'browser-1')
  assert.equal(nodes(render()).find(node => node.props.role === 'tab').children[0].type, 'IconGlobeOutlineRegular')
  button(render(), '新建标签页').props.onClick()
  card().props.onClick()
  const titles = () => nodes(render()).filter(node => node.props.role === 'tab').map(node => node.children.at(-1))
  assert.deepEqual(titles(), ['浏览器', '浏览器 2'])
  const panes = nodes(render()).filter(node => node.props.className === 'nodo-right-pane')
  assert.deepEqual(panes.map(node => node.props.hidden), [true, false])
  panes[0].children[0].props.onChange('https://example.test/', 'A'.repeat(40))
  panes[1].children[0].props.onChange('https://example.test/', 'A'.repeat(40))
  assert.deepEqual(titles(), [`${'A'.repeat(27)}…`, `${'A'.repeat(27)}… 2`])
  await panel.closeTab('browser-1')
  assert.deepEqual(titles(), [`${'A'.repeat(27)}…`], 'numbering is recalculated after closing')
  await panel.closeTab('browser-2')
  assert.equal(panel.getSnapshot().active, '')
  assert.ok(card())
  assert.deepEqual(plain(loaded.createRightPanel(host().ctx).getSnapshot().tabs), [], 'a fresh page has no persisted browsers')
})

test('late terminal restoration preserves browsers across same-cwd sessions and clears them on cwd changes', async () => {
  const list = Promise.withResolvers()
  const loaded = await loadClient('right-panel.tsx', { call: () => list.promise, globals: { URL } })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target)
  panel.newBrowser('localhost:3000')
  list.resolve({ available: false, terminals: [] }); await tick()
  assert.equal(panel.getSnapshot().tabs[0].url, 'http://localhost:3000/')
  assert.equal(panel.getSnapshot().active, 'browser-1')
  panel.bind({ ...target, session: 'second' }); await tick()
  assert.equal(panel.getSnapshot().tabs[0].url, 'http://localhost:3000/')
  panel.bind({ ...target, session: 'third', cwd: '/worktree' }); await tick()
  assert.deepEqual(plain(panel.getSnapshot().tabs), [])
})

test('browser addresses complete local ports and HTTPS hosts, and reject other protocols and malformed inputs', async () => {
  const { normalizeBrowserAddress } = await loadClient('browser.tsx', { globals: { URL } })
  for (const [input, expected] of [
    ['3000', 'http://localhost:3000/'], [':3000', 'http://localhost:3000/'],
    ['localhost', 'http://localhost/'], ['localhost:3000/path?q=1#top', 'http://localhost:3000/path?q=1#top'],
    ['127.0.0.1', 'http://127.0.0.1/'], ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['127.1:3000', 'http://127.0.0.1:3000/'], ['[::1]:3000', 'http://[::1]:3000/'], ['[::1]', 'http://[::1]/'],
    ['example.test/path', 'https://example.test/path'], ['example.test:8443', 'https://example.test:8443/'],
    [' https://example.test ', 'https://example.test/'], ['http://example.test', 'http://example.test/'],
    [`https://a.test/${'a'.repeat(16369)}`, `https://a.test/${'a'.repeat(16369)}`],
  ]) assert.equal(normalizeBrowserAddress(input), expected, input)
  for (const input of ['', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///tmp/a', 'data:text/html,test',
    'ftp://example.test', 'about:blank', 'dsh://session', 'https://', ':99999', 'localhost:bad', 'example.test/a\nb',
    'https://user:password@example.test', 'http:\\example.test', '0', ':0', 'localhost:0',
    `https://a.test/${'a'.repeat(16384)}`]) assert.equal(normalizeBrowserAddress(input), null, input)
})

test('without the desktop bridge, browsers use iframe navigation, refresh and external open with disabled history', async () => {
  const hooks = renderer(), changes = [], opened = []
  const loaded = await loadClient('browser.tsx', { react: hooks.react, globals: { URL, open: (...args) => opened.push(args) } })
  const render = () => hooks.render(() => loaded.BrowserView({ cwd: target.cwd, initialUrl: '', onChange: (...args) => changes.push(args), onOpen() {} }))
  const frame = () => nodes(render()).find(node => node.type === 'iframe')
  const external = () => nodes(render()).find(node => node.children.includes('在外部打开'))
  assert.equal(frame().props.sandbox, 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox')
  assert.equal(frame().props.referrerPolicy, 'no-referrer')
  assert.equal(frame().props.src, 'about:blank')
  assert.equal(external().props.disabled, true)
  enterAddress(render, ':3000')
  assert.equal(frame().props.src, 'http://localhost:3000/')
  assert.deepEqual(changes.at(-1), ['http://localhost:3000/', 'localhost'])
  assert.equal(button(render(), '后退').props.disabled, true)
  assert.equal(button(render(), '前进').props.disabled, true)
  assert.equal(external().props.disabled, false)
  external().props.onClick()
  assert.deepEqual(opened, [['http://localhost:3000/', '_blank', 'noopener,noreferrer']])
  const previous = frame().props.key
  button(render(), '刷新网页').props.onClick()
  assert.notEqual(frame().props.key, previous)
  for (const input of ['javascript:alert(1)', 'file:///tmp/a']) {
    enterAddress(render, input)
    assert.equal(frame().props.src, 'http://localhost:3000/')
    assert.match(JSON.stringify(render()), /仅支持 HTTP 或 HTTPS 地址/)
  }
  assert.equal(changes.length, 1, 'rejected protocols never navigate')
  hooks.dispose()
})

test('desktop browsers configure leased webviews before attachment, keep them while hidden, and release on close and unmount', async () => {
  const mounted = mountedTree(), desktop = browserHost()
  const loaded = await loadClient('right-panel.tsx', { ...desktop, react: mounted.react, call: unavailable })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind({ ...target, cwd: '/workspace/worktree' }); panel.toggle(); await tick()
  const render = () => mounted.render(() => ({ type: loaded.RightPanel, props: { panel, width: 380 }, children: [] }))
  nodes(render()).find(node => node.props.className === 'nodo-right-card' && JSON.stringify(node).includes('浏览器')).props.onClick()
  render(); await tick()
  assert.deepEqual(desktop.acquired, ['cwd:/workspace/worktree'])
  assert.deepEqual(desktop.attached, [{ name: 'lease-1', partition: 'mock-partition', allowpopups: '', src: 'about:blank#lease-1', 'aria-label': '浏览器页面' }])
  assert.equal(nodes(render()).some(node => node.type === 'iframe' || node.children.includes('在外部打开')), false)
  button(render(), '新建标签页').props.onClick(); render()
  assert.deepEqual(desktop.released, [])
  panel.selectTab('browser-1'); panel.toggle(); render(); panel.toggle(); render()
  assert.equal(desktop.guests.length, 1, 'tab and panel hiding retain the same webview')
  const popup = desktop.opens.get('lease-1')
  popup('javascript:alert(1)')
  assert.equal(panel.getSnapshot().tabs.length, 1)
  popup('https://example.test/popup')
  render(); await tick()
  assert.equal(panel.getSnapshot().active, 'browser-2', 'native popup behavior opens a new tab')
  assert.equal(panel.getSnapshot().tabs[1].url, 'https://example.test/popup')
  assert.deepEqual(desktop.acquired, ['cwd:/workspace/worktree', 'cwd:/workspace/worktree'])
  await panel.closeTab('browser-1'); render(); await tick()
  assert.deepEqual(desktop.released, ['lease-1'])
  assert.deepEqual(desktop.unsubscribed, ['lease-1'])
  assert.equal(desktop.guests[0].removed, true)
  popup('https://example.test/stale')
  assert.equal(panel.getSnapshot().tabs.length, 1, 'late popup events cannot reopen a closed tab')
  mounted.dispose(); await tick()
  assert.deepEqual(desktop.released, ['lease-1', 'lease-2'])
  assert.deepEqual(desktop.unsubscribed, ['lease-1', 'lease-2'])
})

test('desktop navigation waits for readiness, observes titles and history, and keeps one lease across address changes', async () => {
  const hooks = renderer(), gate = Promise.withResolvers(), changes = []
  const desktop = browserHost(() => gate.promise)
  const loaded = await loadClient('browser.tsx', { ...desktop, react: hooks.react })
  let initialUrl = ''
  const render = () => hooks.render(() => loaded.BrowserView({ cwd: '/workspace', initialUrl,
    onChange: (url, title) => { initialUrl = url; changes.push([url, title]) }, onOpen() {} }))
  enterAddress(render, '3000')
  gate.resolve({ lease: 'delayed', partition: 'partition' }); await tick()
  const guest = desktop.guests[0]
  assert.deepEqual(guest.loads, [], 'user navigation queues while acquire and dom-ready are pending')
  guest.emit('dom-ready'); render()
  assert.deepEqual(guest.loads, ['http://localhost:3000/'])
  assert.deepEqual(guest.actions, ['clear'], 'bootstrap about:blank is removed from history')
  assert.equal(guest.attributes['aria-label'], '浏览器页面', 'an empty page title keeps the frame label')
  enterAddress(render, 'https://example.test/second')
  guest.back = true; guest.forward = true; guest.title = 'Example page'
  guest.emit('page-title-updated')
  assert.equal(guest.attributes['aria-label'], 'Example page')
  assert.equal(button(render(), '网页地址').props.value, 'https://example.test/second')
  assert.deepEqual(changes.at(-1), ['https://example.test/second', 'Example page'])
  for (const label of ['后退', '前进', '刷新网页']) {
    assert.equal(button(render(), label).props.disabled, false)
    button(render(), label).props.onClick()
  }
  assert.deepEqual(guest.actions, ['clear', 'back', 'forward', 'reload'])
  enterAddress(render, 'javascript:alert(1)')
  assert.deepEqual(guest.loads, ['http://localhost:3000/', 'https://example.test/second'])
  guest.url = 'https://example.test/redirect'; guest.emit('did-navigate-in-page')
  assert.equal(button(render(), '网页地址').props.value, 'https://example.test/redirect')
  assert.deepEqual(desktop.acquired, ['cwd:/workspace'])
  hooks.dispose(); await tick()
  assert.deepEqual(desktop.released, ['delayed'])
})

test('unmounting while browser acquisition is pending releases the late lease without creating a guest', async () => {
  const hooks = renderer(), gate = Promise.withResolvers(), desktop = browserHost(() => gate.promise)
  const loaded = await loadClient('browser.tsx', { ...desktop, react: hooks.react })
  hooks.render(() => loaded.BrowserView({ cwd: '/workspace', initialUrl: '', onChange() {}, onOpen() {} }))
  hooks.dispose()
  gate.resolve({ lease: 'late', partition: 'partition' }); await tick()
  assert.deepEqual(desktop.released, ['late'])
  assert.deepEqual(desktop.guests, [])
  assert.deepEqual(desktop.unsubscribed, [])
})

test('missing workspace or denied browser acquisition shows a short state without creating an unleased guest', async () => {
  for (const cwd of [undefined, '/workspace']) {
    const hooks = renderer(), desktop = browserHost(async () => { throw new Error('denied') })
    const loaded = await loadClient('browser.tsx', { ...desktop, react: hooks.react })
    const render = () => hooks.render(() => loaded.BrowserView({ cwd, initialUrl: '', onChange() {}, onOpen() {} }))
    render(); await tick()
    assert.match(JSON.stringify(render()), cwd ? /无法打开浏览器/ : /工作区不可用/)
    assert.deepEqual(desktop.acquired, cwd ? ['cwd:/workspace'] : [])
    assert.deepEqual(desktop.guests, [])
    assert.deepEqual(desktop.released, [])
    hooks.dispose()
  }
})

test('addresses pointing back at the application origin are refused on the address bar and on popups', async () => {
  const app = { URL, location: { origin: 'https://app.test' } }
  const { normalizeBrowserAddress } = await loadClient('browser.tsx', { globals: app })
  assert.equal(normalizeBrowserAddress('https://app.test/path'), null)
  assert.equal(normalizeBrowserAddress('http://app.test/'), 'http://app.test/', 'a different scheme is a different origin')
  const hooks = renderer(), changes = []
  const loaded = await loadClient('browser.tsx', { react: hooks.react, globals: { ...app, open: () => {} } })
  const render = () => hooks.render(() => loaded.BrowserView({ cwd: target.cwd, initialUrl: '', onChange: (...args) => changes.push(args), onOpen() {} }))
  enterAddress(render, 'app.test')
  assert.match(JSON.stringify(render()), /仅支持 HTTP 或 HTTPS 地址/)
  assert.equal(nodes(render()).find(node => node.type === 'iframe').props.src, 'about:blank')
  assert.equal(changes.length, 0, 'rejected origins never navigate')
  enterAddress(render, 'other.test')
  assert.equal(nodes(render()).find(node => node.type === 'iframe').props.src, 'https://other.test/')
  hooks.dispose()
  const desktop = browserHost(), opened = [], popups = renderer()
  const bridged = await loadClient('browser.tsx', { ...desktop, react: popups.react, globals: { ...desktop.globals, location: { origin: 'https://app.test' } } })
  const renderPopup = () => popups.render(() => bridged.BrowserView({ cwd: '/workspace', initialUrl: '', onChange() {}, onOpen: url => opened.push(url) }))
  renderPopup(); await tick()
  desktop.opens.get('lease-1')('https://app.test/frame')
  assert.deepEqual(opened, [], 'same-origin open requests never reach onOpen')
  desktop.opens.get('lease-1')('https://other.test/frame')
  assert.deepEqual(opened, ['https://other.test/frame'])
  popups.dispose()
})

test('address errors clear once acquisition succeeds and load failures clear on the next navigation', async () => {
  const hooks = renderer(), gate = Promise.withResolvers(), desktop = browserHost(() => gate.promise)
  const loaded = await loadClient('browser.tsx', { ...desktop, react: hooks.react })
  const render = () => hooks.render(() => loaded.BrowserView({ cwd: '/workspace', initialUrl: '', onChange() {}, onOpen() {} }))
  render()
  enterAddress(render, 'javascript:alert(1)')
  assert.match(JSON.stringify(render()), /仅支持 HTTP 或 HTTPS 地址/)
  gate.resolve({ lease: 'late', partition: 'partition' }); await tick()
  assert.doesNotMatch(JSON.stringify(render()), /仅支持 HTTP 或 HTTPS 地址/, 'acquiring the lease clears an earlier address error')
  const guest = desktop.guests[0]
  guest.emit('dom-ready')
  guest.emit('did-fail-load', { isMainFrame: true, errorCode: -105 })
  assert.match(JSON.stringify(render()), /网页加载失败/)
  guest.url = 'https://example.test/recovered'; guest.emit('did-navigate')
  assert.doesNotMatch(JSON.stringify(render()), /网页加载失败/, 'observing a navigated page clears the load failure')
  hooks.dispose()
})

test('a workspace change releases the old lease before acquiring the new one', async () => {
  const hooks = renderer(), ops = [], desktop = browserHost()
  let leases = 0
  desktop.globals.dshDesktop = { browser: {
    async acquire(workspace) { ops.push(`acquire ${workspace}`); return { lease: `lease-${++leases}`, partition: 'partition' } },
    async release(lease) { ops.push(`release ${lease}`) },
    onOpenRequested() { return () => {} },
  } }
  const loaded = await loadClient('browser.tsx', { ...desktop, react: hooks.react })
  let cwd = '/first'
  const render = () => hooks.render(() => loaded.BrowserView({ cwd, initialUrl: '', onChange() {}, onOpen() {} }))
  render(); await tick()
  assert.deepEqual(ops, ['acquire cwd:/first'])
  cwd = '/second'
  render(); await tick()
  assert.deepEqual(ops, ['acquire cwd:/first', 'release lease-1', 'acquire cwd:/second'])
  hooks.dispose(); await tick()
  assert.deepEqual(ops.at(-1), 'release lease-2', 'unmount still releases the current lease')
})

test('a successful terminal restore keeps errors that are not its own list failures', async () => {
  let lists = 0
  const retry = Promise.withResolvers(), closeGate = Promise.withResolvers()
  const loaded = await loadClient('right-panel.tsx', { globals: { fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.op === 'close') { await closeGate.promise; return { json: async () => ({ ok: false }) } }
    if (body.op === 'list') {
      if (++lists === 2) return { json: async () => ({ ok: false }) }
      if (lists === 3) await retry.promise
    }
    return { json: async () => ({ ok: true, value: { available: true, terminals: [{ id: 'kept' }] } }) }
  } } })
  const panel = loaded.createRightPanel(host().ctx)
  panel.bind(target); await tick()
  assert.equal(panel.getSnapshot().tabs[0].id, 'kept')
  panel.bind(target); await tick()
  assert.equal(panel.getSnapshot().error, '终端列表加载失败，正在重试…')
  const closing = panel.closeTab('kept')
  closeGate.resolve(); await closing
  assert.equal(panel.getSnapshot().error, '无法关闭终端')
  retry.resolve(); await tick()
  assert.deepEqual(plain(panel.getSnapshot().tabs), [{ kind: 'terminal', id: 'kept' }])
  assert.equal(panel.getSnapshot().error, '无法关闭终端', 'the restored list keeps unrelated errors')
})
