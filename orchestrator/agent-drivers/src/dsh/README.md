# DeepSeek Harness driver

This folder owns DSH configuration/discovery (`config.ts`), native controller
integration (`native.ts`), ACP-specific configuration (`index.ts`), session
storage (`storage.ts`), safe errors (`errors.ts`) and model discovery (`catalog.ts`).
Desktop/Web uses the host's `workspaceRegistry` and `sessionController`, including
the native agent and its writer. Standalone ACP reuses `../acp/core.ts` and the
shared JSON-RPC transport. It launches an installed CLI with `dsh --profile acp`;
custom profiles must also expose ACP on stdio. No dependencies are added.
The ACP route retains standard diff blocks from confirmed editing tools; the
native route continues to use the host's workspaceChanges service.

## Intake result (2026-10-14)

| Investigation | Result / evidence |
|---|---|
| Installed CLI | `0.2.0-rc.2`, `/usr/local/bin/dsh` |
| ACP connection | Independent subprocess; existing isolated storage and id mapping retained |
| Native connection | Owning Web host controller, not a second ACP writer |
| Native membership | Real `session/list` discovers the plugin-created session |
| Live observation | Independent `session/follow` client receives turn start, assistant message and turn end during the second turn |
| Workspace/session continuity | Real Web host reuses one workspace for two independent sessions; restart retains both ids and the workspace |
| ACP continuity/cancel | Real installed CLI, local mock provider: two turns, cancel and persisted resume passed |
| Model/interaction boundaries | Selection, effort, permission and question mappings tested with fixtures; production-model calls and real tool approvals not run |
| Visual Desktop UI | Not run; native API observation was verified separately |

Follow [ENGINE_INTAKE.md](../../ENGINE_INTAKE.md) for future Agents. DSH validates
the shared ACP core as its second consumer, but its standalone ACP process is
not promoted to a shared-native interface. The native controller route retains
the stronger integration contract.

## Setup

Choose **DeepSeek Harness CLI** in the profile form and enter an existing
absolute working directory. Optional Agent settings:

- `bin`: dsh executable path or command. Discovery searches PATH and ordinary
  local CLI locations, then existing `~/.npm/_npx/*/node_modules/.bin/dsh`
  installations whose package manifest identifies `@deepseek-ai/dsh`.
  It never runs npx or installs packages. Set a path to pin a particular version.
- `profile`: DSH profile name, default `acp`; it must expose ACP stdio.
- `home`: absolute DSH data directory. Blank inherits `DSH_HOME` / `~/.dsh`;
  use a separate home for isolated configuration and tests. DSH may initialize
  the selected profile on first boot, including during an environment check.
- `model` (common profile field): blank uses the ACP profile's existing model.
  An override must match an advertised ACP selector value or unique display
  name. DSH selector values commonly encode `["provider","model"]`; use the
  exact value from your installed DSH catalog, not a guessed model identifier.
- `thinking` (common profile field): a DSH reasoning-effort id (`off`, `low`,
  `high`, `max` for the DeepSeek adapter; pi-ai routes bring their own ids).
  It is applied after the model, because DSH rebuilds the effort list for the
  selected route, and a level the model does not list is rejected.

Credentials and provider configuration are handled by DSH. Profile-selected
secrets are injected into the child environment through the existing host seam.
No credentials or account payloads are returned by the environment check.

New Nodo profiles put sessions under
`<nodo-home>/agents/<profile-id>/dsh/sessions`, using a CLI `--patch`
overlay for `session-persistence-jsonl.root`. DSH home still supplies the model
and credential configuration. Desktop does not discover or upgrade these agent
logs. Saved driver ids use the opaque prefix `dsh:isolated:` to retain that
location across restarts. Hosts pass a stable absolute `storageDir` for each
profile; standalone drivers without it retain the existing DSH storage behavior.

Existing unprefixed session ids keep their original location; no data is moved,
downgraded or replaced automatically. A CLI unable to read a newer saved format
reports the versions and failed ACP method. Continuing that session requires a
compatible CLI, or an explicitly approved recovery from a retained older snapshot.

**Check environment** verifies workspace, CLI version and ACP initialization;
ACP has no credential-status query, so model/authentication is explicitly
reported as unverified. A handshake alone does not confirm a model can answer.

**Model scan** reads the models and their thinking levels. Inside Desktop the
host's own `llm` model directory answers in-process (`listProviders`,
`listModels`, `resolveModelInfo`), together with the default selection from
`agentDefaultModel`. Without those services, ACP answers: `session/new` returns
`configOptions` with a `model` select and a `reasoning_effort` select that is
rebuilt per selected route, so the scan selects each advertised model in turn
and reads the returned options. That opens one ACP session, which the scan
closes before returning; an empty `configOptions` means the profile has no
model selection yet and the scan reports no models.

## Behavior

ACP protocol version 1, newline JSON-RPC 2.0:

