// Run Store: one workflow run per JSON file under <home>/runs, replaced atomically
// (temp file + rename). A commit saves a state change and its events in one write;
// a failed write leaves both the file and the in-memory run as they were.
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RUN_LIMITS } from './constants.js'
import { runTaskTitle, workflowTaskTitle, workflowTitleSource } from '../shared/task-titles.js'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const wellFormed = (run, id) => run?.version === 1 && run.id === id && Number.isInteger(run.revision) && typeof run.status === 'string'
  && Array.isArray(run.events) && Number.isInteger(run.eventsDropped) && Number.isInteger(run.snapshot?.limits?.eventsMax)
  && ['tasks', 'attempts', 'requests', 'artifacts'].every(key => isObject(run[key]))

export function install(rt) {
  const dir = join(rt.home, 'runs')
  const runs = new Map()
  const summaries = new Map()
  const writes = new Map()
  const pathOf = id => join(dir, `${id}.json`)
  const fail = (message, code) => Object.assign(new Error(message), { code })

  const write = async (run) => {
    if (rt.readOnly() !== undefined) throw fail(rt.readOnly(), 'orch/read-only')
    const temp = `${pathOf(run.id)}.${process.pid}.tmp`
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(temp, JSON.stringify(run, null, 2), 'utf8')
      await rename(temp, pathOf(run.id))
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }

  const addEvent = (run, type, fields = {}) => {
    run.events.push({ seq: (run.events.at(-1)?.seq ?? 0) + 1, at: Date.now(), type, ...fields })
    const over = run.events.length - run.snapshot.limits.eventsMax
    if (over > 0) {
      run.events.splice(0, over)
      run.eventsDropped += over
    }
  }

  // Writes for one run go one after another; each mutation sees the last committed run.
  const serial = (id, task) => {
    const next = (writes.get(id) ?? Promise.resolve()).then(task)
    writes.set(id, next.catch(() => {}))
    return next
  }

  const summaryOf = ({ id, title, snapshot, workflowId, workflowName, status, reason, createdAt, updatedAt, endedAt }) =>
    ({ view: { id, title, workflowId, workflowName, status, reason, createdAt, updatedAt, endedAt }, source: workflowTitleSource(snapshot?.graph) })
  const showSummary = ({ view, source }) => rt.redactDeepSecrets({ ...structuredClone(view), title: runTaskTitle(view.title, source, rt.redactDeepSecrets) })

  const readRun = async (id) => {
    let parsed
    try {
      parsed = JSON.parse(await readFile(pathOf(id), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') throw fail('No such run', 'orch/not-found')
      return { id, status: 'unreadable' }
    }
    if (!wellFormed(parsed, id)) return { id, status: 'unreadable' }
    return parsed
  }

  const loadRun = async (id) => {
    id = String(id ?? '')
    if (!ID.test(id)) throw fail('No such run', 'orch/not-found')
    if (runs.has(id)) return structuredClone(runs.get(id))
    const parsed = await readRun(id)
    if (parsed.status === 'unreadable') return parsed
    runs.set(id, parsed)
    summaries.set(id, summaryOf(parsed))
    return structuredClone(parsed)
  }

  const listRuns = async () => {
    await rt.loadSecrets()
    let names = []
    try { names = await readdir(dir) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    const ids = names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(id => ID.test(id))
    const list = []
    for (const id of ids) {
      if (!summaries.has(id)) {
        const run = await readRun(id)
        if (!summaries.has(id)) {
          if (run.status === 'unreadable') { list.push(showSummary(summaryOf(run))); continue }
          summaries.set(id, summaryOf(run))
        }
      }
      list.push(showSummary(summaries.get(id)))
    }
    return list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }

  // The snapshot is redacted before it is stored: credentials never reach a run file.
  const createRun = async ({ workflowId, workflowName, title, workflowRevision = 0, graph, profiles = {}, input = {}, limits = {} }) => {
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.trim().length > 80)) throw fail('Run title must contain 1 to 80 characters', 'orch/invalid')
    await rt.loadSecrets()
    const snapshot = rt.redactDeepSecrets(structuredClone({ graph, profiles, input, limits: { ...RUN_LIMITS, ...limits } }))
    const now = Date.now()
    const run = {
      version: 1,
      id: randomUUID(),
      workflowId,
      workflowName,
      title: (title === undefined ? workflowTaskTitle(snapshot.graph, rt.redactDeepSecrets)
        : rt.redactDeepSecrets(rt.redactDeepSecrets(title).trim().replace(/\s+/g, ' '))).slice(0, 80),
      workflowRevision,
      revision: 1,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      snapshot,
      tasks: {},
      attempts: {},
      requests: {},
      artifacts: {},
      events: [],
      eventsDropped: 0,
    }
    addEvent(run, 'run/status', { data: { status: 'running' } })
    await serial(run.id, () => write(run))
    runs.set(run.id, run)
    summaries.set(run.id, summaryOf(run))
    return structuredClone(run)
  }

  // mutate(draft, event) changes a copy of the run; nothing is kept unless the write succeeds.
  const commit = (id, mutate) => serial(String(id ?? ''), async () => {
    const current = await loadRun(id)
    if (current.status === 'unreadable') throw fail('The run file cannot be read', 'orch/invalid')
    const draft = structuredClone(current)
    await mutate(draft, (type, fields) => addEvent(draft, type, fields))
    draft.revision = current.revision + 1
    draft.updatedAt = Date.now()
    await write(draft)
    runs.set(draft.id, draft)
    summaries.set(draft.id, summaryOf(draft))
    return structuredClone(draft)
  })

  // Another dsh may have changed any run while this one only read.
  const forgetRuns = () => {
    runs.clear()
    summaries.clear()
  }

  rt.ctx.effect(() => () => Promise.all(writes.values()), 'nodo: run writes')

  Object.assign(rt, { createRun, loadRun, listRuns, commit, forgetRuns })
}
