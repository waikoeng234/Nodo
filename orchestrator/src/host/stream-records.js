import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toolText } from './text.js'
import { estimateResources, materializeResources, normalizeResources, previewResources, projectContent } from './resources.js'
import { normalizeChanges } from '../../agent-drivers/dist/file-changes.js'
import { readImageFile } from './image-files.js'

export const STREAM_LIMITS = Object.freeze({ detailBytes: 1024 * 1024, sessionBytes: 16 * 1024 * 1024, entries: 1024 })
const ATTACHMENT_READ_TIMEOUT = 10_000
const UUID = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/
const statuses = ['running', 'done', 'error', 'denied', 'interrupted', 'unknown']
const captures = ['complete', 'partial', 'unavailable']
const reasons = ['unsupported', 'source-limit', 'source-truncated', 'detail-limit', 'quota', 'write-failed', 'read-only', 'conflict', 'unconfirmed']
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invalid = () => Object.assign(new Error('该工具详情不可用或不属于此会话。'), { code: 'orch/stream-detail' })

const string = { type: 'string' }
const resourceSchema = { type: 'object', additionalProperties: false, required: ['kind', 'state'], properties: {
  kind: { type: 'string', enum: ['image', 'file', 'link', 'audio', 'text'] },
  state: { type: 'string', enum: ['pending', 'stored', 'reference', 'unsupported', 'unavailable'] },
  reason: { type: 'string', enum: ['unsupported-type', 'invalid-image', 'image-too-large', 'storage-unavailable', 'attachment-unavailable', 'source-limit', 'no-reader'] },
  name: string, mimeType: string, uri: string, bytes: { type: 'integer' },
  ref: { type: 'object', additionalProperties: false, required: ['id', 'mediaType'], properties: { id: string, mediaType: string } },
} }
const editSchema = { type: 'object', additionalProperties: false, required: ['operation'], properties: {
  operation: { type: 'string', enum: ['add', 'update', 'delete', 'move', 'unknown'] }, fromPath: string,
  availability: { type: 'string', enum: ['binary', 'oversized', 'coarse', 'unavailable'] },
  oldText: { oneOf: [string, { type: 'null' }] }, newText: string, diffText: string,
} }
export const STREAM_VIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['version', 'kind', 'mode', 'profileId', 'conversationId', 'runId', 'entityId', 'revision', 'status', 'source', 'title', 'body', 'capture', 'truncated', 'details'],
  properties: {
    version: { type: 'integer', const: 1 }, kind: { type: 'string', enum: ['tool', 'changes'] }, mode: { type: 'string', const: 'snapshot' },
    profileId: string, conversationId: string, runId: string, entityId: string, revision: { type: 'integer' },
    status: { type: 'string', enum: statuses }, title: string, capture: { type: 'string', enum: captures }, reason: { type: 'string', enum: reasons }, truncated: { type: 'boolean' },
    source: { type: 'object', additionalProperties: false, required: ['engine'], properties: { engine: string, engineSessionId: string, engineTurnId: string } },
    details: { type: 'object', additionalProperties: false, required: ['state'], properties: { state: { type: 'string', enum: ['stored', 'truncated', 'unavailable'] }, ref: string, reason: { type: 'string', enum: reasons } } },
    body: { type: 'object', additionalProperties: false, properties: {
      scope: { type: 'string', enum: ['edit-tools', 'workspace-snapshot'] }, coverage: { type: 'string', const: 'partial' }, fileCount: { type: 'integer' }, turnDiff: string,
      files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'edits'], properties: {
        path: string, edits: { type: 'array', items: editSchema },
      } } },
      inputText: string, outputText: string, command: string, cwd: string, signal: string, exitCode: { type: 'integer' },
      resources: { type: 'array', items: resourceSchema },
      diffs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'oldText', 'newText'],
        properties: { path: string, oldText: { oneOf: [string, { type: 'null' }] }, newText: string, created: { type: 'boolean', const: true } } } },
    } },
  },
}

