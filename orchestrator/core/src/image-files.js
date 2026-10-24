import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMAGE_BYTES_MAX } from './constants.js'

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
const inside = (root, path) => {
  const rest = relative(root, path)
  return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
}
const localPath = uri => {
  if (typeof uri !== 'string' || !uri || uri.includes('\0')) return undefined
  try {
    if (/^file:/i.test(uri)) return fileURLToPath(uri)
    if (/^[a-z][\w+.-]*:/i.test(uri) || uri.startsWith('//')) return undefined
    return decodeURIComponent(uri)
  } catch { return undefined }
}

export const imageFileType = uri => TYPES[extname(localPath(uri) ?? '').toLowerCase()]

export async function readImageFile(uri, cwd) {
  const path = localPath(uri)
  if (!path || !imageFileType(uri) || !cwd) throw new Error('attachment-unavailable')
  const protectedRoot = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  if (inside(protectedRoot, resolve(cwd, path))) throw new Error('attachment-unavailable')
  const full = await realpath(resolve(cwd, path))
  const generated = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'generated_images')
  const roots = await Promise.all([cwd, tmpdir(), '/tmp', generated].map(root => realpath(root).catch(() => null)))
  if (!roots.some(root => root && inside(root, full)) || inside(protectedRoot, full)) throw new Error('attachment-unavailable')
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('attachment-unavailable')
    if (info.size > IMAGE_BYTES_MAX) throw new Error('image-too-large')
    const bytes = Buffer.alloc(Math.min(info.size, IMAGE_BYTES_MAX) + 1)
    let size = 0
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > IMAGE_BYTES_MAX) throw new Error('image-too-large')
    return { mediaType: imageFileType(uri), data: bytes.subarray(0, size).toString('base64'), name: basename(full) }
  } finally { await handle.close() }
}

// Only explicit image file links become candidates for local reads.
export function imageReferences(text) {
  const links = String(text).matchAll(/\]\(\s*(?:<([^>\n]+)>|((?:[^()\s]|\([^()\n]*\))+))(?:\s+["'][^"'\n]*["'])?\s*\)/g)
  return [...new Set([...links].map(match => match[1] ?? match[2]).filter(imageFileType))]
}
