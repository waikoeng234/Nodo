# Shared ACP runtime

`createAcpDriver(options, support)` translates ACP v1 into the existing eight
SPI primitives. It owns startup, capability-aware new/load/resume, live updates,
prompt completion, requests, cancellation, reconnect and disposal. Transport
stays in `../json-rpc-process.ts`; Agent configuration stays in each Agent
folder. This helper is internal and does not register arbitrary CLI commands.

`options` supplies `cwd`, `onEvent` and the Agent-native `driverSessionId`.
`support` supplies:

| Field | Purpose |
|---|---|
| `id`, `label` | Agent identity for events and diagnostics |
| `connect(callbacks)` | Return a JSON-RPC peer connected to the correct runtime |
| `initialize(peer)` | Optional handshake customization; return agent capabilities |
| `configure({peer, sessionId, attached})` | Optional model/settings or native integration after attachment, before prompting |
| `resumeMethod: 'load'` | Prefer advertised load over resume for a verified Agent-specific behavior |
| `savedId(id)` | Optional persisted-id mapping owned by the Agent |
| `instructionMode` | `native` only when the Agent has installed instructions; otherwise `none` (no role identity) |
| `thoughts: false` | Preserve Agents that do not publish reasoning through ACP |
| `stopReason(stop)` | Optional Agent-specific done/error mapping; cancellation stays interrupted |
| `error(error)` | Optional safe Agent-specific error translation |
| `question({method, params})` | Optional question translation returning `{card, answer(value)}` |
| `dispose()` | Release Agent-owned resources after closing the connection |

`initializeAcp(peer, clientCapabilities?, clientInfo?)` validates the negotiated
version and returns advertised capabilities. Saved sessions require advertised
load/resume support and retain their identity even when the resume result omits
`sessionId`. Unsupported restoration never creates a replacement session.

Only updates from the current session after prompting are emitted. Explicit
replay updates are dropped. Tool lifecycles are scoped to one turn and permission
request ids retain their numeric/string distinction. Allow-once never selects an
allow-always option implicitly. Unanswered requests are cancelled on stop/dispose;
an unacknowledged session cancel closes this driver's connection after five seconds.
With a shared-runtime proxy, its disposal must close the proxy, not the shared owner.

`formElicitation` in `elicitation.ts` preserves OpenCode's form translation and
free-text `*_custom` fields. Agents opt in by advertising form capability and
supplying that translator; unsupported requests receive an error.

The helper does not infer native workspace membership or shared execution from
`cwd`, a saved id or successful initialization. A new consumer must still follow
[`ENGINE_INTAKE.md`](../../ENGINE_INTAKE.md) and provide real native evidence.
