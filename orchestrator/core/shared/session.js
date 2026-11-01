// The engine-side conversation id of a plugin session. Only the DSH engine
// runs inside the host and carries a native twin; every other engine's id is
// the plugin's own.
export const nativeIdOf = session => session?.engine === 'dsh' ? session.driverSessionId : undefined
