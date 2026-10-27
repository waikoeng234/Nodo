import {
  h, Fragment, useState, useEffect, useRef, useId, useStateView, call, sessionTime, layoutService, openNativeSession, nativeSpace,
  Button, Menu, Modal, Tag, StateDot, IconPanelLeftOutlineRegular, IconTrashOutlineRegular, IconBranchOutlineRegular,
  IconChevronRightOutlineRegular, IconCodeOutlineRegular, IconUsersOutlineRegular, IconGoalOutlineRegular,
  IconPlusOutlineRegular, IconChevronDownOutlineRegular,
} from './ui-shared.js'
import { avatarTemplateOf, RoleAvatar } from './avatar.tsx'
import { runDuration } from './running.js'
import { RUN_STATUS, RUN_DOT, statusLine, taskName, RunDetail, ApprovalCard } from './run-cards.js'
import { Field } from './profile-dialogs.js'
import { workspacePicker } from './session-rail.tsx'
import { nativeRole, setNavigation } from './page.js'
import { WorkflowTaskComposer } from './workflow-composer.js'
import { workflowTaskTitle } from '../../core/shared/task-titles.js'

const WF_KIND = { start: '开始', agent: '执行节点', human: '人工节点', end: '结束节点' }
const wfIcon = kind => ({ start: IconChevronRightOutlineRegular, agent: IconCodeOutlineRegular, human: IconUsersOutlineRegular, end: IconGoalOutlineRegular })[kind]
const wfClone = value => JSON.parse(JSON.stringify(value))
const WF_REWORK = '$rework'
// An agent with a rework wire chooses between two exits, each judged by its listed conditions, one per line.
const WF_CHECKS = { done: ['任务要求的产出已完成', '结果已验证，没有阻塞问题'], rework: ['存在阻塞问题或未满足任务要求', '缺少继续所需的信息或材料'] }
export const wfExits = node => node.kind === 'end' ? [] : node.kind === 'human'
  ? (node.options ?? []).map(option => option.id)
  : node.kind === 'agent' && node.exits?.length ? node.exits.map(exit => exit.id) : ['done']
const wfPortLabel = (node, exit, forward = false) => exit === WF_REWORK ? '返工' : node.options?.find(item => item.id === exit)?.label
  ?? (exit === 'done' ? node.exits?.length ? '通过' : '完成' : exit === 'rework' ? forward ? '不通过' : '返工' : exit)
const wfPorts = (graph, node) => {
  const inputs = node.kind === 'start' ? [] : graph.edges.filter(edge => edge.to === node.id)
  const outputs = wfExits(node), count = Math.max(inputs.length, outputs.length)
  const height = count > 1 ? 96 + count * 26 : 96, y = index => count > 1 ? 108 + index * 26 : 48
  const backInputs = inputs.filter(edge => edge.back)
  const backOutputs = outputs.filter(exit => graph.edges.some(edge => edge.from === node.id && edge.exit === exit && edge.back))
  const rework = ['agent', 'human'].includes(node.kind) && !backOutputs.length && !outputs.includes('rework')
  const bottom = index => ({ x: 204 * (index + 1) / (backInputs.length + backOutputs.length + (rework ? 1 : 0) + 1), y: height, back: true })
  return { inputs, outputs, height, rework,
    input: edge => edge?.back ? bottom(backInputs.indexOf(edge)) : { x: 0, y: y(Math.max(0, inputs.indexOf(edge))) },
    output: exit => exit === WF_REWORK ? bottom(backInputs.length) : backOutputs.includes(exit) ? bottom(backInputs.length + backOutputs.indexOf(exit)) : { x: 204, y: y(outputs.indexOf(exit)) } }
}
const wfCurve = (from, to, back) => {
  const bend = back ? Math.max(from.y, to.y) + 100 : Math.max(60, Math.abs(to.x - from.x) / 2)
  return { d: back ? `M${from.x},${from.y} C${from.x},${bend} ${to.x},${bend} ${to.x},${to.y}`
    : `M${from.x},${from.y} C${from.x + bend},${from.y} ${to.x - bend},${to.y} ${to.x},${to.y}`,
    x: (from.x + to.x) / 2, y: back ? (from.y + to.y) / 8 + bend * .75 - 10 : (from.y + to.y) / 2 - 10 }
}
function wfConnect(draft, from, exit, to) {
  const source = draft.nodes.find(node => node.id === from), target = draft.nodes.find(node => node.id === to)
  if (!source || !target || from === to || target.kind === 'start' || (exit !== WF_REWORK && !wfExits(source).includes(exit))) return draft
  const previous = draft.edges.find(edge => edge.from === from && edge.exit === exit)
  if (previous?.to === to) return draft
  const edges = draft.edges.filter(edge => edge.from !== from || edge.exit !== exit)
  const leads = (id, list = edges, target = from, seen = new Set()) => id === target || (!seen.has(id) && seen.add(id) && list.some(edge => !edge.back && edge.from === id && leads(edge.to, list, target, seen)))
  if (exit === WF_REWORK) {
    if (!['agent', 'human'].includes(source.kind)) return draft
    const connected = draft.edges.find(edge => edge.from === from && (edge.back || edge.exit === 'rework'))
    if (connected) return wfConnect(draft, from, connected.exit, to)
    if (source.kind === 'agent') {
      const exits = Object.entries(WF_CHECKS).map(([id, lines]) => ({ id, when: lines.join('\n') }))
      return wfConnect({ ...draft, nodes: draft.nodes.map(node => node.id === from ? { ...source, exits } : node) }, from, 'rework', to)
    }
    const choices = source.options ?? []
    const reusable = choices.find(choice => choice.label === '返工' && !draft.edges.some(edge => edge.from === from && edge.exit === choice.id))
    let id = reusable?.id ?? 'rework', n = 2, description = '返工'
    while (!reusable && wfExits(source).includes(id)) id = `rework_${n++}`
    if (!reusable && choices.some(choice => choice.label === description)) description += `（${id}）`
    const next = { ...source, options: reusable ? choices : [...choices, { id, label: description }] }
    return wfConnect({ ...draft, nodes: draft.nodes.map(node => node.id === from ? next : node) }, from, id, to)
  }
  // A loop closed through a forward rework wire turns that wire back, so this exit stays forward.
  if (exit !== 'rework' && leads(to)) {
    const turned = edges.map(edge => edge.exit === 'rework' && !edge.back && leads(to, edges, edge.from) && leads(edge.to) ? { ...edge, back: { max: 2 } } : edge)
    if (!leads(to, turned)) return { ...draft, edges: [...turned, { from, exit, to }] }
  }
  return { ...draft, edges: [...edges, { from, exit, to, ...(leads(to) ? { back: { max: previous?.back?.max ?? 2 } } : {}) }] }
}
function wfDisconnect(draft, wire) {
  const matches = edge => edge.from === wire.from && edge.exit === wire.exit && edge.to === wire.to
  if (!draft.edges.some(matches)) return draft
  const edges = draft.edges.filter(edge => !matches(edge))
  return { ...draft, edges, nodes: draft.nodes.map(node => {
    if (node.id !== wire.from || edges.some(edge => edge.from === wire.from && edge.exit === wire.exit)) return node
    if (node.kind === 'human') return node.options?.length > 1 ? { ...node, options: node.options.filter(option => option.id !== wire.exit) } : node
    return node.kind === 'agent' && wire.exit === 'rework' ? { ...node, exits: undefined } : node
  }) }
}
export const wfGraph = definition => {
  if (definition.nodes) return wfClone({ nodes: definition.nodes, edges: definition.edges ?? [], ...(definition.workspaceId ? { workspaceId: definition.workspaceId } : {}) })
  const nodes = (definition.steps ?? []).map((step, index) => step.decide
    ? { id: `s${index + 1}`, kind: 'human', name: step.name, question: step.question, options: [{ id: 'continue', label: '继续' }] }
    : { id: `s${index + 1}`, kind: 'agent', name: step.name, profileId: step.profileId, task: step.task })
  const deliver = nodes.findLast(node => node.kind === 'agent') ?? nodes.at(-1)
  nodes.unshift({ id: 'start', kind: 'start', name: '开始' })
  nodes.push({ id: 'end', kind: 'end', name: '完成交付', deliver: deliver?.id ?? '' })
  return { nodes, edges: nodes.slice(0, -1).map((node, index) => ({ from: node.id, exit: node.kind === 'human' ? 'continue' : 'done', to: nodes[index + 1].id })) }
}
export const wfNew = () => ({ name: '未命名流程', nodes: [{ id: 'start', kind: 'start', name: '开始' }, { id: 'end', kind: 'end', name: '完成交付', deliver: '' }], edges: [] })
// A run takes the tasks it was started with; the flow keeps the rest for the next run.
const wfClearTasks = graph => ({ ...graph, nodes: graph.nodes.map(node => node.kind === 'agent' ? { ...node, task: '', images: undefined, files: undefined } : node) })
export const wfWorkspace = (view, profile, session) => view.workspaces.find(item => item.id === session?.workspaceRef)
  ?? view.workspaces.find(item => session?.cwd && item.cwd === session.cwd)
  ?? view.workspaces.find(item => item.id === profile?.workspaceId)
export const wfCurrentSession = profile => profile?.sessions?.find(item => item.id === profile.activeSessionId)
  ?? (profile?.activeSessionId === profile?.id && profile ? { id: profile.id, name: '默认会话', workspaceRef: profile.workspaceId } : undefined)
export const wfParticipants = (graph, view) => [...new Set(graph.nodes.filter(node => node.kind === 'agent').map(node => node.profileId))].map(id => {
  const profile = view.profiles.find(item => !item.deletedAt && item.id === id)
  const session = wfCurrentSession(profile)
  return { id, profile, session, workspace: graph.workspaceId ? view.workspaces.find(item => item.id === graph.workspaceId) : wfWorkspace(view, profile, session) }
})
// Run order: a step follows every forward wire into it, siblings by exit order; unreachable steps trail.
const wfSteps = graph => {
  const ahead = graph.edges.filter(edge => !edge.back), order = []
  const waits = new Map(graph.nodes.map(node => [node.id, ahead.filter(edge => edge.to === node.id).length]))
  for (const queue = graph.nodes.filter(node => node.kind === 'start'); queue.length;) {
    const node = queue.shift()
    order.push(node)
    for (const exit of wfExits(node)) for (const edge of ahead.filter(item => item.from === node.id && item.exit === exit)) {
      waits.set(edge.to, waits.get(edge.to) - 1)
      if (!waits.get(edge.to)) queue.push(...graph.nodes.filter(item => item.id === edge.to))
    }
  }
  return [...order, ...graph.nodes.filter(node => !order.includes(node))].filter(node => node.kind === 'agent' || node.kind === 'human')
}