| SPI / event | DSH ACP |
|---|---|
| startup | `initialize` with empty client capabilities |
| conversation | `session/new`; save `sessionId` |
| resume | advertised `session/resume`, or legacy `session/load` capability |
| send | `session/prompt`; completion reply ends the turn |
| assistant text | `session/update` → `agent_message_chunk` with text content |
| thinking | `session/update` → `agent_thought_chunk` with text content, when emitted |
| tool | `tool_call` / `tool_call_update` |
| usage | `usage_update` `{used,size}` → the newest request's context occupancy and the routed window |
| permission | `session/request_permission`; choose an offered option by kind |
| cancel | `session/cancel`; wait for cancelled prompt, close process if stalled |

The native controller displays assistant text and reasoning; its turn end
carries the last committed assistant message with text as `text`. Standalone ACP
forwards thought chunks when the Agent publishes them. Some DSH
versions emit committed messages rather than token-by-token deltas.
The prompt request has no fixed 15-second handshake timeout; the host's activity
watchdog only warns during silence. The Agent's result or explicit cancel/dispose
ends the turn. ACP reports token limits and other
incomplete stop reasons as errors, preserving any partial reply.

Permission option IDs remain opaque. Allow selects `allow_once`; deny selects
`reject_once` (or an offered reject-always option). Unsupported decisions leave
the card open. Cancellation and process closure close outstanding cards.
Unsupported client requests receive an error; file/terminal client capabilities
are not advertised because DSH owns those tools locally.

The adapter refuses steer, letting the host queue another turn. It does not
advertise user-question support. A saved session that the installed CLI cannot
resume fails explicitly; it is never silently replaced by a new conversation.

Native Web/Desktop capabilities differ from standalone ACP. The native catalog
maps the host's available permission presets to plan (read-only), workspace
(workspace-write), and full (danger-full-access with no approvals). Native
steering uses `sessionController.prompt({mode: "steer"})`, consuming extra input
at the next step boundary. Standalone ACP still refuses steer. An unset
role permission preserves the host selection; an explicit tier is applied when
the driver opens or resumes the session, not on every turn. Unsupported tiers
are rejected. Plan here is a sandbox tier, not a separate planning workflow.

Native `compact()` resolves the target agent's preset compaction service through
`agentPresets.serviceFor`; hosts without preset isolation can use their global
compaction service. A preset without compaction rejects the operation. It waits
for the native durable result, preserves native identity, refuses overlapping
work, and forwards interruption/disposal to the compaction signal. The plugin
can reopen a saved conversation before compacting without a warm-up message.
Standalone ACP retains its existing workspace-only declaration and no compact
method. These native controls apply to the dsh engine.

Run `node scripts/check-native-dsh.mjs --native-controls` for the isolated real
Web-host check with a local mock provider, including permission changes, a
committed summary, continuation, and cold compaction after host restart.

## Verification

`node --test test/acp.test.js test/opencode.test.js test/dsh.test.js`
includes the shared-core suite and a strict executable DSH ACP fixture covering JSON-RPC 2.0,
configuration, tool/text updates, native resume, allow/deny, queueing, cancellation,
startup cancellation, process failure, token limits, isolated storage, newer
format errors and a task lasting 16 seconds.

Run `node scripts/check-dsh.mjs [absolute-dsh-path]` from `orchestrator/` for the
opt-in real CLI check. It uses a local mock provider, a temporary DSH home,
and tests two turns, separate agent storage, cancellation and persisted resume. No user DSH data or
real provider credentials are used. The mock answers both provider wire shapes:
DSH `>= 0.2` posts to `<baseURL>/v1/messages`, earlier versions to `<baseURL>/chat/completions`.

On 2026-10-13 the installed DSH CLI `0.2.0-rc.2` passed that integration check;
`0.1.5-rc.1` passed it before the upgrade.

On 2026-10-14, after migration to the shared ACP core, the 22 ACP/OpenCode/DSH
tests and 10 native session tests passed. The installed DSH `0.2.0-rc.2` passed
`node scripts/check-dsh.mjs /usr/local/bin/dsh` again. The expanded
`node scripts/check-native-dsh.mjs` passed with real native session discovery,
independent live observation, two native sessions in one workspace and Web host
restart preserving identity and conversation history. Both real-runtime checks
used isolated temporary configuration and a local mock provider. Real DeepSeek
model calls, real tool approvals and visual Desktop UI interaction were not run.

On 2026-10-22 the installed DSH CLI `0.2.1-rc.2` re-passed `node scripts/check-dsh.mjs`
and `node scripts/check-native-dsh.mjs`, plus that script's `--native-changes` and
`--native-controls` probes, each with a temporary DSH home and the local mock provider.
Its session registry declares 62 known events: `job/registered`, `job/settled` and
`working-directory/change` are new and unmapped, nothing was removed, the six ACP
projections are unchanged and the payload declarations the driver reads stayed
byte-identical or gained optional fields only. `agent-drivers/src/coverage.ts` lists
this version as verified. Real DeepSeek model calls, real tool approvals and visual
Desktop UI interaction were not run.

Primary reference: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
The adapter also follows the installed `@deepseek-ai/dsh-acp` and
`@deepseek-ai/dsh-acp-app` package contracts.
