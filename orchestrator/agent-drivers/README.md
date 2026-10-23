# agent-drivers

One SPI, eight primitives, many coding-agent runtimes. Pure ESM JavaScript,
Node ≥ 20.3.0, covering the MCP dependency tree and native DSH's
[`AbortSignal.any`](https://nodejs.org/api/globals.html#static-method-abortsignalanysignals).
Codex shared connections use a host-provided `ws` library. Standalone consumers
must provide it in their own dependency tree; DSH's working-directory and profile
lookup remain fallbacks. This package does not install or bundle another copy.
The session identity MCP service uses the official `@modelcontextprotocol/sdk`
dependency. Run `npm install --ignore-scripts` for this standalone package, or
`npm ci --ignore-scripts` in the parent Nodo package.

The point of the package boundary: agent CLI protocols drift fast, so drivers
must be patchable and versionable independently of any orchestrator that
consumes them.

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for copyright information. Dependencies retain their own licenses.

## SPI

An adapter is a factory `create(options) → driver` where `options` carries
`onEvent` plus Agent settings (`bin`, `cwd`, `env`, `model`,
`driverSessionId`, `workspaceId`, `name`, `sessionName`, optional `nativeHost`, …).
The driver implements exactly:

| Primitive | Meaning |
|---|---|
| `openSession() → Promise` | register/reuse the native workspace and create/rejoin its session without sending a model prompt |
| `sendTurn(text, images?) → Promise<turnId>` | start a turn; `images` are `{mediaType, data}` base64 entries; rejects if one is running |
| `steer(text) → Promise<'steered'\|'refused'\|'indeterminate'>` | mid-turn redirect |
| `interruptTurn() → Promise<void>` | stop the running turn |
| `respondToRequest(id, {decision, value?, always?}) → Promise` | answer a `request/opened` (`allow` / `deny` / `answer`) |
| `onEvent(cb) → unsubscribe` | (registered via options in current adapters) |
| `hasSession() → boolean` | Agent holds a live/known conversation |
| `dispose()` | end the process and the turn |

Event shapes are documented in `src/spi.js`. See `../test/helpers/echo-driver.js` for a complete
reference implementation.

## Agents

- `codex` — connects through `codex app-server proxy` to the shared runtime.
  The proxy carries WebSocket frames, so `ws` handles the transport over its
  stdio duplex. `project/list` / `project/create` register the workspace;
  `thread/start` / `thread/metadata/update` persist the project assignment.
  `model/list` supplies the model catalog and each model's reasoning efforts,
  which `turn/start` then applies as `effort`; when the CLI cannot be reached the
  scan reads `model` / `model_reasoning_effort` from `~/.codex/config.toml`.
- `dsh` — inside Desktop/Web, uses the host's `workspaceRegistry` and
  `sessionController`, reusing the native agent and its writer. Standalone ACP
  is retained for direct-driver tests and explicitly configured non-native hosts.
  See [DSH setup and behavior](src/dsh/README.md).
- `zcode` — connects to `zcode app-server` (NDJSON stdio, strict envelopes).
  Its per-workspace session store is shared with the Desktop app, so sessions
  created here are native and resumable there. See
  [ZCode setup and behavior](src/zcode/README.md).

- `claude` — owns Claude Code's stream-JSON protocol and control requests.
- `qoder` — Qoder CLI over the same stream-JSON control protocol (wire 1.5.0),
  without partial messages or steering; models and slash commands come from the
  initialize response and sessions live in the shared Qoder store the desktop
  app reads. See [Qoder setup and behavior](src/qoder/README.md).
- `pi` — drives the pi CLI over its first-class RPC protocol (long-lived
  `pi --mode rpc` JSONL subprocess): native delta streaming, steering, abort
  and compaction commands; sessions live in the shared pi store. No native
  approvals exist, so permission cards are unsupported and project-local
  `.pi/` resources never load. See [pi setup and behavior](src/pi/README.md).
- `opencode` — uses the shared ACP core with OpenCode launch, model selection
  and form-question handling. Identity is supplied through process-level native
  agent prompts backed by a private identity version; no workspace files are added.
- `codebuddy` — CodeBuddy Code over the shared ACP core (`codebuddy --acp`), with
  its `mode` / `model` / `thought_level` config options, a permission-gated
  `AskUserQuestion` and answers returned outside the ACP reply. Identity uses
  `--append-system-prompt` in native mode; usage and file changes are not reported by the Agent. See
  [CodeBuddy setup and behavior](src/codebuddy/README.md).

File-based adapters accept an optional `identityFiles` service and `identityOwner`.
Import the storage factory with `import { createIdentityFiles } from 'agent-drivers'`.
`createIdentityFiles(root)` stores complete, immutable content versions and session
references outside the workspace. Identical content shares one file across Agents;
disposing a driver leaves shared versions intact. The host retains archived-session
references and collects unreferenced versions after profile deletion. Without this
service, standalone adapters use temporary files. ZCode owns its version-specific
MCP discovery and configuration checks separately from this reusable file service.

Each Agent owns one folder. The registry, SPI, executable helpers and JSON-RPC
transport stay shared. OpenCode, CodeBuddy and standalone DSH reuse the
[ACP runtime](src/acp/README.md); DSH's owning native controller stays separate.

Future Agents are separate adapters. A CLI installation alone does not supply
its protocol adapter; register it after implementing and validating the SPI.

## Adding an Agent

Follow the [Agent intake and capability-extension workflow](ENGINE_INTAKE.md):
route A adds an Agent; route B extends an existing Agent. Both use one checklist
and `npm run verify:engine -- --engine <id> --route <new|capability>` from the
parent package (`capability` requires `--capability <scope>`). Automated checks
use fixtures; real CLI, model and Desktop acceptance belongs to the project maintainer.
Protocol fixtures, installed-CLI checks and native integration evidence have
different scopes; keep their results separate.

Registration also owns `name`, `adapter`, `shared` and optional `tests` metadata
for host routes, client display names and verification selection. See the workflow
for field meanings. Optional SVG assets are discovered by the client build.

Add one Agent folder with an `index.js` entry, and a registry entry in `src/index.js` with:

- `info`: serializable `id`, `label`, `description`, `requiresCwd`, optional
  executable `command`, `capabilities`, and `fields`.
- `create(options)`: the eight driver primitives above.
- `validate(engineOptions)`: reject unsupported/invalid options before saving;
  return a normalized plain object.
- `check(config)`: installation/protocol/auth diagnostics without a model task, returning
  `{ engine, ok, checks: [{ label, ok, message }], executable?, version? }`.
  An individual check may use `ok: null` for a fact the protocol cannot verify;
  the UI displays that row as informational. DSH boot may initialize its ACP
  profile in the selected home, even during a protocol check.
- `scan(config)` (optional): the models this machine offers and the thinking
  levels each accepts, returning `{ source, defaultModel?, models: [{ id, label?,
  group?, defaultThinking?, thinking: [{ id, label? }] }] }`. `source` names what
  answered, so an empty list can be explained. Read it from the Agent's own
  protocol when it has one and fall back to the CLI's local configuration file;
  never guess a model list. A scan may start a short-lived session, but must end
  it. `id` is whatever the Agent accepts back as the profile `model` value, and
  a thinking level id is what `create(options).thinking` receives. `label`, when
  present, is the display name the pickers show — the model's own name, with the
  provider left inside `id` — so one list row stays a model name rather than a
  route. `group`, when present, is the display name of the provider the model
  belongs to; the pickers show it as the section above that provider's models,
  which is how a name-only row still says whose model it is. List one provider's
  models together, and omit `group` when the Agent has a single source.

## Native session contract

The host owns role → many sessions, active selection, transcripts, queue/stop
state and automatic filesystem workspace creation. Each session has its own
driver instance and persistent native id; a new window must not inherit another
window's native id. Role briefs are sent once per conversation, even when an
empty native draft was created earlier.

`openSession` must reuse/register the native application's workspace and attach
the native session to it. Emit `session:ready` with native `sessionId` and
`workspaceId`. A filesystem `cwd` alone does not establish native UI membership.
An adapter must use the native runtime's owning controller/shared server; opening
another writer against the same files is not a shared-session implementation.
If the application offers no such interface, reject the connection explicitly.

Before adding an Agent, verify first-dialogue workspace creation/reuse, two
turns on one native id, two independent sessions under one workspace, reconnect,
and a native observer connected during the second turn. Passing the eight
method-name checks alone is not evidence that the Agent meets this contract.

An existing session owned by another runtime must never be forcefully taken
over, copied, replaced or have its writer killed automatically. For Codex, every
simultaneous client must connect to the same shared app-server; a Desktop still
using an independent private stdio server remains a separate writer.

A field has `name`, `target` (`profile` or `engineOptions`), `label`, `type`
(`text` or `select`), optional `placeholder`/`default`, and select `choices`
(`{ value, label }`). Use `engineOptions` for adapter-specific settings;
the current `profile` field target supports `model` and `thinking`. The host's `engine-catalog` API delivers this metadata to
the common form together with the cached `scan` result, which turns the `model`
field into a catalog select and adds the thinking-level select under it;
`engine-check` delegates to the adapter. Existing `engines`
still returns ids. Common profile fields and driver-session persistence stay
host-owned. Credentials never belong in field metadata or diagnostics.

`src/json-rpc-process.js` provides bounded request timeouts, process disposal,
and stdio response/notification/request routing for JSONL protocols;
`src/cli.js` provides executable discovery and absolute workspace validation.
ACP consumers reuse `src/acp/core.js` for session flow and standard event/request
mapping. Agent modules keep launch, configuration and verified compatibility
differences. Other protocols keep their translations in each adapter.

## Probe

`probeSpawn()` checks whether the host allows spawning child processes at all —
the first thing an orchestrator should show about its environment.