export function wfValidate(draft, view) {
  const errors = []
  const add = (node, message) => errors.push({ node: node?.id, message: node ? `${node.name || WF_KIND[node.kind]}：${message}` : message })
  const byId = new Map(draft.nodes.map(node => [node.id, node]))
  const ahead = draft.edges.filter(edge => !edge.back)
  const leads = (from, to, list = ahead, seen = new Set()) => from === to || (!seen.has(from) && seen.add(from) && list.some(edge => edge.from === from && leads(edge.to, to, list, seen)))
  if (!draft.name.trim()) add(null, '请填写流程名称')
  const starts = draft.nodes.filter(node => node.kind === 'start')
  if (starts.length !== 1) add(null, '流程需要一个开始节点')
  if (!draft.nodes.some(node => node.kind === 'end')) add(null, '请添加结束节点')
  if (byId.size !== draft.nodes.length) add(null, '节点标识不能重复')
  for (const node of draft.nodes) {
    if (!node.name.trim()) add(node, '请填写节点名称')
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(node.id)) add(node, '节点标识格式无效')
    if (starts[0] && !leads(starts[0].id, node.id, draft.edges)) add(node, '未连接到开始节点')
    if (node.kind === 'agent') {
      if (!view.profiles.some(profile => !profile.deletedAt && profile.id === node.profileId)) add(node, '请选择已有角色')
      if (!node.task?.trim() && !node.images?.length && !node.files?.length) add(node, '请填写任务说明')
      if (node.task?.length > 32000) add(node, '任务说明最多 32000 字符')
    }
    if (node.kind === 'agent' && node.exits?.some(exit => exit.when.split('\n').some(line => !line.trim()))) add(node, '请填写每一条通过和返工条件')
    const choices = node.kind === 'human' && node.options
    if (choices) {
      const ids = choices.map(item => item.id), labels = choices.map(item => (item.label ?? '').trim())
      if (ids.some(id => !/^[a-z][a-z0-9_]{0,31}$/.test(id))) add(node, '选项标识格式无效')
      if (new Set(ids).size !== ids.length || new Set(labels).size !== labels.length) add(node, '选项不能重复')
      if (labels.some(label => !label)) add(node, '请填写每个选项的文字')
    }
    const exits = wfExits(node)
    if (node.kind === 'human' && !exits.length) add(node, '至少提供一个选项')
    if (node.kind === 'end') {
      if (!['agent', 'human'].includes(byId.get(node.deliver)?.kind)) add(node, '请选择交付来源')
      else if (!leads(node.deliver, node.id)) add(node, '交付来源须在结束节点的上游路径中')
    } else {
      for (const exit of exits) if (draft.edges.filter(edge => edge.from === node.id && edge.exit === exit && byId.has(edge.to)).length !== 1) add(node, `出口 ${exit} 需要连接一个节点`)
      if (!ahead.some(edge => edge.from === node.id)) add(node, '需要一条向前的连线')
    }
  }
  for (const edge of draft.edges) {
    const node = byId.get(edge.from)
    if (!node || !wfExits(node).includes(edge.exit) || !byId.has(edge.to) || byId.get(edge.to)?.kind === 'start') add(node, '连线引用了无效出口或目标')
    if (edge.back && (!Number.isInteger(edge.back.max ?? 2) || (edge.back.max ?? 2) < 1 || (edge.back.max ?? 2) > 5 || !leads(edge.to, edge.from))) add(node, '返工须返回上游节点，上限为 1～5 次')
  }
  const visit = (id, path = new Set()) => path.has(id) || ahead.some(edge => edge.from === id && visit(edge.to, new Set([...path, id])))
  if (starts[0] && visit(starts[0].id)) add(null, '普通连线不能形成环；返回上游请标记返工')
  return errors
}

export function wfHistoryGraph(definitions, run) {
  const definition = run?.graph ?? definitions.find(item => item.id === run?.workflowId)
  if (!definition || !Array.isArray(run?.tasks)) return null
  const graph = wfGraph(definition)
  const names = graph.nodes.map(node => node.name)
  if (new Set(names).size !== names.length) return null
  const tasks = new Map()
  for (const task of run.tasks) {
    const node = graph.nodes.find(node => node.name === task.name && node.kind === task.kind)
    if (!node) return null
    tasks.set(node.id, [...(tasks.get(node.id) ?? []), task])
  }
  const path = run.tasks.map(task => graph.nodes.find(node => node.name === task.name && node.kind === task.kind)?.id)
  const start = graph.nodes.find(node => node.kind === 'start')
  if (path.length && !path.includes(start?.id)) path.unshift(start?.id)
  const ends = graph.nodes.filter(node => node.kind === 'end')
  if (run.status === 'done' && ends.length === 1 && path.at(-1) !== ends[0].id) path.push(ends[0].id)
  const taken = new Set()
  for (let i = 1; i < path.length; i++) {
    const matches = graph.edges.filter(edge => edge.from === path[i - 1] && edge.to === path[i])
    if (matches.length === 1) taken.add(`${matches[0].from}.${matches[0].exit}`)
  }
  return { ...graph, tasks, taken, status: run.status }
}

export function wfDelivery(graph, run) {
  if (!graph || run?.status !== 'done') return null
  const ends = graph.nodes.filter(node => node.kind === 'end')
  if (ends.length !== 1) return null
  const node = graph.nodes.find(node => node.id === ends[0].deliver)
  const task = run.tasks.findLast(task => task.name === node?.name && task.kind === node?.kind && task.status === 'done')
  return task ?? null
}

export function wfPositions(graph) {
  const rowHeight = Math.max(150, ...graph.nodes.map(node => wfPorts(graph, node).height + 54))
  const levels = new Map(graph.nodes.filter(node => node.kind === 'start').map(node => [node.id, 0]))
  for (let i = 0; i < graph.nodes.length; i++) {
    let moved = false
    for (const edge of graph.edges.filter(edge => !edge.back)) {
      if (!levels.has(edge.from)) continue
      const level = Math.min(graph.nodes.length, levels.get(edge.from) + 1)
      if ((levels.get(edge.to) ?? -1) < level) { levels.set(edge.to, level); moved = true }
    }
    if (!moved) break
  }
  const occupancy = new Map()
  return Object.fromEntries(graph.nodes.map(node => {
    const level = levels.get(node.id) ?? 0
    const band = Math.floor(level / 3), column = band % 2 ? 2 - level % 3 : level % 3
    const slot = `${band}.${column}`, offset = occupancy.get(slot) ?? 0
    occupancy.set(slot, offset + 1)
    return [node.id, { x: 64 + column * 256, y: 120 + band * (rowHeight + 100) + offset * rowHeight }]
  }))
}

export function wfRemove(draft, id) {
  return { ...draft, nodes: draft.nodes.filter(node => node.id !== id).map(node => node.deliver === id ? { ...node, deliver: '' } : node),
    edges: draft.edges.filter(edge => edge.from !== id && edge.to !== id) }
}
const wfObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const wfText = value => value === undefined ? undefined : String(value)
const wfChoices = list => list === undefined ? undefined : (Array.isArray(list) ? list : []).filter(wfObject)
  .map(item => ({ ...item, id: String(item.id ?? ''), label: wfText(item.label), when: wfText(item.when) }))
const wfAttachments = list => list === undefined ? undefined : (Array.isArray(list) ? list : []).filter(item => wfObject(item) && typeof item.id === 'string')
  .map(item => ({ ...item, name: String(item.name ?? '') }))
// A draft kept in the browser may be damaged: what cannot be shown is dropped, the rest keeps its own errors.
const wfRestore = draft => ({ ...draft, workspaceId: typeof draft.workspaceId === 'string' && draft.workspaceId ? draft.workspaceId : undefined,
  nodes: draft.nodes.filter(node => wfObject(node) && typeof node.id === 'string' && WF_KIND[node.kind])
    .map(node => ({ ...node, name: String(node.name ?? ''), task: wfText(node.task), question: wfText(node.question), options: wfChoices(node.options), exits: wfChoices(node.exits),
      images: wfAttachments(node.images), files: wfAttachments(node.files), choices: wfObject(node.choices)
        ? Object.fromEntries(Object.entries(node.choices).filter(([key, value]) => ['model', 'thinking', 'permission'].includes(key) && typeof value === 'string')) : undefined })),
  edges: draft.edges.filter(edge => wfObject(edge) && ['from', 'exit', 'to'].every(key => typeof edge[key] === 'string')) })
const wfRead = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('nodo.workflow.draft'))
    if (saved?.draft && typeof saved.draft.name === 'string' && Array.isArray(saved.draft.nodes) && Array.isArray(saved.draft.edges)) return { ...saved, draft: wfRestore(saved.draft) }
  } catch {}
  return { draft: wfNew(), source: null, selected: 'start', positions: {} }
}

let wfSidebarContent = null
const wfSidebarListeners = new Set()
export const wfSidebarSnapshot = () => wfSidebarContent
export const wfSubscribeSidebar = listener => { wfSidebarListeners.add(listener); return () => wfSidebarListeners.delete(listener) }
export const wfPublishSidebar = content => {
  if (content === wfSidebarContent) return
  wfSidebarContent = content
  for (const listener of wfSidebarListeners) listener()
}

