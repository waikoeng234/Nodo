// Persistent native-session → engine-thread mapping for the LLM adapter route
// (.agent/context/native-adapter-handoff.md §3.2). Lives in plugin state so a
// host restart cold-resumes the same engine thread via the driver's resume.
export function install(rt) {
  const table = () => {
    if (rt.state.adapterSessions === null || typeof rt.state.adapterSessions !== 'object' || Array.isArray(rt.state.adapterSessions)) rt.state.adapterSessions = {}
    return rt.state.adapterSessions
  }
  Object.assign(rt, {
    adapterMap: {
      of: id => table()[id] ?? null,
      set: (id, threadId) => { table()[id] = { ...table()[id], threadId, at: Date.now() } },
      bind: (id, binding) => { table()[id] = { ...table()[id], ...binding, at: Date.now() } },
      drop: id => { delete table()[id] },
    },
  })
}
