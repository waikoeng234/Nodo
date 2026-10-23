# Driver protocol reference

This document describes the normalized driver interface, event semantics and Agent mappings used by Nodo. The contract is defined in [src/spi.js](src/spi.js), with driver validation in [src/index.js](src/index.js). Implementation steps belong in [ENGINE_INTAKE.md](ENGINE_INTAKE.md).

## Driver interface

Factories receive session settings and an `onEvent` callback and return these eight required members:

| Member | Contract |
| --- | --- |
| `openSession()` | Create or resume a session without sending a model prompt. |
| `sendTurn(text, images?)` | Start a turn; images use `{mediaType, data}` with base64 data. Reject overlapping turns. |
| `steer(text)` | Return `steered`, `refused` or `indeterminate` for running-turn input. |
| `interruptTurn()` | Request cancellation; turn events report completion. |
| `respondToRequest(id, response)` | Answer a permission request or question. |
| `onEvent` | Required compatibility member; supply the callback through factory options because some adapters reject later subscription. |
| `hasSession()` | Report whether the driver has a live or known session. |
| `dispose()` | Release the process or connection and active turn. |

`steered` confirms input will reach the running turn. `refused` permits host queuing. `indeterminate` means delivery may have occurred without acknowledgement; automatic resending could duplicate input. A steering timeout is indeterminate.

Responses use `{decision, value?, always?}`: `allow` / `deny` for permissions and `answer` for questions. Session-wide rules apply only when supported by the Agent.

The optional method currently registered is `compact()`. Its implementation must match `info.capabilities.compact === true`; mismatches are rejected with `driver/bad-spi`. Model catalogs come from the optional registry-level `scan` entry. There is no uniform `setModel()` or `setGoal()` primitive.

Permissions use host tiers `plan`, `workspace` and `full`, translated by each Agent. They do not bypass approval cards. `instructionMode: 'native'` means role instructions were installed through an Agent-supported mechanism; an optional `instructionTarget` identifies the layer. Missing or `none` means no installed identity.

## Event overview

Events use the factory callback. Optional fields remain absent when the source cannot supply them.

| Event | Main fields and meaning |
| --- | --- |
| `session` | `state: starting / ready / closed`; optional session/workspace IDs and detail. |
| `turn/start` | `turnId`; begins a turn. |
| `delta` / `text` | `turnId`, `text`; incremental text / one complete message. |
| `thinking` | `turnId`, `text`; new reasoning text, with source snapshots deduplicated by the driver. |
| `tool` | `turnId`, `name`, `phase: start / update / end`; call identity, input, output and presentation. |
| `changes` | `turnId`, `presentation`; source-scoped file-change snapshot. |
| `plan` | `turnId`; whole-plan snapshot, optional text, steps and removal flag. |
| `activity` | `turnId`, `entityId`, `phase`; source-declared member activity. |
| `lifecycle` | Optional `turnId`, `kind: compaction / retry`, `phase: start / end`; optional error/cancellation. |
| `turn/end` | `turnId`, `reason: done / interrupted / error`; optional final text, error, usage, timing and `unconfirmed`. |
| `request/opened` | `id`, `kind: permission / question`; optional tool, reason, options and detail. |
| `request/closed` | `id`; request already settled by the source. |

Complete text may be emitted without deltas. Final snapshots must not duplicate streamed content. `turn/end.text`, when available, is the final assistant message used for workflow handoff, distinct from accumulated text.

An unacknowledged stop may end locally with `unconfirmed: true`; the Agent may still be running. A cancellation request alone is not confirmation. Requests that pause execution must surface as cards; settled requests must not be answered again.

### Usage and timing

Optional `usage` fields are `inputTokens` (uncached), `outputTokens` (including reasoning), `cacheReadTokens`, `cacheWriteTokens`, `contextUsed` and `contextSize`. The four token buckets are disjoint and additive. Context fields retain the latest model request's occupancy/window, not a sum. Unknown values stay absent; invalid, negative and non-finite values are dropped.

Optional `timing` fields are `ttftMs`, `ttftSteps`, `llmMs`, `toolMs`, `decodeMs` and `decodeTokens`. Durations use milliseconds; step and token counts provide the denominators for averages and decoding speed.

## Optional structured tool snapshots

The existing tool `start` / `end` events may include `presentation`:

