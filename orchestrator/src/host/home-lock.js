// state.lock names the one dsh host that may write the plugin home; any other host
// sharing the directory only reads. A holder on this machine counts while its process
// lives and the machine has not restarted since. A holder elsewhere, or an unreadable
// lock, counts until the file's mtime has stood still for `staleMs` as seen here, so
// clocks of different machines are never compared. The random token, not the pid,
// tells a holder it still owns the lock.
import { randomUUID } from 'node:crypto'
import { linkSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, uptime } from 'node:os'

const processAlive = (pid) => {
  try {
    return process.kill(pid, 0)
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function homeLock(path, { staleMs = 60_000, beatMs = 15_000, host = hostname(), pid = process.pid, boot = Date.now() - uptime() * 1000, isAlive = processAlive, now = Date.now } = {}) {
  const token = randomUUID()
  let beating
  // The lock file's mtime and when this process first saw it.
  let stamp

  // undefined when there is no lock file, '' when it cannot be read.
  const text = (file = path) => {
    try {
      return readFileSync(file, 'utf8')
    } catch (error) {
      return error.code === 'ENOENT' ? undefined : ''
    }
  }
  const parse = (raw) => {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  const fresh = () => {
    let mtime
    try {
      mtime = statSync(path).mtimeMs
    } catch {
      return false
    }
    if (stamp?.mtime !== mtime) stamp = { mtime, at: now() }
    return now() - stamp.at < staleMs
  }
  // Boot times derived from whole-second uptimes differ slightly between processes.
  const sameBoot = record => record.boot === undefined || Math.abs(record.boot - boot) < staleMs
  const held = record => (record?.host === host ? record.pid !== pid && sameBoot(record) && isAlive(record.pid) : fresh())
  const owns = () => parse(text())?.token === token
  const remove = (file = path) => {
    try { rmSync(file, { force: true }) } catch {}
  }
  // Moving a dead holder's file aside before removing it puts back a lock written meanwhile instead of deleting it.
  const evict = (raw) => {
    const aside = `${path}.${token}`
    try { renameSync(path, aside) } catch { return }
    if (text(aside) !== raw) try { linkSync(aside, path) } catch {}
    remove(aside)
  }

  const stopBeating = () => {
    clearInterval(beating)
    beating = undefined
  }
  const beat = () => {
    if (!owns()) return stopBeating()
    const time = new Date(now())
    try { utimesSync(path, time, time) } catch {}
  }
  const create = () => {
    try {
      writeFileSync(path, JSON.stringify({ pid, host, boot, token, since: now() }), { flag: 'wx' })
    } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    }
    stopBeating()
    beating = setInterval(beat, beatMs)
    beating.unref?.()
    return true
  }

  // undefined when this process holds the lock, else the holder's record ({} if unknown).
  function claim() {
    if (owns()) return undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      if (create()) return undefined
      const raw = text()
      if (raw === undefined) continue
      const record = parse(raw)
      if (held(record)) return record ?? {}
      if (text() === raw) evict(raw)
    }
    return parse(text()) ?? {}
  }

  function release() {
    stopBeating()
    if (owns()) remove()
  }

  return { claim, owns, release }
}
