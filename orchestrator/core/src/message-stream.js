import { TRANSCRIPT_TEXT_MAX } from './constants.js'
import { clip } from './text.js'

export function createMessageStream({ append, redact, save = () => {} }) {
  const entries = [], identities = new Map(), pending = new Map()
  let current = null
  const close = () => {
    if (current) { current.line.open = false; save() }
    current = null
  }
  const text = () => entries.filter(entry => entry.line.kind === 'text' && !entry.line.parentCallId).map(entry => entry.raw).join('\n')
  const accept = event => {
    const kind = event.type === 'thinking' ? 'thinking' : 'text'
    const identified = typeof event.messageId === 'string' && event.messageId !== ''
    const key = identified ? JSON.stringify([kind, event.messageId, event.blockIndex ?? null, event.parentCallId ?? null]) : null
    if (event.boundary === 'start') {
      close()
      if (key !== null) pending.set(key, event)
    }
    let created = false
    let entry = key !== null ? identities.get(key)
      : current?.line.kind === kind && current.line.messageId === undefined && current.line.blockIndex === event.blockIndex
        && current.line.parentCallId === event.parentCallId && event.type !== 'text' ? current : null
    if (!entry && identified && event.parentCallId !== undefined) {
      const unowned = identities.get(JSON.stringify([kind, event.messageId, event.blockIndex ?? null, null]))
      if (unowned && unowned.line.parentCallId === undefined) { entry = unowned; identities.set(key, entry) }
    }
    const hasText = typeof event.text === 'string' && event.text !== ''
    if (!entry && hasText) {
      close()
      const source = Object.fromEntries(['turnId', 'messageId', 'blockIndex', 'channel', 'parentCallId']
        .map(field => [field, event[field] ?? pending.get(key)?.[field]]).filter(([, value]) => value !== undefined))
      entry = { raw: '', line: append({ who: 'agent', kind, timeline: true, text: '', open: true, ...redact(source) }) }
      entries.push(entry)
      created = true
      if (key !== null) identities.set(key, entry)
      pending.delete(key)
    }
    if (entry) {
      if (hasText) {
        if (current !== entry && event.type !== 'text') close()
        entry.raw = event.type === 'text' ? event.text : entry.raw + event.text
        entry.raw = entry.raw.slice(0, TRANSCRIPT_TEXT_MAX + 1)
        entry.line.text = clip(redact(entry.raw), TRANSCRIPT_TEXT_MAX, kind === 'text' ? 'long reply' : 'long reasoning')
      }
      if (event.channel !== undefined) entry.line.channel = redact(event.channel)
      if (event.parentCallId !== undefined) entry.line.parentCallId = redact(event.parentCallId)
      entry.line.open = event.boundary !== 'end' && event.type !== 'text'
      if (entry.line.open) current = entry
      else if (current === entry) current = null
    }
    if (event.boundary === 'end' && key === null && (event.blockIndex === undefined
      || current?.line.kind === kind && current.line.blockIndex === event.blockIndex)) close()
    if (created || event.boundary === 'end' || event.type === 'text') save()
    return entry?.line
  }
  const finish = (reason, final) => {
    close()
    const replies = () => entries.filter(entry => entry.line.kind === 'text' && !entry.line.parentCallId)
    if (typeof final === 'string' && final.trim()) {
      const normalize = value => value.trimEnd()
      const candidates = replies(), last = candidates.at(-1)
      const blocks = last?.line.messageId === undefined ? [] : candidates.filter(entry => entry.line.messageId === last.line.messageId)
        .sort((a, b) => (a.line.blockIndex ?? 0) - (b.line.blockIndex ?? 0))
      if (![text(), ...candidates.map(entry => entry.raw), blocks.map(entry => entry.raw).join('')]
        .some(value => normalize(value) === normalize(final))) accept({ type: 'text', text: final })
    }
    const last = replies().filter(entry => entry.raw.trim()).at(-1)
    for (const entry of entries) {
      entry.line.open = false
      if (entry.line.kind === 'text') {
        entry.line.reason = reason
        entry.line.reply = entry === last
      }
    }
    if (last && typeof final === 'string' && final.trim()) last.line.final = clip(redact(final), TRANSCRIPT_TEXT_MAX, 'long reply')
    return entries.filter(entry => entry.line.kind === 'text').map(entry => entry.line)
  }
  return { accept, close, finish, text }
}
