import { toolVariant } from './ui-shared.js'
import { toolFileChange } from './tool-file.ts'

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g

// What a session's model produced: files its write/edit tools touched inside the
// workspace, links in its replies and images it attached.
export function artifactsOf(lines, cwd) {
  const files = new Map(), links = new Set(), images = new Map(), calls = new Set()
  for (const line of lines) {
    if (line.kind === 'tool') {
      if (!['write', 'edit'].includes(toolVariant(line.name))) continue
      const call = line.callId ? JSON.stringify([line.turnId ?? null, line.callId]) : undefined
      if (call && calls.has(call)) continue
      if (call) calls.add(call)
      const file = toolFileChange(line.input, cwd)
      if (file && !file.display.startsWith('/')) files.set(file.display, { ...file, diffs: [...files.get(file.display)?.diffs ?? [], ...file.diffs] })
      continue
    }
    if (line.who === 'user') continue
    if (line.kind === 'text') for (const url of String(line.text ?? '').match(URL_RE) ?? []) links.add(url.replace(/[.,;:!?，。；：！？]+$/, ''))
    for (const image of line.images ?? []) images.set(image.id, image)
  }
  return { files: [...files.values()], links: [...links], images: [...images.values()] }
}
