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

Roles can join several teams. Each team has its own task types and at most one lead; each type names the role that takes it (delegation stops if none is set), optionally with its own model and thinking level, and can name a different role for hard tasks.

Only Claude Code and Codex can lead. A lead leads one team and belongs to no member list. A new team starts with no task types, so add types on the task assignment page before delegating.

Only a lead conversation started in the team view delegates. It uses Nodo's MCP service `nodo_lead`, which Nodo serves over a private socket with one token per session: `nodo_board` reads the role and delegation tables, `nodo_delegate` dispatches a task or replaces the current one, and `nodo_interrupt` stops only a task this lead session dispatched. A lead conversation opened as an ordinary 1:1 chat never delegates and may use plan mode.

A delegation creates a conversation in the lead's workspace for the assigned role and task type. Only one runs at a time, the report must be delivered before the next starts, and a lead turn accepts at most 12. A follow-up can continue the same session, at most twice, while the difficulty and role still match; otherwise a new session gets the existing changes and remaining work in its brief.

When the executor ends, its final reply becomes a conversation reference and the report reaches the lead as a message carrying that reference; a failed snapshot falls back to inline text. Delegations and reports appear round by round in the lead's page, each dispatch as a chip, with 查看会话 opening the executor conversation. On the dsh engine, sessions are not merged and stay as ordinary conversations.

Failures stay visible instead of being guessed at:

- A turn with no engine activity for 120 seconds, or longer while the Agent announces a retry, is marked 疑似卡住 in the sidebar, the run status and a lead's round view. Nodo keeps waiting and the stop button stays available.
- A stop the engine does not confirm within 15 seconds is settled as an unconfirmed interruption, shown as 结果未确认, and frees the delegation slot.
- Transient errors that Codex, Claude Code, Qoder or OpenCode classify as retryable continue in the same session up to five times, 30 seconds apart; stopping the executor, a lead interrupt or a message in that session cancels continuation.
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
