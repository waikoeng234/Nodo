export const inject = ['nodoAdapter']

export function apply(ctx, { engine }) {
  const list = async ({ cwd, signal } = {}) => {
    signal?.throwIfAborted()
    const scan = await ctx.nodoAdapter.commands({ engine, cwd })
    signal?.throwIfAborted()
    return scan.commands.map(command => ({
      name: command.id,
      description: command.description ?? command.id,
      ...(command.path ? { path: command.path } : {}),
      source: scan.source,
      provider: `nodo:${engine}`,
      invocation: { userInvocable: true, modelInvocable: true },
    }))
  }
  // The native menu discovers names here; the engine loads and executes them.
  ctx.provide('skills', { list, snapshot: async options => ({ skills: await list(options), complete: true }), get: async () => undefined })
}
