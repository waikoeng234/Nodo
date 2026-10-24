// Diagnostics: the warn() every module logs through, and a small ring of recent
// entries the client can read, so failures inside a host with no visible console
// (dsh Desktop) still reach the user. Saved key values are replaced before an
// entry is kept or logged.
import { format } from 'node:util'

const KEEP = 200

export function install(rt) {
  const { ctx } = rt
  const entries = []
  const keep = (level, text, max = 1000) => {
    const clean = String(rt.redactSecrets?.(text) ?? text)
    entries.push({ time: Date.now(), level, text: clean.slice(0, max) })
    entries.splice(0, entries.length - KEEP)
    return clean
  }
  const warn = (...args) => {
    const text = keep('warn', format(...args))
    try {
      ctx.logger?.warn?.('%s', text)
    } catch { /* no logger on this host; the ring still has it */ }
  }
  const noteFailure = ({ source, text, code, stack }) => {
    keep('error', `[${source}] ${text}${code ? ` (${code})` : ''}`)
    if (stack !== undefined) keep('error', String(stack), 2000)
  }
  const diagView = () => entries.map(entry => ({ ...entry }))

  Object.assign(rt, { warn, noteFailure, diagView })
}
