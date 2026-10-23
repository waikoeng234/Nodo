// Keys the user saves for the agents. They live only in secrets.json (mode 600) and
// in this process: drivers receive them as ORCH_SECRET_* environment variables, and
// whatever is stored or shown passes through the redactor first.
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ADAPTER_ENGINES } from './adapter/registry.js'

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
export const ENV_PREFIX = 'ORCH_SECRET_'
export const MIN_VALUE = 4
// Values shorter than this (a PIN) are only replaced where no letter or digit touches them.
export const WHOLE_VALUE = 8
export const MAX_VALUE = 16384

export const envName = name => `${ENV_PREFIX}${name}`
export const canUse = (secret, profileId) => secret !== undefined && profileId !== undefined
  && (secret.scope === 'all' || (Array.isArray(secret.scope) && secret.scope.includes(profileId)))

// Accepts `$NAME`, `$env:NAME` and the prefixed environment name.
export function normalizeName(raw) {
  const name = String(raw ?? '').trim().replace(/^\$(?:env:)?/i, '').toUpperCase()
  return (name.startsWith(ENV_PREFIX) ? name.slice(ENV_PREFIX.length) : name).replace(/[\s-]+/g, '_')
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Replaces each value, and its JSON-escaped form, with `[secret:NAME]` in a single
// pass; longer values are tried first so one containing another is replaced whole.
export function redactor(secrets) {
  const labels = new Map()
  const loose = new Set()
  for (const { name, value } of secrets) {
    if (typeof value !== 'string' || value.length < MIN_VALUE) continue
    for (const form of [value, JSON.stringify(value).slice(1, -1)]) {
      if (labels.has(form)) continue
      labels.set(form, `[secret:${name}]`)
      if (value.length < WHOLE_VALUE) loose.add(form)
    }
  }
  if (labels.size === 0) return text => text
  const alternatives = [...labels.keys()].sort((a, b) => b.length - a.length)
    .map(form => (loose.has(form) ? `(?<![\\p{L}\\p{N}])${escapeRegExp(form)}(?![\\p{L}\\p{N}])` : escapeRegExp(form)))
  const pattern = new RegExp(alternatives.join('|'), 'gu')
  return text => (typeof text === 'string' ? text.replace(pattern, form => labels.get(form)) : text)
}

// Redacts strings inside plain objects and arrays; an untouched value keeps its identity.
export function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value)
  const array = Array.isArray(value)
  if (!array && (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)) return value
  const entries = Object.entries(value).map(([key, item]) => [key, redactDeep(item, redact)])
  if (entries.every(([key, item]) => item === value[key])) return value
  return array ? entries.map(([, item]) => item) : Object.fromEntries(entries)
}

