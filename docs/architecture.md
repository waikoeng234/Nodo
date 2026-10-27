# Architecture guide

This document describes Nodo's code structure and runtime behavior for contributors modifying the source. For a user-facing explanation, see [How it works in the README](../README.en.md#how-it-works). See the [development guide](development.md) for the development workflow.

## Overview

Nodo is a dsh plugin with three parts:

- **Host** (`index.js`, `core/`, `src/host/`): runs in the dsh process, manages projects, roles, conversations, approvals, and workflows, and starts Agents.
- **Client** (`client.js`, generated from `src/client/`): runs in the dsh web interface and mounts the sidebar, conversation panel, and workflow canvas into host-provided UI slots.
- **Agent adapter layer** (`agent-drivers/`, TypeScript compiled to the committed `dist/`): normalizes public Agent protocols into a common driver interface.

```mermaid
flowchart LR
    UI[dsh UI<br/>client.js] -->|DSH conversations| S[dsh session controller]
    UI -->|POST /api/nodo| C[channel.js]
    C --> H[Host modules<br/>Conversations · Workflows · Approvals]
    S --> ESH[DSH native agent]
    H --> D[drivers.js]
    D --> AD[agent-drivers]
    AD --> E[Codex · Claude Code · OpenCode …]
    H --> F[(Plugin data directory)]
    H --> P[(Project directory .nodo/)]
```

## Directory structure

```text
orchestrator/
  index.js             dsh plugin entry: data home, then core plus the dsh-only modules
  core/                Embedded host package: host modules under src/, plus shared/ used by host and client
  src/host/            dsh-only host modules: native session status and HTTP route
  src/client/          Sidebar, conversations, settings, and workflow UI
  agent-drivers/       Agent registration, protocol adapters, and capability interfaces
  scripts/             Build, check, and verification scripts
  test/                Automated tests, simulated CLIs, and test helpers
  client.js            Generated browser entry
  cordis.patch.yml     dsh bundle declaration
```

## Host modules

Each module under `core/src/` exports `install(rt)` and attaches its functions to the shared `rt` object. `MODULES` in `core/src/index.js` loads modules in order: `diag` comes first and provides the shared `rt.warn`; `channel` comes last and exposes interfaces over the other modules. The dsh plugin's own modules (`src/host/native-status.js`, `src/host/route.js`) install after the core modules. Modules do not call each other during installation; they interact through `rt` only at runtime.

| Responsibility | Modules |
| --- | --- |
| State and data | `store` (`state.json` reads and writes), `home-lock` (single-writer lock), `runs` (workflow run records), `secrets` (credentials and redaction) |
| Projects and roles | `workspaces` (project directories), `worktrees` (Git worktrees), `profiles` (roles), `sessions` (conversations) |
| Agent bridging | `drivers` (driver process lifecycle), `engine-settings` (Agent settings), `dispatch` (sending, steering, and queuing messages), `approvals` (approval cards) |
| Conversation content | `prompt` (rendering role briefs, references, and handoffs), `session-references` (conversation references), `attachments` (images and attachments), `stream-records` (tool details), `stats` (conversation statistics), `context`, `native-status` (plugin module in `src/host/`) |
| Workflows | `workflows` (definitions and execution), `workflow-materials` (writing handoff materials to disk) |
| Interface | `channel` (answers `POST /api/nodo`, called by the client), `route` (plugin module in `src/host/`, registers the HTTP route) |

## Message paths

**Agent conversations.** Codex, Claude Code, Qoder, Pi, ZCode, OpenCode and CodeBuddy use their own drivers through `drivers.js` and `dispatch.js`. Nodo displays their messages, tool activity and approval cards in its Feed. These roles do not register dsh model providers or Agent presets.

**DSH conversations.** The dsh driver uses the host's public native session controller. Its `driverSessionId` identifies the native conversation, which opens in the host view. Native status and references use that same identifier.

**Workflow steps.** `workflows.js` creates a separate conversation for each execution step and sends its task exclusively through `rt.send`; `dispatch.js` passes it to the role's driver. `workflow-materials.js` writes the previous step's reports and human decisions under the project's `.nodo/`, and `prompt.js` renders them into the next task. Client messages sent through `channel.js` also use `rt.send`.

## Client

`scripts/build-client.mjs` bundles `src/client/` (ESM, plus `core/shared/` data) into `client.js` with esbuild and inlines assets such as icons. dsh loads `client.js` as a plain script. React and UI components are supplied by the host and are not bundled separately.

The client mounts its parts through host UI slots, including run status and references above the composer, conversation message nodes, and tool detail views. UI state such as drafts and navigation is saved in the browser's `localStorage`.

## Agent adapter layer

`agent-drivers/` is a separate package embedded in the plugin and can be patched and versioned independently. Each driver implements the same eight primitives: `openSession`, `sendTurn`, `steer`, `interruptTurn`, `respondToRequest`, `onEvent`, `hasSession`, and `dispose`. Agents are registered in `ENGINES` in `agent-drivers/src/index.ts`; the registration metadata also serves client builds and verification scripts.

See the [Agent adapter overview](../orchestrator/agent-drivers/README.md), [driver interface and event protocol](../orchestrator/agent-drivers/PROTOCOL.md), and [Agent intake workflow](../orchestrator/agent-drivers/ENGINE_INTAKE.md).

## Data storage

The plugin data directory defaults to `~/.dsh/orchestrator/`, or the `orchestrator/` subdirectory of `DSH_HOME` when set. It can also be specified through the plugin's `config.home`.

| Location | Contents |
| --- | --- |
| `state.json` | Projects, roles, conversation records, workflow definitions, and conversation statistics |
| `state.lock` | Write lock: only one dsh can write to the same data directory; other instances are read-only |
| `secrets.json` | Credentials, with mode 600; drivers receive them through `ORCH_SECRET_*` environment variables |
| `runs/` | One JSON file per workflow run |
| `attachments/`, `files/` | Pasted images and attachments |
| `references/` | Conversation reference snapshots |
| `stream-details/` | Tool call details |
| `identities/`, `drivers/`, `agents/` | Role identity files and working directories used by drivers |

`state.json` and run records are written through temporary files followed by renaming. The project's `.nodo/` stores workflow reports and attachment copies; Nodo automatically writes a `.gitignore` there.

Deleting a role marks it with `deletedAt` and archives its conversations; deleting a project archives the conversations that ran in it and records the original project name in `workspaceName`. Every archived conversation keeps its `cwd`, `workspaceRef`, and the role and project names it had. Transcripts, statistics, references, tool details, and identity files remain available. Deleted roles disappear from the lead roster, task routing, and workflow node validation, and no longer hold a name or a slot under the profile limit, so their names can be reused.

Archived conversations open read-only from the global 已移除 entry; the client requests no task and does not open or select the session on the engine, and the host refuses send, compact, select, update, and unarchive requests for them. Manually archived conversations in existing projects stay in that project's archive filter and also open read-only; unarchiving restores writing while the project still exists. Conversations saved before archival was recorded, with no `archivedAt` and no project, remain writable and are not migrated.

Before a role or project is deleted, the DSH twins of its conversations are archived through the host workspace registry; a failure rolls back the archives that call made and leaves Nodo's records unchanged. Hosts without that interface skip synchronization, and other engines' threads are retained without synchronization. A DSH conversation with no local transcript is read back through the host session inspect call.
