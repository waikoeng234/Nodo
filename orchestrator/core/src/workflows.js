// Workflows: a definition is a node graph (start → work and decision nodes → end);
// one saved as the older `steps[]` list is converted on read and never rewritten.
// A node with more than one exit lets its taker choose: a person by an option,
// an agent by the last line of its report, `NEXT: <exit>`. A choice that cannot
// be read, or `blocked`, stops the run for a person. An edge marked `back` returns
// to an earlier node as a new task, at most `back.max` times; the step reworked
// goes on in its earlier conversation when it can, given only what sent it back.
// A run is persisted through the Run Store (runs.js) and moves one task at a time:
// each state change, its events and the successor task are saved in one commit.
// An agent task gets a session of its own and an exclusive send, so it never
// steers into or queues behind another message; its report (the engine's last
// message of the turn where the path reports one, else the turn's text) is the
// artifact handed to the nodes after it. A decision node's question lives in
// the run file, so its card comes back after a restart and the run resumes when it
// is answered. A step has no time limit. A cancel stops further dispatch and
// interrupts the step in progress; only an end the engine reports frees it.
// A step whose end is unknown holds its workspace until a person reconciles it,
// and after a restart nothing is dispatched again without one.
// Work in files travels by itself: profiles that hand off code share
// a workspace.
import { createHash, randomUUID } from 'node:crypto'
import { ANSWER_TEXT_MAX, RUN_BACK_MAX, TASK_TEXT_MAX } from './constants.js'
import { materializeHandoff } from './workflow-materials.js'
import { runTaskTitle, workflowSessionTitle, workflowTitleSource } from '../shared/task-titles.js'

const identityOf = profile => {
  const fields = { name: profile.name, role: profile.role ?? '', instructions: profile.instructions ?? '', goal: profile.goal ?? '', env: [...(profile.env ?? [])], engine: profile.engine, engineOptions: { ...profile.engineOptions } }
  return { ...fields, identityVersion: createHash('sha256').update(JSON.stringify(fields)).digest('hex') }
}

// Old `steps[]` definitions: start → s1 → … → end, delivering the last work step.
export const graphOf = (workflow) => {
  if (Array.isArray(workflow.nodes)) return { nodes: workflow.nodes, edges: workflow.edges ?? [] }
  const steps = workflow.steps.map((step, index) => step.decide === true
    ? { id: `s${index + 1}`, kind: 'human', name: step.name, question: step.question, options: [{ id: 'continue', label: '继续' }] }
    : { id: `s${index + 1}`, kind: 'agent', name: step.name, profileId: step.profileId, task: step.task, completion: 'text', session: 'new' })
  const deliver = steps.findLast(node => node.kind === 'agent') ?? steps.at(-1)
  const nodes = [{ id: 'start', kind: 'start', name: 'start', inputs: [] }, ...steps, { id: 'end', kind: 'end', name: 'end', deliver: deliver?.id }]
  const edges = nodes.slice(0, -1).map((node, index) => ({ from: node.id, exit: node.kind === 'human' ? 'continue' : 'done', to: nodes[index + 1].id }))
  return { nodes, edges }
}

const BLOCKED = 'blocked'
// A decision's own exit, wired by no edge: back to the step whose report it answers.
const BACK = '$back'
const REPORT_SHOWN = 2000
const ID = /^[a-z][a-z0-9_]{0,31}$/

// The exits a node can leave by.
export const exitsOf = node => node.kind === 'end' ? []
  : node.kind === 'human' ? (node.options ?? []).map(option => option.id)
  : node.kind === 'agent' && node.exits?.length ? node.exits.map(exit => exit.id) : ['done']

// The exit a report or an answer takes, undefined when it names none. Only an
// agent's last non-empty line is read; `blocked` is every multi-exit agent's own.
export const exitFrom = (node, text) => {
  const exits = exitsOf(node)
  if (node.kind === 'human') return node.options?.find(option => option.label === String(text).trim())?.id
  if (exits.length < 2) return exits[0]
  const id = /^NEXT:\s*(\S+)$/.exec(String(text).trim().split('\n').at(-1).trim())?.[1]
  return id === BLOCKED || exits.includes(id) ? id : undefined
}

// The step a decision can send back to: the agent task that led to it.
const backTo = (run, task) => {
  const from = task.from && run.tasks[task.from.taskId]
  return from && run.snapshot.graph.nodes.find(node => node.id === from.nodeId)?.kind === 'agent' ? from : undefined
}
const edgeOf = (run, task, exit) => exit === BACK
  ? backTo(run, task) && { from: task.nodeId, exit, to: backTo(run, task).nodeId, back: {} }
  : run.snapshot.graph.edges.find(item => item.from === task.nodeId && item.exit === exit)
const choiceOf = (node, exit) => exit === BACK ? '退回上一步' : node.options?.find(option => option.id === exit)?.label ?? exit

// A task that stops waiting for its question voids it: a later answer is refused.
const setTask = (run, event, task, status, reason) => {
  task.status = status
  task.updatedAt = Date.now()
  if (reason !== undefined) task.reason = reason
  else delete task.reason
  const request = task.requestId && run.requests?.[task.requestId]
  if (request?.status === 'open' && status !== 'active') request.status = 'void'
  event('task/status', { taskId: task.id, data: { status, ...(reason !== undefined ? { reason } : {}) } })
}

const setRun = (run, event, status, reason) => {
  run.status = status
  if (reason !== undefined) run.reason = String(reason).slice(0, 500)
  else delete run.reason
  if (['done', 'failed', 'cancelled'].includes(status)) run.endedAt = Date.now()
  event('run/status', { data: { status, ...(reason !== undefined ? { reason: run.reason } : {}) } })
}

// Stops the run on a task that cannot go on by itself.
export const halt = (run, event, task, status, reason) => {
  setTask(run, event, task, status, reason)
  setRun(run, event, status === 'waiting_human' || status === 'needs_reconcile' ? status : status === 'cancelled' ? 'cancelled' : 'failed', reason)
}

const STOPPABLE = ['running', 'waiting_human', 'paused']
const LIVE = ['dispatching', 'running', 'parsing', 'cancelling']
const UNKNOWN = Symbol('unknown workspace')
const SETTLE = ['needs_reconcile', 'waiting_human']
// The task a person settles: the first one the run stopped on.
const settling = run => SETTLE.includes(run.status) ? Object.values(run.tasks).find(task => SETTLE.includes(task.status)) : undefined

