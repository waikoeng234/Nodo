import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { engineMetadata } from '../agent-drivers/src/index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CAPABILITIES = {
  session: ['drivers', 'sessions', 'context', 'adapter', 'preset-heal'],
  models: ['model-seat'],
  identity: ['identity-files', 'role-mcp', 'adapter'],
  interaction: ['adapter', 'adapter-steering'],
  stream: ['coverage', 'tool-stream', 'stream-records', 'stream-records-client', 'file-changes', 'stats', 'native-running', 'native-status'],
  attachments: ['attachments', 'adapter-input'],
  commands: ['adapter-skills'],
  handoff: ['workflows', 'workflow-materials'],
}
const SHARED = { acp: ['acp'] }

export function engineCheckPlan({ engine, route, capability = [], shared = [] }, root = ROOT) {
  const metadata = engineMetadata()
  const selected = metadata.find(entry => entry.id === engine)
  if (!selected) throw new Error(`Unknown engine: ${engine ?? '(missing)'}`)
  if (!['new', 'capability'].includes(route)) throw new Error('--route must be new or capability')
  if (route === 'new' && capability.length) throw new Error('The new route checks all capabilities; omit --capability')
  if (route === 'capability' && !capability.length) throw new Error('The capability route requires --capability')
  for (const value of capability) if (!Object.hasOwn(CAPABILITIES, value)) throw new Error(`Unknown capability: ${value}`)
  for (const value of shared) if (!Object.hasOwn(SHARED, value)) throw new Error(`Unknown shared core: ${value}`)
  const engines = metadata.filter(entry => entry.id === engine || entry.shared.some(value => shared.includes(value)))
  const capabilities = route === 'new' ? Object.keys(CAPABILITIES) : [...new Set(capability)]
  const tests = new Set(['test/engine-registration.test.js', 'test/engines.test.js'])
  const files = readdirSync(join(root, 'test'))
  for (const entry of engines) {
    for (const name of entry.tests) tests.add(`test/${name}.test.js`)
    for (const file of files) if (file.startsWith(`${entry.id}-`) && file.endsWith('.test.js')) tests.add(`test/${file}`)
    for (const core of entry.shared) {
      if (!Object.hasOwn(SHARED, core)) throw new Error(`Unknown shared core: ${core}`)
      for (const name of SHARED[core]) tests.add(`test/${name}.test.js`)
    }
  }
  for (const value of capabilities) for (const name of CAPABILITIES[value]) tests.add(`test/${name}.test.js`)
  for (const file of tests) if (!existsSync(join(root, file))) throw new Error(`Required test is missing: ${file}`)
  const handoff = capabilities.includes('handoff') ? engines.map(entry => entry.id) : []
  for (const id of handoff) {
    const fixture = `test/fixtures/${id}-cli.cjs`
    if (!existsSync(join(root, fixture))) throw new Error(`Required handoff fixture is missing: ${fixture}`)
  }
  return { engine, route, capabilities, engines: engines.map(entry => entry.id), tests: [...tests].sort(), handoff }
}

export function runEngineChecks(plan, execute = spawnSync) {
  const commands = [['--test', ...plan.tests], ...plan.handoff.map(id => ['scripts/check-handoff-capabilities.mjs', '--engine', id]), ['scripts/build-client.mjs', '--check']]
  for (const args of commands) {
    const result = execute(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) return result.status ?? 1
  }
  return 0
}

const HELP = `Usage: npm run verify:engine -- --engine <id> --route <new|capability> [options]
  --capability <name>  Required for capability route; repeat to combine scopes.
                      ${Object.keys(CAPABILITIES).join(', ')}
  --shared acp        Shared core changed: include every registered ACP consumer.
  --plan              Print selection without running checks.
Automated checks use fixtures only. Real CLI/model/Desktop acceptance belongs to the project maintainer.
See agent-drivers/ENGINE_INTAKE.md for both routes and the acceptance checklist.`

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      engine: { type: 'string' }, route: { type: 'string' },
      capability: { type: 'string', multiple: true }, shared: { type: 'string', multiple: true },
      plan: { type: 'boolean' }, help: { type: 'boolean' },
    } })
    if (values.help) console.log(HELP)
    else {
      const plan = engineCheckPlan(values)
      console.log(JSON.stringify(plan, null, 2))
      console.log('Real CLI/model/Desktop: not run; project maintainer acceptance required (ENGINE_INTAKE.md).')
      if (!values.plan) process.exitCode = runEngineChecks(plan)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
