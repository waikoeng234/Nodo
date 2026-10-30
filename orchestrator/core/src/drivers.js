// Drivers: the bridge from profiles to the agent-drivers package. One live driver
// process per profile while it works, spawned lazily on the profile's first turn,
// stopped after it idles and respawned when its role card changes (engine, cwd,
// model, env). This module owns engine lifecycle only; message routing is
// dispatch.js and cards are approvals.js.
//
// The package import is dynamic and degrades to an empty engine list when
// agent-drivers cannot be loaded, so the plugin still loads and can say why. It
// is imported by relative path from ./agent-drivers (a package-shaped directory
// kept inside the plugin so any install method — link, copy, or git — resolves
// it); extracting it back to a standalone package means republishing it and
// switching this specifier.
import { join } from 'node:path'
import { createIdentityFiles } from '../../agent-drivers/dist/identity-files.js'
import { DRIVER_IDLE_RELEASE_MS } from './constants.js'
import { leadModeOf } from '../shared/lead.js'

const DRIVERS_SPECIFIER = '../../agent-drivers/dist/index.js'
const invalidConfig = message => Object.assign(new Error(message), { code: 'orch/invalid' })

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, {driver:any, signature:string, revoke?:Function, releasable:boolean, idle?:any}>} */
  const instances = new Map()
  const compactions = new Set()
  const idled = new WeakSet()
  const identityFiles = createIdentityFiles(join(rt.home, 'identities'))
  let api = null
  let apiError = null
  let engines = []
  let ready = null

  const driversReady = () => ready ??= (async () => {
    if (api !== null) return api
    try {
      api = await import(DRIVERS_SPECIFIER)
      engines = api.listEngines()
    } catch (error) {
      apiError = error
      rt.warn('nodo: the agent-drivers package is unavailable: %s', error?.message ?? error)
    }
    return api
  })()

  // The signature of a profile's engine settings; a change means a new process.
  const signatureOf = profile => JSON.stringify([profile.engine, profile.cwd ?? null, profile.model ?? null, profile.thinking ?? null, profile.permission ?? null, profile.engineOptions ?? {}, rt.renderIdentity(profile), rt.secretStamp(profile.profileId ?? profile.id)])

  const ensureDriver = async (profile) => {
    await driversReady()
    if (api === null) throw Object.assign(new Error(`No engines available: ${apiError?.message ?? 'agent-drivers missing'}`), { code: 'orch/no-drivers' })
    const signature = JSON.stringify([signatureOf(profile), leadModeOf(profile, profile)])
    const existing = instances.get(profile.id)
    if (existing !== undefined && existing.signature === signature && (!leadModeOf(profile, profile) || existing.revoke)) return armIdle(profile.id, existing).driver
    const leadMcp = await rt.issueLeadMcp?.(profile.id)
    if (existing !== undefined && existing.signature === signature && !leadMcp) return armIdle(profile.id, existing).driver
    if (existing !== undefined) releaseDriver(profile.id)
    let driver
    try { driver = api.createDriver(profile.engine, {
      ...(profile.engineOptions ?? {}),
      cwd: profile.cwd,
      model: profile.model,
      thinking: profile.thinking,
      permission: profile.engine === 'dsh' ? profile.permission : profile.permission || 'workspace',
      env: rt.secretEnv(profile.profileId ?? profile.id),
      driverSessionId: profile.driverSessionId,
      ...(profile.engine === 'dsh' && profile.driverSessionId?.startsWith('dsh:isolated:')
        ? { storageDir: join(rt.home, 'agents', profile.profileId ?? profile.id) } : {}),
      allowEmptyResume: profile.briefSent === false && !profile.lastTurn,
      nativeHost: ctx,
      workspaceId: profile.workspaceId,
      workspaceName: profile.workspaceName,
      workspaceKey: profile.workspaceKey,
      name: profile.name,
      sessionName: profile.sessionName,
      instructions: rt.renderIdentity(profile),
      leadMcpServers: leadMcp?.servers,
      identityFiles,
      identityOwner: profile.id,
      instructionDir: join(rt.home, 'drivers', profile.id),
      onEvent: (event) => {
        if (idled.has(driver)) return
        if (event?.type === 'session' && typeof event.sessionId === 'string' && event.sessionId !== '') {
          void rt.saveSessionEvent(profile.id, event).catch(() => {})
        }
        rt.driverSink?.(profile.id, event)
        if (event?.type !== 'turn/end') return
        const entry = instances.get(profile.id)
        for (const line of entry?.driver?.coverage?.drain?.() ?? []) rt.warn('%s', line)
        if (entry?.driver === driver) armIdle(profile.id, entry)
      },
    }) } catch (error) { leadMcp?.revoke(); throw error }
    const entry = { driver, signature, revoke: leadMcp?.revoke, releasable: profile.engine !== 'dsh' }
    instances.set(profile.id, armIdle(profile.id, entry))
    collectIdentityFiles()
    return driver
  }

  // DSH sessions run inside the host, not in a child process, so they are never armed.
  const armIdle = (profileId, entry) => {
    if (!entry.releasable) return entry
    clearTimeout(entry.idle)
    entry.idle = setTimeout(() => {
      if (instances.get(profileId) !== entry) return
      const work = rt.workView?.()[profileId]
      if (work?.active || work?.queued) armIdle(profileId, entry)
      else { idled.add(entry.driver); releaseDriver(profileId) }
    }, DRIVER_IDLE_RELEASE_MS)
    entry.idle.unref?.()
    return entry
  }
  const driverOf = (profileId) => instances.get(profileId)?.driver
  const releaseDriver = (profileId) => {
    const entry = instances.get(profileId)
    if (entry === undefined) return
    instances.delete(profileId)
    clearTimeout(entry.idle)
    entry.revoke?.()
    try { entry.driver.dispose() } catch { /* a half-dead engine is fine to drop */ }
  }
  const collectIdentityFiles = () => {
    try { identityFiles.collect(Object.values(rt.state.profiles).flatMap(profile => rt.sessionsOf(profile).map(session => session.id))) }
    catch { rt.warn('nodo: unused identity versions could not be collected') }
  }
  const answerRequest = (profileId, requestId, payload) => {
    const driver = driverOf(profileId)
    if (driver === undefined) return Promise.resolve(false)
    return Promise.resolve(driver.respondToRequest(requestId, payload))
  }
  const interruptDriver = (profileId) => {
    const driver = driverOf(profileId)
    if (driver === undefined) return Promise.resolve(false)
    return Promise.resolve(driver.interruptTurn()).then(() => true).catch(() => false)
  }
  // Compaction addresses the active driver; an engine without the optional
  // SPI channel is refused instead of pretending.
  const compactDriver = async (profileId) => {
    if (rt.workView()[profileId]?.active) throw Object.assign(new Error('Stop or finish the task before compacting this session'), { code: 'orch/busy' })
    compactions.add(profileId)
    try {
      const driver = await ensureDriver(await rt.prepareConversation(profileId))
      if (typeof driver.compact !== 'function') throw invalidConfig('This engine has no compaction channel')
      await driver.openSession()
      const { session } = rt.conversationOf(profileId)
      session.restoreContext = true
      await rt.save()
      await driver.compact()
    } finally {
      compactions.delete(profileId)
      rt.drainQueue(profileId)
      void rt.flushLeadReports?.(profileId)
    }
    return true
  }

  // Run once at install: can this host spawn child processes at all? The answer
  // is the single biggest unknown on a new dsh host, so it is stored and shown.
  const runProbe = async () => {
    await driversReady()
    await rt.load()
    if (api === null) {
      rt.state.probe = { ok: false, step: 'package', error: `agent-drivers unavailable: ${apiError?.message ?? 'missing'}`, at: Date.now() }
    } else {
      const result = await api.probeSpawn()
      rt.state.probe = { ...result, at: Date.now() }
      if (result.ok) rt.warn('nodo: child-process probe passed; engines can spawn')
      else rt.warn('nodo: child-process probe FAILED (%s: %s) — engines will not run on this host', result.step, result.error)
    }
    await rt.save().catch(() => {})
    return rt.state.probe
  }

  ctx.effect(() => {
    void runProbe()
    return () => {
      for (const profileId of [...instances.keys()]) releaseDriver(profileId)
    }
  }, 'nodo: drivers')

  Object.assign(rt, {
    driversReady, listEngines: () => engines.slice(), ensureDriver, driverOf, releaseDriver, collectIdentityFiles, answerRequest, interruptDriver, compactDriver, runProbe,
    isCompacting: id => compactions.has(id),
    engineCatalog: () => api?.engineCatalog(ctx) ?? [],
    requiresWorkspace: engine => api?.requiresWorkspace(engine) ?? false,
    enginePermissionModes: engine => api?.enginePermissionModes(engine, ctx) ?? ['workspace'],
    validateEngineOptions: (engine, options) => api.validateEngineOptions(engine, options),
    checkEngine: config => api.checkEngine({ ...config, nativeHost: ctx }),
    scanEngineModels: (config) => {
      if (api === null) throw Object.assign(new Error(`No engines available: ${apiError?.message ?? 'missing'}`), { code: 'orch/no-drivers' })
      return api.scanEngine(config.engine, { ...config, nativeHost: ctx })
    },
    scanEngineCommands: (config) => {
      if (api === null) throw Object.assign(new Error(`No engines available: ${apiError?.message ?? 'agent-drivers missing'}`), { code: 'orch/no-drivers' })
      return api.scanEngineCommands(config.engine, { ...config, nativeHost: ctx })
    },
  })
}
