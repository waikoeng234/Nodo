// P0 probe for the LLM-adapter route (see .agent/context/native-adapter-handoff.md).
// Builds a throwaway DSH plugin whose install registers an "echo-probe" LLM
// adapter on ctx.llm and streams fixed text; the bench (check-native-dsh.mjs
// --native-adapter) asserts registration, model routing, and cancellation
// against a real host. Stream behaviour is selected by the last user-message
// marker, so auxiliary calls (session title) cannot hijack a scenario:
//   ECHO_HANG_ABORT   hang until the request signal aborts, then throw
//   ECHO_HANG_TIMEOUT hang ADAPTER_TIMEOUT_MS (default 180s), then finish
// Probe facts travel back via probe-log.jsonl inside the plugin directory.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN_SOURCE = `import { appendFileSync } from 'node:fs'

export const inject = ['llm']

const log = entry => appendFileSync(new URL('./probe-log.jsonl', import.meta.url), JSON.stringify({ boot: BOOT, ...entry }) + '\\n')
const reach = (ctx, key) => { try { void ctx[key]; return true } catch { return false } }
const userText = options => {
  const message = [...options.messages].reverse().find(item => item.role === 'user')
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}
const userHeads = options => options.messages.filter(item => item.role === 'user')
  .map(item => (typeof item.content === 'string' ? item.content : item.content.filter(block => block.type === 'text').map(block => block.text).join('')).slice(0, 60))
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
  const onAbort = () => { clearTimeout(timer); reject(new Error('adapter probe aborted by request signal')) }
  signal?.addEventListener('abort', onAbort, { once: true })
})

export function apply(ctx) {
  log({ kind: 'install', reach: { llm: reach(ctx, 'llm'), tools: reach(ctx, 'tools'), approval: reach(ctx, 'approval'), agents: reach(ctx, 'agents') } })
  let calls = 0
  const adapter = {
    providerInfo: provider => ({ id: provider, name: 'Echo probe' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async provider => [{ provider, id: 'echo-model', name: 'Echo model', description: 'native adapter probe' }],
    resolveModel: async (provider, model) => ({ provider, id: model, name: 'Echo model', context: { contextWindow: 1000000 } }),
    async prepareCall(provider, model, signal) {
      return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) }
    },
    async *stream(options) {
      const call = ++calls
      const text = userText(options)
      const marker = text.includes('ECHO_HANG_TIMEOUT') ? 'timeout' : text.includes('ECHO_HANG_ABORT') ? 'abort' : 'echo'
      log({ kind: 'stream-start', call, provider: options.provider, model: options.model, purpose: options.purpose ?? null, tools: options.tools?.length ?? 0, marker, text, userMessages: userHeads(options) })
      try {
        if (marker === 'timeout') await wait(Number(process.env.ADAPTER_TIMEOUT_MS) || 180000, options.signal)
        else if (marker === 'abort') await wait(600000, options.signal)
        const reply = marker === 'echo' ? \`ECHO:\${text}\` : 'ECHO:SLOW_DONE'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        for (const piece of reply.match(/.{1,7}/gs) ?? []) {
          if (options.signal?.aborted) throw new Error('adapter probe aborted by request signal')
          yield { type: 'text-delta', index: 0, text: piece }
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        log({ kind: 'stream-end', call, marker, outcome: 'completed' })
      } catch (error) {
        log({ kind: 'stream-end', call, marker, outcome: options.signal?.aborted ? 'aborted' : 'error', detail: String(error?.message ?? error) })
        throw error
      }
    },
  }
  ctx.llm.registerAdapter(['echo-probe'], adapter)
  ctx.on('llm/stream', (options, next) => {
    if (options.provider === 'codex') log({ kind: 'codex-request', tools: options.tools?.map(tool => tool.name) ?? [] })
    return next()
  })
  log({ kind: 'registered' })
}`

export function createNativeAdapterProbe() {
  const plugin = mkdtempSync(join(tmpdir(), 'nodo-native-adapter-plugin-'))
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({
    name: 'nodo-native-adapter-probe', version: '0.0.0', type: 'module', main: 'index.js',
    exports: { '.': './index.js', './package.json': './package.json' },
  }))
  writeFileSync(join(plugin, 'index.js'), PLUGIN_SOURCE.replace('BOOT', String(Date.now())))
  const logPath = join(plugin, 'probe-log.jsonl')
  return {
    plugin,
    patch: [{ insert: [{ id: 'nodo-native-adapter-probe', name: join(plugin, 'index.js') }] }],
    readLog() {
      try { return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
      catch { return [] }
    },
    dispose() {
      rmSync(plugin, { recursive: true, force: true })
    },
  }
}
