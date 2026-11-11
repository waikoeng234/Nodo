# Nodo plugin

Nodo is a dsh plugin that puts several native coding Agents in one workbench: roles bound to an Agent CLI, teams with a lead, and project conversations with files, terminals and a browser. This directory is the plugin package the host loads.

## Package layout

| Path | Contents |
| --- | --- |
| `index.js` | Plugin entry: resolves the data home, then installs the core modules and the dsh-only host modules |
| `core/src/` | Host modules: store, workspaces, worktrees, roles, sessions, dispatch, approvals, teams, tasks, flow, lead, decisions, triggers, worker input, the worker report channel, and the HTTP channel |
| `core/shared/` | Data and pure logic shared by host and client: routing, lead rules, role presets, task types, avatar templates |
| `src/host/` | dsh-only modules: native session status, the `/api/nodo` route, and project terminals |
| `src/client/` | Browser half: sidebar, roles and teams pages, conversations, lead round view, right sidebar, styles |
| `remote-access/` | macOS Tailscale Serve setup, loopback gateway, and system QR encoder; independent of Agent and Nodo task logic |
| `client.js` | Generated browser entry; built from `src/client/`, never edited by hand |
| `agent-drivers/` | Embedded Agent adapter package (TypeScript, compiled `dist/` committed) |
| `scripts/`, `test/` | Build, check and verification scripts; automated tests with simulated Agent CLIs |
| `cordis.patch.yml` | dsh bundle declaration |

## Phone access

On macOS DSH Desktop, open **Nodo 设置 → 手机远程**. Install Tailscale on the computer and phone, sign in to the same account, and connect both devices. Click **启用手机远程**, authorize HTTPS certificates if prompted (leave optional Funnel disabled), then return and continue. Click **连接手机** and scan the QR code in the phone browser. No separate `dsh web` process is required. Keep Desktop running and the computer online and awake. Tailscale replaces an active Android VPN.

The login link grants owner access to the entire DSH host; do not share it. After a Desktop restart, generate a new link if the browser asks for authentication. **关闭远程访问** removes only this feature's root forwarding. Disabling or uninstalling the plugin stops its local proxy; turn remote access off first to remove the persistent Serve configuration too.

## Teams and leads

Roles can join several teams. Each team has its own task types and at most one lead; each type names the role that takes it (delegation stops if none is set), optionally with its own model and thinking level, and can name a different role for hard tasks. A type can be marked independent: it never reuses an executor session that ran other work. The built-in review and test types carry that mark; existing teams can toggle it per type on the task assignment page.

Only Claude Code and Codex can lead. A lead leads one team and belongs to no member list. A new team starts with no task types, so add types on the task assignment page before delegating.

Only a lead conversation started in the team view routes work. The `nodo_lead` MCP service exposes exactly three tools: `nodo_board` reads roles, delegations, tasks, decisions and open task cards; `nodo_context` reads existing material; and `nodo_route` performs `new`, `attach`, `stop` or `ask`. A lead has no task-body or acceptance command. It selects a team type and difficulty, and gives `scope.quote` as an exact substring of the current user original, or one unmarked line of at most 100 UTF-16 units in `scope.note`. A title is optional and limited to 80 units; it is not a worker instruction.

New tasks bind the current pending user trigger, initialize `task.flow`, and return task and execution ids immediately; that execution is dispatched after this lead turn ends successfully and is cancelled when the turn fails or stops. Retry rounds have no trigger and cannot create or supplement tasks. `parentId` and `dependsOn` belong to this coordinator; dependencies must be done and parents unaccepted. `continues` creates another task from an ended source execution, stores `task.source.continuesTaskId`, and keeps the source directory. It cannot combine with those relation fields, and a conflicting `worktree` is refused. Nodo chooses whether the role, difficulty, directory and session history allow reuse. `worktree:true` creates a directory from the coordinator workspace HEAD; Nodo never merges it.

Worker input always comes from `composeWorkerInput({ executionId })`: verbatim user originals, attachment references, fixed task scope, a note of files later tasks touched since the session's last execution, stage, bounded prior conclusions and history. Dependency results and linked decisions include summaries and handles; an accepted dependency also hands over its acceptance, and its result stays archived under `.nodo/workflow-inputs/`. There is no leader-selected `context` field. `attach` merges queued input, steers or queues a running implementation, queues review-time supplements, opens rework and withdraws an open acceptance card, or records a later requirement on a task still waiting for its dependencies so its first execution carries it. Frozen or stalled tasks reject attachment. An unconfirmed execution must settle before another attachment can be delivered.

