// Pasted images: admitted from the client as base64, written under the plugin
// home, and served back by id. The transcript keeps only the references, so
// state.json never grows with image bytes.
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { IMAGE_BYTES_MAX, IMAGES_MAX, FILE_BYTES_MAX, FILES_MAX } from './constants.js'
import { imageSinkHandlers, materializeResources, projectContent } from './resources.js'
import { invalid } from './errors.js'
import { inside } from './fs.js'
import { IMAGE_EXT_BY_MIME } from './image-types.js'
import { isUuid, isUuidLike } from './text.js'

const ignoreFolder = folder => writeFile(join(folder, '.gitignore'), '*\n', { flag: 'wx' })
  .catch(error => { if (error.code !== 'EEXIST') throw error })

const fileName = raw => {
  const name = basename(String(raw ?? 'file').replaceAll('\\', '/')).replace(/[\u0000-\u001f]/g, '').slice(0, 200)
  return name && name !== '.' && name !== '..' ? name : 'file'
}
const validId = id => isUuid(id)

export function install(rt) {
  const dir = join(rt.home, 'attachments')
  const filesDir = join(rt.home, 'files')

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
      if (typeof file?.data !== 'string') throw invalid('File data is not valid base64')
      const bytes = Buffer.from(file.data, 'base64')
      if (bytes.toString('base64') !== file.data) throw invalid('File data is not valid base64')
      if (bytes.length > FILE_BYTES_MAX) throw invalid(`Each file must be at most ${FILE_BYTES_MAX / 1024 / 1024} MB`)
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
    if (bytes.length > FILE_BYTES_MAX) throw invalid(`Attached file exceeds ${FILE_BYTES_MAX / 1024 / 1024} MB`)
    return bytes
  }
  const materializeFiles = async (files, cwd) => {
    if (!files?.length) return []
    const refs = cleanFileRefs(files), contents = await Promise.all(refs.map(fileOf))
    return place(refs.map((file, index) => ({ name: file.name, bytes: contents[index] })), cwd)
  }
  const materializeImages = (images, cwd) => place(images.map(image => {
    const extension = IMAGE_EXT_BY_MIME.get(image.mediaType), name = fileName(image.name || 'image')
    return { name: name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`, bytes: Buffer.from(image.data, 'base64') }
  }), cwd)
  // The staged folder sits in the workspace's ignored `.nodo` segment; both
  // byte entries and existing paths stage through it.
  const stagedFolder = async cwd => {
    await mkdir(cwd, { recursive: true })
    const root = await realpath(cwd)
    let base = root
    for (const segment of ['.nodo', 'workflow-inputs']) {
      const next = join(base, segment)
      await mkdir(next, { recursive: true })
      base = await realpath(next)
      if (!inside(root, base)) throw invalid('Attachment directory must stay inside its workspace')
      if (segment === '.nodo') await ignoreFolder(base)
    }
    return mkdtemp(join(base, 'task-'))
  }
  const place = async (entries, cwd) => {
    if (!entries.length) return []
    const folder = await stagedFolder(cwd)
    return Promise.all(entries.map(async (file, index) => {
      const destination = join(folder, `${index + 1}-${file.name}`)
      await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 })
      return destination
    }))
  }
  const placeCopies = async (paths, cwd) => {
    if (!paths?.length) return []
    const folder = await stagedFolder(cwd)
    return Promise.all(paths.map(async path => {
      const destination = join(folder, basename(path))
      await copyFile(path, destination)
      return destination
    }))
  }

  const admitImages = (images) => {
    if (images === undefined || images === null) return []
    if (!Array.isArray(images) || images.length > IMAGES_MAX) throw invalid(`At most ${IMAGES_MAX} images per message`)
    return images.map(image => {
      if (!IMAGE_EXT_BY_MIME.has(image?.mediaType)) throw invalid('Only PNG, JPEG, WebP and GIF images can be sent')
      if (typeof image.data !== 'string') throw invalid('Image data is not valid base64')
      const bytes = Buffer.from(image.data, 'base64')
      if (bytes.length === 0 || bytes.toString('base64') !== image.data) throw invalid('Image data is not valid base64')
      if (bytes.length > IMAGE_BYTES_MAX) throw invalid(`Each image must be at most ${IMAGE_BYTES_MAX / 1024 / 1024} MB`)
      return { mediaType: image.mediaType, data: image.data, name: typeof image.name === 'string' ? image.name.slice(0, 200) : '' }
    })
  }

  const saveImages = async (images) => {
    if (images.length === 0) return []
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return Promise.all(images.map(async image => {
      const id = randomUUID()
      await writeFile(join(dir, `${id}.${IMAGE_EXT_BY_MIME.get(image.mediaType)}`), Buffer.from(image.data, 'base64'), { flag: 'wx', mode: 0o600 })
      return { id, mediaType: image.mediaType, name: image.name }
    }))
  }

  const imageOf = async ({ id, mediaType }) => {
    const extension = IMAGE_EXT_BY_MIME.get(mediaType)
    if (extension === undefined || !isUuidLike(id)) throw invalid('Unknown image')
    const bytes = await readFile(join(dir, `${id}.${extension}`)).catch(error => {
      if (error.code === 'ENOENT') throw invalid('Attached image is unavailable')
      throw error
    })
    return { mediaType, data: bytes.toString('base64') }
  }

  const saveReplyImages = async (conversationId, text) => {
    const found = rt.conversationOf(conversationId)
    if (!found || rt.readOnly() !== undefined) return []
    const saved = []
    const handlers = imageSinkHandlers(rt, rt.sessionWorkspace(found.profile, found.session)?.cwd)
    await materializeResources({ body: { resources: projectContent(text).resources } }, {
      ...handlers,
      saveImage: async image => {
        const ref = await handlers.saveImage(image)
        if (ref?.id) saved.push(ref)
        return ref
      },
    })
    return saved
  }

  Object.assign(rt, { admitImages, saveImages, imageOf, cleanFileRefs, admitFiles, saveFiles, fileOf, materializeFiles, materializeImages, place, placeCopies, saveReplyImages })
}
