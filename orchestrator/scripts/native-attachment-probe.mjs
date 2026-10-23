import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

async function checkNativeAttachments({ engine, sessionId, observer, nativeCall, until, fixtureLog, url, cookie, requests }) {
  const lastInput = () => engine === 'dsh' ? { text: requests.at(-1).messages.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n') }
    : fixtureLog().filter(entry => ['turn/start', 'prompt', 'session/send', 'session/prompt'].includes(entry.method)).at(-1)
  const run = async content => {
    const mark = observer.frames.length
    await nativeCall('session/prompt', { request: { sessionId, requestId: `attachment-${engine}-${mark}`, mode: 'queue', content } })
    await until(() => observer.frames.slice(mark).some(frame => frame?.event?.type === 'turn/end'))
    assert.equal(observer.frames.slice(mark).find(frame => frame?.event?.type === 'turn/end').event.data.reason.kind, 'completed', `${engine} attachment turn failed`)
    return lastInput()
  }
  let nativeImageCount = 0
  for (const withText of [true, false]) {
    const input = await run([...(withText ? [{ type: 'text', text: 'ATTACHMENT_CHECK' }] : []), { type: 'image', mediaType: 'image/png', data: PNG, name: 'pixel.png' }])
    if (engine === 'dsh') {
      const images = requests.at(-1).messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : [])
      assert.ok(images.length > nativeImageCount && images.every(image => image.source?.file_id === 'fixture-image-upload'), 'DSH lost the new image or its provider upload reference')
      nativeImageCount = images.length
      continue
    }
    const images = engine === 'zcode' ? input.attachments : (input.input ?? input.content ?? input.prompt).filter(block => block.type === 'image')
    assert.equal(images.length, 1, `${engine} lost an image`)
    const image = images[0]
    const data = image.dataBase64 ?? image.source?.data ?? image.data ?? image.url?.split(',')[1]
    const ref = observer.frames.filter(frame => frame?.event?.type === 'user/message' && frame.event.data.content.some(block => block.type === 'image')).at(-1).event.data.content.find(block => block.type === 'image').attachment
    const stored = await nativeCall('session/attachment', { request: { sessionId, attachmentId: ref.attachmentId } })
    assert.deepEqual(Buffer.from(data, 'base64'), Buffer.from(stored.data, 'base64'), `${engine} image bytes changed`)
    assert.equal(input.text ?? input.input.filter(block => block.type === 'text').map(block => block.text).join(''), withText ? 'ATTACHMENT_CHECK' : '')
  }
  for (const [name, bytes] of [['report.txt', Buffer.from('ATTACHMENT_TEXT_OK')], ['report.pdf', Buffer.from('%PDF-1.4\nATTACHMENT_PDF_OK\n%%EOF')], ['data.bin', Buffer.from([0, 255, 17, 128])]]) {
    const response = await fetch(`${url}/api/session/uploadFileBinary?${new URLSearchParams({ sessionId, name })}`, {
      method: 'POST', signal: AbortSignal.timeout(30000), headers: { Origin: url, Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: bytes,
    })
    const result = await response.json()
    assert.equal(result.ok, true, `${engine} file upload failed`)
    const input = await run([{ type: 'file', receiptId: result.value.receiptId }])
    const text = input.text ?? input.input.filter(block => block.type === 'text').map(block => block.text).join('')
    assert.ok(text.includes(name), `${engine} lost the file name`)
    const path = [...text.matchAll(/copy saved at ("(?:[^"\\]|\\.)*")/g)].at(-1)?.[1]
    assert.ok(path, `${engine} lost the file read path`)
    assert.deepEqual(readFileSync(JSON.parse(path)), bytes, `${engine} file bytes changed`)
  }
  console.log(`Attachments ${engine}: image+text, image-only, text/PDF/binary file-only uploads passed at the ${engine === 'dsh' ? 'native provider' : 'engine'} protocol`)
}

export async function checkAttachmentEngine({ engine, api, nativeCall, observe, until, home, runtime, url, cookie, requests }) {
  const models = { codex: 'fixture-model', claude: 'sonnet', zcode: 'fixture$fixture-model', opencode: 'fixture/fixture-model' }
  assert.ok(engine === 'dsh' || models[engine], 'Choose dsh, codex, claude, zcode or opencode')
  const cwd = realpathSync(mkdirSync(join(home, `${engine}-workspace`), { recursive: true }))
  if (engine !== 'dsh') {
    const bin = join(cwd, engine)
    copyFileSync(new URL(`../test/fixtures/${engine}-adapter-cli.cjs`, import.meta.url), bin)
    chmodSync(bin, 0o755)
    if (engine === 'codex') {
      mkdirSync(join(cwd, 'node_modules'), { recursive: true })
      symlinkSync(join(realpathSync(runtime.resolve('ws')), '..'), join(cwd, 'node_modules', 'ws'), 'dir')
    }
    await api('engine-config-set', { engine, engineOptions: { bin } })
    await api('engine-scan', { engine })
  }
  const workspace = await api('workspace-create', { name: 'Attachments', cwd })
  const role = await api('profile-create', { name: `Attachments ${engine}`, engine, workspace: workspace.id, ...(models[engine] ? { model: models[engine] } : {}) })
  const opened = await api(engine === 'dsh' ? 'session-open' : 'adapter-session-open', { profile: role.id, workspace: workspace.id })
  const observer = await observe(opened.sessionId)
  try {
    const fixtureLog = () => readFileSync(join(cwd, `${engine}-requests.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    await checkNativeAttachments({ engine, sessionId: opened.sessionId, observer, nativeCall, until, fixtureLog, url, cookie, requests })
  } finally { observer.close() }
}
