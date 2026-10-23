// Pasted images: admitted from the client as base64, written under the plugin
// home, and served back by id. The transcript keeps only the references, so
// state.json never grows with image bytes.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { IMAGE_BYTES_MAX, IMAGES_MAX, FILE_BYTES_MAX, FILES_MAX } from './constants.js'
import { ignoreFolder } from './workflow-materials.js'
import { materializeResources, projectContent } from './resources.js'
import { readImageFile } from './image-files.js'

const EXTENSIONS = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']])
const invalid = message => Object.assign(new Error(message), { code: 'orch/invalid' })
const fileName = raw => {
  const name = basename(String(raw ?? 'file').replaceAll('\\', '/')).replace(/[\u0000-\u001f]/g, '').slice(0, 200)
  return name && name !== '.' && name !== '..' ? name : 'file'
}
const validId = id => /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id ?? '')

export function install(rt) {
  const dir = join(rt.home, 'attachments')
  const filesDir = join(rt.home, 'files')

  const cleanImageRefs = (images = []) => {
    if (!Array.isArray(images) || images.length > IMAGES_MAX) throw invalid(`At most ${IMAGES_MAX} images per task`)
    return images.map(image => {
      if (!validId(image?.id) || !EXTENSIONS.has(image.mediaType)) throw invalid('Unknown image')
      return { id: image.id, mediaType: image.mediaType, name: fileName(image.name) }
    })
  }
  const cleanFileRefs = (files = []) => {
    if (!Array.isArray(files) || files.length > FILES_MAX) throw invalid(`At most ${FILES_MAX} files per task`)
    return files.map(file => {
      if (!validId(file?.id)) throw invalid('Unknown file')
      return { id: file.id, name: fileName(file.name) }
    })
  }
  const admitFiles = (files = []) => {
    if (!Array.isArray(files) || files.length > FILES_MAX) throw invalid(`At most ${FILES_MAX} files per message`)
    return files.map(file => {
      const bytes = typeof file?.data === 'string' ? Buffer.from(file.data, 'base64') : Buffer.alloc(0)
      if (typeof file?.data !== 'string' || bytes.toString('base64') !== file.data) throw invalid('File data is not valid base64')
      if (bytes.length > FILE_BYTES_MAX) throw invalid('Each file must be at most 20 MB')
      return { name: fileName(file.name), bytes }
    })
  }
  const saveFiles = async files => {
    if (!files.length) return []
    await mkdir(filesDir, { recursive: true, mode: 0o700 })
    return Promise.all(files.map(async file => {
      const id = randomUUID()
      await writeFile(join(filesDir, id), file.bytes, { flag: 'wx', mode: 0o600 })
      return { id, name: file.name }
    }))
  }
  const fileOf = async ref => {
    const [file] = cleanFileRefs([ref])
    const bytes = await readFile(join(filesDir, file.id)).catch(() => { throw invalid('Attached file is unavailable') })
    if (bytes.length > FILE_BYTES_MAX) throw invalid('Attached file exceeds 20 MB')
    return bytes
  }
  const materializeFiles = async (files, cwd) => {
    if (!files?.length) return []
    const refs = cleanFileRefs(files), contents = await Promise.all(refs.map(fileOf))
    await mkdir(cwd, { recursive: true })
    const root = await realpath(cwd)
    let base = root
    for (const segment of ['.nodo', 'workflow-inputs']) {
      const next = join(base, segment)
      await mkdir(next, { recursive: true })
      base = await realpath(next)
      const path = relative(root, base)
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw invalid('Workflow attachment directory must stay inside its workspace')
      if (segment === '.nodo') await ignoreFolder(base)
    }
    const folder = await mkdtemp(join(base, 'task-'))
    return Promise.all(refs.map(async (file, index) => {
      const destination = join(folder, `${index + 1}-${file.name}`)
      await writeFile(destination, contents[index], { flag: 'wx', mode: 0o600 })
      return destination
    }))
  }

  const admitImages = (images) => {
    if (images === undefined || images === null) return []
    if (!Array.isArray(images) || images.length > IMAGES_MAX) throw invalid(`At most ${IMAGES_MAX} images per message`)
    return images.map(image => {
      if (!EXTENSIONS.has(image?.mediaType)) throw invalid('Only PNG, JPEG, WebP and GIF images can be sent')
      const bytes = typeof image.data === 'string' ? Buffer.from(image.data, 'base64') : Buffer.alloc(0)
      if (bytes.length === 0 || bytes.toString('base64') !== image.data) throw invalid('Image data is not valid base64')
      if (bytes.length > IMAGE_BYTES_MAX) throw invalid('Each image must be at most 5 MB')
      return { mediaType: image.mediaType, data: image.data, name: typeof image.name === 'string' ? image.name.slice(0, 200) : '' }
    })
  }

  const saveImages = async (images) => {
    if (images.length === 0) return []
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return Promise.all(images.map(async image => {
      const id = randomUUID()
      await writeFile(join(dir, `${id}.${EXTENSIONS.get(image.mediaType)}`), Buffer.from(image.data, 'base64'), { flag: 'wx', mode: 0o600 })
      return { id, mediaType: image.mediaType, name: image.name }
    }))
  }

  const imageOf = async ({ id, mediaType }) => {
    const extension = EXTENSIONS.get(mediaType)
    if (extension === undefined || !/^[0-9a-f-]{36}$/.test(id)) throw invalid('Unknown image')
    const bytes = await readFile(join(dir, `${id}.${extension}`)).catch(error => {
      if (error.code === 'ENOENT') throw invalid('Attached image is unavailable')
      throw error
    })
    return { mediaType, data: bytes.toString('base64') }
  }

  const saveReplyImages = async (conversationId, text, native = false) => {
    const found = rt.conversationOf(conversationId)
    if (!found || rt.readOnly() !== undefined) return []
    const saved = []
    await materializeResources({ body: { resources: projectContent(text).resources } }, {
      readFileImage: uri => readImageFile(uri, rt.sessionWorkspace(found.profile, found.session)?.cwd),
      validateImage: async image => {
        if (typeof rt.ctx.attachments?.validateImage !== 'function') return false
        await rt.ctx.attachments.validateImage(image)
        return true
      },
      saveImage: async image => {
        const [ref] = native ? await rt.ctx.attachments.saveImages([{ ...image, data: Buffer.from(image.data, 'base64') }]) : await saveImages([image])
        if (!(native ? ref?.attachmentId : ref?.id)) throw new Error('storage-unavailable')
        saved.push(ref)
        return { id: ref.id ?? ref.attachmentId, mediaType: ref.mediaType }
      },
    })
    return saved
  }

  Object.assign(rt, { admitImages, saveImages, imageOf, cleanImageRefs, cleanFileRefs, admitFiles, saveFiles, fileOf, materializeFiles, saveReplyImages })
}
