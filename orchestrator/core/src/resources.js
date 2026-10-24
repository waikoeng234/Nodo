// Engine tool results may carry structured content blocks (ACP ContentBlock,
// Claude tool_result content, DSH ContentBlock, Codex dynamic tool items).
// Only confirmed blocks become resources. Text keeps the legacy flat form, and
// inline bytes stay transient until the detail writer replaces them with
// stored attachment references. Remote URIs remain references.
import { imageFileType, imageReferences } from './image-files.js'
export const RESOURCE_LIMITS = Object.freeze({ count: 16, preview: 4, images: 8, text: 4000, uri: 1000, name: 200, mimeType: 100, imageBytes: 5 * 1024 * 1024 })
export const RESOURCE_KINDS = Object.freeze(['image', 'file', 'link', 'audio', 'text'])
export const RESOURCE_STATES = Object.freeze(['pending', 'stored', 'reference', 'unsupported', 'unavailable'])
export const RESOURCE_REASONS = Object.freeze(['unsupported-type', 'invalid-image', 'image-too-large', 'storage-unavailable', 'attachment-unavailable', 'source-limit', 'no-reader'])
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const blobs = new Set(['image', 'audio', 'resource_link', 'file', 'inputImage', 'inputAudio'])
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const cut = (value, max) => typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined
const mediaTypeOf = value => typeof value === 'string' && value !== '' ? value.toLowerCase().slice(0, RESOURCE_LIMITS.mimeType) : undefined
const base64Bytes = data => Buffer.byteLength(data, 'base64')
const decodeImage = data => {
  if (typeof data !== 'string' || data === '') return undefined
  data = data.replace(/\s+/g, '')
  const bytes = Buffer.from(data, 'base64')
  return bytes.length > 0 && bytes.toString('base64') === data ? bytes : undefined
}
const signatureOk = (type, bytes) => {
  if (type === 'image/png') return bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
  if (type === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  return false
}
const sizeOf = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined
const positive = value => Number.isSafeInteger(value) && value > 0
const dataUrl = value => {
  if (typeof value !== 'string') return undefined
  const match = /^data:([^;,]+)(?:;[^,;]*)*;base64,([\s\S]+)$/i.exec(value)
  return match ? { mimeType: match[1].toLowerCase(), data: match[2].replace(/\s+/g, '') } : undefined
}
const uriOf = value => {
  if (typeof value !== 'string' || value === '' || value.startsWith('data:')) return undefined
  return value.slice(0, RESOURCE_LIMITS.uri)
}
const nameOf = (value, uri) => cut(value, RESOURCE_LIMITS.name)
  ?? cut(typeof uri === 'string' ? uri.split(/[\\/]/).filter(Boolean).pop() : undefined, RESOURCE_LIMITS.name)
const base = (kind, fields) => ({ kind, state: 'pending', ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) })

function imageEntry({ mimeType, data, uri, name, bytes }) {
  const type = mediaTypeOf(mimeType)
  const entry = base('image', { mimeType: type, uri: uriOf(uri), name: nameOf(name, uri), bytes: sizeOf(bytes) })
  if (!type || !IMAGE_TYPES.has(type)) return { ...entry, state: 'unsupported', reason: 'unsupported-type' }
  const decoded = decodeImage(data)
  if (!decoded) return { ...entry, state: 'unavailable', reason: 'invalid-image' }
  if (decoded.length > RESOURCE_LIMITS.imageBytes) return { ...entry, bytes: decoded.length, state: 'unavailable', reason: 'image-too-large' }
  if (!signatureOk(type, decoded)) return { ...entry, state: 'unavailable', reason: 'invalid-image' }
  return { ...entry, bytes: decoded.length, data: decoded.toString('base64') }
}

// The engine's verified ImageAttachmentRef is passed to the attachment store
// unchanged; its width/height/bytes must still match the stored bytes.
function attachmentRef(value) {
  if (!plain(value)) return undefined
  const type = mediaTypeOf(value.mediaType)
  if (typeof value.attachmentId !== 'string' || value.attachmentId === '' || !IMAGE_TYPES.has(type)) return undefined
  if (![value.bytes, value.width, value.height].every(positive)) return undefined
  const reference = { attachmentId: value.attachmentId, mediaType: type, bytes: value.bytes, width: value.width, height: value.height }
  const name = cut(value.name, RESOURCE_LIMITS.name)
  if (name) reference.name = name
  const original = value.originalDimensions
  if (plain(original) && positive(original.width) && positive(original.height)) reference.originalDimensions = { width: original.width, height: original.height }
  return reference
}

