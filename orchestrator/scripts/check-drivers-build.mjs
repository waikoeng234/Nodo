import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const dist = join(plugin, 'agent-drivers/dist')
const temporary = mkdtempSync(join(tmpdir(), 'nodo-drivers-build-'))
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(join(directory, entry.name)).map(path => join(entry.name, path)) : [entry.name])

try {
  const compiled = spawnSync(process.execPath, [join(plugin, 'node_modules/typescript/bin/tsc'), '-p', join(plugin, 'agent-drivers'), '--outDir', temporary], { cwd: plugin, stdio: 'inherit' })
  if (compiled.error) throw compiled.error
  if (compiled.status !== 0) throw new Error('agent-drivers compilation failed')
  const expected = new Set(files(temporary))
  const actual = new Set(existsSync(dist) ? files(dist) : [])
  const different = [...new Set([...expected, ...actual])].sort().filter(path => !expected.has(path) || !actual.has(path)
    || !readFileSync(join(temporary, path)).equals(readFileSync(join(dist, path))))
  if (different.length) {
    console.error(`agent-drivers/dist is out of date; run npm run build:\n${different.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
