import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { engineMetadata } from '../../../agent-drivers/dist/index.js'
import { createPump } from './pump.js'
import { installSteering } from './steering.js'
import { decideApproval } from './approval-bridge.js'
import { answerQuestions } from './questions.js'
import { findOrphanedPresets, healPreset, listSessionLogs } from './preset-heal.js'

const CONTEXT_WINDOW = 1000000 // The host meters and auto-compacts against this declared window, not the model's own.
export const ADAPTER_ENGINES = engineMetadata().filter(entry => entry.adapter).map(entry => entry.id)
const PROVIDER_NAMES = Object.fromEntries(engineMetadata().map(entry => [entry.id, entry.name]))
const SANDBOXES = { 'read-only': 'plan', 'workspace-write': 'workspace', 'danger-full-access': 'full' }
const presetId = profile => `nodo:${profile.engine}:${profile.id}`
const providerId = engine => `nodo:${engine}`
const presetPlugins = engine => [
  { name: fileURLToPath(new URL('./preset.js', import.meta.url)) },
  { name: fileURLToPath(new URL('./skills.js', import.meta.url)), isolate: { skills: true }, config: { engine } },
]

export function enginePermission(service, session, modes = ['plan', 'workspace', 'full']) {
  const spec = service.resolve(service.current(session))
  const mode = SANDBOXES[spec.sandbox]
  if (!mode || !modes.includes(mode) || (mode === 'full' ? spec.approval !== 'never' : spec.approval !== 'ask')) throw new Error('This native permission preset has no equivalent on this engine')
  return mode
}

