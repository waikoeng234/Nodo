# Nodo plugin

Nodo is a multi-Agent workbench plugin for DeepSeek Harness (dsh). It brings Agents such as Claude Code and Codex into one interface, with role assignments, project conversations, and visual workflows.

Create a lead under 主控 on the roles page to let it delegate tasks; a lead can be added only when at least one executor role exists, and it is created with the `leader` identity, which describes how it coordinates and accepts work. Each task opens a conversation in the lead's workspace, and rework or re-review can instead continue the executor's previous session; the executor's report returns to the lead as a conversation reference. A lead session and the executor sessions it opened share one sidebar row, and its page merges delegations and reports round by round — one message makes one round — with 查看会话 to open each executor session; sessions on the dsh engine are not merged and stay as ordinary conversations. The lead delegates only by task type and difficulty, and the executor is picked from the task types and difficulty each role accepts; a task type that no role accepts goes to the fallback role, which starts as the first executor role and can be moved to another executor role in that role's task-types setting. Roles and task types are managed on the roles page. Deleting a role or project archives its conversations, which stay readable from the 已移除 entry.

This directory is the plugin package loaded by the host. It embeds the `agent-drivers` Agent adapter layer.

- [Project home](../README.en.md): features, installation, and usage.
- [Development guide](../docs/development.md): building, testing, adding Agents, and submitting PRs.
- [Architecture guide](../docs/architecture.md): code structure, message paths, and data storage.
- [Agent adapter overview](agent-drivers/README.md): driver interfaces and the intake workflow.

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for copyright information and [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) for third-party dependencies, host UI components, and assets.
