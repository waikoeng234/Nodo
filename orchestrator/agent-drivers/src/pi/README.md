# pi driver

This folder owns pi CLI discovery, launch and configuration on the RPC
protocol: a long-lived `pi --mode rpc` subprocess speaking strict JSONL on
stdin (commands) and stdout (responses, session events, extension UI records).
The transport splits records on LF only — the Agent's own docs forbid line
readers there (U+2028/U+2029 are valid inside JSON strings). No dependencies
are added.

## Intake result (2026-10-22)

| Investigation | Result / evidence |
|---|---|
| Installed CLI | npm-global `@earendil-works/pi-coding-agent` 1.4.0 (Node runtime); open source at github.com/earendil-works/pi with in-package docs and examples |
| Login | Provider API keys / OAuth via `pi auth`; `pi auth check --provider <p> --json --no-refresh` reports readiness without emitting credentials (probe: `{"status":"ready","authType":"api_key"}` for the configured provider) |
| Protocol | `--mode rpc`: commands/responses correlate by `id`; no ACP, no JSON-RPC, so the connector is its own (`native.js`) |
| Continuity | `--session-id <id>` reuses or creates that exact project session (get_state echoes it; an empty session writes no file until the first append). Cross-process cold resume is maintainer acceptance |
| Native session store | `~/.pi/agent/sessions/--<escaped-cwd>--/<timestamp>_<id>.jsonl`, format v3 tree; CLI-only tool — no desktop app shares it |
| Models / thinking | `get_available_models` returns full catalog rows (cost, context window, `thinkingLevelMap`); the scan keys entries as `provider/id`, the one spelling both `--model` and `set_model` accept; thinking levels come from `thinkingLevelMap` keys |
| Permissions | None: the Agent never asks per tool call (its security model is isolation plus `--tools`/`--exclude-tools`). No autonomy tiers are declared beyond the host default; the host approval pipeline has no Agent-side counterpart |
| Questions | No native ask tool. Extension dialogs (`extension_ui_request` select/confirm/input/editor) are the only server→client question channel and must be answered or the Agent stalls — each surfaces as a question card and answers ride `extension_ui_response` |
| Project trust | RPC mode cannot show the trust prompt, so the driver always passes `--no-approve`: project `.pi/` settings and extensions never load silently. `AGENTS.md`/`CLAUDE.md` context files load regardless |
| Steer / cancel | `steer` is a first-class command (queued between tool calls, answered with a disposition) → `steered`; `abort` replies at idle and `agent_settled{aborted:true}` settles the turn as `interrupted` |
| Text streaming | Real deltas: `message_update` carries `text_delta`/`thinking_delta`/`toolcall_delta`; whole texts emit only when a message streamed no deltas (claude's sawText pattern). `agent_settled` — not `agent_end` — is the settle point (retries and steering may follow) |
| Usage / file changes | Per assistant message: `{input, output, cacheRead, cacheWrite}` folds into the turn buckets; context window rides `get_state`. File changes derive from `write` (add/update split by the driver's own existence check at tool start) and `edit` (`edits[].oldText/newText`) tool flows on confirmed results |
| Compaction / retry | `compact` RPC command runs inside a driver turn; `compaction_start/end` and `auto_retry_start/end` map to lifecycle events; a failed retry (`auto_retry_end success:false`) settles the turn as `error` |

## Intake checklist (ENGINE_INTAKE route A, 2026-10-22)

Evidence is split three ways: the CLI's own `--help`/RPC responses and in-package
1.4.0 docs prove the protocol, the repo fixtures prove adapter behavior, and
real runs prove live behavior. Developer probes against the real 1.4.0 CLI
(state commands only — no model turns) are recorded in the memory branch file
`.agent/handoffs/PI-ENGINE.md`; they are not maintainer acceptance.

| Check | Protocol source & version / implementation | Automated verification | Maintainer live results |
|---|---|---|---|
| Route, Agent/version, capability scope, unsupported items | Route A; pi 1.4.0, RPC protocol per in-package docs (`src/pi/`); unsupported: native approvals, permission tiers, plain-file attachments | `npm run verify:engine -- --engine pi --route new` → 334 tests: 333 passed, 1 failed (a pre-existing `workflows.test.js` failure, also reproduced on a clean HEAD tree and unrelated to this Agent); separate handoff and build checks passed | Not run |
| Start/connect, negotiation, install/auth check edges | `--mode rpc --no-approve` spawn (`native.js`); `checkPi` = workspace + version + `get_state` handshake + configured-model fact | check tests in `test/pi.test.js` passed | Not run (auth readiness against real providers) |
| Runtime & writer, native workspace ownership, real session id | `~/.pi/agent/sessions/…` v3 tree written by the CLI; session id from `get_state`, echoed as `--session-id` on respawn | fixture asserts the session id and the respawn flag | Not run |
| Two consecutive turns, two sessions, cold resume | `--session-id <id>` on respawn | fixture resume test passed | Not run (cross-process cold resume) |
| Native UI integration; Agent app discovery/live observation | Session opens through the adapter route, like the other adapter Agents; pi has no separate host app (CLI/TUI only) | `test/engine-registration.test.js`, `npm run build` + `--check` passed | Not applicable (no separate host application); CLI session files can be observed offline |
| Identity injection level, persistence, unsupported behavior | `--append-system-prompt` on every spawn/resume (instructionMode `native`) | spawn-frame assertions in `test/pi.test.js` | Not run (real-model confirmation) |
| Model/thinking & permission sources, switching, refusal | `get_available_models` (`scanPi`), `--model`/`--thinking` flags; no permission tiers declared (Agent has none) | catalog/scan tests passed | Not run (real catalog breadth) |
| Text/tools, snapshot vs incremental, pairing, cancel confirmation | Native deltas; settle on `agent_settled`; `abort` → confirmed `interrupted` | turn/delta/interrupt tests passed | Not run |
| Approvals, single/multi/free-form questions; denial & anomalies | No native approval channel; extension dialogs surface as question cards (select/confirm/input/editor), denial cancels the dialog | dialog tests + host pipeline test passed (fixture level) | Not run (real extension dialogs) |
| Images, plain attachments, commands/skills; missing-capability notices | `prompt` accepts base64 images; `@file` is CLI-only and RPC rejects it (no plain attachments); commands from `get_commands` (`scanPiCommands`) | image + commands scan tests passed | Not run |
| Plans, subtasks, compaction/retry, usage, file changes, rich media | `compact` command + compaction/retry lifecycle events; usage folding; write/edit-derived file changes; no plan or subagent channels mapped | compaction/retry/usage/file tests passed | Not run |
| Turn final text & last reply, error/cancel, serial handoff | `agent_settled` settles done/error/interrupted; HANDOFF/WAIT fixture scenarios | `node scripts/check-handoff-capabilities.mjs --engine pi` → 8 passed / 1 skipped (DSH-only) / 0 failed | Not run |
| Registration, name, routing, icon or generic fallback, build | `src/index.js` Agents entry (name `Pi`, adapter); `assets/engines/pi.svg` (mark from the pi.dev favicon, see `THIRD_PARTY_NOTICES.txt`) | registration tests, client bundle consistency check passed | Not run |
| Change scope, automated commands, results, pending maintainer items | Scope: `src/pi/`, registration, coverage index, tests, docs; commands listed above | results as listed per row | Pending acceptance: cross-process cold resume, real-model turns (steer delivery timing, usage shape, dialog behavior), permission-free semantics in shared workspaces |

## Setup

Choose **pi** in the profile form and enter an existing absolute working
directory. Authenticate once through `pi auth login` or a provider API key
variable. Optional settings:

- `bin`: CLI executable path or command; left blank the driver looks up `pi`
  on PATH (the npm-global install).
- `model` (common profile field): a catalog id exactly as the scan lists it
  (`provider/id`); blank uses the Agent's configured default.
- `thinking` (common profile field): a level the selected model lists in its
  `thinkingLevelMap` (`off`…`max`).
- Identity is passed as `--append-system-prompt` (instructionMode `native`),
  re-applied on every spawn and resume.

## Known gaps

- No native approvals: pi executes tools without per-call permission prompts
  (its security model is isolation plus tool allowlists). The host's approval
  cards have no Agent-side counterpart; an extension-based gate
  (`tool_call` interception plus the dialog channel, cf. pi's own
  permission-gate example) is a possible follow-up but is not built here.
- No autonomy tiers: only the host default tier exists, and it presets
  nothing — the Agent ignores it.
- Project-local `.pi/` resources never load (`--no-approve` is fixed);
  workspace `AGENTS.md`/`CLAUDE.md` still load as context.
- Plain-file attachments have no channel; images ride `prompt.images`.
- Plan and subagent channels: pi exposes none in RPC mode, so no `plan` or
  attributed-activity events are emitted.
- Cross-process cold resume, real-model turn behavior and real extension
  dialogs remain maintainer acceptance items.
