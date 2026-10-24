import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { imageFileType, imageReferences, readImageFile } from '../src/host/image-files.js'
import { IMAGE_BYTES_MAX } from '../src/host/constants.js'
import { install as installAttachments } from '../src/host/attachments.js'
import { install as installDispatch } from '../src/host/dispatch.js'
import { createRecordTracker, createStreamDetailStore } from '../src/host/stream-records.js'
import { materializeResources, projectContent } from '../src/host/resources.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const fixture = async run => {
  const home = await mkdtemp(join(tmpdir(), 'nodo-image-output-'))
  const cwd = join(home, 'workspace')
  await mkdir(cwd)
  const path = join(cwd, 'shot (1).png')
  await writeFile(path, Buffer.from(PNG, 'base64'))
  try { await run({ home, cwd, path }) }
  finally { await rm(home, { recursive: true, force: true }) }
}

test('explicit image links support absolute, relative, encoded and file URL destinations', async () => {
  await fixture(async ({ cwd, path }) => {
    const url = pathToFileURL(path).href
    assert.deepEqual(imageReferences(`![图](<${path}> "title")\n[下载](${url})\n![图](./shot.png)\n![远程](https://example.test/a.png)`), [path, url, './shot.png'])
    assert.equal(imageFileType('https://example.test/a.png'), undefined)
    assert.equal(imageFileType('file://foreign/secret.png'), undefined)
    assert.equal(imageFileType('data:image/png;base64,AAAA'), undefined)
    for (const uri of [path, './shot%20(1).png', url]) assert.equal((await readImageFile(uri, cwd)).data, PNG)
  })
})

test('file reads reject escaped symlinks, missing paths, non-images, oversized files and the protected host directory', async () => {
  await fixture(async ({ cwd, home }) => {
    const escaped = join(cwd, 'escaped.png')
    await symlink('/etc/hosts', escaped)
    await assert.rejects(readImageFile(escaped, cwd), /attachment-unavailable/)
    await assert.rejects(readImageFile('missing.png', cwd))
    await assert.rejects(readImageFile('/etc/hosts', cwd), /attachment-unavailable/)
    await assert.rejects(readImageFile(`${process.env.DSH_HOME ?? join(process.env.HOME, '.dsh')}/nodo-test.png`, cwd), /attachment-unavailable/)
    const large = join(home, 'large.png')
    await writeFile(large, Buffer.alloc(IMAGE_BYTES_MAX + 1))
    await assert.rejects(readImageFile(large, cwd), /image-too-large/)
  })
})

test('MCP envelopes and media-only tool results create records without an optional presentation', () => {
  const output = { content: [{ type: 'text', text: '截图完成' }, { type: 'image', mimeType: 'image/png', data: PNG }], isError: false }
  const run = createRecordTracker({ engine: 'codex', profileId: 'p', conversationId: 's' })
  assert.equal(run.accept({ type: 'tool', name: 'playwright', callId: 'a', phase: 'start' }), null)
  const record = run.accept({ type: 'tool', name: 'playwright', callId: 'a', phase: 'end', output })
  assert.equal(record.body.outputText, '截图完成')
  assert.equal(record.body.resources[0].data, PNG)
  assert.doesNotMatch(record.body.outputText, /iVBOR/)
  assert.equal(run.accept({ type: 'tool', callId: 'plain', phase: 'end', output: 'plain output' }), null)
  assert.equal(run.accept({ type: 'tool', callId: 'invalid', phase: 'end', output, presentation: { version: 99 } }), null)
  const generated = run.accept({ type: 'tool', name: 'imageGeneration', callId: 'generated', phase: 'end', output: PNG })
  assert.equal(generated.body.outputText, '')
  assert.equal(generated.body.resources[0].data, PNG)
  const linked = run.accept({ type: 'tool', name: 'imageGeneration', callId: 'linked', phase: 'end',
    output: [PNG, { type: 'resource_link', uri: '/tmp/generated.png', name: 'generated.png' }] })
  assert.equal(linked.body.resources.length, 1)
  assert.equal(linked.body.resources[0].data, PNG)
  assert.equal(linked.body.resources[0].name, 'generated.png')
  assert.equal(run.accept({ type: 'tool', name: 'other', callId: 'binary', phase: 'end', output: PNG }), null)
  run.accept({ type: 'tool', name: 'playwright', callId: 'existing', phase: 'start',
    presentation: { version: 1, kind: 'tool', mode: 'snapshot', body: { command: 'take screenshot', cwd: '/workspace' } } })
  const completed = run.accept({ type: 'tool', name: 'playwright', callId: 'existing', phase: 'end', output })
  assert.equal(completed.body.command, 'take screenshot')
  assert.equal(completed.body.resources[0].data, PNG)
})

