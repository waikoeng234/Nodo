import { MIRROR_TOOL_NAME, registerMirrorTool } from './mirror-tools.js'

export const inject = ['tools', 'commands', 'nodoAdapter']

export function apply(ctx) {
  registerMirrorTool(ctx, (args, exec) => ctx.nodoAdapter.execute(args, exec))
  ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ allow: [MIRROR_TOOL_NAME] }) })
  ctx.commands.register({
    definitionId: '@deepseek-ai/dsh-command-compact',
    name: 'compact',
    description: 'Compact the external engine context',
    async handler({ agent, signal, rawInput }) {
      if (rawInput.trim()) return { kind: 'error', text: 'Usage: /compact (no arguments)' }
      try {
        await agent.runMaintenance(cancel => ctx.nodoAdapter.compact(agent.id, AbortSignal.any([signal, cancel])))
        return { kind: 'success', text: 'Engine context compaction completed.' }
      } catch (error) {
        return { kind: 'error', text: signal.aborted ? 'Compaction cancelled.' : error.message }
      }
    },
  })
}