A coordinator keeps at most five active executions and accepts at most 24 routes per round. A task whose `dependsOn` tasks are not done waits as `pending` and is dispatched by Nodo once they are. Results are read with `nodo_board` and `nodo_context`; they are not sent to the lead. Workers report through the `nodo_worker` MCP: `nodo_report` carries outcome, summary, changed files, verification results, issues, and the review flags, verdict/findings or answers its stage requires, while a read-only `nodo_context` exposes the execution's own records and whitelisted transcript handles. Engines without an accepted mount — and dsh native sessions, which have none — get stage-specific text reporting instead: a review execution must then open with `结论：通过` or `结论：不通过`, and a review that cannot read that line stalls. The parse takes the first non-empty line and tolerates markdown decoration at its edges (emphasis, backticks, list/quote/heading markers, wrapping quotes or brackets) plus full/half-width colons with spacing; synonyms, trailing punctuation, prose on the line, or the conclusion on a later line still count as no conclusion. When an execution ends the program advances the flow itself, without a lead turn: it dispatches the type's independent review when the report calls for one (flagged risks, missing or unpassed verification, missing flags, or rework after a failed review), reruns rework on a fail verdict, and otherwise marks the task done, which releases its dependents, and opens the acceptance card for the user.

**User decisions.** A choice that changes the goal, adds scope, changes compatibility or crosses the authorization boundary is not the lead's to make: the lead calls `nodo_route action=ask` and ends its turn. Nodo stores the request as `pending` and pauses the team session — no new delegation, no unsent dispatch, no automatic retry, no report wake-up, no acceptance of the related tasks and their parents (any task in the session when nothing is linked), and no archival — cancels delegations not yet sent, and interrupts only the executions the lead names in `stopExecutionIds`. The user answers or cancels in a card in the team conversation: it shows each option's cost, the recommendation with its reason, the linked tasks and the live state of the executions still running or stopping, and keeps an unsent draft across reloads. An answer stays `answered` and blocking until it starts a real new lead turn (`delivered`); the lead then re-plans and dispatches again. Cancelling records a note in the conversation, approves nothing and restores no old dispatch. A lead can neither answer nor cancel on the user's behalf.

**Task cards.** The flow asks the user through cards on the coordinator session. A task has at most one open card, it blocks only that task, and cards survive restarts. An acceptance card opens when the flow needs no further review — either no review was called for, or the review passed — and recommends 接受 only when the latest implementation and its review report no failed verification. It shows the scope as given, a summary of the original request, each stage's outcome and conclusion with one evidence handle per execution, and a count of review findings that name a risk flag the implementation did not report; 接受 completes the task, and 退回 requires a reason and starts rework from it without a lead turn. An acceptance the invariants refuse becomes a stall card naming the gaps. A stall card states its cause, updates in place when the cause changes, and offers 重试 — rerun the review (rechecking a missing review type first), recheck acceptance, or restart the stage — plus 终止; stalls that only mark a limit reached (rework limit, execution cap) offer 终止 only. Stopping a task also stops the tasks still waiting on it.

**Host API.** The client reads and answers cards over `POST /api/nodo`: `card-list` returns every card of one coordinator session (`profile` and `session`), answered ones included; `card-get` reads one card by `cardId`; `card-answer` submits `accept`, `return` (with `reason`), `retry` or `stop` for a card id and returns the updated card. An answer must be one of the card's own options; a return reason becomes the rework trigger.

Failures stay visible instead of being guessed at:

- A turn with no engine activity for 120 seconds, or longer while the Agent announces a retry, is marked 疑似卡住 in the sidebar, the run status and a lead's round view. Nodo keeps waiting and the stop button stays available.
- A stop the engine does not confirm within 15 seconds is settled as an unconfirmed interruption, shown as 结果未确认, and frees that delegation's slot.
- Transient errors that Codex, Claude Code, Qoder or OpenCode classify as retryable continue in the same session up to five times, 30 seconds apart; stopping the executor, a lead interrupt, a message in that session or a pending user decision cancels continuation.
- If an unfinished executor session is continued manually in Nodo and finishes with a confirmed `done`, Nodo sends one supplemental report; later ordinary chat does not report again.

## Right sidebar

Nodo conversation pages, legacy conversation shells before a session exists, and draft welcomes with a selected project browse the working directory, including worktrees, preview text, Markdown and images, open several terminals when the host provides subprocess support, and open HTTP(S) pages in a browser — through the desktop host's webview when available, otherwise an iframe. Read-only pages keep files, changes and the browser without terminal controls.

`查看变更` in a file-changes card opens the turn's file list in one replaceable 变更 tab, where each row opens its diff; hovering still previews it in a popup. Tabs survive switches within the same actual directory during the current page load; after a refresh terminals reconnect with their buffered output, while file, changes and browser tabs are gone. Terminals are shared by actual working directory and end when closed, when no live project or unarchived conversation references that directory, or when the plugin unloads. Native welcomes and Nodo sessions opened in the native conversation view keep dsh's native right sidebar.

## Links

- [Project home](../README.en.md): features, installation, and usage.
- [Development guide](../docs/development.md): building, testing, adding Agents, and submitting PRs.
- [Architecture guide](../docs/architecture.md): code structure, message paths, and data storage.
- [Agent adapter overview](agent-drivers/README.md): driver interfaces and the intake process.

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for copyright information and [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) for third-party dependencies, host UI components, and assets.