export function install(rt) {
  const { ctx, home } = rt
  const path = join(home, 'secrets.json')

  /** @type {Map<string, {name:string, value:string, purpose:string, scope:'all'|string[], createdAt:number, updatedAt:number}>} */
  const secrets = new Map()
  // Replaced and deleted values stay redacted: a running engine may still hold them.
  const retired = new Map()
  let reading
  let unreadable
  let readAsReader = false
  let writing = Promise.resolve()
  let redact = text => text

  const changed = () => {
    redact = redactor([...secrets.values(), ...[...retired].map(([value, name]) => ({ name, value }))])
  }
  const retire = secret => secret && retired.set(secret.value, secret.name)
  // A JSON.parse message would quote the file, so logs carry only the error code.
  const codeOf = error => error?.code ?? error?.name ?? 'error'

  const readSecrets = async () => {
    readAsReader = rt.readOnly() !== undefined
    let saved
    try {
      saved = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        unreadable = codeOf(error)
        return rt.warn('nodo: unreadable secrets file %s (%s)', path, unreadable)
      }
    }
    const now = Date.now()
    for (const secret of secrets.values()) retire(secret)
    secrets.clear()
    unreadable = saved !== undefined && !Array.isArray(saved?.secrets) ? 'format' : undefined
    for (const entry of Array.isArray(saved?.secrets) ? saved.secrets : []) {
      const { name, value, purpose, scope, createdAt, updatedAt } = entry ?? {}
      if (typeof value !== 'string' || !SECRET_NAME.test(name ?? '')) {
        unreadable = 'entry'
        continue
      }
      secrets.set(name, {
        name,
        value,
        purpose: typeof purpose === 'string' ? purpose : '',
        scope: Array.isArray(scope) ? scope.filter(id => typeof id === 'string') : 'all',
        createdAt: Number(createdAt) || now,
        updatedAt: Number(updatedAt) || now,
      })
    }
    if (unreadable !== undefined) rt.warn('nodo: secrets file %s holds keys Nodo cannot read (%s)', path, unreadable)
    if (saved !== undefined && !readAsReader) await chmod(path, 0o600).catch(() => {})
    changed()
  }
  // A reading host rereads the file every time: the writing host may have changed it.
  const loadSecrets = () => {
    if (reading === undefined || readAsReader || rt.readOnly() !== undefined) reading = readSecrets()
    return reading
  }

  // Resolves once secrets.json holds the current keys; rejects when the write failed.
  const persist = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) return Promise.reject(new Error(readOnly))
    // Saving would replace keys the file holds but this host could not read.
    if (unreadable !== undefined) return Promise.reject(new Error('secrets.json could not be read; fix or remove it before saving keys'))
    const text = JSON.stringify({ version: 1, secrets: [...secrets.values()] }, null, 2)
    const job = writing.then(async () => {
      const temp = `${path}.${randomUUID()}.tmp`
      await mkdir(home, { recursive: true })
      try {
        await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
        await rename(temp, path)
      } catch (error) {
        await rm(temp, { force: true })
        throw error
      }
    })
    writing = job.catch(error => rt.warn('nodo: secrets write failed (%s)', codeOf(error)))
    return job
  }

  const invalid = message => Object.assign(new Error(message), { code: 'orch/invalid' })
  const cleanValue = (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value === '') throw invalid('Type the key first')
    if (value.length < MIN_VALUE || value.length > MAX_VALUE) throw invalid(`A key has ${MIN_VALUE} to ${MAX_VALUE} characters`)
    return value
  }
  // Left out, the scope stays as saved; a list keeps only profiles that exist.
  const cleanScope = (raw, saved = 'all') => {
    if (raw === undefined) return saved
    if (raw === 'all') return 'all'
    const scope = Array.isArray(raw) ? [...new Set(raw.filter(id => typeof id === 'string' && Object.hasOwn(rt.state.profiles, id)))] : []
    if (scope.length === 0) throw invalid('Choose every profile or at least one existing profile')
    return scope
  }

  // After a failed write, memory is reread from the file once queued writes finish.
  // The new revision makes open windows fetch the key list again.
  const commit = async () => {
    changed()
    try {
      await persist()
    } catch (error) {
      await (reading = writing.then(readSecrets))
      throw error
    }
    await rt.save()
    // The brief lists each profile's keys; native sessions hold it in their binding.
    for (const profile of Object.values(rt.state.profiles)) {
      if (ADAPTER_ENGINES.includes(profile.engine)) await rt.refreshAdapterBindings?.(profile)
    }
  }

  // A saved key may leave out `value` to change only its purpose or scope.
  async function secretSet({ name, value, purpose, scope }) {
    await rt.load()
    await loadSecrets()
    const key = normalizeName(name)
    if (!SECRET_NAME.test(key)) throw invalid('A name uses capitals, digits, and underscores, and starts with a letter')
    const saved = secrets.get(key)
    const now = Date.now()
    const next = value === undefined && saved !== undefined ? saved.value : cleanValue(value)
    if (saved?.value !== next) retire(saved)
    secrets.set(key, {
      name: key,
      value: next,
      purpose: purpose === undefined ? saved?.purpose ?? '' : String(purpose ?? '').trim().slice(0, 300),
      scope: cleanScope(scope, saved?.scope),
      createdAt: saved?.createdAt ?? now,
      updatedAt: now,
    })
    await commit()
    return secretView(secrets.get(key))
  }

  async function secretDelete({ name }) {
    await rt.load()
    await loadSecrets()
    const key = normalizeName(name)
    retire(secrets.get(key))
    if (!secrets.delete(key)) throw Object.assign(new Error('No such key'), { code: 'orch/not-found' })
    await commit()
    return true
  }

  const secretView = ({ name, purpose, scope, createdAt, updatedAt }) => ({ name, purpose, scope, createdAt, updatedAt })
  const secretsView = () => [...secrets.values()].map(secretView).sort((a, b) => a.name.localeCompare(b.name))
  // Only the keys the profile's scope allows; values go nowhere else.
  const granted = profileId => [...secrets.values()].filter(secret => canUse(secret, profileId))
  const secretEnv = profileId => Object.fromEntries(granted(profileId).map(secret => [envName(secret.name), secret.value]))
  const secretKeys = profileId => granted(profileId).map(({ name, purpose }) => ({ name, purpose }))
  // Changes when any granted value does, so drivers holding the old environment are rebuilt.
  const secretStamp = profileId => createHash('sha256').update(JSON.stringify(secretEnv(profileId))).digest('hex')

  ctx.effect(() => {
    void loadSecrets()
    return () => {}
  }, 'nodo: load secrets')

  Object.assign(rt, {
    secretsView, secretSet, secretDelete, secretEnv, secretKeys, secretStamp,
    loadSecrets, redactSecrets: text => redact(text), redactDeepSecrets: value => redactDeep(value, redact),
  })
}
