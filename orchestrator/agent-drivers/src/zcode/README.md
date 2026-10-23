# ZCode driver

This folder owns ZCode discovery/model parsing (`native.js`), the
ZCode-Protocol-to-SPI adapter (`index.js`) and model discovery (`catalog.js`).
It uses the shared JSON-RPC process transport and the official MCP SDK for its
session identity service. It launches the installed ZCode CLI
with `zcode app-server` (stdio, NDJSON, no `jsonrpc` field).

ZCode has no ACP and no daemon/proxy subcommand. The native shared runtime is
the protocol itself plus the per-workspace session store under `~/.zcode/cli`:
every `zcode app-server` process — including the Desktop app's own runtime —
sees and resumes the same sessions. Sessions created here therefore appear in
the ZCode app and can be continued there. Do not drive the same session from
both sides at once; the "already running" guard is per process.

## Setup

Choose **ZCode CLI** in the profile form and enter an existing absolute working
directory. Optional Agent settings:

- `bin`: ZCode executable path or command. Discovery searches PATH first, then
  the macOS app bundle (`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`
  and the per-user `~/Applications` copy). Set a path to pin an installation.
- `model` (common profile field): blank uses the ZCode app's own settings. An
  override uses ZCode's picker format `providerId$modelId` (ids may contain
  `/`, so `$` is the separator), or an equivalent JSON object. It is applied
  with `session/setModel` after create/resume.
- `thinking` (common profile field): one of the model's thought levels
  (`disabled`, `low`, `medium`, `high`, `xhigh`, `max`, `none`, `minimal`,
  `enabled` — the set is per model). It is sent as the selection's
  `options.reasoningLevel`, which ZCode requires for an object-form model
  selection; without a model override it is applied with
  `session/setThoughtLevel`.

Credentials come from the existing ZCode login; the adapter never supplies API
keys. Profile-selected secrets are injected through the existing host seam.
The autonomy tier rides the Agent mode: `plan` stays `plan`, `full` is `yolo`,
`workspace` is `guarded` (edits and ordinary commands run; only the Agent's
recognized-dangerous commands ask), and an unset tier keeps `build` (every
change asks). The protocol has no channel for allowedTools or
autoApproveHighRisk — those come from the Agent's own configuration only.

When `instructions` is supplied, create and resume include a `nodo_role` MCP
server with session isolation. The stdio service receives the bound identity file
path through its environment, publishes MCP initialization instructions and a
read-only `get_role` tool, and cannot select or edit another role. This does not
change global or workspace MCP configuration. The Agent owns the service's
process lifetime. Only an explicit unknown-field error for `mcpServers` retries
without that field; other errors propagate with the original permissions intact.

On the verified ZCode 0.16.9 and 0.17.0, the role service includes the complete
identity in the get_role tool description. ZCode supplies this as a model tool
schema on every primary request, including after compaction and process resume.
This is `instructionTarget: 'tool-schema'`, not a system message. It does not
require the model to call get_role first; the tool result is a separate recovery
aid. MCP initialization instructions remain available to other clients but these
CLI versions do not consume them.

The service reads an immutable file, and records its content hash when the
Agent requests tools/list. Each CLI connection gets a fresh receipt path;
the adapter exposes `instructionMode: 'native'` only for a verified version
with a matching discovered catalog. Unknown versions, unsupported MCP fields
or missing catalog discovery run the session without role identity.
Catalog discovery alone is not a general proof of system injection: the target
and exact wire behavior are verified separately by the real CLI probe.

HOME, USERPROFILE, shell startup, user instructions, plugins, credentials and
storage locations are unchanged. Because the protocol's mcpServers replaces
configured servers, mcp.js carries forward representable user-level server
definitions in memory before appending the session role service. It writes no
copies of those settings. Project MCP configuration, unsupported server fields
such as cwd, disabled MCP or a reserved-name conflict leave the original MCP
configuration alone and run without role identity instead of dropping options.