export function normalizePresentation(value) {
  if (!plain(value) || value.version !== 1 || !['tool', 'changes'].includes(value.kind) || value.mode !== 'snapshot' || !plain(value.body)) return null
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)) return null
  if (value.capture !== undefined && !captures.includes(value.capture)) return null
  if (value.kind === 'changes') {
    const normalized = normalizeChanges(value.body)
    return normalized && { version: 1, kind: 'changes', mode: 'snapshot', body: normalized.body,
      capture: normalized.truncated ? 'partial' : value.capture ?? 'complete',
      ...(value.revision !== undefined ? { revision: value.revision } : {}),
      ...(normalized.truncated ? { reason: 'source-limit' } : reasons.includes(value.reason) ? { reason: value.reason } : {}) }
  }
  const body = {}
  for (const key of ['inputText', 'outputText', 'command', 'cwd', 'signal']) {
    if (value.body[key] !== undefined) {
      if (typeof value.body[key] !== 'string') return null
      body[key] = value.body[key]
    }
  }
  if (value.body.exitCode !== undefined) {
    if (!Number.isSafeInteger(value.body.exitCode)) return null
    body.exitCode = value.body.exitCode
  }
  if (body.signal !== undefined && body.exitCode !== undefined) return null
  const resources = normalizeResources(value.body.resources)
  if (resources === null) return null
  if (resources?.length) body.resources = resources
  if (value.body.input !== undefined) {
    try { body.input = JSON.parse(JSON.stringify(value.body.input)) } catch { return null }
  }
  if (value.body.diffs !== undefined) {
    if (!Array.isArray(value.body.diffs) || value.body.diffs.length > 64) return null
    body.diffs = []
    for (const diff of value.body.diffs) {
      if (!plain(diff) || typeof diff.path !== 'string' || !diff.path || typeof diff.newText !== 'string'
        || !(typeof diff.oldText === 'string' || diff.oldText === null && diff.created === true)) return null
      body.diffs.push({ path: diff.path, oldText: diff.oldText, newText: diff.newText, ...(diff.created === true ? { created: true } : {}) })
    }
  }
  const result = { version: 1, kind: 'tool', mode: 'snapshot', body, capture: value.capture ?? 'complete',
    ...(value.revision !== undefined ? { revision: value.revision } : {}), ...(reasons.includes(value.reason) ? { reason: value.reason } : {}) }
  if (bytes(result) > STREAM_LIMITS.detailBytes) {
    result.body = Object.fromEntries(['inputText', 'outputText', 'command', 'cwd'].filter(key => body[key] !== undefined).map(key => [key, body[key].slice(0, 4000)]))
    result.capture = 'partial'; result.reason = 'source-limit'
  }
  return result
}

const PROGRESS_TEXT = ['message', 'stdoutTail', 'stderrTail', 'outputPreview']
const PROGRESS_NUMBERS = ['elapsedMs', 'stdoutBytes', 'stderrBytes', 'outputBytes']

/** Display-only progress facts; every absent source field stays absent. */
export function normalizeProgress(value) {
  if (!plain(value)) return null
  const progress = {}
  for (const key of PROGRESS_NUMBERS) if (Number.isFinite(value[key]) && value[key] >= 0) progress[key] = Math.round(value[key])
  for (const key of PROGRESS_TEXT) if (typeof value[key] === 'string' && value[key] !== '') progress[key] = value[key].slice(0, 4000)
  return Object.keys(progress).length > 0 ? progress : null
}