function linkEntry({ uri, mimeType, size, name }) {
  const inline = dataUrl(uri)
  if (inline) {
    const entry = base('file', { mimeType: mediaTypeOf(inline.mimeType), bytes: base64Bytes(inline.data), name: nameOf(name, uri) })
    if (IMAGE_TYPES.has(entry.mimeType)) return imageEntry({ mimeType: inline.mimeType, data: inline.data, name })
    return { ...entry, state: 'reference', reason: 'no-reader' }
  }
  const entry = { ...base('link', { mimeType: mediaTypeOf(mimeType), uri: uriOf(uri), bytes: sizeOf(size), name: nameOf(name, uri) }), state: 'reference' }
  if (imageFileType(uri)) return { ...entry, kind: 'image', state: 'pending', mimeType: imageFileType(uri) }
  return entry.uri || entry.name ? entry : undefined
}

function blockEntry(block) {
  const type = typeof block.type === 'string' ? block.type : ''
  switch (type) {
    case 'content':
      return plain(block.content) ? blockEntry(block.content) : undefined
    case 'image':
    case 'inputImage': {
      if (plain(block.attachment)) {
        const reference = attachmentRef(block.attachment)
        if (!reference) return { kind: 'image', state: 'unavailable', reason: 'invalid-image' }
        return { ...base('image', { mimeType: mediaTypeOf(reference.mediaType), bytes: reference.bytes, name: reference.name }), attachment: reference }
      }
      if (plain(block.source)) {
        if (block.source.type === 'base64') return imageEntry({ mimeType: block.source.media_type, data: block.source.data, uri: block.uri, name: block.name })
        if (block.source.type === 'url') return linkEntry({ uri: block.source.url, name: block.name })
        return { kind: 'image', state: 'unavailable', reason: 'invalid-image' }
      }
      if (block.imageUrl !== undefined) {
        const inline = dataUrl(block.imageUrl)
        return inline ? imageEntry({ mimeType: inline.mimeType, data: inline.data, name: block.name })
          : linkEntry({ uri: block.imageUrl, mimeType: block.mimeType, name: block.name })
      }
      return imageEntry({ mimeType: block.mimeType, data: block.data, uri: block.uri, name: block.name })
    }
    case 'audio':
    case 'inputAudio': {
      const uri = type === 'audio' ? block.uri : block.audioUrl
      const inline = dataUrl(uri)
      return { ...base('audio', { mimeType: mediaTypeOf(block.mimeType ?? inline?.mimeType), uri: inline ? undefined : uriOf(uri), bytes: inline ? base64Bytes(inline.data) : undefined }),
        state: 'unsupported', reason: 'unsupported-type' }
    }
    case 'resource_link':
      return linkEntry({ uri: block.uri, mimeType: block.mimeType, size: block.size, name: block.name })
    case 'resource': {
      const inner = plain(block.resource) ? block.resource : block
      if (typeof inner.text === 'string') {
        return { ...base('text', { mimeType: mediaTypeOf(inner.mimeType), uri: uriOf(inner.uri), bytes: Buffer.byteLength(inner.text), name: nameOf(inner.name, inner.uri) }), state: 'reference' }
      }
      if (typeof inner.blob === 'string') {
        if (IMAGE_TYPES.has(mediaTypeOf(inner.mimeType))) return imageEntry({ mimeType: inner.mimeType, data: inner.blob, uri: inner.uri, name: inner.name })
        return { ...base('file', { mimeType: mediaTypeOf(inner.mimeType), uri: uriOf(inner.uri), bytes: base64Bytes(inner.blob), name: nameOf(inner.name, inner.uri) }), state: 'reference', reason: 'no-reader' }
      }
      return linkEntry({ uri: inner.uri, mimeType: inner.mimeType, name: inner.name })
    }
    case 'file': {
      const reference = plain(block.attachment) ? block.attachment : undefined
      return { ...base('file', { bytes: sizeOf(reference?.bytes), name: nameOf(reference?.name) }), state: 'reference', reason: 'no-reader' }
    }
    default:
      return undefined
  }
}