test('Codex image paths and screenshot Markdown become saved image references in the detail store', async () => {
  await fixture(async ({ cwd, path, home }) => {
    const saved = []
    const rt = { home, state: {}, ctx: { attachments: { validateImage: async () => {} } }, load: async () => {}, loadSecrets: async () => {},
      readOnly: () => undefined, save: async () => {}, redactDeepSecrets: value => value,
      conversationOf: () => ({ profile: { id: 'p' }, session: { id: 's' } }),
      conversation: () => ({ profile: { id: 'p' }, session: { id: 's' } }), sessionWorkspace: () => ({ cwd }) }
    installAttachments(rt)
    const store = createStreamDetailStore(rt)
    const run = createRecordTracker({ engine: 'codex', profileId: 'p', conversationId: 's' })
    for (const [callId, fields] of [
      ['generated', { output: [{ type: 'resource_link', uri: path, name: '生成的图' }] }],
      ['screenshot', { outputText: `![截图](<${path}>)` }],
    ]) {
      const record = run.accept({ type: 'tool', callId, name: callId, phase: 'end', ...fields })
      const value = await store.save('s', record)
      const resource = value.body.resources[0]
      assert.equal(resource.state, 'stored')
      assert.equal((await rt.imageOf(resource.ref)).data, PNG)
      const full = await store.read({ profile: 'p', session: 's', ref: value.details.ref })
      assert.doesNotMatch(JSON.stringify(full), /iVBOR/)
      saved.push(resource.ref)
    }
    assert.equal(saved.length, 2)
    await writeFile(path, Buffer.from('not an image'))
    const corrupt = run.accept({ type: 'tool', callId: 'corrupt', name: 'corrupt', phase: 'end', output: [{ type: 'resource_link', uri: path }] })
    assert.equal((await store.save('s', corrupt)).body.resources[0].reason, 'invalid-image')
  })
})

test('local image failures retain an explicit unavailable resource without reading remote URLs', async () => {
  const projected = projectContent([{ type: 'resource_link', uri: '/tmp/missing.png' }, { type: 'resource_link', uri: 'https://example.test/a.png' }])
  let reads = 0
  const value = await materializeResources({ body: { resources: projected.resources } }, { readFileImage: async () => { reads++; throw new Error('missing') } })
  assert.equal(reads, 1)
  assert.equal(value.body.resources[0].reason, 'attachment-unavailable')
  assert.equal(value.body.resources[1].kind, 'link')
})

test('reply images persist as plugin references, bounded and decoder checked', async () => {
  await fixture(async ({ home, cwd, path }) => {
    const rt = { home, ctx: { attachments: { validateImage: async () => {} } }, conversationOf: id => id === 's' ? { profile: {}, session: {} } : undefined,
      sessionWorkspace: () => ({ cwd }), readOnly: () => undefined }
    installAttachments(rt)
    const text = `![图](<${path}>)\n![重复](<${path}>)`
    const refs = await rt.saveReplyImages('s', text)
    assert.equal(refs.length, 1)
    assert.equal((await rt.imageOf(refs[0])).data, PNG)
    assert.deepEqual(await rt.saveReplyImages('foreign', text), [])
    delete rt.ctx.attachments.validateImage
    assert.deepEqual(await rt.saveReplyImages('s', text), [])
  })
})

test('generated image bytes never become legacy tool text', async () => {
  const lines = [], effects = []
  const rt = { ctx: { effect: factory => effects.push(factory()) }, appendLine: (_id, line) => { lines.push(line); return line },
    redactDeepSecrets: value => value, save: async () => {}, statsTool() {} }
  installDispatch(rt)
  try {
    rt.driverSink('s', { type: 'tool', name: 'imageGeneration', callId: 'a', phase: 'end', output: PNG })
    assert.doesNotMatch(JSON.stringify(lines), /iVBOR/)
  } finally { for (const dispose of effects) dispose?.() }
})

test('legacy final replies wait for saved image references before the turn settles', async () => {
  const lines = [], effects = []
  let release
  const pending = new Promise(resolve => { release = resolve })
  const image = { id: 'fixture', mediaType: 'image/png' }
  const rt = { ctx: { effect: factory => effects.push(factory()) }, appendLine: (_id, line) => { lines.push(line); return line },
    redactDeepSecrets: value => value, save: async () => {}, statsOutput() {}, statsEnd() {}, recordTaskOutcome() {}, isCompacting: () => false,
    saveReplyImages: async (_id, text) => { assert.equal(text, '![图](/tmp/shot.png)'); await pending; return [image] } }
  installDispatch(rt)
  try {
    rt.driverSink('s', { type: 'turn/start', turnId: 't' })
    rt.driverSink('s', { type: 'text', turnId: 't', text: '![图](/tmp/shot.png)' })
    rt.driverSink('s', { type: 'turn/end', turnId: 't', reason: 'done' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(lines[0].images, undefined)
    release()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(lines[0].images, [image])
  } finally { for (const dispose of effects) dispose?.() }
})
