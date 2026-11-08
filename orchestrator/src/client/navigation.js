let navigationSnapshot
const navigationListeners = new Set()

export const readNavigation = () => {
  if (navigationSnapshot === undefined) {
    try {
      navigationSnapshot = JSON.parse(localStorage.getItem('nodo.navigation') ?? localStorage.getItem('orchestrator.navigation')) ?? {}
    } catch { navigationSnapshot = {} }
  }
  return navigationSnapshot
}

export const subscribeNavigation = listener => { navigationListeners.add(listener); return () => navigationListeners.delete(listener) }

export const setNavigation = update => {
  navigationSnapshot = typeof update === 'function' ? update(readNavigation()) : update
  try { localStorage.setItem('nodo.navigation', JSON.stringify(navigationSnapshot)) } catch {}
  for (const listener of navigationListeners) listener()
}
