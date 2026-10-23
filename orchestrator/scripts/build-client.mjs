// Concatenates src/client into client.js. dsh runs client.js as a classic script that
// registers a factory with window.__ModuleLoader__; the factory's `require` resolves
// React and the dsh UI packages from the host's shared module table.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { engineMetadata } from '../agent-drivers/src/index.js'
import { PANEL_SOURCES } from './client-sources.mjs'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(PLUGIN, 'client.js')
const read = path => readFileSync(join(PLUGIN, path), 'utf8')
const json = path => JSON.stringify(JSON.parse(read(path)))

// Later files use names declared by earlier ones; index.js comes last.
const SOURCES = ['avatar', 'engine-logos', 'running', 'native-space', 'native-welcome', 'completion-tracker', 'model-seat',
  'role-seat', 'new-conversation', 'session-references', 'stream-records', 'shared:task-titles', 'workflow', 'workflow-composer']
const sourceText = name => (name.startsWith('shared:')
  ? read(`src/shared/${name.slice(7)}.js`).replace(/^export /gm, '')
  : read(`src/client/${name}.js`)).trimEnd()

const logo = readFileSync(join(PLUGIN, 'src/client/assets/nodo-logo.png')).toString('base64')
// Engine marks are inlined as SVG markup; monochrome ones use fill="currentColor".
const engineSvgs = Object.fromEntries(readdirSync(join(PLUGIN, 'src/client/assets/engines')).sort()
  .filter(file => file.endsWith('.svg')).map(file => [file.slice(0, -4), read(`src/client/assets/engines/${file}`).trim()]))

const body = [
  'const module = { exports: {} }',
  `const AVATAR_TEMPLATES = ${json('src/shared/avatar-templates.json')}`,
  `const ROLE_PRESETS = ${json('src/shared/role-presets.json')}`,
  `const NODO_LOGO = 'data:image/png;base64,${logo}'`,
  `const ENGINE_LOGO_SVGS = ${JSON.stringify(engineSvgs)}`,
  `const ENGINE_NAMES = ${JSON.stringify(Object.fromEntries(engineMetadata().map(entry => [entry.id, entry.name])))}`,
  ...SOURCES.map(sourceText),
  PANEL_SOURCES.map(sourceText).join('\n\n'),
  // The loader expects an ES module namespace object.
  "return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' })",
].join('\n')
const bundled = `// Built by scripts/build-client.mjs from src/client (npm run build); edits here are overwritten.
window.__ModuleLoader__.load({
  id: ${JSON.stringify(JSON.parse(read('package.json')).name)},
  factory: (require) => {
${body}
  },
})
`

// Parse as a classic script, the way the browser loads it.
new Script(bundled, { filename: OUTPUT })

if (process.argv.includes('--check')) {
  if (readFileSync(OUTPUT, 'utf8') !== bundled) {
    console.error('client.js is out of date; run npm run build')
    process.exit(1)
  }
} else {
  writeFileSync(OUTPUT, bundled, 'utf8')
  console.log(`wrote ${OUTPUT} (${bundled.length} bytes)`)
}
