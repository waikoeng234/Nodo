# CodeBuddy driver

This folder owns CodeBuddy discovery, launch and configuration on top of the
shared ACP core (`../acp/core.ts`). It launches an installed CLI with
`codebuddy --acp` (stdio ndJSON, protocol version 1); sessions live in the CLI's
own storage and are restored with `session/load`. No dependencies are added.

## Intake result (2026-10-19)

| Investigation | Result / evidence |
|---|---|
| Installed CLI | `@tencent-ai/codebuddy-code` 2.169.0, `/usr/local/bin/codebuddy` |
| Login | CLI-scoped: TUI `/login` OAuth or `CODEBUDDY_AUTH_TOKEN`; WorkBuddy desktop app credentials are not shared |
| ACP connection | Independent subprocess; `initialize` with `clientCapabilities._meta["codebuddy.ai"]={question:true}` plus `elicitation:{form}` |
| Continuity | Real CLI: two turns one session id, second connection `session/load` restores (result may omit the id; the core keeps the original) |
| Native session list | A live ACP session appears in `codebuddy ps --json`; discovery by the desktop app's list is unverified |
| Models / thinking | Session config options `model` (account catalog, default `default-model`=Auto) and `thought_level`, recomputed per model; the scan reuses `acpModelCatalog` (`modelConfigId:'model'`, `effortConfigId:'thought_level'`) |
| Permissions | `session/request_permission` options `allow_always/allow_once/reject_once`; autonomy tiers map plan/workspace/full → `mode` plan/auto/bypassPermissions |
| Questions | `AskUserQuestion` is gated by a permission request whose `toolCall.rawInput.questions` carries the form; the gate reply only opens it and the answers return through `_codebuddy.ai/resolveInterruption` (`decision:'allow'`, `answers:{q_N}`) — a bare gate reply hangs the turn |
| Cancellation | `session/cancel` stops the turn in ~11 ms with `stopReason:'cancelled'` |
| Usage / file changes | Token usage is not reported (a zeroed `usage_update` only) and tool updates carry no diff/locations, so both are honestly omitted; `steer`/`compact` have no Agent channel |

## Setup

Choose **CodeBuddy** in the profile form and enter an existing absolute
working directory. Log in once by running `codebuddy` and using `/login`.
Optional settings:

- `bin`: CLI executable path or command, auto-detected from PATH by default.
- `model` (common profile field): a catalog id such as `deepseek-v4.1-flash`;
  blank uses the Agent's Auto route.
- `thinking` (common profile field): a thought level the selected model lists;
  applied after the model for the same per-model rebuild. Unknown combinations
  are rejected by the Agent.
- Identity is passed as `--append-system-prompt` on the `--acp` process
  (instructionMode `native`). It lands in the system message, is not stored in
  session history, and is passed again on every spawn and `session/load`.
  Verified against 2.169.0 with `scripts/check-codebuddy-identity.mjs`.

## Known gaps

- The token/usage display stays empty for this Agent.
- `multiSelect` questions render as a single choice in the host card: the CLI
  itself accepts string, newline-joined and array answers (verified against
  2.169.0), so the driver forwards the host's value unchanged.
- No file-change cards: tool output text names touched paths instead.
- The live semantics of the `auto`/`bypassPermissions` modes should be
  confirmed during acceptance; the mapping mirrors the claude channel this CLI
  derives from.