Nodo stores full role content by hash under its own identities/versions,
shared with other file-based Agents. Sessions pin references; only temporary
discovery receipts are cleaned on disposal. Shared versions survive driver
restarts and archived sessions keep their references.

ZCode 0.16.9 does not persist a blank runtime before the first task, even when
create uses `persistence: "immediate"`. Nodo passes `allowEmptyResume` only for
sessions explicitly marked `briefSent: false` without a recorded `lastTurn`.
With that authorization, an exact native `-32004` missing-session error creates
a replacement blank runtime with the same mode and MCP configuration. The
plugin session and identity snapshot remain; only the native id changes. The
driver revokes this permission after one replacement, any send attempt, or
restoring existing messages. Without authorization, missing sessions still fail;
storage, connection and authentication errors never create replacements.

**Check environment** verifies workspace, CLI version, `runtime/capabilities`
and a read-only `session/list`. It never creates a session, so the shared store
stays untouched. The protocol has no credential-status query; the model route
is reported as unverified until a real conversation.

**Model scan** reads `settings.model.available` from a `session/create` snapshot:
ZCode has no model-list method, and only create/resume return the full catalog.
Each entry carries its own `reasoning.levels` and `defaultLevel`, so no second
call is needed; the scan closes that session before returning. The snapshot also
names the current and last used model, which becomes the reported default.

## Behavior

ZCode Protocol v1, newline-delimited JSON with strict envelopes:

| SPI / event | ZCode Protocol |
|---|---|
| startup | no handshake; transport answers once storage is ready |
| conversation | `session/create` `{workspace, mode:"build"}`; save `session.sessionId` |
| resume | `session/resume`; an unknown saved id fails explicitly |
| `openSession` | create/resume + `session/subscribe` (`desktop-continuous`) |
| `sendTurn` | `session/send` `{sessionId, content, attachments?}`; images go as `kind:"image"` attachments; accepted reply ends the call |
| assistant text / thinking | `session/event` → `model.streaming` `text_delta` / `reasoning_delta` |
| final text | `turn.completed` `response`, emitted only if nothing streamed |
| tools | `model.streaming` `tool_input_start` opens a visible tool row while arguments are generated; `tool_input_delta` appends the input character stream; `tool_call` supplies the final input; `tool.updated` scheduled/started and result/error supply call identity, input and output; `tool.updated` progress supplies elapsed/tail/byte snapshots; batch notifications do not create calls |
| usage | `turn.completed` `usage` (provider token counts, cache buckets included) and `cacheStats`; `session.updated` `contextUsage` `{used,size}` is the context occupancy |
| `turn/end` | `turn.completed` `resultType`: `success` → done, `cancelled` → interrupted, `error_*` → error, `response` as `text`; `turn.failed` errors |
| `interruptTurn` | `session/stop`; cancelled completion ends the turn |
| permission | server request `interaction/requestPermission`; reply `{decision:"allow"\|"deny"}` |
| question | server request `interaction/requestUserInput`; reply `{action:"accept", content:{answers:{[question]:text}}}` |
| stale cards | `permission.resolved` / `userInput.resolved` events close them |

The host drains all pending permission and question requests while waiting for
a tool result, including parallel requests that must resolve before that tool
can finish. Request-close watchers attach when each card is opened, including
asks arriving after a tool started. Concurrent stop signals share one stop.

After 30 seconds without session events, a read-only `session/read` check asks
for the runtime state (10-second deadline, one index message). An active turn
remains running and emits a connection/status note; silence alone is not a
failure. An idle runtime without a completion event reports an error. An
unresponsive connection is closed with an explicit failure. Unsupported reads
disable the check for that turn. Network retry metadata becomes a progress note;
terminal errors are preserved across mirror-tool continuation boundaries.
If the runtime still lists an already answered request after a silent interval,
the adapter reports the missing acknowledgement and closes the connection.

