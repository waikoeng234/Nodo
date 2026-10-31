import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { cliVersion, findExecutable, launchCommand } from '../agent-drivers/dist/cli.js'
import { findCodexExecutable } from '../agent-drivers/dist/codex/index.js'
import { findOpencodeExecutable } from '../agent-drivers/dist/opencode/index.js'
import { findDshExecutable } from '../agent-drivers/dist/dsh/index.js'

const withRoot = async run => {
  const root = mkdtempSync(join(tmpdir(), 'orch-win-detect-'))
  try { await run(root) } finally { rmSync(root, { recursive: true, force: true }) }
}
const touch = path => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ''); chmodSync(path, 0o755) }

test('findExecutable probes Windows executable extensions after the bare name', async () => {
  await withRoot(root => {
    const dir = join(root, 'tools')
    const exe = join(dir, 'codex.exe')
    touch(exe)
    assert.equal(findExecutable('codex', { path: dir, defaults: [], platform: 'win32' }), exe)
    assert.equal(findExecutable('codex', { path: dir, defaults: [], platform: 'linux' }), undefined, 'other platforms keep the bare name')
    const cmd = join(dir, 'claude.cmd')
    touch(cmd)
    assert.equal(findExecutable('claude', { path: dir, defaults: [], platform: 'win32' }), cmd, 'a .cmd shim is found when no .exe exists')
    assert.equal(findExecutable(join(dir, 'claude'), { path: '', defaults: [], platform: 'win32' }), cmd, 'an extensionless absolute path probes too')
    assert.equal(findExecutable('codex', { path: dir, defaults: [], extra: [dir], platform: 'win32' }), exe, 'extra dirs come after PATH')
  })
})

test('launchCommand routes .cmd and .bat through cmd.exe on Windows', () => {
  assert.deepEqual(launchCommand('C:\\npm\\codex.cmd', ['app-server']), { bin: 'cmd.exe', args: ['/d', '/s', '/c', '"C:\\npm\\codex.cmd" app-server'], verbatim: true })
  assert.deepEqual(launchCommand('C:\\npm\\dsh.bat', ['--profile', 'text with spaces']), { bin: 'cmd.exe', args: ['/d', '/s', '/c', '"C:\\npm\\dsh.bat" --profile "text with spaces"'], verbatim: true })
  assert.deepEqual(launchCommand('C:\\tools\\codex.exe', ['--version']), { bin: 'C:\\tools\\codex.exe', args: ['--version'] }, 'real executables spawn directly')
  assert.deepEqual(launchCommand('/usr/local/bin/claude', ['--print'], { platform: 'darwin' }), { bin: '/usr/local/bin/claude', args: ['--print'] })
})

test('cliVersion reads the version through a .cmd shim', { skip: process.platform !== 'win32' }, async () => {
  await withRoot(async root => {
    const shim = join(root, 'fake.cmd')
    writeFileSync(shim, '@echo off\r\necho 1.2.3-fake\r\n')
    assert.equal(await cliVersion(shim), '1.2.3-fake')
  })
})

test('Codex discovery falls back to the desktop app package store on Windows', async () => {
  await withRoot(root => {
    const store = join(root, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex.exe')
    const junction = join(root, 'apps', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
    touch(store)
    touch(junction)
    assert.equal(findCodexExecutable('codex', { home: root, path: '', env: {}, platform: 'win32' }), store)
    assert.equal(findCodexExecutable('codex', { home: join(root, 'empty'), path: '', env: { LOCALAPPDATA: join(root, 'apps') }, platform: 'win32' }), junction, 'the Programs junction is the second candidate')
    assert.equal(findCodexExecutable('codex', { home: root, path: '', env: { LOCALAPPDATA: join(root, 'apps') }, platform: 'win32' }), store, 'the package store outranks the junction')
    assert.equal(findCodexExecutable('codex', { home: root, path: '', env: {}, platform: 'darwin' }), undefined, 'the Windows layout stays out of other platforms')
  })
})

test('OpenCode discovery includes the ~/.opencode install dir', async () => {
  await withRoot(root => {
    const exe = join(root, '.opencode', 'bin', 'opencode.exe')
    touch(exe)
    assert.equal(findOpencodeExecutable('opencode', { home: root, path: '', platform: 'win32' }), exe)
  })
})

test('DSH discovery reads the Windows npx cache location', async () => {
  await withRoot(root => {
    const pkg = join(root, 'cache', 'npm-cache', '_npx', 'abc123', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
    const cmd = join(root, 'cache', 'npm-cache', '_npx', 'abc123', 'node_modules', '.bin', 'dsh.cmd')
    touch(cmd)
    assert.equal(findDshExecutable('dsh', { home: root, path: '', defaults: [], env: { LOCALAPPDATA: join(root, 'cache') }, platform: 'win32' }), cmd)
  })
})
