// Mirror tool for the adapter route: the single host-side shell `engine_action`
// (handoff §3.2). The pump emits it as the model's tool-call; the host registry
// executes it, and the body only waits for the engine outcome — the host never
// runs anything on the engine's behalf. presentationMeta stays the style
// upgrade hook for the native tool card.
import { STREAM_VIEW_SCHEMA } from '../stream-records.js'

export const MIRROR_TOOL_NAME = 'engine_action'

export function registerMirrorTool(ctx, execute) {
  return ctx.tools.register({
    name: MIRROR_TOOL_NAME,
    description: 'Reports one action performed by the external engine behind this session and waits until that action settles. Never call it yourself; it arrives only as a relay of the engine.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'What the engine is doing, e.g. commandExecution, fileChange, or an approval ask.' },
        name: { type: 'string', description: 'Engine-side tool or item name.' },
        brief: { type: 'string', description: 'Short human-readable summary of the action.' },
        input: { type: 'string', description: 'Input supplied to the engine-side tool.' },
        parentCallId: { type: 'string', description: 'Engine-side parent call id, only when the source names one.' },
        presentation: STREAM_VIEW_SCHEMA,
      },
      required: ['kind', 'name'],
      additionalProperties: false,
    },
    presentCall: args => args.presentation?.version === 1 && args.presentation.body.command
      ? { card: 'terminal', title: args.presentation.body.command, cwd: args.presentation.body.cwd }
      : ({ card: 'generic', title: args.brief ? `${args.name}: ${args.brief}` : args.name,
      kind: ({ read: 'read', write: 'edit', edit: 'edit', bash: 'execute', glob: 'search', grep: 'search' })[String(args.name).toLowerCase()] ?? 'other',
      ...(args.input ? { rawInput: args.input } : {}) }),
    presentResult: (_args, result) => {
      const record = result.meta?.nodoRecord
      if (record?.version !== 1) return undefined
      if (record.body.command) return { card: 'terminal', title: record.body.command, output: record.body.outputText,
        ...(record.body.exitCode !== undefined ? { exitCode: record.body.exitCode } : {}), ...(record.body.signal ? { signal: record.body.signal } : {}) }
      if (record.status === 'done' && record.body.diffs?.length) return { card: 'diff', diffs: record.body.diffs }
      return { card: 'generic', title: `${record.title} · ${record.status}` }
    },
    output: {
      schema: {
        type: 'object',
        properties: { status: { type: 'string' }, detail: { type: 'string' }, presentation: STREAM_VIEW_SCHEMA },
        required: ['status'],
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: `${args.name}: ${value?.status ?? 'done'}${value?.detail ? ` — ${value.detail}` : ''}` }],
      presentationMeta: (args, value) => ({ engine: true, kind: args.kind, name: args.name, status: value?.status ?? 'done',
        ...(value?.presentation ? { nodoRecord: value.presentation } : {}) }),
    },
    execute: (args, exec) => execute(args, exec),
  })
}