// Strings, content blocks and JSON fallbacks share the same binary-text notice.
const safeText = item => {
  if (typeof item !== 'string' || item.length < 1000) return item
  if (/^data:/i.test(item)) return `[embedded data omitted: ${item.length} chars]`
  if (/^[A-Za-z0-9+/=\r\n\t]+$/.test(item)) return `[binary-like text omitted: ${item.length} chars]`
  return item
}
const safeJson = value => JSON.stringify(value, (_key, item) => safeText(item), 2) ?? String(value)

export function projectContent(value, imageOutput = false) {
  const text = []
  const resources = []
  let truncated = false
  let images = 0
  const push = entry => {
    if (!entry) return
    if (resources.length >= RESOURCE_LIMITS.count || entry.kind === 'image' && images >= RESOURCE_LIMITS.images) { truncated = true; return }
    if (entry.kind === 'image') images += 1
    resources.push(entry)
  }
  const walk = item => {
    if (item === null || item === undefined) return
    if (typeof item === 'string') {
      const decoded = imageOutput ? decodeImage(item) : undefined
      const mimeType = decoded && [...IMAGE_TYPES].find(type => signatureOk(type, decoded))
      if (mimeType) { push(imageEntry({ mimeType, data: item })); return }
      text.push(safeText(item))
      for (const uri of imageReferences(item)) push(linkEntry({ uri }))
      return
    }
    if (Array.isArray(item)) { for (const member of item) walk(member); return }
    if (!plain(item)) { text.push(String(item)); return }
    const type = typeof item.type === 'string' ? item.type : ''
    if (type === 'content') { walk(item.content); return }
    if (type === 'text' || type === 'inputText') { if (typeof item.text === 'string') walk(item.text); return }
    if (!type && Array.isArray(item.content)) { walk(item.content); return }
    if (type === 'reasoning' || type === 'tool-call' || type === 'tool-addition' || type === 'tool-removal') return
    if (type === 'resource') {
      const inner = plain(item.resource) ? item.resource : item
      if (typeof inner.text === 'string') text.push(safeText(inner.text))
      push(blockEntry(item))
      return
    }
    if (blobs.has(type)) { push(blockEntry(item)); return }
    text.push(safeJson(item))
  }
  walk(value)
  if (imageOutput) {
    const inline = resources.find(entry => entry.kind === 'image' && entry.data)
    const index = resources.findIndex(entry => entry.kind === 'image' && !entry.data && imageFileType(entry.uri))
    if (inline && index >= 0) {
      const reference = resources.splice(index, 1)[0]
      inline.uri = reference.uri
      inline.name = reference.name
    }
  }
  return { text: text.filter(part => part !== '').join('\n'), resources, truncated }
}

export function normalizeResources(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  const resources = []
  for (const item of value.slice(0, RESOURCE_LIMITS.count)) {
    if (!plain(item) || !RESOURCE_KINDS.includes(item.kind) || !RESOURCE_STATES.includes(item.state)) continue
    const entry = { kind: item.kind, state: item.state }
    if (RESOURCE_REASONS.includes(item.reason)) entry.reason = item.reason
    for (const key of ['name', 'mimeType', 'uri']) if (cut(item[key], RESOURCE_LIMITS[key]) !== undefined) entry[key] = item[key].slice(0, RESOURCE_LIMITS[key])
    if (sizeOf(item.bytes) !== undefined) entry.bytes = item.bytes
    if (plain(item.ref) && typeof item.ref.id === 'string' && /^[0-9a-f-]{36}$/.test(item.ref.id) && IMAGE_TYPES.has(mediaTypeOf(item.ref.mediaType))) {
      entry.ref = { id: item.ref.id, mediaType: mediaTypeOf(item.ref.mediaType) }
    }
    if (entry.kind === 'image' && entry.state === 'stored' && !entry.ref) { entry.state = 'unavailable'; entry.reason = 'storage-unavailable' }
    resources.push(entry)
  }
  return resources
}

export function previewResources(value) {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, RESOURCE_LIMITS.preview).map(resource => {
    const { data: _data, attachment: _attachment, ...rest } = resource
    return rest
  })
}

