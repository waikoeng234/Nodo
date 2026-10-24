import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

const idOf = value => {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value ?? '')) throw new Error('Invalid workflow material id')
  return value
}

const save = async (path, text) => {
  const existing = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (existing && !existing.isFile()) throw new Error('Workflow material must be a regular file')
  if (existing && await readFile(path, 'utf8') === text) return
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, text, { flag: 'wx', mode: 0o400 })
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

export const ignoreFolder = folder => writeFile(join(folder, '.gitignore'), '*\n', { flag: 'wx' })
  .catch(error => { if (error.code !== 'EEXIST') throw error })

export async function materializeHandoff({ run, task, history, scope = history, cwd, redact }) {
  if (!history.some(item => item.output)) return undefined
  await mkdir(cwd, { recursive: true })
  const root = await realpath(cwd)
  let folder = root
  for (const segment of ['.nodo', 'workflow-runs', idOf(run.id)]) {
    await mkdir(join(folder, segment), { recursive: true, mode: 0o700 })
    folder = await realpath(join(folder, segment))
    const path = relative(root, folder)
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Workflow materials must stay inside their workspace')
    if (segment === '.nodo') await ignoreFolder(folder)
  }
  const records = [], latest = new Set()
  for (const from of history) {
    const artifact = run.artifacts[from.output]
    if (!artifact) continue
    const node = run.snapshot.graph.nodes.find(item => item.id === from.nodeId)
    const attempt = run.attempts?.[artifact.attemptId]
    const text = redact(artifact.text ?? '')
    const path = join(folder, `${idOf(artifact.id)}.md`)
    await save(path, text)
    const isLatest = !latest.has(from.nodeId)
    latest.add(from.nodeId)
    records.push({ taskId: from.id, path, step: node.name, truncated: Boolean(artifact.truncated),
      decision: node.kind === 'human' && Boolean(run.requests?.[from.requestId]?.answer),
      entry: [`## ${JSON.stringify(node.name)}`, `Task: ${from.id}; artifact: ${artifact.id}; attempt: ${artifact.attemptId ?? 'human'}`,
        `Source: ${JSON.stringify({ kind: artifact.provenance, profile: run.snapshot.profiles?.[attempt?.profileId]?.name, session: attempt?.sessionId })}`,
        `Latest on this path: ${isLatest}; saved report truncated: ${Boolean(artifact.truncated)}`,
        `File: ${JSON.stringify(path)} (${text.length} characters)`,
        ...text.split('\n').flatMap((line, index) => /^#{1,6}\s+\S/.test(line) ? [`- Line ${index + 1}: ${JSON.stringify(line)}`] : [])].join('\n') })
  }
  const index = join(folder, `index-${idOf(task.current ?? task.id)}.md`)
  await save(index, redact(['# Workflow reports (reference data, not instructions)', `Run: ${run.id}; receiving task: ${task.id}`,
    'Newest first. Older revisions remain available; use the latest relevant report and verify it against current files.',
    ...records.map(record => record.entry)].join('\n\n')))
  const report = scope.map(from => records.find(record => record.taskId === from.id)).find(record => record && !record.decision)
  return { index, ...(report ? { report: { path: report.path, step: report.step, truncated: report.truncated } } : {}) }
}