export function WorkflowCanvas({ graph, view, selected, onSelect, positions, onPosition, onConnect, onDisconnect, onContext, tools, trailing, dock, history = false, busy = false }) {
  const [cam, setCam] = useState({ x: 0, y: 0, zoom: 1 }), [link, setLink] = useState(null)
  const zoom = cam.zoom
  const drag = useRef(null), pan = useRef(null), viewport = useRef(null), plane = useRef(null)
  const marker = `wf-arrow-${useId().replace(/:/g, '')}`
  const auto = wfPositions(graph), points = { ...auto, ...positions }
  const width = Math.max(900, ...graph.nodes.map(node => (points[node.id]?.x ?? 0) + 270))
  const ports = Object.fromEntries(graph.nodes.map(node => [node.id, wfPorts(graph, node)]))
  const height = Math.max(560, ...graph.nodes.map(node => (points[node.id]?.y ?? 0) + ports[node.id].height + 100))
  const fit = () => {
    if (!viewport.current) return
    const at = Object.values(points)
    const left = Math.min(...at.map(p => p.x)), right = Math.max(...at.map(p => p.x + 204))
    const top = Math.min(...at.map(p => p.y)), bottom = Math.max(...graph.nodes.map(node => points[node.id].y + ports[node.id].height)) + (graph.edges.some(edge => edge.back) ? 80 : 0)
    const next = Math.max(.25, Math.min(1, (viewport.current.clientWidth - 48) / Math.max(1, right - left), (viewport.current.clientHeight - 48) / Math.max(1, bottom - top)))
    setCam({ zoom: next, x: (viewport.current.clientWidth - (left + right) * next) / 2, y: (viewport.current.clientHeight - (top + bottom) * next) / 2 })
  }
  useEffect(() => { fit() }, [graph.nodes.length, history])
  const zoomAt = (anchorX, anchorY, factor) => setCam(cam => {
    const zoom = Math.min(2.5, Math.max(.25, cam.zoom * factor))
    return { zoom, x: anchorX - (anchorX - cam.x) * zoom / cam.zoom, y: anchorY - (anchorY - cam.y) * zoom / cam.zoom }
  })
  const zoomBy = factor => zoomAt((viewport.current?.clientWidth ?? 0) / 2, (viewport.current?.clientHeight ?? 0) / 2, factor)
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const onWheel = event => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.1 : 1 / 1.1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const planePoint = event => {
    const rect = plane.current?.getBoundingClientRect?.() ?? { left: 0, top: 0 }
    return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom }
  }
  const nodeAt = point => graph.nodes.find(node => {
    const at = points[node.id]
    return point.x >= at.x - 10 && point.x <= at.x + 214 && point.y >= at.y && point.y <= at.y + ports[node.id].height + 10
  })
  const linkable = !history && !busy && !!onConnect
  const removable = !history && !busy && !!onDisconnect
  const origin = link && ports[link.from]?.output(link.exit)
  const preview = linkable && origin && points[link.from]
    ? wfCurve({ x: points[link.from].x + origin.x, y: points[link.from].y + origin.y }, link, origin.back) : null
  const icon = wfIcon
  return h('div', { className: 'nodo-wf-stage', onContextMenu: event => {
    if (history || !onContext) return
    event.preventDefault()
    if (busy) return
    const point = planePoint(event)
    onContext({ clientX: event.clientX, clientY: event.clientY, plane: point, node: nodeAt(point)?.id ?? null })
  } },
    h('div', { className: 'nodo-wf-viewport', ref: viewport, 'aria-label': history ? '运行路径画布' : '流程编排画布',
      onPointerDown: event => {
        if (event.button !== 1) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        pan.current = { originX: event.clientX, originY: event.clientY, baseX: cam.x, baseY: cam.y }
      },
      onPointerMove: event => {
        const start = pan.current
        if (start) setCam(current => ({ ...current, x: start.baseX + event.clientX - start.originX, y: start.baseY + event.clientY - start.originY }))
      }, onPointerUp: () => { pan.current = null }, onPointerCancel: () => { pan.current = null } },
      h('div', { className: 'nodo-wf-plane', ref: plane, style: { width, height, transform: `translate(${cam.x}px, ${cam.y}px) scale(${zoom})` } },
          h('svg', { className: 'nodo-wf-wires', width, height, 'aria-label': '节点连线' },
            h('defs', null, ...[false, true].map(back => h('marker', { id: `${marker}${back ? '-back' : ''}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
              h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: back ? 'var(--nodo-wf-rework)' : 'currentColor' })))),
            ...graph.edges.map(edge => {
              const a = points[edge.from], b = points[edge.to]
              if (!a || !b || !ports[edge.from] || !ports[edge.to]) return null
              const from = graph.nodes.find(node => node.id === edge.from)
              const label = edge.back ? '返工' : from?.options?.find(item => item.id === edge.exit)?.label ?? (from?.exits?.length ? wfPortLabel(from, edge.exit, true) : '')
              const out = ports[edge.from].output(edge.exit), input = ports[edge.to].input(edge)
              const curve = wfCurve({ x: a.x + out.x, y: a.y + out.y }, { x: b.x + input.x, y: b.y + input.y }, edge.back)
              return h('g', { key: `${edge.from}.${edge.exit}`, className: `nodo-wf-wire${edge.back ? ' nodo-wf-back' : ''}${history && !graph.taken?.has(`${edge.from}.${edge.exit}`) ? ' nodo-wf-wire-unused' : ''}`, onClick: () => onSelect(edge.from) },
                h('path', { className: 'nodo-wf-wire-hit', d: curve.d, fill: 'none' }),
                h('path', { d: curve.d, fill: 'none', markerEnd: `url(#${marker}${edge.back ? '-back' : ''})` }),
                label && h('text', { x: curve.x, y: curve.y - (removable ? 10 : 0), textAnchor: 'middle' }, `${label}${edge.back ? ` · 最多 ${edge.back.max ?? 2} 次` : ''}`),
                removable && h('foreignObject', { className: 'nodo-wf-wire-action', x: curve.x - 12, y: curve.y - 2, width: 24, height: 24 },
                  h('button', { type: 'button', className: 'nodo-wf-wire-delete', title: '删除连线及对应出口配置',
                    'aria-label': `删除连线：${from?.name ?? edge.from} → ${graph.nodes.find(node => node.id === edge.to)?.name ?? edge.to}（${wfPortLabel(from, edge.exit, !edge.back)}）`,
                    onPointerDown: event => event.stopPropagation(),
                    onClick: event => { event.stopPropagation(); onDisconnect(edge) } },
                    h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': true },
                      h('path', { d: 'M4 4l6 6M10 4l-6 6' })))))
            }),
            preview && h('path', { className: 'nodo-wf-wire-preview', 'data-back': origin.back ? '' : undefined, d: preview.d, fill: 'none' })),
          ...graph.nodes.map(node => {
            const profile = view.profiles.find(item => item.id === node.profileId), point = points[node.id]
            const tasks = graph.tasks?.get(node.id) ?? [], task = tasks.at(-1)
            const layout = ports[node.id]
            return h('button', { key: node.id, type: 'button', className: 'nodo-wf-node',
              style: { left: point.x, top: point.y, height: layout.height, paddingBottom: layout.height - 80, ...(node.kind === 'agent' && profile ? { '--nodo-wf-tint': avatarTemplateOf(profile).color } : {}) },
              'aria-pressed': selected === node.id, 'data-kind': node.kind, 'data-link-target': link?.hover === node.id ? '' : undefined, 'data-link-source': linkable && link?.from === node.id ? '' : undefined, 'aria-label': `${node.name}，${WF_KIND[node.kind]}${task ? `，${RUN_STATUS[task.status] ?? task.status}` : ''}`,
              onClick: () => onSelect(node.id),
              onPointerDown: event => {
                if (history || busy || event.button !== 0) return
                drag.current = { id: node.id, ...point, clientX: event.clientX, clientY: event.clientY }
                event.currentTarget.setPointerCapture(event.pointerId)
              },
              onPointerMove: event => {
                const start = drag.current
                if (start?.id === node.id) onPosition(node.id, { x: start.x + (event.clientX - start.clientX) / zoom, y: start.y + (event.clientY - start.clientY) / zoom })
              }, onPointerUp: () => { drag.current = null }, onPointerCancel: () => { drag.current = null } },
              ...[...layout.outputs, ...(linkable && layout.rework ? [WF_REWORK] : [])].map(exit => {
                const anchor = layout.output(exit)
                return h('span', { key: exit, className: 'nodo-wf-port nodo-wf-port-out', 'data-back': anchor.back ? '' : undefined,
                style: anchor.back ? { left: anchor.x - 7, right: 'auto', top: anchor.y } : { top: anchor.y },
                'data-exit': exit, 'aria-label': `${node.name}：${wfPortLabel(node, exit, !anchor.back)}输出`, 'aria-disabled': !linkable,
                title: `${wfPortLabel(node, exit, !anchor.back)}：拖到目标节点${graph.edges.some(edge => edge.from === node.id && edge.exit === exit) ? '可改接连线' : '建立连线'}`,
                onPointerDown: event => {
                  if (!linkable || event.button !== 0) return
                  event.preventDefault(); event.stopPropagation()
                  event.currentTarget.setPointerCapture?.(event.pointerId)
                  setLink({ from: node.id, exit, hover: null, ...planePoint(event) })
                },
                onPointerMove: event => setLink(current => current?.from === node.id
                  ? { ...current, ...planePoint(event), hover: nodeAt(planePoint(event))?.id ?? null } : current),
                onPointerUp: event => {
                  if (!linkable || link?.from !== node.id || link.exit !== exit) return
                  const point = planePoint(event), target = nodeAt(point)
                  if (target && target.id !== node.id && target.kind !== 'start') onConnect(node.id, exit, target.id)
                  else if (!target && !anchor.back && onContext) {
                    const rect = viewport.current?.getBoundingClientRect?.()
                    if (!rect || (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) {
                      onContext({ clientX: event.clientX, clientY: event.clientY, plane: point, node: null, connection: { from: node.id, exit } })
                    }
                  }
                  setLink(null)
                },
                onPointerCancel: () => setLink(null), onClick: event => event.stopPropagation() }) }),
              node.kind !== 'start' && [...layout.inputs, ...(layout.inputs.some(edge => !edge.back) ? [] : [null])].map((edge, index) => {
                const anchor = layout.input(edge)
                return h('span', {
                key: index, className: 'nodo-wf-port nodo-wf-port-in', 'data-back': anchor.back ? '' : undefined,
                style: anchor.back ? { left: anchor.x - 7, top: anchor.y } : { top: anchor.y },
                title: edge ? `来自 ${graph.nodes.find(item => item.id === edge.from)?.name ?? edge.from} · ${edge.exit}` : '输入：拖入连线',
              }) }),
              node.kind === 'agent' && profile ? h('span', { className: 'nodo-wf-node-avatar' }, h(RoleAvatar, { profile, size: 44, running: task?.status === 'active' }))
                : h('span', { className: 'nodo-wf-node-icon' }, h(icon(node.kind), { size: 20 })),
              h('span', { className: 'nodo-wf-node-copy' }, h('strong', null, node.name || WF_KIND[node.kind]),
                h('span', null, history ? task ? task.card ? '等待回答' : RUN_STATUS[task.status] ?? task.status : node.kind === 'start' ? '开始' : node.kind === 'end' && graph.status === 'done' ? '已完成' : '未记录执行' : node.kind === 'agent' ? profile?.name ?? '选择执行伙伴' : node.kind === 'human' ? '等待你的决定' : node.kind === 'end' ? '交付步骤产出' : '顺序推进'),
                history && tasks.length > 1 && h('small', null, `${tasks.length} 个执行任务（含返工）`)),
              task && h(StateDot, { state: RUN_DOT[task.status] ?? 'idle', size: 10 }))
          }))),
    h('div', { className: 'nodo-wf-canvas-tools' }, tools,
      h('div', { className: 'nodo-wf-zoom', role: 'group', 'aria-label': '缩放' },
        h(Button, { variant: 'ghost', size: 'sm', 'aria-label': '缩小画布', onClick: () => zoomBy(1 / 1.1) }, '−'),
        h('span', null, `${Math.round(zoom * 100)}%`),
        h(Button, { variant: 'ghost', size: 'sm', 'aria-label': '放大画布', onClick: () => zoomBy(1.1) }, '+'),
        h(Button, { variant: 'ghost', size: 'sm', onClick: fit }, '适应画布'))),
    trailing && h('div', { className: 'nodo-wf-canvas-trail' }, trailing), dock)
}

export function WorkflowInspector({ draft, node, profile, disabled, onChange, onEdge, onRemove }) {
  if (!node) return h('aside', { className: 'nodo-wf-inspector' }, h('p', null, '选择节点进行配置。'))
  const input = (label, key, options = {}) => h(Field, { label }, h(options.area ? 'textarea' : 'input', { className: `nodo-dialog-input${options.area ? ' nodo-dialog-textarea' : ''}`, value: node[key] ?? '', disabled, maxLength: options.max ?? 60,
    onChange: event => onChange({ [key]: event.target.value }), ...(options.area ? { rows: 5 } : {}) }))
  const select = (label, value, items, change) => h(Field, { label }, h('select', { className: 'nodo-dialog-input', value, disabled, onChange: event => change(event.target.value) },
    h('option', { value: '' }, '请选择'), ...items.map(item => h('option', { key: item.id, value: item.id }, item.name))))
  const choices = node.kind === 'human' ? node.options ?? [] : []
  const editChoice = (index, changes) => onChange({ options: choices.map((item, i) => i === index ? { ...item, ...changes } : item) })
  const addChoice = () => {
    let n = choices.length + 1
    while (choices.some(item => item.id === `choice_${n}`)) n++
    onChange({ options: [...choices, { id: `choice_${n}`, label: '' }] })
  }
  const wire = exit => draft.edges.find(edge => edge.from === node.id && edge.exit === exit)
  const nameOf = id => draft.nodes.find(item => item.id === id)?.name ?? id
  const limit = edge => {
    const max = edge.back.max ?? 2, step = by => onEdge({ ...edge, back: { max: max + by } })
    return h('div', { className: 'nodo-wf-limit' }, h('span', null, '最多返工'),
      h(Button, { variant: 'ghost', size: 'sm', disabled: disabled || max <= 1, 'aria-label': '减少返工次数', onClick: () => step(-1) }, '−'),
      h('output', null, `${max} 次`),
      h(Button, { variant: 'ghost', size: 'sm', disabled: disabled || max >= 5, 'aria-label': '增加返工次数', onClick: () => step(1) }, '+'))
  }
  const target = exit => {
    const edge = wire(exit)
    return h('span', { className: 'nodo-wf-target', 'data-linked': edge ? '' : undefined }, edge ? `${edge.back ? '↺' : '→'} ${nameOf(edge.to)}` : '未连接')
  }
  // One exit: its destination beside the title, an input per line and an optional add button.
  const group = ({ exit, tone = exit, title, rows, add }) => h('div', { className: 'nodo-wf-checks', 'data-exit': tone, role: 'group', 'aria-label': title },
    h('div', { className: 'nodo-wf-checks-head' }, h('strong', null, title), target(exit)),
    ...rows.map((row, index) => {
      const label = rows.length > 1 ? `${title} ${index + 1}` : title
      return h('div', { key: index, className: 'nodo-wf-check' },
        h('input', { className: 'nodo-dialog-input', 'aria-label': label, maxLength: 500, disabled, ...row.input }),
        row.remove && h(Button, { variant: 'ghost', size: 'sm', disabled, 'aria-label': `删除${label}`, onClick: row.remove }, '×'))
    }),
    add && h(Button, { variant: 'ghost', size: 'sm', disabled, onClick: add.onClick }, add.label))
  // A condition left as its suggestion shows as the placeholder; clearing one returns it to the suggestion.
  const checks = (exit, title) => {
    const lines = (node.exits.find(item => item.id === exit)?.when ?? '').split('\n'), hints = WF_CHECKS[exit]
    const save = next => onChange({ exits: node.exits.map(item => item.id === exit ? { ...item, when: next.join('\n') } : item) })
    return group({ exit, title, add: { label: `+ 添加${title}`, onClick: () => save([...lines, '']) }, rows: lines.map((line, index) => ({
      input: { value: line === hints[index] ? '' : line, placeholder: hints[index] ?? '填写条件',
        onChange: event => save(lines.map((item, i) => i === index ? event.target.value.replace(/\n/g, ' ') || hints[index] || '' : item)) },
      remove: lines.length > 1 && (() => save(lines.filter((_, i) => i !== index))) })) })
  }
  const destination = exit => {
    const edge = wire(exit)
    return h(Fragment, null,
      h('span', { className: 'nodo-dialog-hint' }, edge ? `${edge.back ? '返工 → ' : '→ '}${nameOf(edge.to)}` : '从画布出口拖线连接下一节点'),
      edge?.back && limit(edge))
  }
  const rework = wire('rework')
  const answers = () => h('div', { key: 'answers', className: 'nodo-wf-choice' },
    ...choices.map((choice, index) => {
      const edge = wire(choice.id)
      return h(Fragment, { key: index },
        group({ exit: choice.id, tone: edge?.back ? 'rework' : 'done', title: `选项 ${index + 1}`, rows: [{
          input: { value: choice.label ?? '', placeholder: '填写选项文字', onChange: event => editChoice(index, { label: event.target.value.replace(/\n/g, ' ') }) },
          remove: choices.length > 1 && (() => onChange({ options: choices.filter((_, i) => i !== index) })) }] }),
        edge?.back && limit(edge))
    }),
    h(Button, { variant: 'ghost', size: 'sm', disabled, onClick: addChoice }, '+ 添加选项'),
    h('p', { className: 'nodo-dialog-hint' }, '运行到这里时查看上一步产出，选一个选项继续，可附言交给下一步；也可写明意见退回上一步执行节点（无需连线，最多 2 次）。'))
  return h('aside', { className: 'nodo-wf-inspector', 'aria-label': '节点检查器' },
    h('header', { className: 'nodo-wf-inspector-head' },
      node.kind === 'agent' && profile ? h(RoleAvatar, { profile, size: 40 }) : h('span', { className: 'nodo-wf-node-icon', 'data-kind': node.kind }, h(wfIcon(node.kind), { size: 20 })),
      h('div', null, h('strong', null, node.name || WF_KIND[node.kind]),
        h('span', null, node.kind === 'agent' ? `${WF_KIND.agent} · ${profile?.name ?? '在输入栏选择执行伙伴'}` : WF_KIND[node.kind]))),
    input('节点名称', 'name'),
    node.kind === 'end' && select('交付来源', node.deliver ?? '', draft.nodes.filter(item => ['agent', 'human'].includes(item.kind)), id => onChange({ deliver: id })),
    node.kind !== 'end' && h('section', { className: 'nodo-wf-section' },
      h('h3', null, node.kind === 'start' ? '下一步' : '节点流向'),
      ...(node.kind === 'human' ? [answers()] : node.kind === 'agent' && node.exits?.length
        ? [h('div', { key: 'checks', className: 'nodo-wf-choice' }, checks('done', '通过条件'), checks('rework', '返工条件'),
          rework?.back && limit(rework), h('p', { className: 'nodo-dialog-hint' }, '灰字是建议条件，不改就直接使用。执行伙伴无法继续时流程会停下，等你处理。'))]
        : wfExits(node).map(exit => h('div', { key: exit, className: 'nodo-wf-choice' }, destination(exit)))),
      node.kind === 'agent' && !node.exits?.length && h('p', { className: 'nodo-dialog-hint' }, '从节点底部「返工」端口拖线到上游节点或修复节点，即可设置通过与返工条件。')),
    node.kind !== 'start' && h('div', { className: 'nodo-wf-node-actions' },
      h(Button, { variant: 'outline', size: 'sm', disabled, className: 'nodo-dialog-danger', onClick: onRemove }, '删除节点')))
}

export function WorkflowRunDuration({ run }) {
  const [, tick] = useState(0)
  const ended = ['done', 'failed', 'cancelled'].includes(run.status)
  useEffect(() => {
    if (ended || !Number.isFinite(run.createdAt)) return
    const timer = setInterval(() => tick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [run.id, run.createdAt, ended])
  if (!Number.isFinite(run.createdAt)) return null
  const end = ended ? run.endedAt ?? run.updatedAt : Date.now()
  return h('span', { className: 'nodo-wf-run-duration' }, ended ? '总时长 ' : '已运行 ',
    h('span', { className: 'nodo-running-time' }, Number.isFinite(end) ? runDuration(end - run.createdAt) : '—'))
}

export function WorkflowPage({ view, readOnly, refresh, onOpenSession }) {
  const [saved, setSaved] = useState(wfRead)
  const { draft, source, selected, positions = {} } = saved
  const [mode, setMode] = useState('edit'), [runs, setRuns] = useState([]), [run, setRun] = useState(null), [runId, setRunId] = useState('')
  const [selectedTask, setSelectedTask] = useState(''), [reconcile, setReconcile] = useState({ reason: '', text: '' })
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [launch, setLaunch] = useState(false), [runTitle, setRunTitle] = useState('')
  const [checks, setChecks] = useState({}), [confirm, setConfirm] = useState(null)
  const [addOpen, setAddOpen] = useState(false), [menu, setMenu] = useState(null), [placeOpen, setPlaceOpen] = useState(false)
  const [inputBusy, setInputBusy] = useState(false), [saveOpen, setSaveOpen] = useState(false)
  const inspectorCollapsed = saved.inspectorCollapsed === true
  const gate = useRef(false), request = useRef(0)
  const definitions = view.workflows?.definitions ?? []
  const original = definitions.find(item => item.id === source?.id)
  const dirty = JSON.stringify({ name: draft.name, nodes: draft.nodes, edges: draft.edges, workspaceId: draft.workspaceId }) !== (source?.content ?? JSON.stringify(wfNew()))
  const errors = wfValidate(draft, view), participants = wfParticipants(draft, view)
  const missing = participants.filter(item => !item.profile || !item.workspace)
  const node = draft.nodes.find(node => node.id === selected)
  const moved = JSON.stringify(view.runs ?? [])
  const history = wfHistoryGraph(definitions, run)
  const shown = run?.id === runId ? run : null
  const blocked = !!busy || readOnly || inputBusy
  const update = changes => setSaved(current => ({ ...current, ...changes }))
  const changeTask = (id, changes) => setSaved(current => ({ ...current, draft: { ...current.draft,
    nodes: current.draft.nodes.map(item => item.id === id ? { ...item, ...(typeof changes === 'function' ? changes(item) : changes) } : item) } }))
  useEffect(() => { try { localStorage.setItem('nodo.workflow.draft', JSON.stringify(saved)) } catch {} }, [saved])
  useEffect(() => {
    if (readOnly) { setRuns([]); setRun(null); return }
    let live = true
    const order = ++request.current
    setLoading(true)
    void Promise.all([call('run-list'), runId ? call('run-get', { id: runId }) : Promise.resolve(null)])
      .then(([list, detail]) => { if (live && order === request.current) { setRuns(list); setRun(detail) } })
      .catch(failure => { if (live && order === request.current) setError(failure.message) })
      .finally(() => { if (live && order === request.current) setLoading(false) })
    return () => { live = false }
  }, [moved, runId, readOnly])
  const perform = async (label, action) => {
    if (gate.current || readOnly) return
    gate.current = true; setBusy(label); setError('')
    try { await action(); await refresh(true) } catch (failure) { setError(failure.message) }
    finally { gate.current = false; setBusy('') }
  }
  const load = definition => {
    const graph = wfGraph(definition), content = JSON.stringify({ name: definition.name, ...graph })
    setSaved({ draft: { name: definition.name, ...graph }, source: { id: definition.id, revision: definition.revision, content }, selected: graph.nodes[0]?.id, positions: {} })
    setMode('edit'); setError(''); setLaunch(false)
  }
  const replace = action => dirty ? setConfirm({ kind: 'discard', action }) : action()
  const keep = result => {
    const graph = wfGraph(result)
    update({ draft: { name: result.name, ...graph }, source: { id: result.id, revision: result.revision, content: JSON.stringify({ name: result.name, ...graph }) } })
    return result
  }
  const persist = async (asNew, graph = draft, base = source) => {
    const name = graph.name.trim()
    if (definitions.some(item => item.name === name && (asNew || !base || item.id !== base.id))) throw new Error(`已有同名流程“${name}”，请换一个名称。`)
    const body = { name, workspaceId: graph.workspaceId, nodes: graph.nodes.map(item => ({ ...item, ...(item.exits?.length === 0 ? { exits: undefined } : {}), ...(item.options?.length === 0 ? { options: undefined } : {}) })), edges: graph.edges }
    if (!base || asNew) return keep(await call('workflow-create', body))
    const fresh = await call('state'), current = fresh.workflows?.definitions?.find(item => item.id === base.id)
    if (!current || (current.revision ?? 0) !== (base.revision ?? 0) || JSON.stringify({ name: current.name, ...wfGraph(current) }) !== base.content) throw new Error('来源流程已删除或版本已变化。草稿已保留，可另存为新流程或转为独立草稿。')
    return keep(await call('workflow-update', { id: base.id, revision: base.revision ?? 0, ...body }))
  }
  const save = asNew => perform('save', () => persist(asNew))
  const saveAs = name => { setConfirm(null); void perform('save', () => persist(true, { ...draft, name })) }
  const copyName = () => {
    const base = draft.name.trim().slice(0, 70) || '未命名流程'
    let name = `${base} 副本`, n = 2
    while (definitions.some(item => item.name === name)) name = `${base} 副本 ${n++}`
    return name
  }
  const asName = confirm?.kind === 'saveAs' ? confirm.name.trim() : '', asClash = definitions.some(item => item.name === asName)
  const start = () => perform('launch', async () => {
    const flow = dirty || !original ? await persist(false) : original
    const result = await call('workflow-run', { id: flow.id, title: runTitle.trim() })
    setLaunch(false); selectRun(result.runId)
    const graph = wfGraph(flow)
    await persist(false, wfClearTasks({ name: flow.name, ...graph }), { id: flow.id, revision: flow.revision, content: JSON.stringify({ name: flow.name, ...graph }) })
    setRuns(await call('run-list'))
  })
  const add = (kind, at, connection) => {
    if (blocked) return
    let n = draft.nodes.length
    while (draft.nodes.some(node => node.id === `${kind}_${n}`)) n++
    const added = { id: `${kind}_${n}`, kind, name: kind === 'agent' ? '执行任务' : kind === 'human' ? '人工验收' : '完成交付',
      ...(kind === 'agent' ? { profileId: view.profiles.find(profile => !profile.deletedAt)?.id ?? '', task: '' } : kind === 'human' ? { options: [{ id: 'choice_1', label: '继续' }] } : { deliver: '' }) }
    const nodes = [...draft.nodes], before = nodes.findIndex(node => node.kind === 'end')
    nodes.splice(before < 0 ? nodes.length : before, 0, added)
    const next = { ...draft, nodes }, connected = connection ? wfConnect(next, connection.from, connection.exit, added.id) : next
    if (connection && connected === next) return
    update({ draft: connected, selected: added.id,
      ...(at ? { positions: { ...positions, [added.id]: at } } : {}) })
  }
  const connect = (from, exit, to) => {
    if (!blocked) setSaved(current => ({ ...current, draft: wfConnect(current.draft, from, exit, to) }))
  }
  const disconnect = edge => {
    if (!blocked) setSaved(current => ({ ...current, draft: wfDisconnect(current.draft, edge) }))
  }
  const removeNode = id => update({ draft: wfRemove(draft, id), selected: 'start' })
  const deletable = () => draft.nodes.find(item => item.id === selected && item.kind !== 'start')
  const changeNode = changes => {
    const next = { ...node, ...changes, ...(changes.profileId && changes.profileId !== node.profileId ? { choices: {} } : {}) }, before = wfExits(node), after = wfExits(next)
    // Renaming an exit retains its destination; removing it removes its wire.
    const edges = draft.edges.flatMap(edge => {
      if (edge.from !== node.id) return [edge]
      const index = before.indexOf(edge.exit)
      if (after.includes(edge.exit)) return [edge]
      if (before.length === after.length && after[index]) return [{ ...edge, exit: after[index] }]
      return []
    })
    update({ draft: { ...draft, nodes: draft.nodes.map(item => item.id === node.id ? next : item), edges } })
  }
  const actRun = (endpoint, payload) => perform(endpoint, async () => {
    const result = await call(endpoint, { id: shown.id, ...payload })
    if (result?.tasks) setRun(result)
    setReconcile({ reason: '', text: '' })
    setRuns(await call('run-list'))
  })
  const selectRun = id => { setRunId(id); setMode('run'); setSelectedTask(''); setReconcile({ reason: '', text: '' }); setError('') }
  const focusTask = shown?.tasks?.find(task => task.id === selectedTask)
  const currentTask = focusTask ?? shown?.tasks?.find(task => task.id === shown.settle)
  const currentNode = history?.nodes.find(node => node.name === currentTask?.name && node.kind === currentTask?.kind)
  const delivery = wfDelivery(history, shown)
  const pending = (view.approvals ?? []).filter(card => shown?.tasks?.some(task => task.card === card.id || task.attempts.some(attempt => card.profileId === attempt.sessionId || card.profileId === attempt.profileId)))
  const dock = pending.length > 0 && h('section', { className: 'nodo-wf-task-dock nodo-wf-card-dock', 'aria-label': '待处理' }, ...pending.map(card => h(ApprovalCard, { key: card.id, card, readOnly, refresh })))
  const canOpen = attempt => view.profiles.some(role => role.id === attempt.profileId && role.sessions?.some(session => session.id === attempt.sessionId))
  const checkKey = item => JSON.stringify([item.profile.engine, item.profile.engineOptions, item.workspace?.cwd])
  const inspect = () => perform('check', async () => {
    const results = await Promise.all(participants.filter(item => item.profile && item.workspace).map(async item => {
      const key = checkKey(item)
      const value = await call('engine-check', { engine: item.profile.engine, engineOptions: item.profile.engineOptions, cwd: item.workspace.cwd })
      return [key, value]
    }))
    setChecks(Object.fromEntries(results))
  })
  const views = h('div', { className: 'nodo-wf-views', role: 'group', 'aria-label': '视图' },
    h(Button, { variant: 'ghost', size: 'sm', className: 'nodo-wf-mode', 'aria-pressed': mode === 'edit', onClick: () => setMode('edit') }, '编排'),
    h(Button, { variant: 'ghost', size: 'sm', className: 'nodo-wf-mode', 'aria-pressed': mode === 'run', onClick: () => setMode('run') }, '运行记录'))
  const navigation = h('div', { className: 'nodo-wf-navigation', role: 'navigation', 'aria-label': mode === 'edit' ? '流程' : '运行记录' },
        views,
        mode === 'edit' && h('div', { className: 'nodo-wf-side-title' }, h('strong', null, '流程'),
          h('button', { type: 'button', className: 'nodo-icon-btn nodo-visible', 'aria-label': '新建流程', title: '新建流程', disabled: blocked,
            onClick: () => replace(() => setSaved({ draft: wfNew(), source: null, selected: 'start', positions: {} })) }, h(IconPlusOutlineRegular, { size: 16 }))),
        mode === 'edit' && h('div', { className: 'nodo-wf-definitions' }, ...definitions.map(item => {
          const cast = wfParticipants(wfGraph(item), view).filter(entry => entry.profile)
          return h('div', { key: item.id, className: 'nodo-session-item' },
            h('button', { type: 'button', className: 'nodo-runs-row', disabled: blocked, 'aria-pressed': mode === 'edit' && source?.id === item.id, onClick: () => replace(() => load(item)) },
              h('span', null, item.name),
              h('span', { className: 'nodo-wf-cast', title: cast.map(entry => entry.profile.name).join('、') }, ...cast.slice(0, 3).map(entry => h(RoleAvatar, { key: entry.id, profile: entry.profile, size: 18 })),
                cast.length > 3 && h('span', { className: 'nodo-wf-cast-more' }, '…'))),
            h('span', { className: 'nodo-row-actions' }, h('button', { type: 'button', className: 'nodo-row-action', disabled: blocked,
              'aria-label': `删除流程“${item.name}”`, title: '删除流程', onClick: () => setConfirm({ kind: 'delete', item }) }, h(IconTrashOutlineRegular, { size: 14 }))))
        }),
          !definitions.length && h('p', { className: 'nodo-dialog-hint' }, '还没有保存的流程，从添加节点开始。')),
        mode === 'edit' && h('details', { className: 'nodo-wf-outline' }, h('summary', null, `节点列表 · ${draft.nodes.length}`),
          ...draft.nodes.map((item, index) => h('button', { key: item.id, type: 'button', className: 'nodo-runs-row', 'aria-pressed': selected === item.id, onClick: () => update({ selected: item.id }) }, `${index + 1}. ${item.name || WF_KIND[item.kind]}`))),
        mode === 'run' && h('div', { className: 'nodo-wf-side-title' }, h('strong', null, '最近运行'), loading && h('span', { role: 'status' }, '读取中…')),
        mode === 'run' && h('div', { className: 'nodo-wf-runs' }, ...runs.map(item => h('button', { key: item.id, type: 'button', className: 'nodo-runs-row', 'aria-pressed': mode === 'run' && runId === item.id, disabled: blocked, onClick: () => selectRun(item.id) },
          h('strong', { title: `${item.title ?? '未命名任务'}\n流程：${item.workflowName ?? '未知流程'}` }, item.title ?? '未命名任务'), statusLine(item.status), h('time', null, sessionTime(item.createdAt)))),
          !runs.length && h('p', { className: 'nodo-dialog-hint' }, readOnly ? '请在主窗口查看。' : '还没有运行记录。保存流程后即可启动。')))
  useEffect(() => { wfPublishSidebar({ view: 'workflow', content: navigation }) }, [navigation])
  return h('section', { className: 'nodo-page nodo-workflow', 'aria-label': 'Workflow 工作流', onKeyDown: event => {
    if (mode !== 'edit' || blocked || menu || event.nativeEvent?.isComposing) return
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return
    const target = deletable()
    if (!target) return
    event.preventDefault()
    removeNode(target.id)
  } },
    h('div', { className: 'nodo-wf-workspace' },
    h('header', { className: 'nodo-wf-header' },
      h('div', { className: 'nodo-wf-heading' },
        mode === 'edit' ? h('input', { className: 'nodo-wf-title', 'aria-label': '流程名称', value: draft.name, maxLength: 80, disabled: blocked, onChange: event => update({ draft: { ...draft, name: event.target.value } }) }) : h('h1', { className: 'nodo-wf-title' }, shown ? shown.title ?? '未命名任务' : '运行记录'),
        mode === 'edit' ? h('span', { className: 'nodo-wf-meta' }, `${draft.nodes.length} 个节点 · ${draft.edges.length} 条连线`,
          (dirty || source) && h('span', { className: 'nodo-wf-save-state', role: 'status' }, dirty ? source ? '有未保存修改' : '未保存草稿' : '已保存'))
          : shown && h('span', { className: 'nodo-wf-meta' }, h('span', null, `流程：${shown.workflowName ?? '未知流程'}`), statusLine(shown.status, shown.reason), h('time', null, sessionTime(shown.createdAt)))),
      h('div', { className: 'nodo-wf-toolbar' },
        mode === 'edit' && h('div', { className: 'nodo-wf-save', role: 'group', 'aria-label': '保存' },
          h(Button, { variant: 'ghost', size: 'sm', 'aria-label': '保存', title: busy === 'save' ? '保存中…' : '保存', disabled: blocked || !dirty, onClick: () => save(false),
            icon: h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
              h('path', { d: 'M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' }),
              h('path', { d: 'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7' })) }),
          h(Menu, { open: saveOpen, onClose: () => setSaveOpen(false), portal: true, align: 'end',
            items: [{ id: 'save', label: '保存', disabled: blocked || !dirty }, { id: 'saveAs', label: '另存为新流程…', disabled: blocked || !source }],
            onSelect: id => { setSaveOpen(false); if (id === 'save') save(false); else setConfirm({ kind: 'saveAs', name: copyName() }) },
            anchor: h(Button, { variant: 'ghost', size: 'sm', className: 'nodo-wf-save-more', 'aria-label': '更多保存选项', 'aria-haspopup': 'menu', 'aria-expanded': saveOpen,
              disabled: blocked, icon: h(IconChevronDownOutlineRegular, { size: 12 }), onClick: () => setSaveOpen(open => !open) }) })),
        h('div', { className: 'nodo-wf-action-group', role: 'group', 'aria-label': '运行' },
          h(Button, { variant: 'outline', size: 'sm', disabled: blocked || !!errors.length || !!missing.length || !!view.workflows?.running,
            title: missing.length ? '需要已有的工作区和角色，请在输入栏为节点选择已关联项目的角色。' : errors[0]?.message
              ?? (view.workflows?.running ? '已有流程正在运行。' : dirty ? '运行前会先保存当前修改。' : undefined),
            onClick: () => { setRunTitle(workflowTaskTitle(draft)); setLaunch(true) } },
            h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true }, h('path', { d: 'M7 4.5v15l12.5-7.5z' })), '运行')))),
    readOnly && h('p', { className: 'nodo-wf-notice', role: 'status' }, '只读窗口不读取运行记录，请在主窗口查看和处理工作流。'),
    error && h('p', { className: 'nodo-wf-notice nodo-dialog-error', role: 'alert' }, error),
    source && (!original || error.startsWith('来源流程')) && h('div', { className: 'nodo-wf-notice' }, h('span', null, '当前草稿仍可独立保存。 '),
      h(Button, { variant: 'outline', size: 'sm', disabled: blocked, onClick: () => { update({ source: null }); setError('') } }, '转为独立草稿')),
    h('div', { className: 'nodo-wf-body' },
      h('div', { className: 'nodo-wf-main' },
        mode === 'edit' ? h(Fragment, null,
          h(WorkflowCanvas, { graph: draft, view, selected, positions, busy: blocked, onSelect: id => update({ selected: id }), onPosition: (id, point) => update({ positions: { ...positions, [id]: point } }),
            onConnect: connect, onDisconnect: disconnect, onContext: setMenu,
            trailing: workspacePicker({ workspaces: view.workspaces, workspace: view.workspaces.find(item => item.id === draft.workspaceId), open: placeOpen, setOpen: setPlaceOpen,
              onSelect: id => update({ draft: { ...draft, workspaceId: id || undefined } }), none: '跟随角色会话', button: true, label: '流程运行的工作区', disabled: blocked }),
            tools: h('div', { className: 'nodo-wf-addbar' },
              h(Menu, { open: addOpen, onClose: () => setAddOpen(false), portal: true, align: 'start',
                items: ['agent', 'human', 'end'].map(kind => ({ id: kind, label: `添加${WF_KIND[kind]}`, icon: h(wfIcon(kind)) })),
                onSelect: kind => { setAddOpen(false); add(kind) },
                anchor: h(Button, { variant: 'outline', size: 'sm', disabled: blocked, 'aria-haspopup': 'menu', 'aria-expanded': addOpen, onClick: () => setAddOpen(open => !open) }, '+ 添加节点') })) }),
          node?.kind === 'agent' && h('section', { className: 'nodo-wf-task-dock', 'aria-label': '节点任务输入' },
            h(WorkflowTaskComposer, { key: node.id, node, view, disabled: blocked, onBusy: setInputBusy, onChange: changes => changeTask(node.id, changes) })))
          : shown && shown.status !== 'unreadable' ? h(Fragment, null,
            history ? h(WorkflowCanvas, { key: shown.id, graph: history, view, selected: history.nodes.find(node => node.name === focusTask?.name && node.kind === focusTask?.kind)?.id, positions: {}, history: true, dock,
              onSelect: id => setSelectedTask(history.nodes.find(node => node.id === id)?.kind === 'end' ? '' : history.tasks.get(id)?.at(-1)?.id ?? '') })
              : h('p', { className: 'nodo-wf-notice' }, '原定义已删除或节点名称无法唯一对应，步骤记录见右侧运行概览。'), !history && dock)
          : h('div', { className: 'nodo-wf-empty' }, h(IconBranchOutlineRegular, { size: 36 }), h('h2', null, shown?.status === 'unreadable' ? '这条运行记录无法读取' : loading ? '正在读取运行记录…' : '每一步，都有迹可循'),
            h('p', null, shown?.status === 'unreadable' ? '记录文件保留原样，请返回原会话核对。' : '从左侧选择运行，查看步骤产出、人工决定与执行会话。'))))),
      h('div', { className: 'nodo-wf-drawer', 'data-collapsed': inspectorCollapsed ? '' : undefined },
        h('div', { className: 'nodo-wf-drawer-chrome' }, h(Button, { variant: 'ghost',
          'aria-label': inspectorCollapsed ? '展开节点侧栏' : '收起节点侧栏', 'aria-expanded': !inspectorCollapsed, 'aria-controls': 'nodo-workflow-inspector',
          icon: h(IconPanelLeftOutlineRegular, { size: 16 }), onClick: () => update({ inspectorCollapsed: !inspectorCollapsed }) })),
        h('div', { id: 'nodo-workflow-inspector', className: 'nodo-wf-drawer-content', hidden: inspectorCollapsed },
      mode === 'edit' ? h(WorkflowInspector, { key: node?.id, draft, node, profile: view.profiles.find(item => !item.deletedAt && item.id === node?.profileId), disabled: blocked, onChange: changeNode,
        onEdge: edge => update({ draft: { ...draft, edges: [...draft.edges.filter(item => item.from !== edge.from || item.exit !== edge.exit), edge] } }),
        onRemove: () => removeNode(selected) })
        : h('aside', { className: 'nodo-wf-inspector nodo-wf-run-inspector', 'aria-label': focusTask ? '步骤详情' : '运行概览' },
          h('header', { className: 'nodo-wf-inspector-head' }, h('strong', null, focusTask ? '步骤详情' : '运行概览'),
            !focusTask && shown && h(WorkflowRunDuration, { key: shown.id, run: shown }),
            focusTask && h(Button, { variant: 'ghost', size: 'sm', onClick: () => setSelectedTask('') }, '查看全流程')),
          !focusTask && delivery && h('section', { className: 'nodo-wf-section', 'aria-label': '交付结果' },
            h('h3', null, '交付结果'),
            h('div', { className: 'nodo-run-line' }, h('strong', null, delivery.name), delivery.provenance === 'human' && h(Tag, { tone: 'neutral' }, '人工产出')),
            h('p', { className: 'nodo-run-output nodo-wf-delivery' }, delivery.output === undefined ? '没有可用的产出预览' : `${delivery.output}${delivery.more ? '…' : ''}`),
            delivery.attempts.at(-1)?.sessionId && h(Button, { variant: 'outline', size: 'sm', disabled: blocked || !canOpen(delivery.attempts.at(-1)),
              onClick: () => perform('open', () => onOpenSession(delivery.attempts.at(-1))) }, '打开交付会话')),
          shown && h('section', { className: 'nodo-wf-section', 'aria-label': focusTask ? taskName(focusTask) : '执行步骤' },
            !focusTask && h('div', { className: 'nodo-wf-section-head' }, h('h3', null, '执行步骤'),
              h('span', { className: 'nodo-runs-meta' }, `${shown.tasks.filter(task => task.status === 'done').length} / ${shown.tasks.length} 已完成`)),
            h(RunDetail, { run: focusTask ? { ...shown, tasks: [focusTask], settle: shown.settle === focusTask.id ? shown.settle : undefined } : shown,
              step: Boolean(focusTask), onPick: focusTask ? undefined : setSelectedTask,
              work: view.work, draft: reconcile, busy, readOnly, canOpen, onDraft: setReconcile, onAct: actRun, onOpenSession: attempt => perform('open', () => onOpenSession(attempt)),
              exitHint: currentNode && (currentNode.exits ?? []).map(exit => exit.id), answerHint: currentNode?.options?.map(option => option.label) })),
          h('p', { className: 'nodo-dialog-hint' }, '步骤产出为最多 400 字的预览。完整过程与报告请打开原会话。')))),
    launch && h(Modal, { open: true, title: '启动流程', onClose: () => !busy && setLaunch(false), closeLabel: '关闭', className: 'nodo-dialog', footer: [
      h(Button, { key: 'cancel', variant: 'outline', disabled: blocked, onClick: () => setLaunch(false) }, '取消'),
      h(Button, { key: 'run', variant: 'primary', disabled: blocked || !runTitle.trim() || !!errors.length || !!missing.length || !!view.workflows?.running, onClick: start }, busy === 'launch' ? '启动中…' : '确认运行') ] },
      h('strong', null, draft.name), h('p', { className: 'nodo-dialog-hint' }, `${dirty || !original ? source ? '运行前先把修改保存到当前流程。' : '运行前先保存为新流程。' : ''}按连线顺序派发，每个执行节点使用角色当前项目。启动后清空各执行节点的任务与附件，本次输入记入运行记录。`),
      h(Field, { label: '本次任务标题' }, h('input', { className: 'nodo-dialog-input', 'aria-label': '本次任务标题', value: runTitle, maxLength: 80, disabled: blocked, onChange: event => setRunTitle(event.target.value) })),
      h('div', { className: 'nodo-dialog-fields nodo-wf-steps' }, ...wfSteps(draft).map((step, index) => {
        const item = participants.find(entry => entry.id === step.profileId)
        const routes = draft.edges.filter(edge => edge.from === step.id).map(edge => `${wfPortLabel(step, edge.exit, !edge.back)} ${edge.back ? '↺' : '→'} ${draft.nodes.find(node => node.id === edge.to)?.name ?? '未连接'}`)
        return h('section', { key: step.id, className: 'nodo-wf-association' },
          h('div', { className: 'nodo-wf-person' }, item?.profile ? h(RoleAvatar, { profile: item.profile, size: 20 }) : h(wfIcon(step.kind)), h('strong', null, `${index + 1}. ${step.name}`)),
          h('p', null, step.kind === 'human' ? '人工节点 · 查看上一步产出并选择下一步' : `${item?.profile?.name ?? '角色不可用'} · ${item?.profile?.engine ?? '未知 Agent'} · ${item?.workspace?.name ?? '缺少项目关联'}`),
          routes.length > 0 && h('p', { className: 'nodo-dialog-hint' }, routes.join('；')),
          item?.profile && checks[checkKey(item)] && h('p', { className: 'nodo-dialog-hint' }, checks[checkKey(item)].ok ? '环境检查通过' : '环境需要处理，请返回 Nodo 设置查看'))
      })),
      ...draft.nodes.filter(node => node.kind === 'end').map(node => h('p', { key: node.id, className: 'nodo-dialog-hint' }, `${node.name}的交付来源：${draft.nodes.find(item => item.id === node.deliver)?.name ?? '未选择'}`)),
      h(Button, { variant: 'outline', size: 'sm', disabled: blocked || !!missing.length, onClick: inspect }, busy === 'check' ? '检查中…' : '检查参与 Agent'),
      error && h('p', { className: 'nodo-dialog-error', role: 'alert' }, error)),
    menu && mode === 'edit' && h(Menu, { open: true, onClose: () => setMenu(null), portal: true, align: 'start',
      // The host Menu measures its in-flow wrapper unless given the rect; the wrapper sits at the page end.
      getAnchorRect: () => ({ left: menu.clientX, top: menu.clientY, right: menu.clientX, bottom: menu.clientY, width: 0, height: 0 }),
      items: [...['agent', 'human', 'end'].map(kind => ({ id: `add:${kind}`, label: `添加${WF_KIND[kind]}`, icon: h(wfIcon(kind)) })),
        ...(menu.connection ? [] : menu.node && draft.nodes.find(item => item.id === menu.node && item.kind !== 'start')
          ? [{ id: 'delete', label: '删除节点', icon: h(IconTrashOutlineRegular), danger: true }]
          : !menu.node && deletable() ? [{ id: 'delete', label: '删除选中节点', icon: h(IconTrashOutlineRegular), danger: true }] : [])],
      onSelect: id => {
        const at = menu.plane
        setMenu(null)
        if (id.startsWith('add:')) add(id.slice(4), { x: at.x - 102, y: at.y - 48 }, menu.connection)
        else if (id === 'delete') removeNode(menu.node && draft.nodes.some(item => item.id === menu.node && item.kind !== 'start') ? menu.node : deletable()?.id)
      },
      anchor: h('span', { style: { position: 'fixed', width: 0, height: 0 } }) }),
    confirm?.kind === 'discard' && h(Modal, { open: true, title: '替换当前草稿？', onClose: () => setConfirm(null), closeLabel: '关闭', className: 'nodo-dialog', footer: [
      h(Button, { key: 'keep', variant: 'outline', onClick: () => setConfirm(null) }, '保留草稿'), h(Button, { key: 'discard', variant: 'primary', onClick: () => { confirm.action(); setConfirm(null) } }, '放弃草稿并继续') ] }, h('p', null, '当前修改尚未保存，继续会替换这份草稿。')),
    confirm?.kind === 'saveAs' && h(Modal, { open: true, title: '另存为新流程', onClose: () => setConfirm(null), closeLabel: '关闭', className: 'nodo-dialog', footer: [
      h(Button, { key: 'cancel', variant: 'outline', onClick: () => setConfirm(null) }, '取消'),
      h(Button, { key: 'save', variant: 'primary', disabled: blocked || !asName || asClash, onClick: () => saveAs(asName) }, '保存')] },
      h(Field, { label: '流程名称' }, h('input', { className: 'nodo-dialog-input', value: confirm.name, maxLength: 80, autoFocus: true,
        onChange: event => setConfirm({ ...confirm, name: event.target.value }),
        onKeyDown: event => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing && asName && !asClash && !blocked) saveAs(asName) } })),
      asClash && h('p', { className: 'nodo-dialog-error', role: 'alert' }, '已有同名流程，请换一个名称。')),
    confirm?.kind === 'delete' && h(Modal, { open: true, title: `删除流程“${confirm.item.name}”？`, onClose: () => setConfirm(null), closeLabel: '关闭', className: 'nodo-dialog', footer: [
      h(Button, { key: 'keep', variant: 'outline', onClick: () => setConfirm(null) }, '取消'),
      h(Button, { key: 'delete', variant: 'outline', className: 'nodo-dialog-danger', disabled: blocked, onClick: () => { const id = confirm.item.id; setConfirm(null)
        perform('delete', async () => { await call('workflow-delete', { id }); if (source?.id === id) update({ source: null }) }) } }, '删除') ] },
      h('p', null, '删除后不能恢复。已有运行记录保留；正在编辑的内容转为未保存草稿。')))
}