```js
{ version: 1, kind: 'tool', mode: 'snapshot', revision: 1,
  body: { input: { command: 'echo hello' }, inputText: 'echo hello',
    command: 'echo hello', cwd: '/workspace', outputText: 'hello\n', exitCode: 0 },
  capture: 'complete' }
```

`revision` is an optional nonnegative safe integer. A newer snapshot replaces
the previous body; an older revision cannot overwrite it, identical revisions
are idempotent, and conflicting revisions retain the previous content with a
partial-capture notice. Missing revisions are ordered locally by the host.
`callId` is required for this projection; the host supplies its own run and
conversation identity. A terminal record cannot return to running.

The body accepts JSON `input`, readable `inputText` / `outputText`, and source
provided `command`, `cwd`, `exitCode` or `signal` (the latter two are exclusive).
Optional `diffs` contain `{path, oldText, newText}`; `oldText: null` requires
`created: true`. Unknown before-images remain text rather than invented diffs.
`capture` is `complete`, `partial` or `unavailable`; source truncation uses
`reason: 'source-truncated'`. No arbitrary raw payload, host path or detail ref
is accepted. Unknown versions, delta mode and invalid structures retain the
existing text path. This is an additive SPI field, not a new event or phase.

### Rendered resources

A tool body may also carry `resources`, projected by the host from confirmed
content blocks: ACP `ContentBlock` (`text`, `image`, `audio`, `resource_link`,
`resource`), Claude `tool_result` content (`text`, `image`), DSH `ContentBlock`
(`text`, `image`, `file`) and Codex dynamic tool items (`inputText`,
`inputImage`, `inputAudio`), plus `imageView`/`imageGeneration` path references.
MCP result envelopes unwrap their `content` blocks. Confirmed media creates a
tool record even when the driver omits the optional `presentation` field.
Codex `imageGeneration` base64 results are decoded as images rather than prose.
A DSH image block carries the Agent's verified `ImageAttachmentRef`
(`attachmentId`, `mediaType`, `bytes`, `width`, `height`); the host passes it
to the attachment store unchanged so the stored metadata check still holds.
Before reading a host reference, the detail writer uses public
`sessionController.inspect` to confirm the exact reference occurs in a message
of the owning native session. Missing ownership evidence degrades to
`attachment-unavailable`; a reference alone does not authorize a global read.
Each entry is `{kind: 'image'|'file'|'link'|'audio'|'text', state:
'stored'|'reference'|'unsupported'|'unavailable', reason?, name?, mimeType?,
uri?, bytes?, ref?}`. Inline image bytes never enter the body, transcript or
detail file: base64 whitespace is normalized and the host's public
`attachments.validateImage` fully decodes PNG/JPEG/WebP/GIF before saving to
the same plugin attachment store pasted images use. Missing validation service
degrades to `no-reader`; a signature match alone does not mark an image stored.
The saved entry carries `ref: {id, mediaType}`. Long binary-like text is omitted
consistently in strings, text blocks and JSON fallbacks. Duplicate immutable
revisions reuse saved detail/image references before quota checks, including
after restart; refused saves never leave images promising future storage.
Explicit local raster image links are copied from the session workspace, OS
temporary directories or Codex's `generated_images` directory. Reads check
resolved paths, file type and size; the protected DSH directory is excluded.
Reply image links use the same validation and limits: legacy replies store
plugin image references, and native replies emit durable image attachment blocks.
Remote `uri` values remain references; audio has no player; embedded text stays in
`outputText` with its resource metadata; a blob with no displayable type or a
DSH file attachment stays a reference. Unknown or invalid shapes fall back to
the existing text path, and old records without `resources` remain readable.

Tool snapshots are additive; existing Agent tool text remains compatible. File summaries have the separate optional event below.

## Optional tool updates

A source that exposes progress emits the same `{type:'tool', ...}` event with
`phase:'update'` and the tool's existing `turnId`+`callId`; it is never a
second execution and the host never counts it as one. The fields are:

- `inputDelta` / `outputDelta` append the source's own delta text. This is used
  only where the source declares a delta (for example Claude
  `input_json_delta.partial_json`, Codex `item/commandExecution/outputDelta`,
  ZCode `tool_input_delta`). No source here supplies a per-delta identity, so a
  replayed delta repeats; the host does not guess a replay away.
- `inputText` / `outputText` replace a readable snapshot. The `stdoutTail` /
  `stderrTail` / `outputPreview` facts are latest snapshots too, not appends.