export function createRecordTracker({ engine, conversationId, profileId, engineSessionId, redact = value => value, limits = STREAM_LIMITS }) {
  const runId = randomUUID()
  const records = new Map()
  let retainedBytes = 0
  // One event's fields fold into the running body. Delta fields append only
  // because their producer declared delta semantics; snapshots replace. The
  // final end's structured input/output stay authoritative.
  const fold = (body, event, final) => {
    let truncated = false
    const set = (key, text) => {
      if (text.length > limits.detailBytes) { body[key] = text.slice(0, limits.detailBytes); truncated = true }
      else body[key] = text
    }
    if (event.inputText !== undefined) set('inputText', String(event.inputText))
    if (event.inputDelta !== undefined) set('inputText', redact((body.inputText ?? '') + String(event.inputDelta)))
    if (event.input !== undefined) {
      body.input = redact(event.input)
      if (final || body.inputText === undefined) set('inputText', projectContent(body.input).text)
    }
    if (event.outputText !== undefined) set('outputText', String(event.outputText))
    if (event.outputDelta !== undefined) set('outputText', redact((body.outputText ?? '') + String(event.outputDelta)))
    if (event.output !== undefined || event.outputText !== undefined) {
      const projected = projectContent(redact(event.output ?? event.outputText), event.name === 'imageGeneration')
      set('outputText', projected.text)
      if (projected.resources.length > 0) body.resources = projected.resources
      else delete body.resources
      truncated ||= projected.truncated
    }
    if (event.progress !== undefined) {
      const progress = normalizeProgress(redact(event.progress))
      if (progress) body.progress = progress
    }
    if (final) delete body.progress
    return truncated
  }
  return {
    accept(event) {
      event = redact(event)
      if (event?.type !== 'tool' || !event.callId || !['start', 'update', 'end'].includes(event.phase)) return null
      const id = String(event.callId)
      const previous = records.get(id)
      if (previous && previous.status !== 'running') return previous
      // An update carries no invention of its own: without a started record
      // there is no identity to attach it to, so it cannot create a tool.
      if (event.phase === 'update' && !previous) return null
      const supplied = event.presentation === undefined
        ? (!previous && projectContent(event.output ?? event.outputText, event.name === 'imageGeneration').resources.length ? { kind: 'tool', body: {}, capture: 'complete' } : null)
        : normalizePresentation(redact(event.presentation))
      if (!supplied && !previous && event.phase !== 'update') return null
      if (!previous && records.size >= limits.entries) return null
      const status = event.phase === 'end' ? event.isError ? 'error' : 'done' : 'running'
      const body = supplied?.body ?? { ...(previous?.body ?? {}) }
      const truncated = fold(body, event, event.phase === 'end')
      const revision = supplied?.revision ?? (previous ? previous.revision + 1 : 0)
      const record = { version: 1, kind: supplied?.kind ?? previous?.kind ?? 'tool', mode: 'snapshot', profileId, conversationId, runId, entityId: id,
        revision, status, source: { engine, ...(engineSessionId ? { engineSessionId } : {}),
          ...((event.turnId ?? previous?.source?.engineTurnId) ? { engineTurnId: String(event.turnId ?? previous.source.engineTurnId) } : {}) },
        title: String(event.name ?? previous?.title ?? 'tool').slice(0, 200), body,
        capture: truncated ? 'partial' : supplied?.capture ?? previous?.capture ?? 'complete',
        ...((truncated ? 'source-limit' : supplied?.reason ?? previous?.reason) ? { reason: truncated ? 'source-limit' : supplied?.reason ?? previous?.reason } : {}) }
      if (event.presentation !== undefined && !supplied) { record.capture = 'partial'; record.reason = 'unsupported' }
      if (JSON.stringify({ ...record, body: {} }).length > 6000) return null
      if (previous && revision < previous.revision) return previous
      if (previous && revision === previous.revision) {
        if (digest(record) === digest(previous)) return previous
        const conflict = { ...previous, capture: 'partial', reason: 'conflict' }
        records.set(id, conflict)
        return conflict
      }
      const previousBytes = previous ? bytes(previous.body) : 0
      if (retainedBytes - previousBytes + bytes(record.body) > limits.sessionBytes) {
        const preview = previewRecord(record).body
        // The preview drops inline bytes, so a pending image can no longer be
        // saved; say why instead of reporting it as invalid image data.
        if (Array.isArray(preview.resources)) preview.resources = preview.resources.map(resource =>
          resource.kind === 'image' && resource.state === 'pending' ? { ...resource, state: 'unavailable', reason: 'source-limit' } : resource)
        record.body = preview
        if (retainedBytes - previousBytes + bytes(record.body) > limits.sessionBytes) record.body = {}
        record.capture = 'partial'; record.reason = 'source-limit'
      }
      retainedBytes += bytes(record.body) - previousBytes
      records.set(id, record)
      return record
    },
    finish(record, status) {
      if (!record) return undefined
      if (record.status === status) return record
      // Progress is a live display fact, not part of the saved final snapshot.
      const { progress, ...body } = record.body
      const finished = { ...record, body, revision: record.revision + 1, status,
        ...(record.status === 'running' ? { capture: 'partial', reason: 'unconfirmed' } : {}) }
      if (records.get(record.entityId)?.revision <= record.revision) records.set(record.entityId, finished)
      return finished
    },
    close(status) { return [...records.values()].filter(record => record.status === 'running').map(record => this.finish(record, status)) },
  }
}