export function WorkflowEntry() {
  const { view, error, refresh } = useStateView()
  useEffect(() => {
    if (document.querySelector('[data-sidebar-collapsed]')) layoutService?.toggleSidebar()
    return () => wfPublishSidebar(null)
  }, [])
  const open = async attempt => {
    const profile = view.profiles.find(item => item.id === attempt.profileId), session = profile?.sessions.find(item => item.id === attempt.sessionId)
    if (!session) return
    const workspace = wfWorkspace(view, profile, session)
    if (session.archivedAt) {
      setNavigation(current => ({ ...current, profile: profile.id, workspace: session.workspaceRef, archivedSession: session.id }))
      nativeSpace.showLegacy()
      return
    }
    const native = nativeRole(profile) && openNativeSession
    if (native) {
      const opened = await call('session-open', { profile: profile.id, session: session.id, workspace: workspace?.id })
      openNativeSession(opened.sessionId)
    } else {
      if (!view.readOnly) await call('session-select', { profile: profile.id, session: session.id })
      setNavigation(current => ({ ...current, archivedSession: undefined, profile: profile.id, workspace: workspace?.id, sessions: { ...current.sessions, [`${workspace?.id}:${profile.id}`]: session.id } }))
      nativeSpace.showLegacy()
    }
  }
  if (!view) return h('section', { className: 'nodo-page nodo-wf-empty' }, error || '正在读取工作流…')
  return h(WorkflowPage, { view, readOnly: !!view.readOnly, refresh, onOpenSession: open })
}

