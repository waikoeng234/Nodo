const SANDBOXES = { plan: 'read-only', workspace: 'workspace-write', full: 'danger-full-access' }

export function nativeDshPermissions(host) {
  const service = host?.get?.('permissionPresets')
  if (typeof service?.resolve !== 'function' || typeof service?.set !== 'function') return {}
  return Object.fromEntries(Object.entries(SANDBOXES).flatMap(([tier, sandbox]) => {
    const preset = service.names.find(name => {
      const spec = service.resolve(name)
      return spec.sandbox === sandbox && (tier !== 'full' || spec.approval === 'never')
    })
    return preset ? [[tier, preset]] : []
  }))
}

export function nativeDshCompaction(host) {
  const presets = host?.get?.('agentPresets')
  if (typeof presets?.serviceFor !== 'function') return host?.get?.('compaction')
  return {
    compactNow(agent, signal) {
      const service = presets.serviceFor(agent, 'compaction')
      if (typeof service?.compactNow !== 'function') throw new Error('This DSH session preset has no native compaction service')
      return service.compactNow(agent, signal)
    },
  }
}