export function install(rt) {
  const { ctx } = rt
  if (typeof ctx.llm?.registerAdapter !== 'function' || typeof ctx.tools?.register !== 'function') return
  const pumps = new Map()
  installSteering(ctx, id => pumps.get(String(id)))
  const presets = new Map()
  const personas = new Map()
  const modelSelection = new AsyncLocalStorage()
  let picks = Promise.resolve()
  let stopped = false

  const syncAdapterPreset = async profile => {
    if (!ADAPTER_ENGINES.includes(profile.engine)) return
    const id = presetId(profile)
    const signature = JSON.stringify([profile.name, profile.role])
    if (presets.get(id)?.signature === signature) return
    const old = presets.get(id)
    await old?.dispose()
    presets.delete(id)
    const dispose = await ctx.agentPresets.register({ id, name: profile.name, description: profile.role,
      plugins: presetPlugins(profile.engine) })
    presets.set(id, { signature, dispose })
  }

  const dropPump = id => {
    const entry = pumps.get(id)
    if (!entry) return
    pumps.delete(id)
    entry.compaction?.reject(new Error('Engine session disposed'))
    entry.pump.dispose()
    entry.driver.dispose()
  }
  const onDriverEvent = (id, event) => {
    const entry = pumps.get(id)
    if (event?.type === 'request/missed') rt.warn?.('nodo: approval reply missed: id=%s connected=%s pending=[%s]', event.id, event.connected, (event.pending ?? []).join(' '))
    if (event?.type === 'request/stray') rt.warn?.('nodo: stray %s for requestId %s (resolved outside this channel)', event.kind, event.requestId)
    entry?.pump.receive(rt.redactDeepSecrets?.(event) ?? event)
    if (event?.type === 'turn/end' && entry?.compaction) {
      if (event.reason === 'done') entry.compaction.resolve()
      else entry.compaction.reject(new Error(event.error || `Engine compaction ${event.reason}`))
    }
    if (event?.type === 'session' && event.sessionId && rt.adapterMap.of(id)?.threadId !== event.sessionId) {
      rt.adapterMap.set(id, event.sessionId)
      void rt.save().catch(() => {})
    }
  }
  const ensurePump = async (id, model, thinking, provider, signal) => {
    await rt.load()
    signal?.throwIfAborted()
    // The stream request carries the model id; the compact path reads the
    // agent's current selection, which is a {provider, model} object.
    if (model !== null && typeof model === 'object') model = model.model ?? model.id
    const binding = rt.adapterMap.of(id)
    if (!binding?.profileId) throw new Error('Open a role from Nodo before sending to this model')
    // The composer picker only offers the role's own models; this catches a
    // mismatch that arrived over any other path before it reaches the engine.
    if (provider !== undefined && provider !== providerId(binding.engine)) {
      throw new Error(`This session runs the "${binding.name ?? 'Nodo'}" role; pick models from the ${PROVIDER_NAMES[binding.engine] ?? binding.engine} group`)
    }
    const agent = ctx.agents.get(id)
    if (!agent || ctx.agentPresets.composedPreset(agent.ctx) !== binding.preset) throw new Error('The session must use its role preset')
    const permission = enginePermission(ctx.permissionPresets, agent.session, rt.enginePermissionModes(binding.engine))
    const conversation = rt.conversationOf(binding.conversationId)?.session
    if (conversation && !conversation.briefSent) { conversation.briefSent = true; await rt.save() }
    // The tier the engine actually runs under is the one worth remembering: a
    // tier changed in the native window is captured here for the next conversation.
    if (conversation && conversation.permission !== permission) { conversation.permission = permission; await rt.save() }
    signal?.throwIfAborted()
    const signature = JSON.stringify([binding.engine, model, thinking, permission, binding.identity, binding.engineOptions, rt.secretStamp(binding.profileId)])
    let entry = pumps.get(id)
    if (entry?.signature === signature) return entry
    if (entry?.pump.active || entry?.compaction) throw new Error('Finish the engine turn before changing its settings')
    dropPump(id)
    const driver = await rt.createEngineDriver(binding.engine, {
      ...binding.engineOptions, cwd: binding.cwd, model: model ?? binding.model, thinking: thinking ?? binding.thinking,
      permission, instructions: binding.identity, name: binding.name,
      env: rt.secretEnv(binding.profileId), driverSessionId: rt.adapterMap.of(id)?.threadId,
      onEvent: event => onDriverEvent(id, event),
    })
    if (signal?.aborted) { driver.dispose(); signal.throwIfAborted() }
    entry = { driver, pump: createPump({ driver, attachments: ctx.attachments, createRecords: () => rt.newStreamRun?.(binding.conversationId),
      saveReplyImages: text => rt.saveReplyImages?.(binding.conversationId, text, true) ?? Promise.resolve([]) }), signature, permission }
    pumps.set(id, entry)
    return entry
  }

  // The persona section is one-shot per agent scope: an earlier open that
  // failed after installing it leaves it registered, so a duplicate heals
  // instead of throwing. The disposer is kept so an identity edit can swap
  // the text in place while the agent stays resident.
  const installPersona = (agent, text) => {
    try {
      personas.set(agent.id, agent.ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text, interpolate: false }))
    } catch (error) {
      if (!/already registered/.test(String(error?.message))) throw error
    }
  }

  // dsh saves every selectModel pick as the deployment default. Picks run one at a
  // time, so none reads another's pick as the default, and the default is put back
  // even when the pick fails.
  const keepDeploymentDefault = (run) => {
    const service = ctx.agentDefaultModel
    const job = picks.then(async () => {
      const before = service?.currentSelection?.()
      try {
        return await run()
      } finally {
        if (before?.provider && typeof service.saveSelection === 'function') await service.saveSelection(before).catch(() => {})
      }
    })
    picks = job.catch(() => {})
    return job
  }

  // The fallback preset is the one the host itself offers: a deployment default
  // is always registered, while a Nodo role preset is the choice that would
  // rebuild the same dangling id.
  const fallbackPreset = async () => {
    const rows = await ctx.agentPresets.list()
    const preferred = rows.find(row => row.id === ctx.agentPresets.defaultId)?.id
    if (preferred && !preferred.startsWith('nodo:')) return preferred
    return rows.find(row => row.id === 'standard')?.id ?? rows.find(row => !row.id.startsWith('nodo:'))?.id
  }
  const healOrphanedPresets = async () => {
    if (stopped) return
    const ghosts = await findOrphanedPresets({
      listing: () => listSessionLogs(join(rt.home, '..', 'sessions')),
      isRegistered: async id => presets.has(id) || await ctx.agentPresets.resolve(id).then(() => true, () => false),
    })
    if (!ghosts.length) return
    const fallback = await fallbackPreset()
    if (!fallback) { rt.warn('nodo: %d deleted-role preset(s) cannot be healed: this host offers no fallback preset', ghosts.length); return }
    for (const ghost of ghosts) {
      await healPreset({ ...ghost, fallback, agentPresets: ctx.agentPresets, sessionController: ctx.sessionController, warn: rt.warn })
    }
  }

  const openAdapterSession = async ({ profile: profileId, session: sessionId, workspace }) => {
    await rt.load()
    const profile = rt.findProfile(profileId)
    if (!ADAPTER_ENGINES.includes(profile?.engine)) throw new Error('This role does not use the adapter route')
    const session = sessionId ? rt.conversation(profile.id, sessionId).session
      : await rt.createSession(profile.id, undefined, workspace, true, true)
    if (sessionId) await rt.selectSession(profile.id, session.id)
    return { sessionId: await nativeSessionOf(profile, session), conversationId: session.id }
  }

  // The native host session a conversation runs in, set up on its first use.
  const nativeSessionOf = async (profile, session) => {
    await syncAdapterPreset(profile)
    const prepared = await rt.prepareConversation(session.id)
    if (prepared.engine !== profile.engine) throw new Error('Open a new conversation after changing its engine')
    if (prepared.permission && !rt.enginePermissionModes(profile.engine).includes(prepared.permission)) {
      throw new Error(`The engine does not offer the "${prepared.permission}" permission tier`)
    }
    const model = prepared.model ?? rt.engineCatalogOf(profile.engine)?.models?.[0]?.id
    if (!model) throw new Error(`Scan ${PROVIDER_NAMES[profile.engine]} models before opening a role session`)
    if (!session.nativeSessionId) {
      const nativeWorkspace = await ctx.workspaceRegistry.resolveByPath(prepared.cwd) ?? await ctx.workspaceRegistry.create(prepared.cwd)
      session.nativeSessionId = (await ctx.sessionController.create({ workspaceId: nativeWorkspace.id, agentPreset: presetId(profile) })).sessionId
      rt.adapterMap.bind(session.nativeSessionId, { profileId: profile.id, conversationId: session.id, preset: presetId(profile),
        cwd: prepared.cwd, identity: rt.renderIdentity(prepared), name: prepared.name, engine: profile.engine,
        engineOptions: prepared.engineOptions, model: prepared.model, thinking: prepared.thinking })
      await rt.save()
    }
    if (!session.nativeReady) {
      await ctx.sessionController.rename({ sessionId: session.nativeSessionId, title: `${prepared.name} · ${session.name}` })
      const { agent, error } = await ctx.sessionController.resolveAgent(session.nativeSessionId)
      if (error) throw new Error(error.message)
      if (!rt.adapterMap.of(session.nativeSessionId)?.persona) {
        installPersona(agent, rt.renderIdentity(prepared))
        rt.adapterMap.bind(session.nativeSessionId, { persona: true })
      }
      if (prepared.permission) {
        const sandbox = Object.keys(SANDBOXES).find(key => SANDBOXES[key] === prepared.permission)
        const offered = ctx.permissionPresets.names.find(name => {
          const spec = ctx.permissionPresets.resolve(name)
          return spec.sandbox === sandbox && spec.approval === (prepared.permission === 'full' ? 'never' : 'ask')
        })
        if (!offered) throw new Error(`The native host does not offer permission tier "${prepared.permission}"`)
        ctx.permissionPresets.set(agent.session, offered)
      }
      // A role model must never become the deployment default: new plain and
      // dsh sessions inherit it and could never send.
      await selectAdapterModel({ sessionId: session.nativeSessionId, provider: providerId(profile.engine), model,
        ...(prepared.thinking ? { reasoningEffort: prepared.thinking } : {}) })
      session.nativeReady = true
      await rt.save()
    }
    await ctx.sessionController.resolveAgent(session.nativeSessionId).then(async ({ agent, error }) => {
      if (error) throw new Error(error.message)
      if (agent.status === 'idle') await agent.whenIdle?.()
    })
    const binding = rt.adapterMap.of(session.nativeSessionId)
    if (!binding.selection) await selectAdapterModel({ sessionId: session.nativeSessionId, provider: providerId(profile.engine), model,
      ...(prepared.thinking ? { reasoningEffort: prepared.thinking } : {}) })
    return session.nativeSessionId
  }

  // Identity edits propagate to existing native sessions: the binding snapshot
  // is the engine channel and the pump signature carries it, so the next turn
  // rebuilds the driver onto the same thread with the new persona, while a
  // resident agent's persona section swaps in place. Sessions without a native
  // side yet just adopt the new card for their first open.
  const refreshAdapterBindings = async profile => {
    if (!ADAPTER_ENGINES.includes(profile.engine)) return
    for (const session of rt.sessionsOf(profile)) {
      Object.assign(session, { profileName: profile.name, role: profile.role ?? '', instructions: profile.instructions ?? '', goal: profile.goal ?? '' })
      rt.snapshotIdentity(profile, session)
      const id = session.nativeSessionId
      const binding = id && rt.adapterMap.of(id)
      if (binding?.profileId !== profile.id) continue
      try {
        const prepared = await rt.prepareConversation(session.id)
        const identity = rt.renderIdentity(prepared)
        if (binding.identity === identity && binding.name === prepared.name) continue
        rt.adapterMap.bind(id, { identity, name: prepared.name })
        const agent = ctx.agents.get(id)
        if (agent && binding.persona) { personas.get(id)?.(); installPersona(agent, identity) }
      } catch { /* keep the previous binding; the next open or turn re-prepares */ }
    }
    await rt.save()
  }

  const dropAdapterProfile = async profile => {
    for (const session of rt.sessionsOf(profile)) {
      const id = session.nativeSessionId
      if (!id || rt.adapterMap.of(id)?.profileId !== profile.id) continue
      dropPump(id)
      rt.adapterMap.drop(id)
    }
    // Bindings can also sit under ids the session list no longer names, and
    // engine changes before the lock left presets under other engines' ids.
    for (const [id, binding] of Object.entries(rt.state.adapterSessions ?? {})) {
      if (binding?.profileId !== profile.id) continue
      dropPump(id)
      rt.adapterMap.drop(id)
    }
    for (const [id, preset] of [...presets]) {
      if (!id.endsWith(`:${profile.id}`)) continue
      presets.delete(id)
      await preset.dispose()
    }
  }

  const executeClaim = async (args, exec) => {
    const entry = pumps.get(String(exec.agent?.id ?? ''))
    // No pump means the engine never entered the loop (the session's model is
    // not a Nodo role engine); say that instead of a cryptic missing action.
    if (!entry) return { status: 'error', detail: 'No engine is attached to this session; its model is not a Nodo role engine' }
    const claim = entry.pump.takeMirror()
    if (!claim) return { status: 'error', detail: 'No pending engine action for this session' }
    const abort = () => { void entry.pump.interrupt().catch(() => {}) }
    exec.signal?.addEventListener('abort', abort, { once: true })
    // The engine can settle the ask behind the card (it resolved the request
    // itself, or the turn ended): close the host card instead of eating a dead
    // click, and relay the engine's real outcome rather than a forced deny.
    try {
      if (exec.signal?.aborted) { abort(); return await claim.done }
      while (true) {
        const request = entry.pump.takeRequest(claim)
        if (!request) {
          const settled = await Promise.race([claim.done, claim.requested.then(() => null)])
          if (settled) return settled
          continue
        }
        const stale = new AbortController()
        const unwatch = entry.pump.watchRequestClose(request.id, () => stale.abort(new Error('This engine request is no longer active')))
        const signal = exec.signal ? AbortSignal.any([exec.signal, stale.signal]) : stale.signal
        try {
          if (signal.aborted) continue
          if (request.kind === 'question') {
            await entry.pump.respondQuestion(claim, await answerQuestions(ctx, request, { ...exec, signal }), request)
          } else {
            const decision = entry.permission === 'full' ? 'deny'
              : await decideApproval(ctx, { agent: exec.agent, toolName: String(request.tool ?? args.name), callId: exec.callId, reason: String(request.reason ?? args.brief ?? ''), signal })
            if (signal.aborted) continue
            if (await entry.pump.respondApproval(claim, decision, request) === false) {
              await new Promise(resolve => setTimeout(resolve, 300))
              if (stale.signal.aborted) continue
              if (await entry.pump.respondApproval(claim, decision, request) !== false) continue
              rt.warn?.('nodo: approval %s reply never reached the engine; interrupting the turn', request.id)
              abort()
              await claim.done
              return { status: 'error', detail: '审批应答未送达 Agent，本轮已中断——请重发任务继续。' }
            }
          }
        } catch (error) {
          if (stale.signal.aborted) continue
          abort()
          await claim.done
          return { status: 'error', detail: String(error?.message ?? error) }
        } finally { unwatch() }
      }
    } finally {
      exec.signal?.removeEventListener('abort', abort)
    }
  }

  const execute = async (args, exec) => {
    const result = await executeClaim(args, exec)
    if (!result.presentation) return result
    const conversationId = rt.adapterMap.of(String(exec.agent?.id))?.conversationId
    return { ...result, presentation: await rt.saveStreamRecord(conversationId, result.presentation) }
  }

  const compact = async (id, signal) => {
    const agent = ctx.agents.get(id)
    if (!agent) throw new Error('Native session is unavailable')
    // The agent's creation-time options can carry another engine's default
    // model; the live driver (or the session binding) is the engine-correct
    // source for what the current thread runs.
    const current = pumps.get(id)
    const entry = await ensurePump(id, current?.driver?.options?.model, current?.driver?.options?.thinking)
    if (entry.pump.active || entry.compaction) throw new Error('Stop or finish the task before compacting')
    if (typeof entry.driver.compact !== 'function') throw new Error('This engine has no compaction channel')
    signal?.throwIfAborted()
    let resolve, reject
    const done = new Promise((yes, no) => { resolve = yes; reject = no })
    done.catch(() => {})
    entry.compaction = { resolve, reject }
    const abort = () => { void entry.driver.interruptTurn().catch(reject) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await entry.driver.compact()
      await done
      signal?.throwIfAborted()
    } finally {
      signal?.removeEventListener('abort', abort)
      entry.compaction = null
    }
  }

  const models = async engine => {
    await rt.load()
    return rt.engineCatalogOf(engine)?.models ?? []
  }
  const resolved = async (provider, model) => {
    const item = (await models(provider.slice('nodo:'.length))).find(item => item.id === model)
    return { provider, id: model, name: item?.label ?? model, context: { contextWindow: CONTEXT_WINDOW },
      ...(item?.thinking?.length ? { reasoning: { efforts: item.thinking.map(level => ({ id: level.id, name: level.id })), defaultEffort: item.defaultThinking } } : {}) }
  }
  const adapterModels = async ({ sessionId }) => {
    await rt.load()
    const binding = rt.adapterMap.of(sessionId)
    if (!binding?.profileId) return null
    const provider = providerId(binding.engine)
    const catalog = await models(binding.engine)
    return {
      groups: [{ id: provider, name: `Nodo·${PROVIDER_NAMES[binding.engine]}`, models: await Promise.all(catalog.map(async item => {
        const info = await resolved(provider, item.id)
        return { id: item.id, name: info.name, ...(info.reasoning ? { reasoning: info.reasoning } : {}) }
      })) }],
      current: binding.selection ?? { provider, model: binding.model ?? catalog[0]?.id, ...(binding.thinking ? { reasoningEffort: binding.thinking } : {}) },
    }
  }
  const selectAdapterModel = async ({ sessionId, provider, model, reasoningEffort }) => {
    await rt.load()
    const binding = rt.adapterMap.of(sessionId)
    if (!binding?.profileId || provider !== providerId(binding.engine)) throw new Error('Select a model from this Nodo role’s engine')
    const { error } = await ctx.sessionController.resolveAgent(sessionId)
    if (error) throw new Error(error.message)
    if (!(await models(binding.engine)).some(item => item.id === model)) throw new Error('This engine does not offer the selected model')
    const pick = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
    const result = await modelSelection.run(sessionId, () => keepDeploymentDefault(() => ctx.sessionController.selectModel({ sessionId, ...pick })))
    rt.adapterMap.bind(sessionId, { selection: result.selected ?? pick })
    // The pick belongs to the conversation from now on: the next conversation on
    // this role starts here instead of the role card.
    const conversation = rt.conversationOf(binding.conversationId)?.session
    if (conversation) {
      conversation.model = model
      if (reasoningEffort) conversation.thinking = reasoningEffort
      else delete conversation.thinking
    }
    await rt.save()
    return adapterModels({ sessionId })
  }
  const loggedSelection = agent => {
    const event = agent?.session.snapshotEvents?.().findLast(event => event.type === 'model/selection' || event.type === 'request/header')
    return event?.type === 'model/selection' ? event.data : event?.data.header.config
  }
  const repairNativeSelection = async agent => {
    if (stopped || typeof ctx.sessionController?.modelCatalog !== 'function' || !ctx.agentDefaultModel) return
    const saved = ctx.agentDefaultModel.currentSelection()
    const picked = loggedSelection(agent) ?? saved
    const legacy = selection => selection?.provider?.startsWith('nodo:') || ADAPTER_ENGINES.includes(selection?.provider)
    if (!legacy(saved) && !legacy(picked)) return
    const { groups } = await ctx.sessionController.modelCatalog()
    if (stopped) return
    const native = selection => groups.some(group => group.id === selection?.provider)
    const group = groups.find(group => group.id === saved.provider) ?? groups[0]
    if (!group?.models.length) return
    const fallback = native(saved) ? saved : { provider: group.id, model: group.models[0].id }
    if (legacy(saved) && !native(saved)) await ctx.agentDefaultModel.saveSelection(fallback)
    if (agent && legacy(picked) && !native(picked)) await keepDeploymentDefault(() => ctx.sessionController.selectModel({ sessionId: agent.id, ...fallback }))
  }
  const adapter = {
    // dsh-llm keys providers by their full id and shows `name` as the group
    // label, so the Nodo groups read "Nodo·ZCode", distinct from native ones.
    providerInfo: provider => ({ id: provider, name: `Nodo·${PROVIDER_NAMES[provider.slice('nodo:'.length)] ?? provider}` }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async provider => {
      const binding = rt.adapterMap.of(modelSelection.getStore())
      if (!binding || provider !== providerId(binding.engine)) return []
      return (await models(binding.engine)).map(item => ({ provider, id: item.id, name: item.label ?? item.id }))
    },
    resolveModel: async (provider, model) => resolved(provider, model),
    async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: options => adapter.stream(options) } },
    async *stream(options) {
      if (options.purpose) { yield* createPump({ driver: {} }).stream(options); return }
      const signal = options.signal
      signal?.throwIfAborted()
      let abort
      try {
        const preparing = ensurePump(String(options.sessionId ?? ''), options.model, options.reasoningEffort, options.provider, signal)
        const entry = signal ? await Promise.race([preparing, new Promise((_, reject) => {
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })]) : await preparing
        signal?.throwIfAborted()
        yield* entry.pump.stream(options)
      } finally { if (abort) signal.removeEventListener('abort', abort) }
    },
  }
  const commands = async ({ engine, cwd }) => {
    await rt.driversReady()
    return rt.scanEngineCommands({ engine, cwd, engineOptions: rt.engineConfig(engine).engineOptions })
  }
  ctx.provide('nodoAdapter', { execute, compact, commands })
  rt.adapterWork = id => pumps.get(String(id))?.pump.status ?? null
  const registration = ctx.llm.registerAdapter(ADAPTER_ENGINES.map(providerId), adapter)
  ctx.on('agent/status', ({ agent, status }) => {
    const entry = pumps.get(String(agent.id))
    if (status !== 'running' && entry) void entry.pump.interrupt().catch(() => {})
    // ES-01 projection: identity once per session, then bounded unknown-event
    // counters — through the existing diagnostics ring, never raw payloads.
    for (const line of entry?.driver?.coverage?.drain?.() ?? []) rt.warn?.('%s', line)
  })
  ctx.on('agent/created', async ({ agent }) => {
    await rt.load()
    const binding = rt.adapterMap.of(agent.id)
    if (binding?.identity) installPersona(agent, binding.identity)
    if (binding?.profileId) {
      const picked = binding.selection ?? loggedSelection(agent)
      const model = picked?.model ?? binding.model ?? (await models(binding.engine))[0]?.id
      if (model) await selectAdapterModel({ sessionId: agent.id, provider: providerId(binding.engine), model,
        ...((picked?.reasoningEffort ?? binding.thinking) ? { reasoningEffort: picked?.reasoningEffort ?? binding.thinking } : {}) })
    } else await repairNativeSelection(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => { dropPump(String(agent.id)); personas.delete(String(agent.id)) })
  ctx.effect(() => async () => {
    stopped = true
    registration()
    for (const id of pumps.keys()) dropPump(id)
    await Promise.all([...presets.values()].map(entry => entry.dispose()))
    presets.clear()
  }, 'nodo: adapter registry')
  Object.assign(rt, { syncAdapterPreset, openAdapterSession, adapterModels,
    adapterSessionOf: conversationId => { const { profile, session } = rt.conversationOf(conversationId); return nativeSessionOf(profile, session) }, selectAdapterModel, refreshAdapterBindings, dropAdapterProfile,
    adapterBusy: session => { const agent = session.nativeSessionId && ctx.agents.get(session.nativeSessionId); return !!agent && agent.status !== 'idle' },
    initializeAdapters: async () => {
      await rt.load()
      // One role that cannot register its preset must not hold back the host's
      // boot: the others still need their sessions resumable.
      for (const profile of Object.values(rt.state.profiles)) {
        if (stopped) break
        try { await syncAdapterPreset(profile) } catch (error) { rt.warn('nodo: role "%s" has no agent preset this run: %s', profile?.name ?? profile?.id, error?.message ?? error) }
      }
      // A binding whose role is gone (deleted before the drop path existed)
      // would only re-register a ghost preset; sweep it before that.
      let swept = false
      for (const [id, binding] of Object.entries(rt.state.adapterSessions ?? {})) {
        if (!binding?.profileId || rt.state.profiles[binding.profileId]) continue
        dropPump(id)
        rt.adapterMap.drop(id)
        swept = true
      }
      if (swept) await rt.save().catch(() => {})
      // A binding can outlive its preset (roles edited before engines were
      // locked); re-registering keeps those native sessions resumable.
      for (const binding of Object.values(rt.state.adapterSessions ?? {})) {
        if (stopped || !binding?.preset || presets.has(binding.preset)) continue
        const profile = rt.state.profiles[binding.profileId ?? '']
        try {
          const dispose = await ctx.agentPresets.register({ id: binding.preset, name: profile?.name ?? binding.name ?? 'Nodo role', description: profile?.role ?? '',
            plugins: presetPlugins(binding.engine) })
          presets.set(binding.preset, { signature: binding.preset, dispose })
        } catch (error) {
          rt.warn('nodo: native session preset "%s" could not be restored: %s', binding.preset, error?.message ?? error)
        }
      }
      // Preset diagnostics can await the host loader, including this activation.
      void ctx.fiber.await().then(async () => { await repairNativeSelection(); await healOrphanedPresets() }).catch(error => {
        rt.warn('nodo: deleted-role session repair failed: %s', error?.message ?? error)
      })
    },
  })
}
