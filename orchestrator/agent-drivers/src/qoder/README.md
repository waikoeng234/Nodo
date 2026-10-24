# Qoder driver

This folder owns Qoder CLI discovery, launch and configuration on the
stream-json control protocol (typed JSONL over stdio, wire protocol 1.5.0 as
reported by the init frame). The transport mirrors `../claude/native.ts` minus
the partial-message channel: the CLI has no `--include-partial-messages`, so
assistant frames arrive whole and text is snapshot-only. No dependencies are
added.

## Intake result (2026-10-22)

| Investigation | Result / evidence |
|---|---|
| Installed CLI | Desktop-bundled `~/.qoder/bin/qodercli/qodercli-1.1.76` (versioned file name, no PATH entry); discovery scans that directory, highest version first |
| Login | CLI-scoped desktop login; initialize carries `account` (facts only, never persisted); `--list-models` reports `Not logged in` otherwise |
| Protocol | Claude-family stream-json with `control_request`/`control_response`; `initialize` answers before the first user frame with `commands`/`agents`/`skills`/`models`/`capabilities` |
| Continuity | Session id arrives on the `system init` frame; a second spawn passes `--resume <id>` (flag verified; cross-process resume itself is maintainer acceptance) |
| Native session store | `~/.qoder/projects/<escaped-cwd>/<uuid>.jsonl`, shared with the Qoder desktop app: `--list-sessions` lists desktop-created sessions. Whether the desktop observes CLI sessions live is maintainer acceptance |
| Models / thinking | Initialize `models[]`: `value` is what `--model` takes, `displayName` labels the row, `efforts`/`defaultEffort` are the thinking levels; the scan reads this table only (no fabricated fallback). `--reasoning-effort` outside a model's `efforts` is silently accepted by the CLI |
| Permissions | `can_use_tool` control requests (field superset of Claude's); `--permission-mode` takes `default/accept_edits/bypass_permissions/dont_ask/auto`; autonomy tiers map workspace/full → `auto`/`bypass_permissions`; there is no plan flag, so the plan tier falls back to `default` and is not declared |
| Questions | `AskUserQuestion` arrives as `can_use_tool`; answers return via `updatedInput.answers` keyed by the question text (verified against the real CLI) |
| Cancellation | `interrupt` control request receipts `{still_queued:[]}` immediately; the turn ends as `result error_during_execution` and the driver maps it to `interrupted` |
| Steer | Not supported on the driver's wire: mid-turn user frames queue as the next turn, no marker list is declared (`request_marker_lists_v1` absent), and `priority`/`uuid` frames get no acknowledgement (re-verified against 1.1.76 with plain and `priority:'now'` frames). The interactive TUI does deliver mid-turn messages into the running context (the Agent answers on its own "handle next" note, Ctrl+Enter interrupts) — that input layer does not exist on `--input-format stream-json`, so `steer()` always refuses and the host queues |
| Usage / file changes | Anthropic-shaped usage plus `credits`/`context_usage_ratio`; `result.total_credits` and per-model `modelUsage` (contextWindow) feed the normalized usage — and on a free route, whose Anthropic counters all read 0, `context_usage_ratio × modelUsage[].contextWindow` is the turn's prompt side. File changes derive from Write/Edit inputs on confirmed tool results; the CLI sends no structured `tool_use_result` |
| Compaction / subagents | `/compact` rides the slash line and emits `status compacting` → `compact_boundary`; `task_started/progress/notification` map to attributed activity, same shapes as Claude's |

## Intake checklist (ENGINE_INTAKE route A, 2026-10-22)

Evidence is split three ways: the CLI's own `--help`/initialize output proves the
protocol, the repo fixtures prove adapter behavior, and real runs prove live
behavior. Developer probes against the real 1.1.76 CLI are recorded in the memory
branch file `.agent/handoffs/QODER-ENGINE.md`; they are not maintainer
acceptance.

| Check | Protocol source & version / implementation | Automated verification | Maintainer live results |
|---|---|---|---|
| Route, Agent/version, capability scope, unsupported items | Route A; qodercli 1.1.76, wire protocol 1.5.0 (`src/qoder/`); unsupported: steer, plan tier, incremental text | `npm run verify:engine -- --engine qoder --route new` → 337/338 (the one failure is the unrelated in-flight dispatch/test mismatch, reproducible without Qoder) | Not run |
| Start/connect, negotiation, install/auth check edges | stream-json control channel (`native.ts`); `checkQoder` = workspace + version + initialize handshake + account fact | check tests in `test/qoder.test.js` passed; discovery test covers the desktop version directory | Not run |
| Runtime & writer, native workspace ownership, real session id | `~/.qoder/projects/<escaped-cwd>/<uuid>.jsonl`, shared with Qoder Desktop (CLI `--list-sessions` listed a desktop session, probe 2026-10-22); session id from `system init` | fixture asserts the init session id | Not run (desktop-side observation) |
| Two consecutive turns, two sessions, cold resume | `--resume <id>` on respawn | fixture resume test passed | Not run (cross-process resume) |
| Native UI integration; Agent app discovery/live observation | Session opens through the adapter route (`session-open`), like the other adapter Agents; registration `src/index.ts` | `test/engine-registration.test.js`, `npm run build:check` passed | Not run |
| Identity injection level, persistence, unsupported behavior | `--append-system-prompt` on every spawn/resume (instructionMode `native`); verified against the real CLI (probe) | spawn-frame assertions in `test/qoder.test.js` | Not run |
| Model/thinking & permission sources, switching, refusal | initialize `models[]` (`scanQoder`); `--reasoning-effort`; tiers workspace/full → `auto`/`bypass_permissions`, plan → `default` (undeclared) | catalog/scan/tier tests passed | Not run (real tier semantics) |
| Text/tools, snapshot vs incremental, pairing, cancel confirmation | Whole-message text (no partial channel); file changes from Write/Edit inputs on confirmed tool results; interrupt receipt → `interrupted` | turn/file/interrupt tests passed | Not run |
| Approvals, single/multi/free-form questions; denial & anomalies | `can_use_tool` control requests; answers via `updatedInput.answers` keyed by question text (verified against the real CLI, probe) | approval/question tests + host pipeline test passed; multi-question forms remain fixture-level | Not run |
| Images, plain attachments, commands/skills; missing-capability notices | In-turn image blocks (real-CLI probe); commands from initialize `commands[]` (`scanQoderCommands`) | commands scan test passed | Not run |
| Plans, subtasks, compaction/retry, usage, file changes, rich media | `task_started/progress/notification` → attributed activity; `/compact` → `compact_boundary`; Anthropic-shaped usage + credits | lifecycle/usage tests passed | Not run |
| Turn final text & last reply, error/cancel, serial handoff | `result` frame settles done/error/interrupted; HANDOFF/WAIT fixture scenarios | `node scripts/check-handoff-capabilities.mjs --engine qoder` → 8 passed / 1 skipped (DSH-only) / 0 failed | Not run |
| Registration, name, routing, icon or generic fallback, build | `src/index.ts` Agents entry (name `Qoder`, adapter); `assets/engines/qoder.svg` (word-mark path from the qoder.com favicon, see `THIRD_PARTY_NOTICES.txt`) | registration tests, client bundle consistency check passed | Not run |
| Change scope, automated commands, results, pending maintainer items | Scope: `src/qoder/`, registration, tests, docs; commands listed above | results as listed per row | Pending acceptance: cross-process `--resume`, desktop observation, `auto`/`bypass_permissions` semantics, multi-question cards, real paid models |

## Setup

Choose **Qoder** in the profile form and enter an existing absolute working
directory. Log in once through the Qoder desktop app or `qodercli login`.
Optional settings:

- `bin`: CLI executable path or command. An explicit path is used strictly;
  left blank, the driver looks up `qodercli` on PATH and then the desktop's
  `~/.qoder/bin/qodercli` directory.
- `model` (common profile field): a catalog id exactly as the scan lists it
  (the initialize response's `value` — the model picker's rows); blank uses
  the Agent's configured default.
- `thinking` (common profile field): an effort the selected model lists in its
  `efforts`; the CLI silently accepts unknown values, so the catalog is the
  source of truth for the picker.
- Identity is passed as `--append-system-prompt` (instructionMode `native`),
  re-applied on every spawn and resume. Verified against the real 1.1.76 CLI.

## Known gaps

- No steering: `steer()` returns `refused` and the host queues instead. The
  interactive TUI accepts mid-turn input and a Ctrl+Enter interrupt, but the
  `--input-format stream-json` wire this driver speaks has no such channel; a
  refused steer must never be written to the CLI's stdin, or the Agent runs
  the queued frame itself and the host's post-turn send duplicates it.
- No incremental text: the Agent has no delta channel, so transcripts restore
  from whole messages.
- File-change snapshots rely on the Agent's response wording ("File created
  successfully …"); a changed wording drops that edit from the snapshot rather
  than guessing.
- The `plan` autonomy tier is not offered (no Agent flag); live semantics of
  `auto` vs `bypass_permissions` should be confirmed during acceptance.
- Cross-process `--resume`, desktop-side observation of CLI sessions and real
  paid-model turns remain maintainer acceptance items.