- `input` / `output` carry the final structured value; the terminal `end` is
  authoritative. Updates after a terminal state are ignored.
- `progress` is a display-only latest snapshot with only the facts the source
  distinguishes: `elapsedMs`, `message`, `stdoutTail`, `stderrTail`,
  `stdoutBytes`, `stderrBytes`, `outputBytes`. No percentage is synthesized.
- `parentCallId` is present only when the source names a parent; the host keeps
  it in the event and transcript row but does not invent a hierarchy.

The host merges updates into the running row/record in memory; only the final
record enters the immutable detail path. The legacy transcript row is updated
before the tool ends. The native `engine_action` card has no public live-update
hook (the host exposes `presentCall`/`presentResult` only), so it shows the
final content; live progress there is a documented degradation, not a second
execution or a fabricated call.

| Source | Update channel | Semantics |
|---|---|---|
| Codex | `item/commandExecution/outputDelta`, `item/mcpToolCall/progress` | output delta appends; progress message is the latest snapshot |
| Claude | `stream_event` `input_json_delta`, `tool_progress` | partial input JSON appends; parsed input arrives at `content_block_stop`; progress is elapsed time only |
| ZCode | `model.streaming` `tool_input_delta` / `tool_call`, `tool.updated` `progress` / `result` | input delta appends; `tool_call.input` is final; progress tails/bytes/elapsed are latest snapshots; result/error end |
| ACP (OpenCode, CodeBuddy, DSH ACP) | `session/update` `tool_call_update` | partial patch: an included field replaces, an omitted field stays; status pending/in_progress/completed/failed |
| DSH native | none declared | `tool/call` and `tool/result` only; no progress/partial output is invented |

## Plans, subagent activity and lifecycle statuses

Three optional events carry source-provided structure. A source without them emits
nothing; hosts and older drivers ignore what they do not know. None of the
three is model-visible text, none changes turn state, and none invents fields
the source did not send.

`plan` is a whole-plan snapshot per turn: `steps` (`{text, status: pending |
in_progress | completed}`) and the readable `text`/`explanation` replace the
previous values, `removed: true` (or a snapshot left with no steps) clears the
row. Updates rewrite the host's one plan row per turn instead of appending
transcript lines, so a restored session shows the last snapshot exactly once.

