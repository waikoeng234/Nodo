function createCompletionTracker(storage, events) {
  const key = 'nodo.completions.seen'
  const read = () => {
    try {
      const value = JSON.parse(storage.getItem(key))
      return Object.fromEntries(Object.entries(value ?? {}).filter(([, at]) => Number.isFinite(at)))
    } catch { return {} }
  }
  let snapshot = read()
  const listeners = new Set()
  const notify = () => { for (const listener of listeners) listener() }
  const changed = event => { if (event.key === key || event.key === null) { snapshot = read(); notify() } }
  events.addEventListener?.('storage', changed)
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    mark(id, at) {
      if (!Number.isFinite(at) || (snapshot[id] ?? -1) >= at) return
      const latest = read()
      for (const [id, at] of Object.entries(snapshot)) latest[id] = Math.max(latest[id] ?? -1, at)
      latest[id] = Math.max(latest[id] ?? -1, at)
      snapshot = latest
      try { storage.setItem(key, JSON.stringify(snapshot)) } catch {}
      notify()
    },
    dispose() { events.removeEventListener?.('storage', changed); listeners.clear() },
  }
}
