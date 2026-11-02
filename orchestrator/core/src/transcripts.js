import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { appendFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TRANSCRIPT_MAX } from './constants.js'

const encode = lines => lines.map(line => JSON.stringify(line) + '\n').join('')
// A trailing row without its newline is still being written.
const parse = text => {
  const end = text.lastIndexOf('\n') + 1
  return { rows: text.slice(0, end).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    bytes: Buffer.byteLength(text.slice(0, end)), partial: end < text.length }
}
const stamp = path => {
  try { const s = statSync(path); return `${s.size}@${s.mtimeMs}` } catch { return '' }
}
const recent = lines => {
  const tail = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && tail.length < 16; i--) {
    bytes += Buffer.byteLength(JSON.stringify(lines[i]))
    if (bytes > 65536) break
    tail.unshift(lines[i])
  }
  return tail
}

// <id>.jsonl holds settled rows. While a turn runs, its rows also go to <id>.open, a
// journal of { i, line } records after a { start } header naming the size of
// <id>.jsonl it continues; the journal is folded into <id>.jsonl when the turn ends.
export function createTranscripts({ home, state, warn, writable, assertLock, active, settling, changed }) {
  const folder = join(home, 'transcripts')
  const entries = new Map()
  const pathOf = (id, extension = 'jsonl') => join(folder, `${encodeURIComponent(id)}.${extension}`)
  const openOf = id => pathOf(id, 'open')
  const replace = (path, lines) => {
    const temp = `${path}.${randomUUID()}.tmp`
    mkdirSync(folder, { recursive: true })
    assertLock()
    writeFileSync(temp, encode(lines))
    assertLock()
    renameSync(temp, path)
  }
  const readMain = id => {
    const path = pathOf(id)
    try {
      const { rows, bytes, partial } = parse(readFileSync(path, 'utf8'))
      if (partial && writable()) { assertLock(); truncateSync(path, bytes) }
      return { rows, bytes }
    } catch (error) {
      if (error.code !== 'ENOENT') throw Object.assign(error, { file: path })
    }
    const oldPath = pathOf(id, 'json')
    try {
      const rows = JSON.parse(readFileSync(oldPath, 'utf8'))
      if (!Array.isArray(rows)) throw new TypeError('not a list')
      if (!writable()) return { rows, bytes: 0 }
      replace(path, rows)
      assertLock()
      renameSync(oldPath, `${oldPath}.bak`)
      return { rows, bytes: Buffer.byteLength(encode(rows)) }
    } catch (error) {
      if (error.code !== 'ENOENT') throw Object.assign(error, { file: oldPath })
      return { rows: [], bytes: 0 }
    }
  }
  const read = id => readMain(id).rows
  const readOpen = (id, bytes) => {
    try {
      const [head, ...records] = parse(readFileSync(openOf(id), 'utf8')).rows
      if (head?.start !== bytes) return []
      const rows = new Map()
      for (const { i, line } of records) rows.set(i, line)
      return [...rows].sort(([a], [b]) => a - b).map(([, line]) => line)
    } catch (error) {
      if (error.code !== 'ENOENT') warn('nodo: unreadable transcript %s: %s; ignored', openOf(id), error)
      return []
    }
  }
  const entryOf = id => {
    let entry = entries.get(id)
    if (entry) return entry
    const embedded = state.transcripts[id] !== undefined
    let lines = state.transcripts[id] ?? [], open = [], bytes = 0, broken = false
    if (!embedded) {
      try {
        ({ rows: lines, bytes } = readMain(id))
        open = readOpen(id, bytes)
        if (writable()) {
          assertLock()
          if (open.length) { appendFileSync(pathOf(id), encode(open)); lines = [...lines, ...open]; open = [] }
          rmSync(openOf(id), { force: true })
        }
      } catch (error) {
        broken = error.file ?? pathOf(id)
        warn('nodo: unreadable transcript %s: %s; left unchanged', broken, error)
      }
    }
    const cut = Math.max(0, lines.length - TRANSCRIPT_MAX)
    if (cut && !embedded && writable() && !broken) replace(pathOf(id), lines.slice(cut))
    const kept = lines.slice(cut)
    const next = lines.length + open.length + 1
    entry = { base: Math.max(cut + 1, next - TRANSCRIPT_MAX), end: embedded ? cut : lines.length, next, fileRows: embedded ? 0 : kept.length,
      tail: embedded ? [] : recent(kept), dirty: new Map(), broken, bytes, journal: false, journalAt: 0,
      stamp: stamp(pathOf(id)), openStamp: stamp(openOf(id)) }
    entries.set(id, entry)
    state.transcripts[id] = embedded ? kept : open
    state.transcriptIndex[id] = { lines: next - entry.base, at: (state.transcripts[id].at(-1) ?? kept.at(-1))?.at ?? 0 }
    return entry
  }
  // Settled rows from `from` (at least base) through end, from the cached tail when it covers them.
  const diskLines = (id, entry, from = entry.base) => {
    const count = entry.end - Math.max(from, entry.base) + 1
    if (count <= 0) return []
    return count <= entry.tail.length ? entry.tail.slice(-count) : read(id).slice(-count)
  }
  const linesOf = id => {
    const entry = entryOf(id)
    return [...diskLines(id, entry), ...state.transcripts[id]].slice(-TRANSCRIPT_MAX)
  }
  const append = (id, line) => {
    const entry = entryOf(id)
    const saved = { at: Date.now(), ...line }
    state.transcripts[id].push(saved)
    entry.dirty.set(entry.next++, changed())
    entry.base = Math.max(entry.base, entry.next - TRANSCRIPT_MAX)
    if (state.transcripts[id].length > TRANSCRIPT_MAX) state.transcripts[id].shift()
    for (const n of entry.dirty.keys()) if (n < entry.base) entry.dirty.delete(n)
    state.transcriptIndex[id] = { lines: entry.next - entry.base, at: saved.at }
    return saved
  }
  const touch = (id, ...lines) => {
    const entry = entryOf(id)
    const pending = state.transcripts[id]
    const version = changed()
    for (const line of lines) {
      const index = pending.indexOf(line)
      if (index !== -1) entry.dirty.set(entry.next - pending.length + index, version)
    }
    return version
  }
  const delta = (id, since, token, version) => {
    const entry = entryOf(id)
    const { base, next, dirty } = entry
    const known = since?.token === token && Number.isInteger(since.n) && Number.isInteger(since.dirty)
      && since.n >= base - 1 && since.n < next
    if (!known) return { full: true, token, base, dirty: version, lines: linesOf(id).map((line, i) => ({ n: base + i, line })) }
    const appended = [], updated = []
    const pending = state.transcripts[id]
    const start = next - pending.length
    if (since.n < entry.end) {
      const from = Math.max(base, since.n + 1)
      const disk = diskLines(id, entry, from)
      for (let n = from; n <= entry.end; n++) appended.push({ n, line: disk[n - from] })
    }
    for (let i = 0; i < pending.length; i++) {
      const n = start + i
      if (n > since.n) appended.push({ n, line: pending[i] })
      else if (dirty.get(n) > since.dirty) updated.push({ n, line: pending[i] })
    }
    // A recently flushed row can still be newer than the client's position.
    const old = [...dirty].filter(([n, v]) => n >= base && n <= Math.min(since.n, entry.end) && v > since.dirty)
    if (old.length) {
      const from = Math.min(...old.map(([n]) => n))
      const disk = diskLines(id, entry, from)
      for (const [n] of old) updated.push({ n, line: disk[n - from] })
    }
    return { token, base, dirty: version, appended, changed: updated }
  }
  const settle = async (id, entry, pending) => {
    const end = entry.next - 1
    const count = pending.length
    mkdirSync(folder, { recursive: true })
    assertLock()
    await appendFile(pathOf(id), encode(pending), 'utf8')
    entry.end = end
    entry.fileRows += count
    entry.tail = recent([...entry.tail, ...pending.slice(0, count)])
    pending.splice(0, count)
    if (entry.journal) {
      assertLock()
      await rm(openOf(id), { force: true })
      Object.assign(entry, { journal: false, journalAt: 0 })
    }
    if (entry.fileRows > 2 * TRANSCRIPT_MAX) {
      replace(pathOf(id), read(id).slice(-TRANSCRIPT_MAX))
      entry.fileRows = TRANSCRIPT_MAX
    }
  }
  const journal = async (id, entry, pending) => {
    const start = entry.next - pending.length, first = entry.end + 1
    let at = entry.journalAt
    const records = []
    pending.forEach((line, i) => {
      const version = entry.dirty.get(start + i) ?? 0
      if (entry.journal && version <= entry.journalAt) return
      records.push({ i: start + i - first, line })
      at = Math.max(at, version)
    })
    if (!records.length) return
    mkdirSync(folder, { recursive: true })
    assertLock()
    if (entry.journal) await appendFile(openOf(id), encode(records), 'utf8')
    else {
      let size = 0
      try { size = statSync(pathOf(id)).size } catch {}
      await writeFile(openOf(id), encode([{ start: size }, ...records]), 'utf8')
      entry.journal = true
    }
    entry.journalAt = at
  }
  // Rows of a running turn go to its journal; others settle. A failed conversation
  // keeps its rows for the next pass without holding back the rest.
  const flush = async (force) => {
    const failed = []
    for (const id of Object.keys(state.transcripts)) {
      const entry = entryOf(id)
      const pending = state.transcripts[id]
      if (!pending.length) continue
      try {
        if (entry.broken) {
          if (entry.broken === pathOf(id)) {
            assertLock()
            renameSync(entry.broken, `${entry.broken}.broken-${Date.now()}`)
            warn('nodo: unreadable transcript %s moved aside; new rows start a new file', entry.broken)
          }
          entry.broken = false
        }
        await (force === true || !settling(id) && (force.has(id) || !active(id)) ? settle : journal)(id, entry, pending)
      } catch (error) {
        warn('nodo: transcript write failed %s: %s', pathOf(id), error)
        failed.push(error)
      }
      entry.stamp = stamp(pathOf(id))
      entry.openStamp = stamp(openOf(id))
    }
    return failed
  }
  // A reader drops a conversation whose settled rows changed and re-reads a moved journal.
  const follow = () => {
    let reset = false
    for (const [id, entry] of entries) {
      if (stamp(pathOf(id)) !== entry.stamp) {
        entries.delete(id)
        delete state.transcripts[id]
        reset = true
        continue
      }
      const openStamp = stamp(openOf(id))
      if (openStamp === entry.openStamp) continue
      entry.openStamp = openStamp
      const rows = readOpen(id, entry.bytes)
      const pending = state.transcripts[id]
      const first = entry.end + 1
      rows.forEach((line, i) => { if (JSON.stringify(line) !== JSON.stringify(pending[i])) entry.dirty.set(first + i, changed()) })
      pending.splice(0, pending.length, ...rows)
      entry.next = first + rows.length
      entry.base = Math.max(entry.base, entry.next - TRANSCRIPT_MAX)
    }
    return reset
  }
  const reset = () => entries.clear()
  return { linesOf, append, touch, delta, flush, follow, reset, entryOf }
}