// Worst-case size of the record after materialization: each pending image is
// replaced by its stored reference form, so the detail writer can refuse a
// record before creating attachment files that would become orphans.
export function estimateResources(record) {
  const list = record?.body?.resources
  if (!Array.isArray(list) || list.length === 0) return record
  const resources = list.map(entry => {
    if (!plain(entry) || entry.kind !== 'image' || entry.state !== 'pending') return entry
    const { data: _data, attachment: _attachment, state: _state, reason: _reason, ...saved } = entry
    const mediaType = saved.mimeType ?? (plain(entry.attachment) ? mediaTypeOf(entry.attachment.mediaType) : undefined)
    const hasPayload = typeof entry.data === 'string' && entry.data !== '' || plain(entry.attachment) || imageFileType(entry.uri)
    if (!hasPayload || !mediaType) return { ...saved, state: 'unavailable', reason: 'invalid-image' }
    return { ...saved, state: 'stored', ref: { id: '0'.repeat(36), mediaType } }
  })
  return { ...record, body: { ...record.body, resources } }
}

// Inline bytes become stored attachment references exactly once, before the
// record is hashed or written. A refused type/size or an unreadable source
// attachment stays visible as an explicit unavailable resource.
export async function materializeResources(record, { saveImage, readAttachment, readFileImage, validateImage } = {}) {
  const list = record?.body?.resources
  if (!Array.isArray(list) || list.length === 0) return record
  const resources = []
  for (const entry of list) {
    if (!plain(entry) || entry.kind !== 'image' || entry.state !== 'pending') { resources.push(entry); continue }
    const saved = { ...entry }
    delete saved.data
    delete saved.attachment
    delete saved.state
    delete saved.reason
    let payload = typeof entry.data === 'string' && entry.data !== '' ? entry.data : undefined
    let mediaType = saved.mimeType
    let name = saved.name
    if (payload === undefined && !plain(entry.attachment) && imageFileType(entry.uri)) {
      try {
        const read = await readFileImage?.(entry.uri)
        if (!read) throw new Error('attachment-unavailable')
        payload = read.data
        mediaType = read.mediaType
        name = read.name ?? name
      } catch (error) {
        resources.push({ ...saved, state: 'unavailable', reason: error?.message === 'image-too-large' ? 'image-too-large' : 'attachment-unavailable' })
        continue
      }
    }
    if (payload === undefined) {
      if (!plain(entry.attachment) || typeof readAttachment !== 'function') {
        resources.push({ ...saved, state: 'unavailable', reason: plain(entry.attachment) ? 'attachment-unavailable' : 'invalid-image' })
        continue
      }
      try {
        const read = await readAttachment(entry.attachment)
        payload = read.data
        mediaType = read.mediaType ?? mediaType
        name = read.name ?? name
      } catch {
        resources.push({ ...saved, state: 'unavailable', reason: 'attachment-unavailable' })
        continue
      }
    }
    const decoded = decodeImage(payload)
    if (!decoded) {
      resources.push({ ...saved, state: 'unavailable', reason: 'invalid-image' })
      continue
    }
    if (decoded.length > RESOURCE_LIMITS.imageBytes) {
      resources.push({ ...saved, bytes: decoded.length, state: 'unavailable', reason: 'image-too-large' })
      continue
    }
    mediaType = mediaTypeOf(mediaType)
    if (!mediaType || !signatureOk(mediaType, decoded)) {
      resources.push({ ...saved, state: 'unavailable', reason: 'invalid-image' })
      continue
    }
    if (typeof validateImage === 'function') {
      try {
        if (!await validateImage({ mediaType, data: decoded, name })) {
          resources.push({ ...saved, state: 'unavailable', reason: 'no-reader' })
          continue
        }
      } catch {
        resources.push({ ...saved, state: 'unavailable', reason: 'invalid-image' })
        continue
      }
    }
    if (typeof saveImage !== 'function') {
      resources.push({ ...saved, state: 'unavailable', reason: 'storage-unavailable' })
      continue
    }
    name = cut(name, RESOURCE_LIMITS.name)
    try {
      const ref = await saveImage({ mediaType, data: decoded.toString('base64'), name })
      if (!ref?.id) throw new Error('storage-unavailable')
      resources.push({ ...saved, ...(name ? { name } : {}), state: 'stored', ref: { id: ref.id, mediaType: mediaTypeOf(ref.mediaType ?? mediaType) } })
    } catch {
      resources.push({ ...saved, state: 'unavailable', reason: 'storage-unavailable' })
    }
  }
  return { ...record, body: { ...record.body, resources } }
}
