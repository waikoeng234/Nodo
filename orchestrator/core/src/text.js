// Text helpers shared by the host modules.
export const normalize = value => `${value ?? ''}`.trim().toLowerCase()

// Quote marks a user may type around a name, ASCII and CJK.
const QUOTES = new Set('"\'“”‘’「」『』《》')
export function unquote(text) {
  const chars = [...`${text ?? ''}`.trim()]
  while (QUOTES.has(chars[0])) chars.shift()
  while (QUOTES.has(chars.at(-1))) chars.pop()
  return chars.join('').trim()
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
