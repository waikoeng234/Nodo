// Bundles src/client into client.js with esbuild. dsh runs client.js as a classic
// script that registers a factory with window.__ModuleLoader__; the factory's
// `require` resolves React and the dsh UI packages from the host's shared module
// table, so both stay external and are not bundled.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { build } from 'esbuild'
import { engineMetadata } from '../agent-drivers/dist/index.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(PLUGIN, 'client.js')
const read = path => readFileSync(join(PLUGIN, path), 'utf8')

// Engine marks are inlined as SVG markup; monochrome ones use fill="currentColor".
const engineSvgs = Object.fromEntries(readdirSync(join(PLUGIN, 'src/client/assets/engines')).sort()
  .filter(file => file.endsWith('.svg')).map(file => [file.slice(0, -4), read(`src/client/assets/engines/${file}`).trim()]))
const ENGINE_NAMES = Object.fromEntries(engineMetadata().map(entry => [entry.id, entry.name]))

const virtualModule = (name, contents) => ({
  name: `virtual-${name}`,
  setup(compile) {
    compile.onResolve({ filter: new RegExp(`^${name}$`) }, () => ({ path: name, namespace: name }))
    compile.onLoad({ filter: new RegExp(`^${name}$`), namespace: name }, () => ({ contents, loader: 'js' }))
  },
})

const result = await build({
  entryPoints: [join(PLUGIN, 'src/client/index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2022',
  minify: false,
  write: false,
  logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.png': 'dataurl' },
  jsx: 'transform', jsxFactory: 'h', jsxFragment: 'Fragment',
  plugins: [
    virtualModule('nodo:engine-logos', `export const ENGINE_LOGO_SVGS = ${JSON.stringify(engineSvgs)}`),
    virtualModule('nodo:engine-names', `export const ENGINE_NAMES = ${JSON.stringify(ENGINE_NAMES)}`),
  ],
})
const bundled = `// Built by scripts/build-client.mjs from src/client (npm run build); edits here are overwritten.
window.__ModuleLoader__.load({
  id: ${JSON.stringify(JSON.parse(read('package.json')).name)},
  factory: (require) => {
    const module = { exports: {} }
${result.outputFiles[0].text.trimEnd()}
    // The loader expects an ES module namespace object.
    return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' })
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
