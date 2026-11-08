import { accessSync, constants, statSync } from 'node:fs'
import { extname, isAbsolute, join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export type FindExecutableOptions = { path?: string; home?: string; defaults?: string[]; extra?: string[]; platform?: string }
export type RegistryQuery = (root: string, match: string) => string
export type CliVersionOptions = Omit<ExecFileOptions, 'encoding'> & { encoding?: BufferEncoding }
export const invalidConfig = (message: string) => Object.assign(new Error(message), { code: 'orch/invalid' })

export function validateWorkspace(cwd: unknown, required = false) {
  if (cwd === undefined || cwd === null || cwd === '') {
    if (required) throw invalidConfig('Choose an absolute working directory for this engine')
    return undefined
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw invalidConfig('Working directory must be an absolute path')
  try { if (!statSync(cwd).isDirectory()) throw new Error('not a directory') }
  catch { throw invalidConfig(`The working directory "${cwd}" does not exist`) }
  return cwd
}

export function validateBin(bin: unknown) {
  if (bin === undefined || bin === null || bin === '') return undefined
  if (typeof bin !== 'string' || bin.length > 1000 || bin.includes('\0')) throw invalidConfig('Invalid CLI executable')
  const clean = bin.trim()
  if (!isAbsolute(clean) && !/^[\w.-]+$/.test(clean)) throw invalidConfig('CLI executable must be an absolute path or a command name')
  return clean || undefined
}

// Windows resolves bare command names through PATHEXT, so a `claude` on PATH is
// really claude.exe or claude.cmd. npm also leaves an extensionless sh shim in the
// same directory that cannot be spawned, so the bare name is probed last.
const windowsExtensions = ['.exe', '.cmd', '.bat']

export function findExecutable(command: unknown, { path = process.env.PATH ?? '', home = homedir(), platform = process.platform, defaults = [join(home, '.local/bin'), ...(platform === 'win32' ? [] : ['/usr/local/bin', '/opt/homebrew/bin'])], extra = [] }: FindExecutableOptions = {}) {
  const bin = validateBin(command)
  if (!bin) return undefined
  const dirs = [...path.split(delimiter), ...defaults, ...extra].filter(dir => isAbsolute(dir))
  const names = platform === 'win32' && extname(bin) === '' ? [...windowsExtensions.map(extension => bin + extension), bin] : [bin]
  const candidates = isAbsolute(bin) ? names : [...new Set(dirs)].flatMap(dir => names.map(name => join(dir, name)))
  return candidates.find(candidate => {
    try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile() } catch { return false }
  })
}

// Desktop apps registered for uninstall expose their install dir even when they
// never touch PATH, so an installer may have put them on any drive or folder.
const uninstallRoots = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]
// The first absolute Windows path in a registry value: quoted for uninstall
// strings, whole for display icons, which may carry a ",0" icon index.
const registryPath = (value: string) => {
  const quoted = value.match(/"([^"]+)"/)
  const text = (quoted ? quoted[1] : value.split(',')[0]).trim()
  return /^[A-Za-z]:\\.+/.test(text) ? text : ''
}

export function registryProgramDirs(match: string, { platform = process.platform, query }: { platform?: string; query?: RegistryQuery } = {}) {
  if (platform !== 'win32') return []
  const run = query ?? ((root, text) => {
    try { return execFileSync('reg', ['query', root, '/s', '/f', text, '/d'], { encoding: 'utf8', timeout: 5000, windowsHide: true }) } catch { return '' }
  })
  const dirs = new Set<string>()
  let location = '', uninstall = '', icon = ''
  const flush = () => {
    // InstallLocation already names the directory; uninstall and icon values name
    // files inside their directory, cut at the last backslash — never path.dirname,
    // which only sees separators of the running platform.
    const file = registryPath(uninstall) || registryPath(icon)
    const cut = file.lastIndexOf('\\')
    const value = (location || (cut >= 0 ? file.slice(0, cut) : '')).replace(/\\+$/, '')
    if (value) dirs.add(value)
    location = uninstall = icon = ''
  }
  for (const root of uninstallRoots) {
    for (const line of run(root, match).split(/\r?\n/)) {
      if (/^HKEY_/i.test(line)) { flush(); continue }
      const at = line.indexOf('REG_SZ')
      if (at < 0) continue
      const name = line.slice(0, at).trim(), data = line.slice(at + 6).trim()
      if (!data) continue
      if (name === 'InstallLocation') location = data
      else if (name === 'UninstallString') uninstall = data
      else if (name === 'DisplayIcon') icon = data
    }
    flush()
  }
  return [...dirs]
}

// Node refuses to spawn .cmd/.bat shims directly (CVE-2024-27980); route them
// through cmd.exe with the command quoted. An argument is quoted when it
// contains whitespace, so an argument value must not contain double quotes.
export function launchCommand(bin: string, args: string[] = [], { platform = process.platform }: { platform?: string } = {}): { bin: string; args: string[]; verbatim?: boolean } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return { bin, args }
  return { bin: 'cmd.exe', args: ['/d', '/s', '/c', [`"${bin}"`, ...args.map(arg => /\s/.test(arg) ? `"${arg}"` : arg)].join(' ')], verbatim: true }
}

export async function cliVersion(bin: string, options: CliVersionOptions & { args?: string[] } = {}) {
  const { args, ...rest } = options
  const launch = launchCommand(bin, args ?? ['--version'])
  const { stdout } = await execute(launch.bin, launch.args, {
    ...rest, ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
    ...(rest.env ? { env: { ...process.env, ...rest.env } } : {}), timeout: 5000, maxBuffer: 16_384, windowsHide: true,
  })
  return stdout.trim().split('\n')[0].slice(0, 120)
}

export type CliCheckItem = { label: string; ok: boolean | null; message: string }
export type CliCheckBase<E extends string = string> = {
  checks: CliCheckItem[]
  executable?: string
  version?: string
  failed?: { engine: E; ok: false; executable?: string; version?: string; checks: CliCheckItem[] }
}

// The workspace, executable and version checks every adapter shares. `failed`
// already carries the adapter's engine id, so a caller returns it unchanged.
export async function checkCliBase<E extends string>(engine: E, cwd: string | undefined, executable: string | undefined,
  missingMessage: string, versionOf: (bin: string) => Promise<string> = cliVersion): Promise<CliCheckBase<E>> {
  const checks: CliCheckItem[] = []
  try { validateWorkspace(cwd, true); checks.push({ label: 'Working directory', ok: true, message: cwd! }) }
  catch (error) { checks.push({ label: 'Working directory', ok: false, message: (error as Error).message }) }
  if (!executable) return { checks, failed: { engine, ok: false, checks: [...checks, { label: 'CLI', ok: false, message: missingMessage }] } }
  try {
    const version = await versionOf(executable)
    return { checks: [...checks, { label: 'CLI', ok: true, message: `${version} · ${executable}` }], executable, version }
  } catch {
    return { checks, executable, failed: { engine, ok: false, executable, checks: [...checks, { label: 'CLI', ok: false, message: 'CLI version check failed or timed out.' }] } }
  }
}