export function previewRecord(record, details = { state: 'unavailable' }) {
  const body = {}
  let truncated = false
  if (record.kind === 'changes') {
    Object.assign(body, { scope: record.body.scope, coverage: 'partial', fileCount: record.body.fileCount,
      ...(record.body.cwd ? { cwd: record.body.cwd } : {}),
      files: record.body.files.slice(0, 3).map(file => ({ path: file.path, edits: file.edits.slice(0, 1).map(({ operation, fromPath, availability }) => ({ operation, ...(fromPath ? { fromPath } : {}), ...(availability ? { availability } : {}) })) })) })
    truncated = record.body.files.length > 3 || record.body.files.some(file => file.edits.length > 0) || record.body.turnDiff !== undefined
  }
  for (const [key, limit] of [['inputText', 4000], ['outputText', 4000], ['command', 1000], ['cwd', 500], ['signal', 100]]) {
    const text = record.body[key] ?? (key === 'inputText' && record.body.input !== undefined ? toolText(record.body.input) : undefined)
    if (text === undefined) continue
    body[key] = text.slice(0, limit)
    truncated ||= text.length > limit
  }
  // Live progress is a bounded, latest-only display fact; the saved final
  // record drops it (finish), so history never shows a stale elapsed/byte count.
  if (record.status === 'running' && record.body.progress) body.progress = record.body.progress
  if (record.body.exitCode !== undefined) body.exitCode = record.body.exitCode
  const resources = previewResources(record.body.resources)
  if (resources?.length) {
    body.resources = resources
    truncated ||= record.body.resources.length > resources.length
  }
  if (record.body.diffs?.length) {
    const diff = record.body.diffs[0]
    if (JSON.stringify(diff).length <= 3000) body.diffs = [diff]
    truncated ||= record.body.diffs.length > (body.diffs?.length ?? 0)
  }
  const view = { ...record, body, truncated, details }
  if (JSON.stringify(view).length > 16000) {
    view.body = record.kind === 'changes' ? { scope: record.body.scope, coverage: 'partial', fileCount: record.body.fileCount, files: [] } : {}
    view.truncated = true
  }
  return view
}

export function changesTool(event) {
  if (event?.type !== 'changes') return null
  const supported = event.presentation?.kind === 'changes' && normalizePresentation(event.presentation)
  const workspace = supported?.body.scope === 'workspace-snapshot'
  return { type: 'tool', turnId: event.turnId, callId: `changes-${randomUUID()}`, name: '文件变更', phase: 'end',
    ...(supported ? { presentation: event.presentation } : {}), observation: true,
    brief: workspace ? '宿主工作区快照，不能据此归因于当前 Agent' : 'Agent 已确认的编辑文件，部分覆盖',
    output: supported ? workspace ? '宿主工作区变更记录（可能包含其他进程修改，部分覆盖）' : 'Agent 编辑文件记录（部分覆盖）' : '文件变更格式尚不支持，详情不可得。' }
}

// Native activity and plan projections are display-only, not model-visible thinking.
const noteClip = (text, limit) => text.length > limit ? `${text.slice(0, limit)}…` : text

/** The native path's one card per finished subtask: the end event only, carrying
 * the start-remembered title and the engine's result summary; start/update stay
 * silent while the running dock covers progress. */
export function activityRow(event) {
  if (event?.phase !== 'end') return null
  const title = typeof event?.title === 'string' && event.title ? noteClip(event.title.split('\n')[0], 160) : ''
  const detail = typeof event?.detail === 'string' && event.detail ? noteClip(event.detail, 200) : ''
  if (!title && !detail) return null
  return { type: 'tool', turnId: event.turnId, callId: `activity-${randomUUID()}`, name: title ? `子任务：${title}` : '子任务',
    phase: 'end', observation: true, isError: event.isError === true,
    brief: event.isError === true ? '子任务失败' : '子任务结束',
    output: detail || (event.isError === true ? '子任务失败' : '子任务已完成') }
}

