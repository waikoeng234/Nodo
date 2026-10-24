import { cleanModel, cleanThinking } from './profiles.js'

export function install(rt) {
  const engineConfig = engine => rt.state.prefs.engineConfigs?.[engine] ?? { engineOptions: {} }
  const saveEngineConfig = async ({ engine, model, thinking, engineOptions }) => {
    await rt.load()
    await rt.driversReady()
    const config = { model: cleanModel(model), thinking: cleanThinking(thinking), engineOptions: rt.validateEngineOptions(engine, engineOptions) }
    rt.state.prefs.engineConfigs ??= {}
    rt.state.prefs.engineConfigs[engine] = config
    await rt.save()
    return config
  }

  // The scanned model list of one engine (agent-drivers scanEngine). It lives in
  // state.engineCatalogs, not in prefs: it travels only to the settings page
  // through engine-catalog, never with the polled state. A list written in an
  // older shape is not served: the page scans again instead of showing labels
  // this build no longer writes.
  const CATALOG_FORMAT = 3
  const engineCatalogOf = (engine) => {
    const cached = rt.state.engineCatalogs?.[engine]
    return cached?.format === CATALOG_FORMAT ? cached : null
  }
  // Scanned on demand: the page scans an engine with no cached list once, and the
  // button re-scans after a CLI, its configuration or its login changed.
  const scanEngineCatalog = async engine => {
    await rt.load()
    await rt.driversReady()
    const defaults = engineConfig(engine)
    const catalog = await rt.scanEngineModels({ engine, engineOptions: defaults.engineOptions, cwd: rt.workspacesView()[0]?.cwd ?? rt.home })
    rt.state.engineCatalogs ??= {}
    rt.state.engineCatalogs[engine] = { ...catalog, format: CATALOG_FORMAT, at: Date.now() }
    await rt.save()
    return rt.state.engineCatalogs[engine]
  }
  // What the settings page sees: field metadata plus the cached catalog. Only
  // engines usable on this machine are listed — the CLI was detected, the user
  // pinned an absolute path in bin, or the engine runs on the host itself.
  const engineCatalogView = () => rt.engineCatalog()
    .filter(info => info.executable || info.nativeRuntime || engineConfig(info.id).engineOptions?.bin)
    .map(info => ({ ...info, catalog: engineCatalogOf(info.id) }))

  // The full registry with local detection, for the settings page's detected /
  // undetected groups; usable mirrors engineCatalogView's filter.
  const engineDetectView = () => rt.engineCatalog().map(info => ({
    ...info,
    catalog: engineCatalogOf(info.id),
    usable: !!(info.executable || info.nativeRuntime || engineConfig(info.id).engineOptions?.bin),
  }))

  // First-run onboarding: the chosen engine set drives the role dialog; an empty
  // or missing list only marks onboarding done and keeps every usable engine.
  const saveEngineEnables = async ({ engines } = {}) => {
    await rt.load()
    await rt.driversReady()
    const known = new Set(rt.listEngines())
    const chosen = [...new Set((Array.isArray(engines) ? engines : []).map(String))].filter(id => known.has(id))
    if (chosen.length > 0) rt.state.prefs.enabledEngines = chosen
    rt.state.prefs.onboardedAt = Date.now()
    await rt.save()
    return { enabledEngines: rt.state.prefs.enabledEngines ?? null, onboardedAt: rt.state.prefs.onboardedAt }
  }

  Object.assign(rt, { engineConfig, saveEngineConfig, engineCatalogOf, scanEngineCatalog, engineCatalogView, engineDetectView, saveEngineEnables })
}
