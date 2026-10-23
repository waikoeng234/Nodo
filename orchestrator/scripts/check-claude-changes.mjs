import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createClaudeDriver, findExecutable } from '../agent-drivers/src/claude/index.js'

const bin = findExecutable('claude')
assert.ok(bin, 'Install Claude Code before running this check')
const root = mkdtempSync(join(tmpdir(), 'nodo-claude-changes-'))
const cwd = join(root, 'workspace'), config = join(root, 'config')
mkdirSync(cwd); mkdirSync(config)
const events = [], paths = Array.from({ length: 10 }, (_, i) => join(cwd, `file-${i}.txt`))
let driver, requested = false, requests = 0
const mock = createServer(async (request, response) => {
  let body
  try { let raw = ''; for await (const chunk of request) raw += chunk; body = JSON.parse(raw) } catch { response.writeHead(400); response.end(); return }
  requests++
  const primary = body.tools?.some(tool => tool.name === 'Write')
  const content = primary && !requested ? paths.map((file_path, i) => ({ type: 'tool_use', id: `local-write-${i}`, name: 'Write', input: { file_path, content: 'local confirmed' } }))
    : [{ type: 'text', text: 'Local files done' }]
  if (primary) requested = true
  const message = { id: `local-${requests}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10 } }
  if (!body.stream) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(message)); return }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
  send('message_start', { message: { ...message, content: [], stop_reason: null } })
  content.forEach((block, index) => {
    send('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
    send('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
    send('content_block_stop', { index })
  })
  send('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } })
  send('message_stop', {})
  response.end()
})
try {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
  const env = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`, ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDECODE: '' }
  const version = spawnSync(bin, ['--version'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000 }).stdout.trim()
  driver = createClaudeDriver({ bin, cwd, model: 'sonnet', env, onEvent: event => {
    events.push(event)
    if (event.type === 'request/opened') void driver.respondToRequest(event.id, { decision: 'allow' })
  } })
  await driver.sendTurn('NODO_ES05_CLAUDE_FILES: use only the requested local Write tools')
  const deadline = Date.now() + 45000
  while (!events.some(event => event.type === 'turn/end') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(events.find(event => event.type === 'turn/end')?.reason, 'done', 'Isolated Claude turn did not complete')
  const body = events.find(event => event.type === 'changes')?.presentation.body
  assert.equal(body?.fileCount, 10, 'Actual completed writes must be available as structured file results')
  assert.deepEqual(new Set(body.files.map(file => file.path)), new Set(paths))
  for (const path of paths) assert.equal(readFileSync(path, 'utf8'), 'local confirmed')
  console.log(JSON.stringify({ result: 'passed', actualCli: 'claude', version, filesWritten: 10, reportedFiles: body.fileCount, coverage: body.coverage, localRequests: requests, remoteModelCalls: 0 }))
} finally {
  driver?.dispose(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve))
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