Steer uses the public `v4/command` envelope with `type: "sendText"` and
`payload: {text, requestedDelivery: "guide"}`. Legacy `session/send` still rejects
concurrent prompts. V4 may inject at a tool boundary or fall back to its own
queue; an accepted `inputAccepted` acknowledgement transfers delivery to the
Agent. The driver waits for matching `turn.steerDrained` inputs or the queued
turn's `turn.completed.inputId` before completing the host activity, summing
usage across Agent turns. Stop uses V4 `stop` to hold queued inputs. Older
servers or rejected commands return refused, leaving the host to queue.
`session/requestRuntimePreferences` is
refused (-32601), which selects the server's documented defaults; MCP auth
header requests receive empty headers, keeping the protocol flowing. Server
requests without an active turn are refused. `session/close` is never sent —
disposing only ends the process, leaving the native session in the store.

`session/compact` can acknowledge acceptance before compression finishes. The
adapter waits for that session's `turn.completed` / `turn.failed` and rejects new
turns or repeated compaction until then. Process loss or a failed compression
rejects the pending operation.

The protocol is internal to ZCode (Desktop ↔ CLI) and undocumented; the check
reports the CLI version and the fixture tests pin the wire behavior. Session
titles come from the first input and cannot be renamed through the protocol.

## Verification

`npm test` includes a strict executable fixture covering NDJSON envelopes,
create-time runtime-preference refusals, subscriptions, streamed and
non-streamed replies, multi-message separation, tool events, usage, permission
allow/deny, question answers, interrupt, resume, stale-session rejection,
model selection and a task outliving the handshake timeout.

Run `node scripts/check-zcode.mjs [absolute-zcode-path]` from `orchestrator/`
for the opt-in real CLI check. It is read-only and creates no session.

Run `node scripts/check-zcode-flow.mjs [absolute-zcode-path]` for the isolated
real-CLI flow check through the Nodo adapter registry and pump. It uses a
temporary HOME/workspace and a local mock model to verify file tools, multiple
approvals, a retried request, cancellation, same-session recovery and terminal
failure. It makes no paid model calls and removes its temporary session store.

Run `node scripts/check-zcode-identity.mjs /absolute/path/to/zcode.cjs` for the
opt-in identity check. It runs the installed CLI with a temporary HOME, dummy
provider settings and a local mock model, without real login data or remote
model requests. It uses no runtime preload or source patch. On 2026-10-15,
ZCode 0.16.9 passed actual-request checks for consecutive turns, manual
compaction, automatic compaction between a tool call and continuation in one
turn, cross-process resume and concurrent roles. Each primary request contained
its own identity exactly once in the tool schemas, including a Chinese identity
over 100 KiB, and no identity in message history. Original MCP tools, global
rules, the session database and shell HOME stayed available. On 2026-10-19,
ZCode 0.17.0 (bundled with Desktop 3.16.2) passed the same checks; its
app-server surface differs from 0.16.9 only by the added `provider/refreshRegistry`
method and the `historyFirst` subscribe option. Model obedience, Windows, future
releases and configurations that cannot be represented by session MCP parameters
remain outside that verification.

On 2026-10-13, the installed ZCode CLI `0.16.9` passed a live probe: create,
subscribe, a real model turn with streamed deltas and usage, `session/stop`
mid-stream (`resultType: "cancelled"`), and resume from a second process. The
live permission round trip through this adapter passed in `build` mode: an
allowed Write tool created the requested file; a denied Bash call left the
workspace untouched while the turn finished gracefully. Desktop UI interaction
and long unattended approval flows remain unverified.

The wire-level reply schemas were corrected against the CLI internals on the
same day: permission results are `{decision}` (an `{optionId}` reply passes
`{decision:"deny"}` fallbacks instead), and question results are
`{action:"accept", content:{answers}}`.
