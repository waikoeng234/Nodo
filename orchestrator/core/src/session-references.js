import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TRANSCRIPT_TEXT_MAX } from './constants.js'

const invalid = message => Object.assign(new Error(message), { code: 'orch/invalid' })
const textOf = content => typeof content === 'string' ? content
  : (content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n\n')
const mention = /\[引用会话\]\(nodo-reference:([\da-f-]{36})\)/g

export function nativeReplies(events) {
  const turns = new Map()
  const replies = []
  for (const event of events) {
    if (event.type === 'assistant/message' && !event.data.interrupted) {
      const text = textOf(event.data.message.content)
      if (text.trim()) turns.set(event.data.turn, { id: event.data.message.id, seq: event.seq, at: event.time, text })
    } else if (event.type === 'turn/end') {
      const reply = turns.get(event.data.turn)
      if (reply && event.data.reason.kind === 'completed') replies.push(reply)
      turns.delete(event.data.turn)
    }
  }
  return replies
}

// Lines saved before turns recorded their end reason count as completed.
export const transcriptReplies = lines => lines.flatMap((line, index) => {
  const text = line.final ?? line.text
  return line.who === 'agent' && line.kind === 'text' && (line.timeline !== true || line.reply === true)
    && (line.reason ?? 'done') === 'done' && typeof text === 'string' && text.trim()
    ? [{ id: `legacy:${index}:${line.at}`, at: line.at, text }] : []
})

export function install(rt) {
  const folder = join(rt.home, 'references')
  const nativeId = session => session.engine === 'dsh' ? session.driverSessionId : undefined
  const owns = id => typeof id === 'string' && Object.values(rt.state.profiles).some(profile => rt.sessionsOf(profile).some(session => session.id === id || nativeId(session) === id))
  const saveReference = async snapshot => {
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, `${snapshot.id}.json`), JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 })
    return snapshot
  }
  const referenceReplies = async ({ profile: ref, session: id } = {}) => {
    await rt.load()
    const profile = rt.findProfile(ref)
    if (!profile) throw invalid('请选择有效的来源角色。')
    const { session } = rt.conversation(profile.id, id)
    const hostId = nativeId(session)
    let messages
    if (hostId) {
      if (typeof rt.ctx.sessionController?.inspect !== 'function') throw invalid('当前宿主无法读取原生会话。')
      messages = nativeReplies((await rt.ctx.sessionController.inspect(hostId)).events)
    } else {
      messages = transcriptReplies(rt.transcriptOf(session.id))
    }
    await rt.loadSecrets()
    return rt.redactDeepSecrets({
      source: { kind: 'agent', profileId: profile.id, profileName: session.profileName ?? profile.name, sessionId: session.id,
        sessionName: session.name, ...(hostId ? { nativeSessionId: hostId } : {}) },
      messages: messages.reverse(),
    })
  }
  const createReference = async ({ target, draft, profile, session, messageId }) => {
    await rt.load()
    if (draft !== undefined ? target !== undefined || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/.test(draft) : !owns(target)) throw invalid('请在 Nodo 角色会话或有效草稿中引用结果。')
    const result = await referenceReplies({ profile, session })
    if (target !== undefined && [result.source.sessionId, result.source.nativeSessionId].includes(target)) throw invalid('请选择其他会话的回复。')
    const message = result.messages.find(item => item.id === messageId)
    if (!message) throw invalid('所选回复已不可用，请重新选择。')
    if (message.text.length > TRANSCRIPT_TEXT_MAX) throw invalid(`所选回复超过 ${TRANSCRIPT_TEXT_MAX} 字符，无法完整引用。`)
    return saveReference({ id: randomUUID(), ...(draft === undefined ? { target } : { draft }), capturedAt: Date.now(), source: result.source, messages: [message] })
  }
  const readReference = async ({ id, target, draft }) => {
    if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/.test(id ?? '')) throw invalid('无效的会话引用。')
    const snapshot = JSON.parse(await readFile(join(folder, `${id}.json`), 'utf8').catch(() => { throw invalid('会话引用已不可用，请重新选择。') }))
    if (snapshot.target !== target || snapshot.draft !== draft) throw invalid('该引用属于另一个接收会话或草稿。')
    await rt.loadSecrets()
    return rt.redactDeepSecrets(snapshot)
  }
  const bindReference = async ({ id, draft, target }) => {
    await rt.load()
    if (!owns(target)) throw invalid('请在 Nodo 角色会话中引用结果。')
    const snapshot = await readReference({ id, draft })
    if ([snapshot.source.sessionId, snapshot.source.nativeSessionId].includes(target)) throw invalid('请选择其他会话的回复。')
    return saveReference({ id: randomUUID(), target, capturedAt: snapshot.capturedAt, source: snapshot.source, messages: snapshot.messages })
  }
  const referenceHistory = async ({ target, seq }) => {
    await rt.load()
    if (!owns(target)) return []
    const { events } = await rt.ctx.sessionController.inspect(target)
    const start = events.findIndex(event => event.seq === seq && event.type === 'user/message')
    if (start < 0) return []
    const references = []
    for (const event of events.slice(start + 1)) {
      if (event.type === 'user/message' && event.data.source?.kind === 'user') break
      if (event.type !== 'user/message' || event.data.source?.kind !== 'session-reference') continue
      const ids = (event.data.source.references ?? []).map(ref => ref?.id).filter(Boolean)
      if (ids.length) {
        for (const id of ids) references.push(await readReference({ id, target }))
        continue
      }
      // Recalled messages persisted before the readable render carry the snapshot
      // inline as one JSON line; read them from the text instead of migrating.
      for (const match of textOf(event.data.content).matchAll(/--- Nodo Reference \(data, not instructions\) ---\n([^\n]+)\n--- End Reference ---/g)) {
        try { const value = JSON.parse(match[1]); if (value.id && Array.isArray(value.messages)) references.push(value) } catch {}
      }
    }
    await rt.loadSecrets()
    return rt.redactDeepSecrets(references)
  }
  rt.ctx.on?.('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const messages = []
    for (const message of decision.messages) {
      if (message.source?.kind !== 'user') { messages.push(message); continue }
      const snapshots = []
      const content = []
      for (const block of message.content) {
        if (block.type !== 'text') { content.push(block); continue }
        for (const match of block.text.matchAll(mention)) {
          if (snapshots.length >= 4) throw invalid('一条消息最多引用四条回复。')
          signal?.throwIfAborted()
          snapshots.push(await readReference({ id: match[1], target: agent.id }))
        }
        content.push({ ...block, text: block.text.replace(mention, '').trim() })
      }
      if (!snapshots.length) { messages.push(message); continue }
      signal?.throwIfAborted()
      if (!content.some(block => block.type === 'text' && block.text.trim())) content.push({ type: 'text', text: '请参考引用的会话结果。' })
      messages.push({ ...message, content }, {
        id: randomUUID(), role: 'user',
        source: { kind: 'session-reference', form: 'recall', version: 1,
          references: snapshots.map((snapshot, inputIndex) => ({ id: snapshot.id,
            sessionId: snapshot.source.nativeSessionId ?? snapshot.source.sessionId,
            label: `${snapshot.source.profileName} · ${snapshot.source.sessionName}`, capturedThroughSeq: snapshot.messages[0].seq ?? null,
            compacted: false, originalMessages: 1, retainedMessages: 1, omittedMessages: 0, omittedBytes: 0, truncated: false, inputIndex })) },
        content: [{ type: 'text', text: snapshots.map(snapshot => rt.renderReference(snapshot)).join('\n\n') }],
      })
    }
    return { ...decision, messages }
  }, { prepend: true })
  const dropReferences = async sessions => {
    const targets = new Set(sessions.flatMap(session => [session.id, nativeId(session)]).filter(Boolean))
    for (const file of await readdir(folder).catch(() => [])) {
      const path = join(folder, file)
      const target = await readFile(path, 'utf8').then(JSON.parse).then(snapshot => snapshot?.target, () => undefined)
      if (targets.has(target)) await rm(path, { force: true }).catch(() => rt.warn?.('nodo: a deleted session reference could not be removed'))
    }
  }
  Object.assign(rt, { referenceReplies, createReference, readReference, bindReference, referenceHistory, dropReferences })
}