`activity` is one Agent-declared subagent/task/workflow member:
`entityId` (the source's own stable id) is required; `parentId`, `toolCallId`
and `childId` ride along only when the source names them — no hierarchy is
inferred from names. The legacy transcript indents a row only when its explicit
parent call id resolves in the same user turn (at most eight levels); unknown
parents remain flat. Activity rows have their own summary count and never add
to the tool count. `title`/`detail` are latest snapshots; `end` is terminal;
`isError` marks a failed member, whose failure never ends the owning turn.
OpenCode child sessions (not negotiated) arrive as ordinary updates carrying
`_meta['opencode/child-session']`; the shared core routes them to per-child
activity instead of the main reply.

`lifecycle` maps only Agent-declared compaction and retry signals:
compaction `start`/`end` (Codex `thread/compacted` and the `contextCompaction`
item are completions, Claude closes on the durable `compact_boundary` only,
ACP `compaction_update` and OpenCode's `_meta['opencode/compaction']` degrade
channel — whose statuses are started/completed/failed, with the reducer's
aborted error type meaning cancelled — DSH `compaction/start`/`end` with
`compactionId`) and retry waits
(Codex `error.willRetry`, OpenCode `session_info_update._meta['opencode/retry']`
with `null` clearing it, DSH `llm/retry`/`llm/retry-started` with `retryId`).
The host keeps one replaceable status line per kind and scope (session or
specific turn); those scopes never share a slot. Session events remain accepted
while a turn's detail writes finish. A turn-scoped line closes
when its own turn ends — a completed turn renders a retry wait as recovered,
an interrupted one as interrupted — while a session-scoped line (the DSH host
compaction carries no turn id) survives turn ends and is retired only by its
own end event or a closed session, so a cancelled or disconnected state never
keeps showing as ongoing. A source-declared cancellation renders as cancelled,
never as a success. Codex's retry wait has no end signal and renders as a
bounded status line, not an ongoing spinner.

| Source | Plan | Subagent activity | Compaction / retry |
|---|---|---|---|
| Codex 0.159.2 | `turn/plan/updated` snapshot (`explanation`, steps `pending`/`inProgress`/`completed`) | `subAgentActivity` items (`id`, `agentThreadId`, `kind`); `collabAgentToolCall` stays a tool row with `agentsStates` in its output | `thread/compacted` + `contextCompaction` end; `error` with `willRetry` starts the retry line |
| Claude 2.1.301 | none declared | `task_started`/`task_progress`/`task_updated`/`task_notification` (`task_id`, `parent_task_id`, `tool_use_id`) | `status.compacting` opens; `compact_boundary` closes exactly once |
| ACP (OpenCode, DSH ACP) | `plan`/`plan_update(items, markdown)`/`plan_removed` snapshots | negotiated-off child updates carry `_meta['opencode/child-session']`; routed per child | `compaction_update` (`compactionId`, status incl. cancelled), `_meta['opencode/retry']` + `_meta['opencode/compaction']` degraded channel |
| DSH native | `todo/write` whole-list snapshot (`content`, `status`) | `tool-workflow/run-start`/`agent-start`/`agent-end`/`run-end` (`runId`+`seq`, `childId`; `outcome` enum unrecorded → neutral terminal) | `compaction/start`/`end` (`compactionId`, runs outside turns), `llm/retry`/`retry-started` (`retryId`) |
| ZCode 0.16.9 | none usable | none usable: `part.*` schemas exist but the mapper never emits them and the part base record is undeclared; `session.updated` payloads are open records; V4 `subagents`/`plan` state is not mapped | same gap; the existing `_meta.zcode.apiRetry` note is untouched |

`item/plan/delta` and the Codex `plan` text item stay unmapped: the structured
snapshot channel is authoritative and streaming both would duplicate the row.
The native surface has no live plan/subagent views (the engine_action card has
no refresh hook, as with tool updates), so pump shows statuses and member
start/end as bounded notes plus one final plan row on successful turns. Failed
or cancelled turns retain a bounded final-plan note, without creating a mirror
tool boundary after cancellation. The legacy transcript carries replaceable
rows, including the final plan on failed/cancelled turns.

## Confirmed edit-file snapshots

Codex, OpenCode, Claude and ZCode may emit `{type:'changes', turnId, presentation}` immediately
before `turn/end`. The presentation is `{version:1, kind:'changes',
mode:'snapshot', body:{scope:'edit-tools', coverage:'partial', fileCount, files,
cwd?, turnDiff?}, capture, reason?}`. Each file is `{path, edits}`; each edit has
`operation: 'add'|'update'|'delete'|'move'|'unknown'` and optional `fromPath`,
`oldText`, `newText`, `diffText`. Paths are resolved against the known working
directory without reading the filesystem. `cwd` only shortens display labels.

Only successful source editing results enter the list. Call IDs deduplicate
repeated results; repeated edits share one file row with separate edit records.
This is the set of confirmed editing-tool paths, not the whole turn's net diff.
The count describes this set only; shell writes and unreported paths may be
missing, so coverage remains partial even when capture is complete.

Codex uses completed fileChange items with `status:'completed'`; failed,
declined and inProgress items are excluded. `kind.update.move_path` supplies
the destination and the original path is preserved. `turn/diff/updated.diff`
is saved as the newest whole text snapshot. No patch parsing, file counts or
line counts are inferred from that text.

OpenCode ACP retains content.diff independently of rawOutput. Completed
edit/delete/move tools may also supply locations without differences; the kind
and locations survive omitted partial updates. Read-tool locations and approval
proposals are excluded. ACP v1 defines explicit diff.oldText=null as a new file;
missing oldText stays unknown. See the [official tool contract](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/tool-calls.mdx).
Source locations do not imply full difference coverage.

The source collector retains at most 512 files, 1024 edits and 1 MiB of content.
Exceeding a limit drops detail text first and marks partial/source-limit. No
filesystem snapshot, git state or other session supplies missing edit-tool data.

Claude pairs a live tool_result with the known input and structured tool_use_result
for Write/Edit/NotebookEdit. Errors, staged writes, replays and inconsistent paths
are excluded. Confirmed Write/Notebook full images can supply a difference; Edit
replacement snippets are never treated as full files. ZCode accepts successful
legacy Write/Edit results and their matched inputs, including an approval's
modifiedInput. It provides a path list only; V4 aggregate queries remain disabled.

DSH native uses the same changes event with scope:'workspace-snapshot'. It queries
the public workspaceChanges.summary(sessionId, event.seq) for a matching native
turn, then diff(sessionId, event.seq, fileIndex, signal). Summary limits and missing
comparisons remain explicit, with binary/oversized/coarse/unavailable edit states.
Four concurrent reads have a shared two-second deadline; detail text is bounded.
This source can contain concurrent external writes, so UI and model text explicitly
identify it as a host workspace snapshot, never an Agent-owned edit set. A host
without this service, or a disposed summary, emits no fabricated empty set. DSH
standalone ACP does not use native host services.

## Codex wire mapping

Codex uses `codex app-server proxy` to connect to the shared local runtime. The adapter
does not supply API keys, change provider configuration or perform a login.
It inherits existing Codex settings and requires an explicit working directory.

| SPI / event | Codex JSON-RPC |
|---|---|
| startup | `initialize` response, then `initialized` notification |
| native workspace | `project/list` / `project/create`; `projectId` on new threads |
| native membership | `thread/metadata/update` for existing threads |
| native conversation | `thread/start` or `thread/resume`; persist `thread.id` |
| `sendTurn` | `turn/start` with `threadId` and text plus `image` inputs (`data:` URL) |
| `steer` | `turn/steer` with the exact `expectedTurnId`; refusal queues host-side |
| `interruptTurn` | `turn/interrupt`; completion status is `interrupted` |
| text | `item/agentMessage/delta`; completed text supplies only any missing tail |
| thinking | `item/reasoning/summaryTextDelta` / `textDelta`; completed reasoning `summary` / `content` arrays supply missing text without repeating streamed parts |
| tool progress | `item/started` / `item/completed` for tool items; `item/commandExecution/outputDelta` appends output and `item/mcpToolCall/progress` updates the latest message |
| `turn/end` | `turn/completed` status `completed` / `failed` / `interrupted`; `text` is the last completed `agentMessage` with phase `final_answer`, absent when none has that phase |
| usage | `thread/tokenUsage/updated` `last`/`total` buckets (uncached input, cached input, cache write, output) plus `modelContextWindow`; one notification per model call, so a multi-request turn folds them |
| permission | command/file approval server request; reply `accept` / `decline` |
| question | `item/tool/requestUserInput`; reply an `answers` object per question id |
| stale request | `serverRequest/resolved` closes the host card |
| compact | `thread/compact/start`; the completion announcement is `thread/compacted` (or a completed `contextCompaction` item) and settles the driver's local compaction turn; a bare request resolution settles it too |

Request ids remain typed on the wire. Host card ids also include the native
thread id to prevent collisions between profiles. Unsupported server requests
receive an explicit error; the client never implicitly grants a request.
Failed question answers leave the card open so the user can correct them.

## Claude Code (src/claude)

`claude --print --verbose --input-format stream-json --output-format stream-json
--include-partial-messages --replay-user-messages --permission-prompt-tool=stdio`
spawns one persistent CLI process per profile speaking typed JSONL frames (not
JSON-RPC). `--resume <session-id>` continues a stored session,
`--model` / `--effort` carry the profile's model and thinking level, and
`--append-system-prompt` installs the role instructions (instructionMode
`native`).

| SPI / event | Claude stream-json |
|---|---|
| startup | spawn; the CLI emits nothing until the first input — a boot only confirms the process came up |
| `sendTurn` | user frame `{"type":"user","message":{...}}` on stdin with text and base64 `image` content blocks; it triggers the `system/init` frame carrying the `session_id` |
| `steer` | stream-json user frame with `uuid` and priority `now`; uses `later` while an approval/question is pending. Requires init capabilities `request_marker_lists_v1`, `interrupt_cancel_queued_v1`, `interrupt_send_now_v1`; older CLIs refuse and the host queues |
| `interruptTurn` | control_request `interrupt`; the killed turn reports `result` `error_during_execution` |
| delta / thinking | `stream_event` `content_block_delta` `text_delta` / `thinking_delta` |
| tool progress | `content_block_start` `tool_use`; `input_json_delta` appends partial input; parsed input closes at `content_block_stop`; `tool_progress` supplies elapsed time; the replayed user frame's `tool_result` ends it with `is_error` |
| thinking / tool fallback | whole `assistant` content fills missing thinking text and tool calls; streamed tool JSON input and replayed results preserve input/output and call identity |
| text fallback | whole `assistant` frame, and `result.result`, only when nothing streamed |
| `turn/end` | `result` frame: `success`/`error_max_turns` → done, else interrupted (own interrupt) or error; after steering, wait for result `user_message_uuids`/`user_message_uuid` to cover injected input instead of ending on the preempted cycle; `text` is the last `result.result` |
| usage | the turn's buckets come from the `result` frame's `usage` (uncached input, cache read/creation, output); the newest `assistant` frame's `message.usage` is the context occupancy and `modelUsage[].contextWindow` the window |
| permission | control_request `can_use_tool`; reply control_response `behavior: allow` (echoed `updatedInput`) / `deny` |
| question | `can_use_tool` with `tool_name: "AskUserQuestion"`; allow with `updatedInput.answers` keyed by question text |

`--permission-prompt-tool=stdio` must use the `=` form: the space-separated
spelling does not arm the control-channel dispatcher and gated tools are denied
silently. Model scan is a static alias list (`fable`, `opus`, `sonnet`,
`haiku`) with the configured default read from `settings.json`; the CLI has no
model-list query.

## OpenCode (src/opencode)

`opencode acp` is an Agent Client Protocol server on stdio (JSON-RPC 2.0,
shared with OpenCode's session store). `session/new` / `session/load` attach a
workspace; model and thinking go through `session/set_config_option`
(`configId` `model` / `effort`, values from the session's `configOptions` —
note the parameter is `configId`, and `session/set_model` does not exist).

| SPI / event | OpenCode ACP |
|---|---|
| startup | `initialize`, then `session/new` (or `session/load` for resume) |
| `sendTurn` | `session/prompt` with a text part and base64 `image` parts when the agent declares `promptCapabilities.image`; otherwise it rejects; the request settles at turn completion (no timeout) |
| delta / thinking | `session/update` `agent_message_chunk` / `agent_thought_chunk` |
| tool progress | `session/update` `tool_call` / `tool_call_update`: included fields replace, statuses `pending`/`in_progress`/`completed`/`failed` |
| `turn/end` | `session/prompt` response `stopReason`: `cancelled` → interrupted, `end_turn` → done, any other stop (limits, refusal, unknown) → error; `text` is the turn's last `agent_message_chunk` message by `messageId`, absent when any text chunk lacks one |
| usage | `session/update` `usage_update` `{used,size}` is the context occupancy; the prompt response's `Usage` carries the buckets (`inputTokens`/`outputTokens`/`cachedReadTokens`/`cachedWriteTokens`), which the shared ACP core merges with it |
| `interruptTurn` | `session/cancel` notification |
| permission | server request `session/request_permission`; reply `{outcome:{outcome:"selected",optionId}}` (`once`/`always`) or cancelled |
| question | server request `elicitation/create` (client capability `elicitation.form`); reply `accept` with content keyed by schema property, `*_custom` fields take free text |

Role identity rides the Agent's own configuration: the driver appends a
`{file:…}` reference for the instruction file to the `build` and `plan` agent
prompts in `OPENCODE_CONFIG_CONTENT` (existing inline configuration is
preserved), so `instructionMode` is native and task text never carries
identity.
A leading `/name` line resolves the command markdown file the scan lists —
same id rule, project winning — and sends the body with arguments appended
after it; frontmatter beyond `description` is dropped and `$ARGUMENTS` is not
substituted. A first word outside the id rule is sent verbatim; an unknown
command-shaped name errors. Permission prompts only appear when the user's
OpenCode permission configuration asks; by default OpenCode allows and no card
is raised. Model scan attaches one throwaway session and reports its
`configOptions` (full catalog plus the current model's effort levels). The
session id persists before `session/set_config_option`, so a rejected model or
mode option fails the boot without stranding a fresh Agent-side conversation.

## Related documentation

These mappings describe the adapter contract, not compatibility with every CLI release. Protocol fixtures, real CLI checks, model access and host UI acceptance cover different scopes. Record versions and results in PRs or release documentation.

- [Driver package and Agent overview](README.md)
- [Agent contribution guide](ENGINE_INTAKE.md)
- [Shared ACP core](src/acp/README.md)
- [DSH native and standalone ACP](src/dsh/README.md)
- [ZCode](src/zcode/README.md)
- [CodeBuddy](src/codebuddy/README.md)
- [Qoder](src/qoder/README.md)
- [Pi](src/pi/README.md)