// Cancels the run and every task still open in it.
const stopRun = (run, event, reason) => {
  for (const task of Object.values(run.tasks)) if (['pending', 'active', 'waiting_human', 'needs_reconcile'].includes(task.status)) setTask(run, event, task, 'cancelled', reason)
  setRun(run, event, 'cancelled', reason)
}

const addTask = (run, event, nodeId, key, from) => {
  if (Object.values(run.tasks).some(task => task.key === key)) return
  const now = Date.now()
  const task = { id: randomUUID(), nodeId, status: 'pending', key, ...(from ? { from } : {}), attempts: [], createdAt: now, updatedAt: now }
  run.tasks[task.id] = task
  event('task/create', { taskId: task.id, data: { nodeId } })
}

// Marks a task done and creates its successor in the same commit; the creation
// key keeps a repeated commit from adding a second successor. A back edge taken
// as often as it may be stops for a person instead.
export const advance = (run, event, task, exit, reason) => {
  setTask(run, event, task, 'done', reason)
  const edge = edgeOf(run, task, exit)
  if (!edge) return halt(run, event, task, 'waiting_human', 'no_exit')
  const key = `${task.id}:${exit}`
  const taken = () => Object.values(run.tasks).filter(item => item.key !== key && item.from?.exit === exit && run.tasks[item.from.taskId]?.nodeId === task.nodeId).length
  if (edge.back && taken() >= (edge.back.max ?? run.snapshot.limits.backMax)) return halt(run, event, task, 'waiting_human', 'back_limit')
  addTask(run, event, edge.to, key, { taskId: task.id, exit })
}

