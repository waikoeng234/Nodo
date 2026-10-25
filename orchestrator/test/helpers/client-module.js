// Loads src/client modules for tests: esbuild bundles them in memory, the
// shell-seeded `react` and UI kit come from a fake require, and the bundle runs
// in a vm context whose globals and sibling-module stubs the test provides.
import { readFileSync, readdirSync } from 'node:fs'
import { relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script, createContext } from 'node:vm'
import { build } from 'esbuild'
import { engineMetadata } from '../../agent-drivers/dist/index.js'

const CLIENT = fileURLToPath(new URL('../../src/client/', import.meta.url))
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

// The same virtual content the real build serves.
const engineSvgs = Object.fromEntries(readdirSync(join(ROOT, 'src/client/assets/engines')).sort()
  .filter(file => file.endsWith('.svg')).map(file => [file.slice(0, -4), readFileSync(join(ROOT, 'src/client/assets/engines', file), 'utf8').trim()]))
const ENGINE_NAMES = Object.fromEntries(engineMetadata().map(entry => [entry.id, entry.name]))
const VIRTUALS = [
  ['nodo:engine-logos', `export const ENGINE_LOGO_SVGS = ${JSON.stringify(engineSvgs)}`],
  ['nodo:engine-names', `export const ENGINE_NAMES = ${JSON.stringify(ENGINE_NAMES)}`],
]

// The fake host module table: React hooks keep a per-render cursor store the
// test drives through host.reset(), and every kit member resolves to its own
// name so element trees stay readable, unless the test overrides it.
export function fakeHost({ react = {}, primitives = {} } = {}) {
  const calls = []
  const effects = []
  const cells = []
  let cursor = 0
  const reactModule = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {},
      children: children.flat(Infinity).filter(child => child !== false && child !== null && child !== undefined) }),
    Fragment: 'Fragment',
    useState: initial => {
      const at = cursor++
      if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
      return [cells[at], value => { cells[at] = typeof value === 'function' ? value(cells[at]) : value }]
    },
    useMemo: calculate => calculate(),
    useRef: initial => ({ current: initial }),
    useEffect: effect => { effects.push(effect) },
    useLayoutEffect: effect => { effects.push(effect) },
    useId: () => 'test',
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    ...react,
  }
  return {
    calls, effects, cells,
    reset: () => { cursor = 0 },
    require: name => {
      calls.push(name)
      if (name === 'react') return reactModule
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: (_t, key) => key in primitives ? primitives[key] : String(key) })
      throw new Error(`only shell-seeded modules may be required, got ${name}`)
    },
  }
}

// A `call` handler becomes the fetch stand-in the real ui-shared `call` hits.
export const callFetch = handler => async (_url, options) => {
  const body = options?.body ? JSON.parse(options.body) : {}
  const value = await handler(body.endpoint, body.payload)
  return { json: async () => ({ ok: true, value }) }
}

const exportedNames = source => {
  const names = []
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/gs))
    for (const part of match[1].split(','))
      if (part.trim()) names.push(part.trim().split(/\s+as\s+/).pop().trim())
  for (const match of source.matchAll(/export\s+(?:const|let|var|async\s+function|function|class)\s+(\w+)/g))
    names.push(match[1])
  return [...new Set(names)]
}

const importNames = (source, from) => {
  const match = source.match(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${from}'`, 's'))
  if (!match) return []
  return match[1].split(',').map(part => part.trim()).filter(Boolean)
}

const localNames = clauses => clauses.map(clause => clause.split(/\s+as\s+/).pop().trim())

// A stub module maps every real export to a value the test provides; names
// listed in `live` keep their real import (react and kit names, for example).
export function stubSource(file, values, live = []) {
  const source = readFileSync(join(CLIENT, file), 'utf8')
  const names = exportedNames(source).filter(name => !live.includes(name) && name !== 'default')
  const key = JSON.stringify(`__nodoStub:${file}`)
  return {
    source: [
      `const stub = globalThis[${key}]`,
      ...names.map(name => `export const ${name} = stub[${JSON.stringify(name)}]`),
    ].join('\n'),
    global: [`__nodoStub:${file}`, values],
  }
}

// A ui-shared stub keeps hooks and kit members live on the fakes; every other
// export reads the values object the test provides.
export function uiSharedStub(values) {
  const source = readFileSync(join(CLIENT, 'ui-shared.js'), 'utf8')
  const reactList = importNames(source, 'react')
  const kitList = importNames(source, '@deepseek-ai/dsh-client-ui-primitives')
  const generated = stubSource('ui-shared.js', values, [...localNames(reactList), ...localNames(kitList)])
  return {
    source: [
      `import { ${reactList.join(', ')} } from 'react'`,
      `import { ${kitList.join(', ')} } from '@deepseek-ai/dsh-client-ui-primitives'`,
      `export { ${localNames(reactList).join(', ')} }`,
      `export { ${localNames(kitList).join(', ')} }`,
      generated.source,
    ].join('\n'),
    global: generated.global,
  }
}

export async function loadClient(entries, {
  globals = {}, stubs = {}, uiShared, react = {}, primitives = {}, createElement, call, filename = 'client-module.js',
} = {}) {
  const list = Array.isArray(entries) ? entries : [entries]
  const host = fakeHost({ react: createElement ? { createElement, ...react } : react, primitives })
  const contextGlobals = { ...globals }
  const stubMap = {}
  if (uiShared !== undefined) {
    const generated = uiSharedStub(uiShared)
    stubs = { 'ui-shared.js': generated.source, ...stubs }
    contextGlobals[generated.global[0]] = uiShared
  }
  for (const [file, value] of Object.entries(stubs)) {
    if (typeof value === 'string') { stubMap[file] = value; continue }
    const generated = stubSource(file, value)
    stubMap[file] = generated.source
    contextGlobals[generated.global[0]] = value
  }
  const plugins = VIRTUALS.map(([name, contents]) => ({
    name,
    setup(compile) {
      compile.onResolve({ filter: new RegExp(`^${name}$`) }, () => ({ path: name, namespace: name }))
      compile.onLoad({ filter: /.*/, namespace: name }, () => ({ contents, loader: 'js' }))
    },
  }))
  if (Object.keys(stubMap).length) plugins.push({
    name: 'nodo-test-stubs',
    setup(compile) {
      compile.onLoad({ filter: /.*/ }, args => {
        const rel = relative(CLIENT, args.path).replaceAll('\\', '/')
        return rel.startsWith('..') || stubMap[rel] === undefined ? undefined
          : { contents: stubMap[rel], loader: 'js', resolveDir: CLIENT }
      })
    },
  })
  if (call !== undefined) contextGlobals.fetch = callFetch(call)
  const result = await build({
    ...(list.length === 1
      ? { entryPoints: [join(CLIENT, list[0])] }
      : { stdin: { contents: list.map(file => `export * from './${file}';`).join('\n'), resolveDir: CLIENT, loader: 'js' } }),
    bundle: true, format: 'cjs', platform: 'neutral', target: 'es2022', minify: false, write: false, logLevel: 'silent',
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
    loader: { '.png': 'dataurl' },
    jsx: 'transform', jsxFactory: 'h', jsxFragment: 'Fragment',
    plugins,
  })
  const context = createContext(contextGlobals)
  const factory = new Script(`(function (require) {
const module = { exports: {} }
${result.outputFiles[0].text}
return module.exports
})`, { filename })
  return { ...factory.runInContext(context)(host.require), context, host }
}
