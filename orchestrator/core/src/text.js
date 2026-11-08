// Text helpers shared by the host modules.
import { NAME_MAX } from './constants.js'
import { invalid } from './errors.js'

export const normalize = value => `${value ?? ''}`.trim().toLowerCase()
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const UUID = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i
export const isUuid = value => typeof value === 'string' && UUID.test(value)
export const isUuidLike = value => typeof value === 'string' && /^[\da-f-]{36}$/i.test(value)

// Quote marks a user may type around a name, ASCII and CJK.
const QUOTES = new Set('"\'“”‘’「」『』《》')
export function unquote(text) {
  const chars = [...`${text ?? ''}`.trim()]
  while (QUOTES.has(chars[0])) chars.shift()
  while (QUOTES.has(chars.at(-1))) chars.pop()
  return chars.join('').trim()
}

// A user-typed display name: unquoted, length-capped, and unique up to
// normalization; `taken` returns the conflicting name, if any.
export function uniqueName(raw, what, taken) {
  const name = unquote(raw).slice(0, NAME_MAX)
  if (name === '') throw invalid(`A ${what} needs a name`)
  const conflict = taken(name)
  if (conflict !== undefined) throw invalid(`The name "${name}" is already ${conflict}`)
  return name
}

export const clip = (text, max, what) => (text.length <= max ? text : `${text.slice(0, max)}… (${what} truncated)`)

export function toolText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(toolText).filter(Boolean).join('\n')
  if (value.type === 'text') return value.text ?? ''
  if (value.type === 'content' || value.type === 'resource') return toolText(value.content ?? value.resource?.text)
  return JSON.stringify(value, null, 2) ?? ''
}