/** The native path's one final plan row per turn: the last snapshot, never the update stream. */
export function planObservation(event) {
  const steps = Array.isArray(event?.steps) ? event.steps : []
  // A markdown-form plan (no steps) keeps its text; a structured one lists its
  // steps and the two forms never mix.
  const body = [typeof event?.explanation === 'string' && event.explanation ? event.explanation : '',
    ...(steps.length ? steps.map(step => `${step?.status === 'completed' ? '[x]' : step?.status === 'in_progress' ? '[~]' : '[ ]'} ${step?.text ?? ''}`)
      : [typeof event?.text === 'string' ? event.text : ''])]
    .filter(Boolean).join('\n').trim()
  if (body === '') return null
  return { type: 'tool', turnId: event.turnId, callId: `plan-${randomUUID()}`, name: '计划', phase: 'end', observation: true,
    brief: '本轮执行计划（最终快照）', output: body }
}

export function createStreamDetailStore(rt, limits = STREAM_LIMITS) {
  const folder = join(rt.home, 'stream-details')
  let writing = Promise.resolve()
  const index = () => {
    if (!plain(rt.state.streamDetails)) rt.state.streamDetails = {}
    return rt.state.streamDetails
  }
  const owner = (profileId, sessionId) => {
    const { profile, session } = rt.conversation(profileId, sessionId)
    return { profile, session }
  }
  const unavailable = (record, reason) => {
    const view = previewRecord(record, { state: 'unavailable', reason })
    if (view.body.resources) view.body.resources = view.body.resources.map(resource => resource.state === 'pending'
      ? { ...resource, state: 'unavailable', reason: 'storage-unavailable' } : resource)
    return view
  }
  const save = (conversationId, record) => {
    const operation = writing.then(async () => {
      await rt.load()
      const found = rt.conversationOf(conversationId)
      if (!found || record.conversationId !== conversationId || record.profileId !== found.profile.id) return unavailable(record, 'write-failed')
      if (rt.readOnly() !== undefined) return unavailable(record, 'read-only')
      await rt.loadSecrets()
      const all = Object.values(index()).filter(entry => entry.conversationId === conversationId)
      const sourceHash = digest(record)
      const previous = all.find(entry => entry.runId === record.runId && entry.entityId === record.entityId && entry.revision === record.revision)
      if (previous?.sourceHash === sourceHash) {
        const saved = await store.read({ profile: found.profile.id, session: conversationId, ref: previous.ref })
        return previewRecord(saved, { state: saved.reason === 'source-limit' ? 'truncated' : 'stored', ref: previous.ref })
      }
      if (previous?.sourceHash) return unavailable(record, 'conflict')
      const estimated = bytes(estimateResources(record))
      if (estimated > limits.detailBytes) return unavailable(record, 'detail-limit')
      if (all.length >= limits.entries || all.reduce((sum, entry) => sum + entry.bytes, 0) + estimated > limits.sessionBytes) return unavailable(record, 'quota')
      let sessionAttachments
      record = await materializeResources(record, {
        readFileImage: uri => readImageFile(uri, rt.sessionWorkspace?.(found.profile, found.session)?.cwd),
        validateImage: async image => {
          if (typeof rt.ctx?.attachments?.validateImage !== 'function') return false
          await rt.ctx.attachments.validateImage(image)
          return true
        },
        saveImage: async ({ mediaType, data, name }) => {
          if (typeof rt.saveImages !== 'function') return undefined
          const [saved] = await rt.saveImages([{ mediaType, data, name }])
          return saved
        },
        readAttachment: async attachment => {
          const signal = AbortSignal.timeout(ATTACHMENT_READ_TIMEOUT)
          const nativeId = found.session.nativeSessionId ?? (found.session.engine === 'dsh' ? found.session.driverSessionId : undefined)
          if (!nativeId) throw new Error('attachment-unavailable')
          if (!sessionAttachments) {
            const inspected = await rt.ctx?.sessionController?.inspect?.(nativeId, signal)
            sessionAttachments = new Set((inspected?.events ?? []).flatMap(event => {
              if (!['user/message', 'assistant/message', 'tool/result'].includes(event.type)) return []
              return projectContent(event.type === 'user/message' ? event.data?.content : event.data?.message?.content).resources.filter(resource => resource.attachment)
                .map(resource => JSON.stringify(resource.attachment))
            }))
          }
          if (!sessionAttachments.has(JSON.stringify(attachment))) throw new Error('attachment-unavailable')
          const stored = await rt.ctx?.attachments?.readImage?.(attachment, signal)
          if (!stored) throw new Error('attachment-unavailable')
          return { mediaType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64'), name: stored.ref.name }
        },
      })
      record = { ...record, body: rt.redactDeepSecrets(record.body), title: rt.redactDeepSecrets(record.title), source: rt.redactDeepSecrets(record.source) }
      const hash = digest(record)
      const saved = all.find(entry => entry.runId === record.runId && entry.entityId === record.entityId && entry.revision === record.revision && entry.hash === hash)
      if (saved) return previewRecord(record, { state: record.reason === 'source-limit' ? 'truncated' : 'stored', ref: saved.ref })
      if (all.some(entry => entry.runId === record.runId && entry.entityId === record.entityId && entry.revision === record.revision)) return unavailable(record, 'conflict')
      const size = bytes(record)
      if (size > limits.detailBytes) return unavailable(record, 'detail-limit')
      if (all.length >= limits.entries || all.reduce((sum, entry) => sum + entry.bytes, 0) + size > limits.sessionBytes) return unavailable(record, 'quota')
      const ref = randomUUID()
      const file = join(folder, `${ref}.json`)
      const temp = join(folder, `${ref}.tmp`)
      try {
        await mkdir(folder, { recursive: true, mode: 0o700 })
        await writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
        await rename(temp, file)
        index()[ref] = { ref, profileId: found.profile.id, conversationId, runId: record.runId, entityId: record.entityId,
          revision: record.revision, bytes: size, hash, sourceHash }
        try { await rt.save() } catch (error) { delete index()[ref]; throw error }
        return previewRecord(record, { state: record.reason === 'source-limit' ? 'truncated' : 'stored', ref })
      } catch {
        await unlink(temp).catch(() => {})
        await unlink(file).catch(() => {})
        rt.warn?.('nodo: tool detail could not be saved')
        return unavailable(record, 'write-failed')
      }
    }).catch(() => unavailable(record, 'write-failed'))
    writing = operation.then(() => {})
    return operation
  }
  const store = {
    save,
    async read({ profile, session, target, ref }) {
      await rt.load()
      if (!UUID.test(ref ?? '')) throw invalid()
      if (target) {
        const found = Object.values(rt.state.profiles).flatMap(p => rt.sessionsOf(p).map(s => ({ profile: p.id, session: s.id,
          native: s.nativeSessionId ?? (s.engine === 'dsh' ? s.driverSessionId : undefined) }))).find(item => item.native === target)
        if (!found) throw invalid()
        profile = found.profile; session = found.session
      }
      let owning
      try { owning = owner(profile, session) } catch { throw invalid() }
      const entry = index()[ref]
      if (!entry || entry.profileId !== owning.profile.id || entry.conversationId !== owning.session.id) throw invalid()
      let record
      try { record = JSON.parse(await readFile(join(folder, `${ref}.json`), 'utf8')) } catch { throw invalid() }
      if (record.version !== 1 || record.profileId !== entry.profileId || record.conversationId !== entry.conversationId
        || record.runId !== entry.runId || record.entityId !== entry.entityId || record.revision !== entry.revision || digest(record) !== entry.hash) throw invalid()
      await rt.loadSecrets()
      return rt.redactDeepSecrets(record)
    },
    async drop(profileId) {
      await writing
      const refs = Object.values(index()).filter(entry => entry.profileId === profileId).map(entry => entry.ref)
      for (const ref of refs) delete index()[ref]
      await rt.save()
      await Promise.all(refs.filter(ref => UUID.test(ref)).map(ref => unlink(join(folder, `${ref}.json`)).catch(() => rt.warn?.('nodo: retired tool detail cleanup failed'))))
    },
  }
  return store
}

export function install(rt) {
  const store = createStreamDetailStore(rt)
  Object.assign(rt, {
    newStreamRun(conversationId) {
      const found = rt.conversationOf(conversationId)
      if (!found) return null
      return createRecordTracker({ engine: found.session.engine, conversationId, profileId: found.profile.id,
        engineSessionId: found.session.driverSessionId, redact: value => rt.redactDeepSecrets(value) })
    },
    saveStreamRecord: store.save,
    readStreamDetail: store.read,
    dropStreamDetails: store.drop,
  })
}
