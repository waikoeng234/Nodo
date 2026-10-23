// Isolated UI fixture: local engine only, no model traffic or user configuration.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDshExecutable } from '../agent-drivers/src/dsh/config.js'

const executable = findDshExecutable()
assert.ok(executable, 'Install DSH before running the isolated UI check')
const desktopChrome = process.argv.includes('--desktop-chrome')
const home = mkdtempSync(join(tmpdir(), 'nodo-workflow-ui-')), plugin = join(home, 'fixture'), cwd = join(home, 'workspace')
mkdirSync(plugin); mkdirSync(cwd)
writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'nodo-workflow-fixture', version: '0.0.0', type: 'module', main: 'index.js',
  exports: { '.': './index.js', ...(desktopChrome ? { './client': './client.js' } : {}) },
  ...(desktopChrome ? { dsh: { client: { platform: 'web' } } } : {}) }))
if (desktopChrome) writeFileSync(join(plugin, 'client.js'), `window.__ModuleLoader__.load({ id: 'nodo-workflow-fixture', factory: () => ({ apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = ':root{--dsh-frame-top-clearance:52px!important}'
    document.head.appendChild(style)
    return () => style.remove()
  }, 'workflow: desktop chrome fixture')
} }) })`)
writeFileSync(join(plugin, 'index.js'), `
import { registerEngine } from ${JSON.stringify(new URL('../agent-drivers/src/index.js', import.meta.url).href)}
import { createEchoDriver, echoInfo } from ${JSON.stringify(new URL('../test/helpers/echo-driver.js', import.meta.url).href)}
registerEngine('workflow-fixture', {
  info: { ...echoInfo, id: 'workflow-fixture', label: '本地验证 Agent', requiresCwd: true }, validate: value => value,
  check: async () => ({ ok: true, checks: [{ label: '隔离夹具', ok: true, message: '仅本地事件，无模型调用' }] }),
  create: options => createEchoDriver({ ...options, script: [
    { kind: 'text', text: '已完成本地工作流夹具检查。实现复用原有组件，验证结果供人工验收。\\nNEXT: done' }, { kind: 'wait', ms: 160 },
  ] }),
})
export function apply() {}
`)
let cookies = [], child, log = '', modelCalls = 0
const relay = createServer((request, response) => {
  if (request.url === '/login') { response.writeHead(302, { 'Set-Cookie': cookies, Location: url }); response.end(); return }
  modelCalls++
  response.writeHead(503); response.end('This fixture has no model endpoint')
})
relay.listen(0, '127.0.0.1'); await once(relay, 'listening')
const relayUrl = `http://127.0.0.1:${relay.address().port}`
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening')
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const url = `http://127.0.0.1:${port}`
const patch = join(home, 'fixture.patch.json')
writeFileSync(patch, JSON.stringify([
  { id: 'llm-deepseek', config: { baseURL: relayUrl, apiKeyEnv: 'NODO_WORKFLOW_LOCAL_KEY' } },
  { id: 'session-title-llm', disabled: true },
  { insert: [{ id: 'nodo-workflow-fixture', name: join(plugin, 'index.js') }, { id: 'nodo', name: fileURLToPath(new URL('../index.js', import.meta.url)), config: { home: join(home, 'nodo') } }] },
]))
const until = async check => {
  const end = Date.now() + 25000
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    if (child.exitCode !== null) throw new Error('Isolated host exited; raw logs withheld')
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error('Isolated UI check timed out; raw logs withheld')
}
let cookie
const api = async (endpoint, payload) => {
  const response = await fetch(`${url}/api/nodo`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie }, body: JSON.stringify({ endpoint, payload }) })
  const result = await response.json()
  assert.equal(result.ok, true, `Nodo ${endpoint} failed (${result.error?.code ?? ''})`)
  return result.value
}
try {
  child = spawn(executable, ['--profile', 'web', '--patch', patch, '--no-open', '--port', String(port)], {
    env: { ...process.env, DSH_HOME: home, NODO_WORKFLOW_LOCAL_KEY: 'local-fixture-only' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-32000) })
  const token = await until(() => log.match(/\?token=([^\s]+)/)?.[1])
  const page = await fetch(`${url}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  cookies = page.headers.getSetCookie(); cookie = cookies.map(value => value.split(';')[0]).join('; ')
  await until(async () => (await api('state')).readOnly == null)
  const workspace = await api('workspace-create', { name: 'Workflow UI 验证项目', cwd })
  const roles = []
  for (const [name, avatarTemplate] of [['天空规划伙伴', 'sky'], ['蜜桃开发伙伴', 'peach'], ['橄榄审查伙伴', 'olive']]) {
    roles.push(await api('profile-create', { name, engine: 'workflow-fixture', workspace: workspace.id, avatarTemplate }))
  }
  const graph = {
    name: '需求开发与审查', nodes: [{ id: 'start', kind: 'start', name: '开始' },
      { id: 'plan', kind: 'agent', name: '方案规划', profileId: roles[0].id, task: '制定开发方案，说明现有结构与需要验证的行为。' },
      { id: 'code', kind: 'agent', name: '编码实现', profileId: roles[1].id, task: '复用项目现有组件完成实现，报告改动和验证证据。' },
      { id: 'review', kind: 'agent', name: '代码审查', profileId: roles[2].id, task: '核对代码与验证证据，给出审查结论。', exits: [{ id: 'done', when: '无需修改\n验证证据完整' }, { id: 'rework', when: '存在待修复问题' }] },
      { id: 'accept', kind: 'human', name: '人工验收', question: '本次实现是否符合预期？', allowText: false, options: [{ id: 'accept', label: '接受并完成' }, { id: 'revise', label: '返回修改' }] },
      { id: 'end', kind: 'end', name: '完成交付', deliver: 'code' }],
    edges: [{ from: 'start', exit: 'done', to: 'plan' }, { from: 'plan', exit: 'done', to: 'code' }, { from: 'code', exit: 'done', to: 'review' },
      { from: 'review', exit: 'done', to: 'accept' }, { from: 'review', exit: 'rework', to: 'code', back: { max: 2 } },
      { from: 'accept', exit: 'accept', to: 'end' }, { from: 'accept', exit: 'revise', to: 'code', back: { max: 2 } }],
  }
  const definition = await api('workflow-create', graph)
  const { runId } = await api('workflow-run', { id: definition.id })
  await until(async () => {
    const run = await api('run-get', { id: runId })
    assert.equal(run.status, 'running', `Local fixture stopped: ${run.status}/${run.reason ?? ''}`)
    return run.tasks.some(task => task.card)
  })
  assert.equal(modelCalls, 0)
  console.log(JSON.stringify({ result: 'ready', login: `${relayUrl}/login`, host: url, definition: definition.id, run: runId, modelCalls }))
  if (process.argv.includes('--serve')) await new Promise(resolve => {
    process.once('SIGINT', resolve); process.once('SIGTERM', resolve)
    process.stdin.resume(); process.stdin.once('data', resolve)
  })
  assert.equal(modelCalls, 0)
} finally {
  process.stdin.pause()
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))])
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
  }
  await new Promise(resolve => relay.close(resolve))
  rmSync(home, { recursive: true, force: true })
}