export const WORKFLOW_CSS = `
.nodo-workflow{--nodo-wf-shadow:color-mix(in srgb,var(--dsw-alias-border-l1) 55%,var(--dsw-alias-label-tertiary));--nodo-wf-rework:var(--dsw-alias-state-warn-primary);flex-direction:row;overflow:hidden;font-size:13px;line-height:1.5}
.nodo-wf-workspace{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.nodo-wf-header{--nodo-wf-header-gutter:20px;box-sizing:border-box;display:flex;align-items:center;gap:12px;min-height:max(44px,var(--dsh-frame-top-clearance,0px));padding:6px var(--nodo-wf-header-gutter);padding-inline-start:max(var(--nodo-wf-header-gutter),var(--dsh-frame-leading-clearance,0px));border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;-webkit-app-region:drag}
.nodo-wf-heading{display:flex;flex-direction:column;flex:1;min-width:80px}
.nodo-wf-header input,.nodo-wf-toolbar,.nodo-wf-drawer-chrome button{-webkit-app-region:no-drag}
.nodo-wf-meta{display:flex;align-items:center;gap:8px;min-width:0;font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;color:var(--dsw-alias-label-tertiary)}
.nodo-wf-save-state::before{content:'· '}
.nodo-wf-toolbar{margin-left:auto;display:flex;flex:none;align-items:center;gap:12px;max-width:calc(100% - 92px);overflow-x:auto}
.nodo-wf-views{display:flex;flex:none;gap:20px;padding:0 8px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.nodo-wf-views .nodo-wf-mode{height:32px;padding:0;border-radius:0;background:0 0;color:var(--dsw-alias-label-tertiary);box-shadow:inset 0 -2px transparent}
.nodo-wf-views .nodo-wf-mode:hover,.nodo-wf-views .nodo-wf-mode[aria-pressed=true]{background:0 0;color:var(--dsw-alias-label-primary)}
.nodo-wf-views .nodo-wf-mode[aria-pressed=true]{box-shadow:inset 0 -2px var(--dsw-alias-label-primary)}
.nodo-wf-action-group{display:flex;align-items:center;gap:6px;flex:none}
.nodo-wf-action-group button{border-radius:999px}
.nodo-wf-action-group svg{margin-right:4px;color:var(--dsw-alias-state-business-primary)}
.nodo-wf-body{display:flex;flex:1;min-height:0;min-width:0}
.nodo-wf-navigation{display:flex;flex-direction:column;gap:12px;padding:18px 0 8px;flex:1;min-height:0}
.nodo-wf-side-title{display:flex;align-items:center;justify-content:space-between;padding:0 8px;font-size:13px;flex:none}
.nodo-wf-side-title>strong{font-weight:600}
.nodo-wf-side-title>span{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.nodo-wf-definitions{max-height:28%;overflow:auto;flex-shrink:0}
.nodo-wf-definitions .nodo-runs-row{display:flex;flex-direction:row;justify-content:space-between;gap:8px;align-items:center}
.nodo-wf-definitions .nodo-session-item>.nodo-runs-row{flex:1;min-width:0}
.nodo-wf-definitions .nodo-runs-row>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-wf-cast{display:flex;flex:none}
.nodo-wf-cast>*+*{margin-left:2px}
.nodo-wf-cast>.nodo-wf-cast-more{margin-left:2px;color:var(--dsw-alias-label-tertiary);line-height:18px}
.nodo-wf-outline{max-height:24%;overflow:auto;font-size:11px;color:var(--dsw-alias-label-secondary);flex-shrink:0}
.nodo-wf-outline summary{padding:4px 8px;cursor:pointer}
.nodo-wf-runs{flex:1;min-height:0;overflow:auto}
.nodo-wf-runs .nodo-runs-row{flex-direction:row;align-items:center;gap:8px;padding:6px 10px;margin-bottom:2px}
.nodo-wf-runs .nodo-runs-row>*{flex:none;white-space:nowrap}
.nodo-wf-runs .nodo-runs-row>strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-wf-navigation .nodo-runs-row[aria-pressed=true]{background:var(--dsw-specific-sidebar-nav-item-active-accent);color:var(--dsw-alias-state-business-primary)}
.nodo-wf-runs time{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.nodo-wf-main{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;position:relative}
.nodo-wf-drawer{display:flex;flex-direction:column;width:320px;flex:none;min-height:0;border-left:1px solid var(--dsw-alias-border-l2);transition:width .16s ease;overflow:hidden}
.nodo-wf-drawer[data-collapsed]{width:fit-content}
.nodo-wf-drawer-chrome{box-sizing:border-box;display:flex;justify-content:flex-end;align-items:flex-start;height:max(36px,var(--dsh-frame-top-clearance,0px));padding:10px 12px 0;flex:none;-webkit-app-region:drag}
.nodo-wf-drawer-chrome svg{transform:rotate(180deg)}
.nodo-wf-drawer-content{display:flex;flex:1;min-height:0;min-width:0}
.nodo-wf-drawer-content[hidden]{display:none}
.nodo-wf-task-dock{position:absolute;left:0;right:0;bottom:16px;z-index:3;min-width:0;width:calc(100% - 32px);max-width:calc(var(--dsh-chat-content-width,748px) + 32px);margin:0 auto;container-type:inline-size}
.nodo-wf-card-dock{display:flex;flex-direction:column;gap:8px;max-height:calc(100% - 32px);overflow-y:auto;overscroll-behavior:contain}
.nodo-wf-card-dock .nodo-question-frame{padding:0}
.nodo-wf-task-dock .nodo-composer{width:100%;max-width:100%;margin:0}
.nodo-wf-task-dock .nodo-perm{flex:0 1 auto;min-width:0}
.nodo-wf-task-dock .nodo-perm-trigger{max-width:100%}
.nodo-wf-task-dock .nodo-role-seat{max-width:min(160px,35cqw)}
.nodo-wf-task-dock .nodo-role-seat-trigger>svg,.nodo-wf-task-dock .nodo-chevron{flex:none}
.nodo-wf-task-dock .nodo-composer-scroll{max-height:min(160px,24vh)}
.nodo-wf-input-error{margin:4px 0 0;padding:4px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);font-size:12px;color:var(--dsw-alias-state-error-primary)}
.nodo-wf-title{font:inherit;font-size:14px;font-weight:600;min-width:0;width:100%;margin:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:4px 0;outline:none}
.nodo-wf-title:focus-visible{box-shadow:0 1px var(--dsw-alias-state-business-primary)}
.nodo-wf-addbar{display:flex}
.nodo-wf-save{display:flex;flex:none;align-items:center;gap:1px;padding:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px}
.nodo-wf-save button{border-radius:999px}
.nodo-wf-save .nodo-wf-save-more{min-width:0;width:22px;padding:0}
.nodo-wf-addbar button{border-radius:999px;background:var(--dsw-alias-bg-base);box-shadow:1px 1px 0 var(--nodo-wf-shadow)}
.nodo-wf-stage{position:relative;flex:1;min-height:140px;min-width:0;overflow:hidden;background-image:radial-gradient(var(--dsw-alias-border-l2) 1px,transparent 1.2px);background-size:22px 22px}
.nodo-wf-viewport{height:100%;overflow:hidden;touch-action:none}
.nodo-wf-plane{position:relative;transform-origin:top left}
.nodo-wf-wires{position:absolute;inset:0;overflow:visible;color:var(--dsw-alias-state-business-primary)}
.nodo-wf-wire{stroke:currentColor;stroke-width:2.2;cursor:pointer}
.nodo-wf-wire text{font-size:11px;font-weight:600;fill:currentColor;paint-order:stroke;stroke:var(--dsw-alias-bg-base);stroke-width:4px;stroke-linejoin:round}
.nodo-wf-wire-hit{stroke:transparent;stroke-width:18px}
.nodo-wf-wire-action{opacity:0;pointer-events:none}
.nodo-wf-wire:is(:hover,:focus-within) .nodo-wf-wire-action{opacity:1;pointer-events:auto}
.nodo-wf-wire-delete{display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-state-error-primary);cursor:pointer;stroke:none}
.nodo-wf-wire-delete:hover{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.nodo-wf-back{color:var(--nodo-wf-rework)}
.nodo-wf-back>path:not(.nodo-wf-wire-hit){stroke-dasharray:6 5}
.nodo-wf-wire-unused{opacity:.24}
.nodo-wf-wire-preview{stroke:var(--dsw-alias-state-business-primary);stroke-width:2.2;stroke-dasharray:6 5;pointer-events:none}
.nodo-wf-wire-preview[data-back]{stroke:var(--nodo-wf-rework)}
.nodo-wf-node[data-link-target]{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px var(--dsw-specific-sidebar-nav-item-active-accent)}
.nodo-wf-port{position:absolute;top:50%;width:14px;height:14px;margin-top:-7px;border-radius:5px;border:2px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);touch-action:none;opacity:0;pointer-events:none}
.nodo-wf-node:is(:hover,:focus-visible,[data-link-source],[data-link-target]) .nodo-wf-port{opacity:1}
.nodo-wf-node:is(:hover,:focus-visible,[data-link-source],[data-link-target]) .nodo-wf-port-out{pointer-events:auto}
.nodo-wf-port-out{right:-8px;border-color:var(--dsw-alias-state-business-primary);cursor:crosshair}
.nodo-wf-port-out:hover{background:var(--dsw-alias-state-business-primary)}
.nodo-wf-port[aria-disabled=true]{cursor:default}
.nodo-wf-port-in{left:-8px;pointer-events:none}
.nodo-wf-port[data-back]{border-color:var(--nodo-wf-rework)}
.nodo-wf-port-out[data-back]:hover{background:var(--nodo-wf-rework)}
.nodo-wf-node{position:absolute;display:flex;align-items:center;gap:12px;width:204px;min-height:96px;padding:16px;border:2px solid color-mix(in srgb,var(--nodo-wf-tint,var(--dsw-alias-border-l1)) 45%,var(--dsw-alias-border-l2));border-radius:24px;background:var(--dsw-alias-bg-layer-1);box-shadow:1px 1px 0 var(--nodo-wf-shadow);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;touch-action:none}
.nodo-wf-node[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);box-shadow:1px 1px 0 var(--nodo-wf-shadow),0 0 0 5px var(--dsw-specific-sidebar-nav-item-active-accent)}
.nodo-wf-node-avatar{display:flex;flex:none}
.nodo-wf-node-icon{--nodo-wf-kind:var(--dsw-alias-state-business-primary);display:flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;border-radius:50%;color:var(--nodo-wf-kind);background:color-mix(in srgb,var(--nodo-wf-kind) 14%,transparent)}
:is(.nodo-wf-node,.nodo-wf-node-icon)[data-kind=start] .nodo-wf-node-icon,.nodo-wf-node-icon[data-kind=start]{--nodo-wf-kind:var(--dsw-alias-state-success-primary)}
:is(.nodo-wf-node,.nodo-wf-node-icon)[data-kind=human] .nodo-wf-node-icon,.nodo-wf-node-icon[data-kind=human]{--nodo-wf-kind:var(--dsw-alias-state-warn-primary)}
.nodo-wf-node-copy{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.nodo-wf-node-copy strong{font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-wf-node-copy>span,.nodo-wf-node-copy small{font-size:12px;color:color-mix(in srgb,var(--dsw-alias-label-secondary) 80%,var(--dsw-alias-label-primary));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-wf-canvas-tools{position:absolute;top:12px;left:16px;z-index:2;display:flex;align-items:center;gap:16px;max-width:calc(100% - 32px)}
.nodo-wf-canvas-trail{position:absolute;top:12px;right:16px;z-index:2;display:flex;align-items:center}
.nodo-wf-canvas-trail .nodo-project-pick{border-radius:999px;background:var(--dsw-alias-bg-base);box-shadow:1px 1px 0 var(--nodo-wf-shadow)}
.nodo-wf-zoom{display:flex;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.nodo-wf-zoom button{min-width:28px;height:28px;padding:0 6px;color:inherit;font-size:11px}
.nodo-wf-zoom>span{min-width:36px;text-align:center}
.nodo-wf-inspector{display:flex;flex-direction:column;flex:1;min-width:0;gap:16px;min-height:0;overflow:auto;padding:0 20px 20px}
.nodo-wf-inspector-head{display:flex;align-items:center;gap:10px}
.nodo-wf-inspector-head>div{display:flex;flex-direction:column;min-width:0}
.nodo-wf-inspector-head strong{font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-wf-inspector-head span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.nodo-wf-inspector .nodo-field{display:flex;flex-direction:column;gap:7px;padding:0;border:0;font-size:12px}
.nodo-wf-inspector .nodo-dialog-input{font-size:12px;padding:7px 10px;height:36px;border-radius:var(--dsw-radius-md)}
.nodo-wf-inspector .nodo-dialog-textarea{height:auto;min-height:116px}
.nodo-wf-steps{margin:12px 0;border-block:.5px solid var(--dsw-alias-border-l2)}
.nodo-wf-association{display:flex;flex-direction:column;gap:2px;padding:8px 0;font-size:13px;line-height:1.5}
.nodo-wf-association+.nodo-wf-association{border-top:.5px solid var(--dsw-alias-border-l2)}
.nodo-wf-association p{margin:0}
.nodo-wf-person{display:flex;align-items:center;gap:8px}
.nodo-wf-section{display:flex;flex-direction:column;gap:12px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2)}
.nodo-wf-section h3{font-size:13px;margin:0;font-weight:600}
.nodo-wf-inspector>.nodo-field>span{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.nodo-wf-choice{display:flex;flex-direction:column;gap:9px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg)}
.nodo-wf-choice:has(>.nodo-wf-checks){gap:12px;padding:14px;border-radius:20px}
.nodo-wf-checks{--nodo-wf-exit:var(--dsw-alias-state-business-primary);display:flex;flex-direction:column;gap:6px}
.nodo-wf-checks[data-exit=rework]{--nodo-wf-exit:var(--nodo-wf-rework)}
.nodo-wf-checks+.nodo-wf-checks{padding-top:12px;border-top:1px dashed var(--dsw-alias-border-l2)}
.nodo-wf-checks-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.nodo-wf-checks-head strong{display:flex;align-items:center;gap:6px;flex:none}
.nodo-wf-checks-head strong::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--nodo-wf-exit)}
.nodo-wf-target{min-width:0;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-overlay)}
.nodo-wf-target[data-linked]{color:var(--nodo-wf-exit);background:color-mix(in srgb,var(--nodo-wf-exit) 12%,transparent)}
.nodo-wf-checks>button{align-self:flex-start;color:var(--nodo-wf-exit)}
.nodo-wf-choice>button{align-self:flex-start;color:var(--dsw-alias-state-business-primary)}
.nodo-wf-check{position:relative;display:flex}
.nodo-wf-check>input{flex:1;min-width:0}
.nodo-wf-check:has(>button)>.nodo-dialog-input{padding-right:34px}
.nodo-wf-check>button{position:absolute;top:50%;right:4px;width:28px;min-width:0;height:28px;padding:0;transform:translateY(-50%)}
.nodo-wf-limit{display:flex;align-items:center;gap:4px;padding:4px 4px 4px 10px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-overlay)}
.nodo-wf-limit>span{flex:1;font-weight:600}
.nodo-wf-limit output{min-width:36px;text-align:center;font-weight:600}
.nodo-wf-node-actions{display:flex;margin-top:auto;padding-top:16px}
.nodo-wf-node-actions>button{flex:1;justify-content:center;height:36px;border-radius:var(--dsw-radius-lg)}
.nodo-wf-notice{margin:0;padding:10px 20px;background:var(--dsw-alias-bg-overlay);font-size:12px;flex:none}
.nodo-wf-run-inspector .nodo-run{overflow:visible;flex:none;padding:0}
.nodo-wf-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.nodo-wf-run-inspector .nodo-wf-inspector-head{justify-content:space-between}
.nodo-wf-run-duration{white-space:nowrap}
.nodo-wf-delivery{max-height:180px;overflow-y:auto;padding:8px 12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
.nodo-wf-run-inspector .nodo-run>.nodo-run-task:first-child{padding-top:0;border-top:0}
.nodo-wf-run-inspector .nodo-run-actions,.nodo-wf-run-inspector .nodo-run-attempt{flex-wrap:wrap;justify-content:flex-start}
.nodo-wf-run-inspector .nodo-question-frame,.nodo-wf-run-inspector .nodo-approval{width:100%;margin:0}
.nodo-wf-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;flex:1;text-align:center;padding:32px;color:var(--dsw-alias-label-secondary)}
.nodo-wf-empty h2{font-size:18px;color:var(--dsw-alias-label-primary)}
.nodo-workflow button:focus-visible,.nodo-workflow summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
@media(max-width:1100px){.nodo-wf-drawer:not([data-collapsed]){width:280px}.nodo-wf-inspector{padding:0 14px 14px}.nodo-wf-header{gap:10px}.nodo-wf-save-state{display:none}}
@media(max-width:800px){.nodo-wf-drawer:not([data-collapsed]){width:min(280px,55%)}.nodo-wf-header{--nodo-wf-header-gutter:14px}}
@media(max-width:520px){.nodo-wf-canvas-tools{gap:8px;left:8px}.nodo-wf-canvas-trail{right:8px}.nodo-wf-toolbar{gap:8px}.nodo-wf-header{gap:8px}}
@media(prefers-reduced-motion:reduce){.nodo-wf-drawer{transition:none}}
`
