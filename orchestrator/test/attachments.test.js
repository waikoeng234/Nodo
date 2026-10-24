import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot, until } from './helpers/host.js'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')

test('pasted images: refused by type, stored under home, referenced in the transcript, served by id', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-attach-test-'))
  const host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Main', cwd: join(home, 'ws') })
    const profile = await host.api('profile-create', { name: 'Echo', engine: 'echo', workspace: workspace.id })
    await assert.rejects(host.api('send', { profile: profile.id, text: 'x', images: [{ mediaType: 'image/svg+xml', data: PNG }] }), { code: 'orch/invalid' })
    await host.api('send', { profile: profile.id, text: '', images: [{ mediaType: 'image/png', data: PNG, name: 'shot.png' }] })
    const line = await until(async () => (await host.api('transcript', { profile: profile.id })).find(entry => entry.who === 'user'))
    assert.equal(line.images.length, 1)
    assert.equal(line.images[0].name, 'shot.png')
    assert.deepEqual(await host.api('attachment', { id: line.images[0].id, mediaType: 'image/png' }), { mediaType: 'image/png', data: PNG })
    await assert.rejects(host.api('attachment', { id: '../state', mediaType: 'image/png' }), { code: 'orch/invalid' })
    await until(async () => (await host.api('state', { since: -1 })).work[profile.id]?.active === false ? true : undefined)
  } finally {
    host.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('task files persist by id, reject invalid input and materialize inside the execution workspace', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-task-files-')), outside = mkdtempSync(join(tmpdir(), 'orch-task-outside-'))
  let host = boot(home)
  try {
    const files = await host.api('attachment-save', { files: [{ name: '../notes.txt', data: Buffer.from('Saved task file').toString('base64') }] })
    assert.equal(files.files[0].name, 'notes.txt')
    assert.equal(files.files[0].data, undefined)
    await assert.rejects(host.api('attachment-save', { files: [{ name: 'bad', data: 'not base64!' }] }), { code: 'orch/invalid' })
    host.dispose(); host = boot(home)
    const rt = await host.runtime
    const cwd = join(home, 'workspace')
    const [path] = await rt.materializeFiles(files.files, cwd)
    assert.equal(readFileSync(path, 'utf8'), 'Saved task file')
    assert.equal(readFileSync(join(cwd, '.nodo', '.gitignore'), 'utf8'), '*\n')
    const workspace = await host.api('workspace-create', { name: 'Main', cwd })
    const placed = await host.api('attachment-place', { files: files.files, workspace: workspace.id })
    assert.match(placed.files[0], /\.nodo[/\\]workflow-inputs[/\\]task-[^/\\]+[/\\]1-notes\.txt$/)
    assert.equal(readFileSync(placed.files[0], 'utf8'), 'Saved task file')
    assert.equal(placed.text, `## Attached files (user provided)\n- ${JSON.stringify(placed.files[0])}`)
    await assert.rejects(host.api('attachment-place', { files: files.files, workspace: 'missing' }), { code: 'orch/invalid' })
    await assert.rejects(rt.materializeFiles([{ id: '../state.json', name: 'secret' }], cwd), { code: 'orch/invalid' })
    await assert.rejects(rt.fileOf({ id: '00000000-0000-0000-0000-000000000000', name: 'missing' }), { code: 'orch/invalid' })
    symlinkSync(outside, join(home, '.nodo'))
    await assert.rejects(rt.materializeFiles(files.files, home), { code: 'orch/invalid' })
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test('a conversation send carries picked files as chips and keeps the path block out of the echoed text', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-send-files-'))
  const host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Main', cwd: join(home, 'ws') })
    const profile = await host.api('profile-create', { name: 'Echo', engine: 'echo', workspace: workspace.id })
    const saved = await host.api('attachment-save', { files: [{ name: 'spec.pdf', data: Buffer.from('Spec body').toString('base64') }] })
    const session = await host.api('session-create', { profile: profile.id, workspace: workspace.id, lazy: true })
    await host.api('send', { profile: profile.id, session: session.id, text: '查一下规格', files: saved.files })
    const line = await until(async () => (await host.api('transcript', { profile: profile.id })).find(entry => entry.who === 'user'))
    assert.equal(line.text, '查一下规格')
    assert.deepEqual(line.files, [{ id: saved.files[0].id, name: 'spec.pdf' }])
    assert.ok(existsSync(join(home, 'ws', '.nodo', 'workflow-inputs')), 'the picked file lands inside the workspace')
    await host.api('send', { profile: profile.id, session: session.id, text: '', files: saved.files })
    const second = await until(async () => (await host.api('transcript', { profile: profile.id })).filter(entry => entry.who === 'user').at(-1))
    assert.deepEqual(second.files, [{ id: saved.files[0].id, name: 'spec.pdf' }], 'a files-only message is sendable')
    await until(async () => (await host.api('state', { since: -1 })).work[profile.id]?.active === false ? true : undefined)
  } finally {
    host.dispose()
    for (let attempt = 0; attempt < 10; attempt++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await new Promise(resolve => setTimeout(resolve, 50)) } }
  }
})

test('pasted images are private to the owner and still load in a read-only window', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-attach-mode-'))
  const host = boot(home)
  try {
    const { images: [image] } = await host.api('attachment-save', { images: [{ mediaType: 'image/png', data: PNG }] })
    assert.equal(statSync(join(home, 'attachments', `${image.id}.png`)).mode & 0o777, 0o600)
    const rt = await host.runtime
    rt.readOnly = () => 'Another window is writing'
    assert.deepEqual(await host.api('attachment', image), { mediaType: 'image/png', data: PNG })
    assert.equal((await host.post('attachment-save', { images: [{ mediaType: 'image/png', data: PNG }] })).error.code, 'orch/read-only')
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})