export function install(rt) {
  const { state } = rt
  let running = null // {id, name, startedAt, runId, cancelled?, finished?}
  let flight = null // the agent attempt in progress: {runId, stopping, stopped, stop(reason)}
  const cards = new Map() // request id → card id shown
  const waiters = new Map() // request id → resolves the run loop waiting on it
  const busy = () => Object.assign(new Error(`"${running.name}" is still running`), { code: 'orch/busy' })
  const stale = message => Object.assign(new Error(message), { code: 'orch/stale' })
  const hold = (id, name, runId = null) => {
    if (running !== null) throw busy()
    return (running = { id, name, startedAt: Date.now(), runId })
  }
  const cardId = (run, request) => `run:${run.id}:${request.id}:${request.version}`

  // Shows a card for each question the run still waits on and drops the rest.
  const syncCards = (run) => {
    for (const request of Object.values(run.requests ?? {})) {
      const open = request.status === 'open' && run.status === 'running' && run.tasks[request.taskId]?.status === 'active'
      const id = open ? cardId(run, request) : undefined
      const shown = cards.get(request.id)
      if (shown !== undefined && shown !== id) rt.dropQuestion(shown)
      if (id === undefined) {
        cards.delete(request.id)
        waiters.get(request.id)?.(run)
        waiters.delete(request.id)
        continue
      }
      const task = run.tasks[request.taskId], from = task.from && run.tasks[task.from.taskId], report = from && run.artifacts[from.output]?.text, back = backTo(run, task)
      const question = request.question || (from ? `查看「${nodeOf(run, from).name}」的产出，选择下一步` : '选择下一步')
      // An old run may wait on a text-only question: the card shows it can no longer be answered.
      const legacy = nodeOf(run, task)?.kind === 'human' && !(request.options ?? []).length
      rt.holdQuestion({ id, name: run.workflowName, question, at: request.createdAt, detail: { exits: request.options ?? [],
        ...(legacy ? { legacy: true } : {}),
        ...(back ? { back: nodeOf(run, back).name } : {}),
        ...(report ? { report: { step: nodeOf(run, from).name, text: report.slice(0, REPORT_SHOWN), more: report.length > REPORT_SHOWN } } : {}) } })
      cards.set(request.id, id)
    }
    return run
  }
  const commit = async (id, mutate) => syncCards(await rt.commit(id, mutate))

  const cleanSteps = (raw) => {
    if (!Array.isArray(raw) || raw.length === 0) throw Object.assign(new Error('A workflow needs at least one step'), { code: 'orch/invalid' })
    return raw.map((step) => {
      if (step?.decide === true) {
        const question = String(step.question ?? '').trim()
        if (question === '') throw Object.assign(new Error('A decide step needs a question'), { code: 'orch/invalid' })
        return { decide: true, name: String(step.name ?? 'decision').slice(0, 60), question }
      }
      const profile = rt.findProfile(step?.profile)
      if (profile === undefined) throw Object.assign(new Error(`Step profile "${step?.profile}" does not exist`), { code: 'orch/invalid' })
      const task = String(step.task ?? '').trim().slice(0, TASK_TEXT_MAX)
      if (task === '') throw Object.assign(new Error('A step needs a task'), { code: 'orch/invalid' })
      return { name: String(step.name ?? profile.name).slice(0, 60), profileId: profile.id, profileName: profile.name, task }
    })
  }

  // `fail` reports what a run needs and a draft may still lack; shape faults throw either way.
  const cleanNode = (raw, fail) => {
    const invalid = message => Object.assign(new Error(message), { code: 'orch/invalid' })
    const id = String(raw?.id ?? '')
    if (!['start', 'end', 'human', 'agent'].includes(raw?.kind)) throw invalid(`Node "${id}" has an unknown kind "${raw?.kind}"`)
    if (!ID.test(id)) fail(`Node id "${id}" must be lowercase letters, digits or _, starting with a letter`)
    const base = { id, kind: raw.kind, name: String(raw.name ?? id).slice(0, 60) }
    const choices = (list, what, reserved, text) => {
      if (list === undefined) return undefined
      if (!Array.isArray(list) || list.length === 0) return fail(`Node "${id}" lists no ${what}s`)
      const clean = list.map(item => ({ id: String(item?.id ?? ''), [text]: String(item?.[text] ?? '').split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 2000) }))
      for (const item of clean) {
        if (!ID.test(item.id) || item.id === reserved) fail(`Node "${id}" has an invalid ${what} id "${item.id}"`)
        if (item[text] === '') fail(`The ${what} "${item.id}" of node "${id}" needs a ${text}`)
      }
      if (new Set(clean.map(item => item.id)).size < clean.length || new Set(clean.map(item => item[text])).size < clean.length) fail(`Node "${id}" repeats a ${what}`)
      return clean
    }
    if (raw.kind === 'start') return { ...base, inputs: [] }
    if (raw.kind === 'end') return { ...base, deliver: String(raw.deliver ?? '') }
    if (raw.kind === 'human') {
      const question = String(raw.question ?? '').trim().slice(0, ANSWER_TEXT_MAX)
      const options = choices(raw.options ?? [], 'option', undefined, 'label')
      return { ...base, ...(question ? { question } : {}), options: options ?? [] }
    }
    const profile = rt.findProfile(raw.profile ?? raw.profileId)
    if (profile === undefined) fail(`Node "${id}": profile "${raw.profile ?? raw.profileId}" does not exist`)
    const task = String(raw.task ?? '').trim().slice(0, TASK_TEXT_MAX)
    const images = rt.cleanImageRefs(raw.images), files = rt.cleanFileRefs(raw.files)
    if (task === '' && !images.length && !files.length) fail(`Node "${id}" needs a task`)
    const selected = raw.choices === undefined || profile === undefined ? undefined : rt.cleanSessionChoices(profile, raw.choices)
    const exits = choices(raw.exits, 'exit', BLOCKED, 'when')
    return { ...base, name: String(raw.name ?? profile?.name ?? id).slice(0, 60), profileId: profile?.id ?? String(raw.profile ?? raw.profileId ?? ''), task, completion: 'text', session: 'new',
      ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(selected ? { choices: selected } : {}), ...(exits ? { exits } : {}) }
  }

  // One start, every exit wired to one node, and loops only through back edges to
  // a node leading there; with a way forward from every node, every path can end.
  // A draft is saved without these checks; a run passes them before it starts.
  const cleanGraph = (rawNodes, rawEdges, strict = true) => {
    const invalid = message => Object.assign(new Error(message), { code: 'orch/invalid' })
    const fail = strict ? message => { throw invalid(message) } : () => {}
    if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges ?? [])) throw invalid('A workflow graph needs a list of nodes and of edges')
    const nodes = rawNodes.map(raw => cleanNode(raw, fail))
    const byId = new Map(nodes.map(node => [node.id, node]))
    if (byId.size < nodes.length) fail('Node ids must be unique')
    const starts = nodes.filter(node => node.kind === 'start')
    if (starts.length !== 1) fail('A workflow needs exactly one start node')
    for (const node of nodes) if (node.kind === 'end' && !['agent', 'human'].includes(byId.get(node.deliver)?.kind)) fail(`End node "${node.id}" must deliver a work or decision node`)
    const edges = (rawEdges ?? []).map((raw) => {
      const edge = { from: String(raw?.from ?? ''), exit: String(raw?.exit ?? ''), to: String(raw?.to ?? '') }
      if (!exitsOf(byId.get(edge.from) ?? { kind: 'end' }).includes(edge.exit)) fail(`Node "${edge.from}" has no exit "${edge.exit}"`)
      if (!byId.has(edge.to) || edge.to === starts[0]?.id) fail(`Edge "${edge.from}.${edge.exit}" goes to no valid node`)
      if (raw?.back === undefined) return edge
      if (typeof raw.back !== 'object' || raw.back === null || Array.isArray(raw.back)) throw invalid(`Edge "${edge.from}.${edge.exit}" marks back with no { max }`)
      const max = raw.back.max
      if (max !== undefined && !(Number.isInteger(max) && max >= 1 && max <= RUN_BACK_MAX)) fail(`Edge "${edge.from}.${edge.exit}" may go back 1 to ${RUN_BACK_MAX} times`)
      return { ...edge, back: max === undefined ? {} : { max } }
    })
    for (const node of nodes) {
      for (const exit of exitsOf(node)) {
        const wired = edges.filter(edge => edge.from === node.id && edge.exit === exit).length
        if (wired !== 1) fail(`Exit "${exit}" of node "${node.id}" needs exactly one edge`)
      }
    }
    const ahead = edges.filter(edge => !edge.back)
    const visiting = new Set()
    const done = new Set()
    const loops = (id) => {
      if (done.has(id)) return false
      if (visiting.has(id)) return true
      visiting.add(id)
      const found = ahead.some(edge => edge.from === id && loops(edge.to))
      done.add(id)
      return found
    }
    if (nodes.some(node => loops(node.id))) fail('A workflow can loop only through an edge marked back')
    const leads = (id, to, seen = new Set()) => id === to || (!seen.has(id) && seen.add(id) && ahead.some(edge => edge.from === id && leads(edge.to, to, seen)))
    for (const edge of edges) if (edge.back && !leads(edge.to, edge.from)) fail(`Edge "${edge.from}.${edge.exit}" goes back to a node that does not lead to it`)
    for (const node of nodes) if (node.kind !== 'end' && !ahead.some(edge => edge.from === node.id)) fail(`Node "${node.id}" needs an exit that is not back`)
    return { nodes, edges }
  }

  const cleanDefinition = async ({ name, steps, nodes, edges, workspaceId }) => {
    const clean = nodes === undefined ? { steps: cleanSteps(steps) } : cleanGraph(nodes, edges, false)
    for (const node of clean.nodes ?? []) {
      await Promise.all((node.images ?? []).map(image => rt.imageOf(image)))
      await Promise.all((node.files ?? []).map(file => rt.fileOf(file)))
    }
    if (workspaceId !== undefined && state.workspaces[String(workspaceId)] === undefined) throw Object.assign(new Error('No such workspace'), { code: 'orch/invalid' })
    return { name: String(name ?? 'workflow').trim().slice(0, 80) || 'workflow', ...clean, ...(workspaceId === undefined ? {} : { workspaceId: String(workspaceId) }) }
  }

  const unique = workflow => {
    if (Object.values(state.workflows).some(item => item.id !== workflow.id && item.name === workflow.name)) {
      throw Object.assign(new Error(`A workflow named "${workflow.name}" already exists`), { code: 'orch/invalid' })
    }
  }

  const defineWorkflow = async (body) => {
    await rt.load()
    const now = Date.now()
    const workflow = { id: randomUUID(), ...await cleanDefinition(body), revision: 1, createdAt: now, updatedAt: now }
    unique(workflow)
    state.workflows[workflow.id] = workflow
    await rt.save()
    return workflow
  }

  // Overwrites a definition in place; runs keep the graph they snapshotted.
  const updateWorkflow = async ({ id, revision, ...body }) => {
    await rt.load()
    const current = state.workflows[String(id ?? '')]
    if (current === undefined) throw Object.assign(new Error('No such workflow'), { code: 'orch/not-found' })
    // A definition saved before revisions counts as revision 0 (ADR 0005 §5), so
    // a missing or null revision updates instead of writing NaN and conflicting.
    const currentRevision = current.revision ?? 0
    const conflict = () => Object.assign(new Error('The workflow changed elsewhere'), { code: 'orch/conflict' })
    if ((revision ?? 0) !== currentRevision) throw conflict()
    const clean = await cleanDefinition(body)
    // cleanDefinition awaits, so the base revision is checked again: two updates
    // from one revision must not both land, and a deleted flow must not come back.
    const latest = state.workflows[current.id]
    if (latest === undefined || (latest.revision ?? 0) !== currentRevision) throw conflict()
    const workflow = { id: current.id, ...clean, revision: currentRevision + 1, createdAt: current.createdAt, updatedAt: Date.now() }
    unique(workflow)
    state.workflows[workflow.id] = workflow
    await rt.save()
    return workflow
  }

  const deleteWorkflow = async (id) => {
    await rt.load()
    if (state.workflows[String(id ?? '')] === undefined) throw Object.assign(new Error('No such workflow'), { code: 'orch/not-found' })
    delete state.workflows[String(id ?? '')]
    await rt.save()
    return true
  }

  const nodeOf = (run, task) => run.snapshot.graph.nodes.find(node => node.id === task.nodeId)

  const addArtifact = (run, task, fields) => {
    const text = rt.redactSecrets(String(fields.text ?? ''))
    const artifact = { id: randomUUID(), taskId: task.id, ...fields, text, createdAt: Date.now() }
    run.artifacts[artifact.id] = artifact
    task.output = artifact.id
    return artifact
  }

  // The tasks before this one on its path, latest first.
  const pathOf = (run, task) => {
    const path = []
    for (let from = task.from && run.tasks[task.from.taskId]; from; from = from.from && run.tasks[from.from.taskId]) path.push(from)
    return path
  }

  // The latest output of each node among `tasks` (latest first), oldest first, as handoff references.
  const upstream = (run, tasks) => {
    const refs = []
    const seen = new Set()
    for (const from of tasks) {
      const artifact = from.output && run.artifacts[from.output]
      if (artifact === undefined || seen.has(from.nodeId)) continue
      seen.add(from.nodeId)
      const node = nodeOf(run, from)
      const attempt = artifact.attemptId && run.attempts[artifact.attemptId]
      const answer = node.kind === 'human' && run.requests?.[from.requestId]?.answer
      refs.unshift(answer ? { source: { kind: 'user', step: node.name }, messages: [{ text: artifact.text }],
        decision: { ...(run.requests[from.requestId].question ? { question: run.requests[from.requestId].question } : {}), choice: choiceOf(node, answer.exit), ...(answer.text ? { note: answer.text } : {}) } }
        : artifact.provenance === 'human'
        ? { source: { kind: 'user', step: node.name }, messages: [{ text: artifact.text }] }
        : { source: { kind: 'agent', profileId: attempt.profileId, profileName: run.snapshot.profiles[attempt.profileId]?.name, sessionId: attempt.sessionId, step: node.name },
          messages: [{ text: artifact.text || '(no report)' }] })
    }
    return refs
  }

  // Resolves with the run once the question is answered, or no longer asked.
  const runHuman = async (run, task, node) => {
    const request = { id: randomUUID(), taskId: task.id, version: 1, kind: 'decide', ...(node.question ? { question: node.question } : {}), options: node.options, status: 'open', createdAt: Date.now() }
    const settled = new Promise(resolve => waiters.set(request.id, resolve))
    try {
      await commit(run.id, (draft, event) => {
        draft.requests[request.id] = request
        draft.tasks[task.id].requestId = request.id
        setTask(draft, event, draft.tasks[task.id], 'active')
        event('request/open', { taskId: task.id, data: { requestId: request.id } })
      })
    } catch (error) {
      waiters.delete(request.id)
      throw error
    }
    return settled
  }

  // 'repeat' when the same answer was already saved; throws when the run does not take it.
  // An answer is an exit with an optional note; without an exit, its text names an option.
  const checkAnswer = (run, requestId, version, answer) => {
    const request = run.requests?.[requestId]
    if (request === undefined) throw stale('This question is no longer open')
    if (request.version !== version) throw stale('This question has changed; answer the current one')
    const task = run.tasks[request.taskId]
    const exit = answer.exit || exitFrom(nodeOf(run, task), answer.text), text = answer.exit ? answer.text : ''
    if (request.status === 'answered') {
      if (request.answer?.exit === exit && (request.answer?.text ?? '') === text) return 'repeat'
      throw stale('This question was already answered differently')
    }
    if (request.status !== 'open' || run.status !== 'running' || task?.status !== 'active') throw stale('The run no longer waits for this answer')
    const invalid = message => Object.assign(new Error(message), { code: 'orch/invalid' })
    if (exit === BACK && !backTo(run, task)) throw invalid('No step before this question to send back to')
    if (exit === BACK && text === '') throw invalid('Say what to change before sending it back')
    if (exit !== BACK && !exitsOf(nodeOf(run, task)).includes(exit)) throw invalid('Choose one of the options')
    return { exit, text }
  }

  // Answers a run's question by card id. Returns false for an id that is not one.
  // A run nobody is waiting on (the host restarted) carries on from here.
  const answerRunRequest = async (id, { exit, text } = {}) => {
    const [, runId, requestId, version] = /^run:([^:]+):([^:]+):(\d+)$/.exec(String(id ?? '')) ?? []
    if (runId === undefined) return false
    const answer = { exit: String(exit ?? ''), text: String(text ?? '').trim().slice(0, ANSWER_TEXT_MAX) }
    const found = await rt.loadRun(runId).catch(() => ({}))
    try {
      if (checkAnswer(found, requestId, Number(version), answer) === 'repeat') return true
    } catch (error) {
      if (found.requests) syncCards(found)
      throw error
    }
    const resume = !waiters.has(requestId)
    if (resume) hold(found.workflowId, found.workflowName, runId)
    let repeat = false
    let run
    try {
      run = await commit(runId, (draft, event) => {
        const checked = checkAnswer(draft, requestId, Number(version), answer)
        if (checked === 'repeat') { repeat = true; throw stale('Already answered') }
        const { exit, text } = checked
        const request = draft.requests[requestId]
        const task = draft.tasks[request.taskId]
        request.status = 'answered'
        request.answer = { exit, ...(text ? { text } : {}), at: Date.now() }
        event('request/answer', { taskId: task.id, data: { requestId } })
        const node = nodeOf(draft, task)
        addArtifact(draft, task, { kind: 'decision', text: `Decision "${node.name}": ${choiceOf(node, exit)}${text ? `\n${text}` : ''}`, provenance: 'human' })
        advance(draft, event, task, exit)
      })
    } catch (error) {
      if (resume) running = null
      if (repeat) return true
      throw error
    }
    if (resume) {
      const owner = running
      owner.finished = drive(run, owner).finally(() => { if (running === owner) running = null })
      owner.finished.catch(error => rt.warn('nodo: workflow run %s stopped: %s', runId, error))
    }
    return true
  }

  // Workspaces of steps nobody has confirmed stopped; only reconciling frees them.
  // An attempt saved without its workspace takes the one of its bound conversation;
  // one with neither holds every workspace. An unreadable run holds nothing.
  const occupied = async () => {
    const held = new Set()
    for (const { id, status } of await rt.listRuns()) {
      if (['done', 'failed', 'cancelled', 'unreadable'].includes(status)) continue
      const run = await rt.loadRun(id)
      for (const task of Object.values(run.tasks)) {
        const attempt = task.status === 'needs_reconcile' && run.attempts[task.current]
        if (attempt) held.add(attempt.workspaceId ?? (attempt.sessionId && rt.conversationOf(attempt.sessionId)?.session.workspaceRef) ?? UNKNOWN)
      }
    }
    return held
  }

  const runsHere = attempt => attempt?.sessionId !== undefined && rt.workView()[attempt.sessionId]?.active === true
  const stepRuns = () => Object.assign(new Error('The step is still running in its conversation'), { code: 'orch/busy' })
  // A person settling a step stands for its end: an attempt still marked live is let go.
  const letGo = (run, event, task) => {
    const attempt = run.attempts[task.current]
    if (!attempt || !LIVE.includes(attempt.phase)) return
    attempt.phase = 'interrupted'
    event('attempt/phase', { taskId: task.id, attemptId: attempt.id, data: { phase: 'interrupted', reason: 'reconciled' } })
  }

  const endAttempt = (run, event, attempt, end) => {
    attempt.phase = 'ended'
    attempt.end = end
    attempt.endedAt = Date.now()
    event('attempt/end', { taskId: attempt.taskId, attemptId: attempt.id, data: end })
  }

  // Prepare → Dispatch → Commit. Each phase is saved before the next starts, so a
  // crash leaves the attempt in the phase it reached (P1-6 reconciles it).
  const runAgent = async (run, task, node, step) => {
    let stopped
    const own = flight = { runId: run.id, stopping: null, stopped: new Promise(resolve => { stopped = resolve }), stop: (reason) => { own.stopping ??= reason; stopped(own.stopping) } }
    try { return await attemptAgent(run, task, node, step, own) } finally { flight = null }
  }

  const attemptAgent = async (run, task, node, step, own) => {
    const snap = run.snapshot.profiles[node.profileId]
    const live = rt.findProfile(node.profileId)
    if (live === undefined || identityOf(live).identityVersion !== snap?.identityVersion) {
      return commit(run.id, (draft, event) => halt(draft, event, draft.tasks[task.id], 'waiting_human', live === undefined ? 'profile_missing' : 'profile_changed'))
    }
    // A flow with its own workspace runs every step there; otherwise each role's current conversation decides.
    const pinned = run.snapshot.input?.workspaceId
    const workspace = pinned === undefined ? rt.sessionWorkspace(live, rt.sessionsOf(live).find(item => item.id === live.activeSessionId)) : state.workspaces[pinned]
    if (pinned !== undefined && workspace === undefined) {
      return commit(run.id, (draft, event) => halt(draft, event, draft.tasks[task.id], 'waiting_human', 'workspace_missing'))
    }
    const held = await occupied()
    if (held.has(UNKNOWN) || held.has(workspace?.id)) {
      return commit(run.id, (draft, event) => halt(draft, event, draft.tasks[task.id], 'waiting_human', 'workspace_occupied'))
    }
    const previous = run.attempts[task.attempts.at(-1)]
    const reuse = previous?.unsent && previous.workspaceId === workspace?.id && rt.sessionsOf(live).find(item => item.id === previous.sessionId)
    const idle = attempt => !runsHere(attempt) && rt.sessionsOf(live).find(item => item.id === attempt.sessionId && !item.archivedAt && item.workspaceRef === workspace?.id
      && item.engine === snap.engine && JSON.stringify(item.engineOptions ?? {}) === JSON.stringify(snap.engineOptions ?? {}))
    // A step retried after a turn that surely ended is given the person's reason, in that conversation while it is idle.
    const note = previous?.end && !previous.end.unconfirmed && task.reason?.startsWith('retry: ') ? task.reason.slice(7) : undefined
    const again = note !== undefined && idle(previous)
    // A step run again after a send-back goes on in the conversation of its earlier
    // report when that conversation ended as reported, is idle and still has the
    // run's engine and workspace. The step sent back is given only the report or
    // answer that sent it back; any other, only what came after its earlier report.
    const back = task.from && (task.from.exit === BACK || run.snapshot.graph.edges.find(edge => edge.from === run.tasks[task.from.taskId]?.nodeId && edge.exit === task.from.exit)?.back)
    const history = pathOf(run, task)
    const prior = history.find(item => item.nodeId === task.nodeId)
    const before = prior?.provenance !== 'human' && run.attempts[prior?.current]
    const resumed = task.attempts.length === 0 && before?.end?.reason === 'done' && !before.end.unconfirmed && idle(before)
    const now = Date.now()
    const attempt = { id: randomUUID(), taskId: task.id, n: task.attempts.length + 1, phase: 'dispatching', profileId: node.profileId, engine: snap.engine, path: snap.engine, workspaceId: workspace?.id,
      turn: {}, startedAt: now }
    run = await commit(run.id, (draft, event) => {
      draft.attempts[attempt.id] = attempt
      const current = draft.tasks[task.id]
      current.attempts.push(attempt.id)
      current.current = attempt.id
      setTask(draft, event, current, 'active')
      event('attempt/phase', { taskId: task.id, attemptId: attempt.id, data: { phase: 'dispatching' } })
    })
    let placed
    let sessionId
    try {
      // The task's own conversation; the role's active one stays what the user chose.
      // A retry never falls back to the conversation of an earlier report: it goes on
      // where the last attempt stopped, or starts afresh when that is gone.
      const activeSessionId = live.activeSessionId
      const session = reuse || again || (note === undefined && resumed) || await rt.createSession(node.profileId,
        workflowSessionTitle(node, runTaskTitle(run.title, workflowTitleSource(run.snapshot.graph), rt.redactSecrets), rt.redactSecrets), workspace?.id, true, false, {},
        { kind: 'workflow', workflowId: run.workflowId, runId: run.id, nodeId: node.id, attemptId: attempt.id })
      live.activeSessionId = activeSessionId
      // The run keeps the model, thinking and permission it started with. A saved
      // thinking 'default' means the engine picks, the same as no choice.
      for (const key of ['model', 'thinking', 'permission']) {
        const value = node.choices?.[key] ?? snap[key]
        if (value === undefined || value === '' || (key === 'thinking' && value === 'default')) delete session[key]
        else session[key] = value
      }
      await rt.save()
      sessionId = session.id
      run = await commit(run.id, (draft, event) => {
        draft.attempts[attempt.id].sessionId = session.id
        event('attempt/bind', { taskId: task.id, attemptId: attempt.id, data: { sessionId: session.id } })
      })
      if (own.stopping) {
        return commit(run.id, (draft, event) => {
          endAttempt(draft, event, draft.attempts[attempt.id], { reason: 'interrupted' })
          stopRun(draft, event, 'cancelled')
        })
      }
      // The rework wording and the handoff follow the conversation actually chosen:
      // only when it holds the earlier report does the step read it above.
      const above = session.id === before?.sessionId
      const rework = back && prior ? { rework: above ? 'resumed' : 'fresh' } : above ? { rerun: 'resumed' } : {}
      const retry = note !== undefined ? { retry: { note, resumed: Boolean(again) && previous.turn?.seq !== undefined } } : {}
      const images = await Promise.all((node.images ?? []).map(async image => ({ ...await rt.imageOf(image), name: image.name })))
      const cwd = session.cwd ?? workspace?.cwd
      const files = await rt.materializeFiles(node.files, cwd)
      const scope = !above ? history : back ? [run.tasks[task.from.taskId]] : history.slice(0, history.indexOf(prior))
      const materials = await materializeHandoff({ run, task: run.tasks[task.id], history, scope, cwd, redact: rt.redactSecrets })
      if (node.task.length > TASK_TEXT_MAX) throw new Error('Task exceeds 32000 characters')
      placed = await rt.send(node.profileId, node.task, session.id, images, [], { workflowName: run.workflowName, stepName: node.name, ...step, ...rework, ...retry, files, materials, artifacts: upstream(run, scope) }, { exclusive: true })
    } catch (error) {
      return commit(run.id, (draft, event) => {
        endAttempt(draft, event, draft.attempts[attempt.id], { reason: 'error' })
        halt(draft, event, draft.tasks[task.id], 'waiting_human', `not sent: ${rt.redactSecrets(String(error?.message ?? error))}`.slice(0, 500))
      })
    }
    run = await commit(run.id, (draft, event) => {
      Object.assign(draft.attempts[attempt.id], { phase: 'running', turn: { seq: placed.seq } })
      event('attempt/phase', { taskId: task.id, attemptId: attempt.id, data: { phase: 'running' } })
    })
    const outcome = await Promise.race([placed.completion, own.stopped.then(() => null)])
    if (outcome === null) return stopAttempt(run, task, node, attempt, sessionId, placed)
    const turnId = await placed.turn
    return commit(run.id, (draft, event) => {
      const saved = draft.attempts[attempt.id]
      const current = draft.tasks[task.id]
      if (turnId) saved.turn.turnId = turnId
      endAttempt(draft, event, saved, { reason: outcome.reason, ...(outcome.unconfirmed ? { unconfirmed: true } : {}) })
      // An end the engine did not confirm may still be running: nothing it wrote moves the run.
      if (outcome.unconfirmed) return halt(draft, event, current, 'needs_reconcile', outcome.reason === 'interrupted' ? 'stop_unconfirmed' : 'end_unconfirmed')
      const text = String(outcome.final ?? outcome.text ?? '').trim()
      if (outcome.reason === 'done' && text !== '') {
        saved.reply = addArtifact(draft, current, { attemptId: attempt.id, kind: 'text', text, provenance: 'agent' }).id
        const exit = exitFrom(node, text)
        if (exit === undefined || exit === BLOCKED) return halt(draft, event, current, 'waiting_human', exit ?? 'no_exit')
        return advance(draft, event, current, exit)
      }
      if (outcome.reason === 'interrupted') return halt(draft, event, current, 'cancelled', 'interrupted')
      halt(draft, event, current, 'waiting_human', outcome.reason === 'done' ? 'empty_reply' : `ended ${outcome.reason}`)
    })
  }

  // A cancel took effect before the turn ended: whatever the engine
  // reports after it is kept for audit only, and a stop it never confirms leaves
  // the task for a person to reconcile.
  const stopAttempt = async (run, task, node, attempt, sessionId, placed) => {
    run = await commit(run.id, (draft, event) => {
      draft.attempts[attempt.id].phase = 'cancelling'
      event('attempt/phase', { taskId: task.id, attemptId: attempt.id, data: { phase: 'cancelling', reason: 'interrupted' } })
    })
    void rt.interrupt(node.profileId, sessionId).catch(error => rt.warn('nodo: workflow step "%s" could not be stopped: %s', node.name, error))
    let wait
    const ended = await Promise.race([placed.completion, new Promise(resolve => { wait = setTimeout(resolve, run.snapshot.limits.cancelConfirmMs, null) })])
    clearTimeout(wait)
    const late = outcome => event => event('audit/late', { taskId: task.id, attemptId: attempt.id, data: { reason: outcome.reason } })
    if (ended === null) {
      void placed.completion.then(outcome => commit(run.id, (draft, event) => late(outcome)(event))).catch(() => {})
      return commit(run.id, (draft, event) => halt(draft, event, draft.tasks[task.id], 'needs_reconcile', 'stop_unconfirmed'))
    }
    const turnId = await placed.turn
    return commit(run.id, (draft, event) => {
      const saved = draft.attempts[attempt.id]
      if (turnId) saved.turn.turnId = turnId
      endAttempt(draft, event, saved, { reason: 'interrupted', ...(ended.unconfirmed ? { unconfirmed: true } : {}) })
      if (ended.reason !== 'interrupted') late(ended)(event)
      if (ended.unconfirmed) return halt(draft, event, draft.tasks[task.id], 'needs_reconcile', 'stop_unconfirmed')
      stopRun(draft, event, 'cancelled')
    })
  }

  const runEnd = (run, task, node) => commit(run.id, (draft, event) => {
    const delivered = Object.values(draft.tasks).filter(item => item.nodeId === node.deliver && item.status === 'done' && item.output).at(-1)
    if (delivered === undefined) return halt(draft, event, draft.tasks[task.id], 'failed', 'missing_deliverable')
    draft.final = delivered.output
    setTask(draft, event, draft.tasks[task.id], 'done')
    setRun(draft, event, 'done')
  })

  // Runs one task at a time until the run leaves `running`. Only one workflow
  // agent task runs in the whole host.
  const drive = async (run, owner) => {
    const steps = run.snapshot.graph.nodes.filter(node => node.kind === 'agent' || node.kind === 'human')
    while (run.status === 'running' && !owner.cancelled) {
      const task = Object.values(run.tasks).find(item => item.status === 'pending')
      if (task === undefined) {
        run = await commit(run.id, (draft, event) => setRun(draft, event, 'failed', 'no_pending_task'))
        break
      }
      const node = nodeOf(run, task)
      if (node.kind === 'start') run = await commit(run.id, (draft, event) => advance(draft, event, draft.tasks[task.id], 'done'))
      else if (node.kind === 'human') run = await runHuman(run, task, node)
      else if (node.kind === 'agent') run = await runAgent(run, task, node, { index: steps.findIndex(item => item.id === node.id) + 1, of: steps.length, ...(exitsOf(node).length > 1 ? { exits: node.exits } : {}) })
      else if (node.kind === 'end') run = await runEnd(run, task, node)
      else run = await commit(run.id, (draft, event) => halt(draft, event, draft.tasks[task.id], 'waiting_human', `unsupported_node:${node.kind}`))
    }
    if (owner.cancelled && STOPPABLE.includes(run.status)) {
      let already = false
      try {
        run = await commit(run.id, (draft, event) => {
          if (!STOPPABLE.includes(draft.status)) { already = true; throw stale('Already stopped') }
          stopRun(draft, event, 'cancelled')
        })
      } catch (error) {
        if (!already) throw error
        run = await rt.loadRun(run.id)
      }
    }
    return run
  }

  // Stops a run: nothing more is dispatched, and a step in progress is
  // interrupted. A run waiting to be reconciled is given up only with a reason,
  // which stands for its steps' end. Resolves with the run once its loop has let go of it.
  const cancelRun = async (id, { reason } = {}) => {
    id = String(id ?? '')
    reason = rt.redactSecrets(String(reason ?? '').trim()).slice(0, 500)
    const owner = running?.runId === id ? running : null
    if (owner !== null) owner.cancelled = true
    if (flight?.runId === id) {
      flight.stop('cancelled')
      return owner.finished
    }
    const invalid = message => Object.assign(new Error(message), { code: 'orch/invalid' })
    let already = false
    let run
    try {
      run = await commit(id, (draft, event) => {
        if (draft.status === 'cancelled') { already = true; throw stale('Already cancelled') }
        if (draft.status === 'needs_reconcile') {
          if (reason === '') throw invalid('Give a reason')
          const held = Object.values(draft.tasks).filter(task => task.status === 'needs_reconcile')
          if (held.some(task => runsHere(draft.attempts[task.current]))) throw stepRuns()
          for (const task of held) letGo(draft, event, task)
          return stopRun(draft, event, `cancelled: ${reason}`)
        }
        if (!STOPPABLE.includes(draft.status)) throw invalid('This run has already ended')
        if (Object.values(draft.attempts).some(attempt => ['dispatching', 'running', 'cancelling'].includes(attempt.phase))) throw invalid('A step of this run may still be running; reconcile it first')
        stopRun(draft, event, 'cancelled')
      })
    } catch (error) {
      if (owner !== null) owner.cancelled = false
      if (!already) throw error
      run = await rt.loadRun(id)
    }
    return owner?.finished ?? run
  }

  // `started` is called with the run once it is saved and moving.
  const runWorkflow = async (id, { limits, started, title } = {}) => {
    await rt.load()
    const workflow = state.workflows[String(id ?? '')]
    if (workflow === undefined) throw Object.assign(new Error('No such workflow'), { code: 'orch/not-found' })
    const stored = graphOf(workflow), graph = cleanGraph(stored.nodes, stored.edges)
    if (workflow.workspaceId !== undefined && state.workspaces[workflow.workspaceId] === undefined) throw Object.assign(new Error('The workflow\'s workspace no longer exists'), { code: 'orch/invalid' })
    const owner = hold(workflow.id, workflow.name)
    try {
      const profiles = {}
      for (const node of graph.nodes) {
        const profile = node.kind === 'agent' ? rt.findProfile(node.profileId) : undefined
        if (profile !== undefined) profiles[node.profileId] = { ...identityOf(profile), ...Object.fromEntries(Object.entries(rt.sessionChoices(profile)).filter(([, value]) => value !== undefined)) }
      }
      let run = await rt.createRun({ workflowId: workflow.id, workflowName: workflow.name, title, workflowRevision: workflow.revision ?? 0, graph, profiles, limits,
        input: workflow.workspaceId === undefined ? {} : { workspaceId: workflow.workspaceId } })
      owner.runId = run.id
      run = await commit(run.id, (draft, event) => addTask(draft, event, graph.nodes.find(node => node.kind === 'start').id, 'start'))
      started?.(run)
      owner.finished = drive(run, owner).finally(() => { if (running === owner) running = null })
      return await owner.finished
    } finally {
      if (running === owner) running = null
    }
  }

  // The exit a done task took, read again from its answer or its output.
  const takenExit = (run, task) => run.requests?.[task.requestId]?.answer?.exit ?? exitFrom(nodeOf(run, task), run.artifacts[task.output]?.text ?? '')

  // A step the host lost track of is marked interrupted; a running run gets its
  // missing successor, and what it would dispatch next waits for a person.
  const recover = (run, event) => {
    for (const attempt of Object.values(run.attempts)) {
      if (!LIVE.includes(attempt.phase)) continue
      // A conversation made but not bound before the crash was never sent to.
      const profile = state.profiles[attempt.profileId]
      const node = nodeOf(run, run.tasks[attempt.taskId])
      const legacyName = run.title === undefined ? `${run.workflowName} · ${node.name}`.slice(0, 80) : undefined
      const orphan = !attempt.sessionId && profile && rt.sessionsOf(profile).find(session => session.workspaceRef === attempt.workspaceId && session.createdAt >= attempt.startedAt
        && (session.source?.kind === 'workflow' && session.source.runId === run.id && session.source.nodeId === node.id && session.source.attemptId === attempt.id
          || legacyName !== undefined && !session.source && session.name === legacyName))
      if (orphan) {
        Object.assign(attempt, { sessionId: orphan.id, unsent: true })
        event('attempt/bind', { taskId: attempt.taskId, attemptId: attempt.id, data: { sessionId: orphan.id, unsent: true } })
      }
      attempt.phase = 'interrupted'
      event('attempt/phase', { taskId: attempt.taskId, attemptId: attempt.id, data: { phase: 'interrupted' } })
      const task = run.tasks[attempt.taskId]
      if (task.status === 'active') setTask(run, event, task, 'needs_reconcile', 'interrupted')
    }
    if (run.status === 'running') {
      for (const task of Object.values(run.tasks)) {
        const edge = task.status === 'done' && edgeOf(run, task, takenExit(run, task))
        if (edge) addTask(run, event, edge.to, `${task.id}:${edge.exit}`, { taskId: task.id, exit: edge.exit })
      }
      for (const task of Object.values(run.tasks)) if (task.status === 'pending') setTask(run, event, task, 'needs_reconcile', 'host_restarted')
    }
    const held = Object.values(run.tasks).find(task => task.status === 'needs_reconcile')
    if (held && run.status !== 'needs_reconcile') setRun(run, event, 'needs_reconcile', held.reason)
  }

  // At boot or takeover: every run not yet ended is checked, and its open questions get
  // their cards back. A run this host still drives is left to it.
  const recoverRuns = async () => {
    const unchanged = new Error('unchanged')
    try {
      for (const { id, status } of await rt.listRuns()) {
        if (running?.runId === id || !['running', 'waiting_human', 'paused', 'needs_reconcile'].includes(status)) continue
        await commit(id, (draft, event) => {
          let changed = false
          recover(draft, (...args) => { changed = true; event(...args) })
          if (!changed) throw unchanged
        }).catch(async (error) => {
          if (error !== unchanged) throw error
          syncCards(await rt.loadRun(id))
        }).catch(error => rt.warn('nodo: workflow run %s was not recovered: %s', id, error))
      }
    } catch (error) { rt.warn('nodo: workflow runs were not recovered: %s', error) }
  }

  // A person settles a step the run cannot go on from: `accept` takes their text
  // as its output, `retry` dispatches it again in a new attempt. Refused while
  // the step's conversation still runs in this host. Resolves with the run once
  // its loop has let go of it.
  const reconcileRun = async (id, { action, text, reason, started } = {}) => {
    id = String(id ?? '')
    const invalid = message => Object.assign(new Error(message), { code: 'orch/invalid' })
    reason = rt.redactSecrets(String(reason ?? '').trim()).slice(0, 500)
    text = String(text ?? '').trim().slice(0, ANSWER_TEXT_MAX)
    if (!['accept', 'retry'].includes(action)) throw invalid('Choose accept or retry')
    if (reason === '') throw invalid('Give a reason')
    if (action === 'accept' && text === '') throw invalid('Give the output to accept')
    const found = await rt.loadRun(id)
    const task = settling(found)
    if (task === undefined) throw stale('This run has nothing to reconcile')
    const node = nodeOf(found, task)
    if (action === 'accept' && !['agent', 'human'].includes(node?.kind)) throw invalid('Only a step with an output can be accepted; retry it')
    const exit = action === 'accept' ? exitFrom(node, text) : undefined
    if (action === 'accept' && (exit === undefined || (node.kind === 'agent' && exit === BLOCKED))) {
      throw invalid(node.kind === 'human' ? 'Choose one of the options' : `End the output with a line "NEXT: <exit>", one of: ${exitsOf(node).join(', ')}`)
    }
    if (runsHere(found.attempts[task.current])) throw stepRuns()
    const owner = hold(found.workflowId, found.workflowName, id)
    let run
    try {
      run = await commit(id, (draft, event) => {
        const current = settling(draft)
        if (current?.id !== task.id) throw stale('This run has changed; look again')
        letGo(draft, event, current)
        setRun(draft, event, 'running')
        if (action === 'retry') {
          delete current.current
          return setTask(draft, event, current, 'pending', `retry: ${reason}`)
        }
        current.provenance = 'human'
        addArtifact(draft, current, { kind: 'text', text, provenance: 'human' })
        advance(draft, event, current, exit, `accepted: ${reason}`)
      })
    } catch (error) {
      running = null
      throw error
    }
    owner.finished = drive(run, owner).finally(() => { if (running === owner) running = null })
    started?.(run)
    return owner.finished
  }

  // What the client shows of a run: its steps in the order they were made, each
  // with its attempts, the start of its output and the card of its open question,
  // and the task a person settles. Start and end tasks show only while not done.
  // A reference the file lacks is left out rather than read.
  const getRun = async (id) => {
    await rt.loadSecrets()
    const run = await rt.loadRun(id)
    if (run.status === 'unreadable') return run
    const { workflowId, workflowName, status, reason, createdAt, updatedAt, endedAt } = run
    const tasks = Object.values(run.tasks).sort((a, b) => a.createdAt - b.createdAt).flatMap((task) => {
      const node = run.snapshot.graph?.nodes?.find(item => item.id === task.nodeId)
      if (task.status === 'done' && node?.kind !== 'agent' && node?.kind !== 'human') return []
      const output = rt.redactSecrets(run.artifacts[task.output]?.text)
      const request = run.requests[task.requestId]
      const attached = [...node?.images ?? [], ...node?.files ?? []].map(item => item.name).filter(Boolean)
      return [{ id: task.id, name: node?.name ?? task.nodeId, kind: node?.kind, status: task.status, reason: task.reason, provenance: task.provenance,
        ...(node?.kind === 'agent' ? { input: { text: node.task ?? '', ...(attached.length ? { attachments: attached } : {}) } } : {}),
        ...(typeof output === 'string' ? { output: output.slice(0, 400), more: output.length > 400 } : {}),
        ...(request?.status === 'open' ? { card: cardId(run, request) } : {}),
        attempts: (task.attempts ?? []).filter(attemptId => run.attempts[attemptId]).map((attemptId) => {
          const { n, phase, profileId, sessionId, end, startedAt, endedAt } = run.attempts[attemptId]
          return { id: attemptId, n, phase, profileId, profileName: run.snapshot.profiles?.[profileId]?.name, sessionId, end, startedAt, endedAt }
        }) }]
    })
    return rt.redactDeepSecrets({ id: run.id, title: runTaskTitle(run.title, workflowTitleSource(run.snapshot.graph), rt.redactSecrets), workflowId, workflowName, status, reason, createdAt, updatedAt, endedAt, tasks, settle: settling(run)?.id,
      ...(run.snapshot.graph?.nodes ? { graph: { nodes: run.snapshot.graph.nodes, edges: run.snapshot.graph.edges ?? [] } } : {}) })
  }

  const workflowsView = () => ({
    definitions: Object.values(state.workflows),
    running: running === null ? null : { id: running.id, name: running.name, startedAt: running.startedAt, runId: running.runId },
  })

  Object.assign(rt, { defineWorkflow, updateWorkflow, deleteWorkflow, runWorkflow, cancelRun, answerRunRequest, reconcileRun, recoverRuns, getRun, workflowsView })
}
