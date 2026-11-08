# Nodo plugin

Nodo is a dsh plugin that puts several native coding Agents in one workbench: roles bound to an Agent CLI, teams with a lead, and project conversations with files, terminals and a browser. This directory is the plugin package the host loads.

## Package layout

| Path | Contents |
| --- | --- |
| `index.js` | Plugin entry: resolves the data home, then installs the core modules and the dsh-only host modules |
| `core/src/` | Host modules: store, workspaces, worktrees, roles, sessions, dispatch, approvals, teams, lead, and the HTTP channel |
| `core/shared/` | Data and pure logic shared by host and client: routing, lead rules, role presets, task types, avatar templates |
| `src/host/` | dsh-only modules: native session status, the `/api/nodo` route, and project terminals |
| `src/client/` | Browser half: sidebar, roles and teams pages, conversations, lead round view, right sidebar, styles |
| `client.js` | Generated browser entry; built from `src/client/`, never edited by hand |
| `agent-drivers/` | Embedded Agent adapter package (TypeScript, compiled `dist/` committed) |
| `scripts/`, `test/` | Build, check and verification scripts; automated tests with simulated Agent CLIs |
| `cordis.patch.yml` | dsh bundle declaration |

## Teams and leads

Roles can join several teams. Each team has its own task types and at most one lead; each type names the role that takes it (delegation stops if none is set), optionally with its own model and thinking level, and can name a different role for hard tasks. A type can be marked independent: it never reuses an executor session that ran other work. The built-in review and test types carry that mark; existing teams can toggle it per type on the task assignment page.

Only Claude Code and Codex can lead. A lead leads one team and belongs to no member list. A new team starts with no task types, so add types on the task assignment page before delegating.

Only a lead conversation started in the team view delegates. It uses Nodo's MCP service `nodo_lead` with one credential per session: `nodo_board` reads roles, delegations, this coordinator's tasks and its decisions; `nodo_delegate` accepts a new task or a follow-up execution and returns `taskId`, `executionId`, `queued` status and `continued` before sending after the lead turn; `nodo_interrupt` stops a specific execution (or an unambiguous legacy session); `nodo_decision` asks the user for a choice that current instructions do not authorize; and `nodo_task` completes a task with a reason and result references, reopens a finished task, revises its title, brief, parentId and dependsOn while it is not finished, or reviews a report the lead has just received (`review` with `continue` or `investigate`, `reason` and `basis`). Execution completion and task acceptance are separate steps. A lead conversation opened as an ordinary 1:1 chat never delegates and may use plan mode. New tasks may specify `parentId` and `dependsOn` within the same coordinator; dependencies must all be `done` before dispatch, and all children must be `done` before parent acceptance. A follow-up with `taskId` must omit both relationship parameters; use `nodo_task revise` to change them (`parentId:""` and `dependsOn:[]` clear them). A new task may pass `continues: <taskId>` to build on another task's result. `continues` decides the executor session and directory only: it stores no relation and adds no ordering, so pass `dependsOn` when the next step must wait, and a source task that is still executing is refused. Whether the executor session is actually continued is Nodo's decision, reported in the receipt with a reason when it is not. A fresh session then receives the source task's last finished execution result as required context, or as background material when it is too large; when no usable result exists, the receipt message says so and the task must carry the context itself. Status changes do not propagate. Before acceptance, use the existing rules to decide whether independent review is needed, without repeating completed reviews.

A delegation creates a conversation in the lead's workspace for the assigned role and task type. A lead session keeps up to 5 delegations running in parallel and one lead turn accepts at most 24; independent tasks can be dispatched in the same turn, while changes with order dependencies use `dependsOn`. Executor reports are delivered one by one in dispatch order between lead turns — a lead that is mid-turn, waiting for an answer or compacting context postpones them — and a report still queued never holds back a dispatch that was already accepted. A report that has just been delivered does block new delegations until the lead reviews it or attaches it to a user decision. Nodo decides whether a follow-up continues the same executor session, at most five executions per session, while the role, difficulty and directory still match; otherwise a new session opens and receives the previous finished result. Tasks that would edit the same files as running delegations take `worktree:true` and then run in their own Git worktree and branch; the task keeps that directory across executions, and Nodo leaves merging to you or to a follow-up task without isolation.

When the executor ends, its final reply becomes a conversation reference and the report reaches the lead as a message carrying that reference; a failed snapshot falls back to inline text. Delegations and reports appear round by round in the lead's page, each dispatch as a chip, with 查看会话 opening the executor conversation. On the dsh engine, sessions are not merged and stay as ordinary conversations.

**User decisions.** A choice that changes the goal, adds scope, changes compatibility or crosses the authorization boundary is not the lead's to make: the lead calls `nodo_decision` and ends its turn. Nodo stores the request as `pending` and pauses the team session — no new delegation, no unsent dispatch, no automatic retry, no report wake-up, no acceptance of the related tasks and their parents (any task in the session when nothing is linked), and no archival — cancels delegations not yet sent, and interrupts only the executions the lead names in `stopExecutionIds`. The user answers or cancels in a card in the team conversation: it shows each option's cost, the recommendation with its reason, the linked tasks and the live state of the executions still running or stopping, and keeps an unsent draft across reloads. An answer stays `answered` and blocking until it starts a real new lead turn (`delivered`); the lead then re-plans and dispatches again. Cancelling records a note in the conversation, approves nothing and restores no old dispatch. A lead can neither answer nor cancel on the user's behalf.

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
