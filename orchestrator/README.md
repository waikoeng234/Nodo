# Nodo plugin

Nodo is a multi-Agent workbench plugin for DeepSeek Harness (dsh). It brings Agents such as Claude Code and Codex into one interface, with role assignments, project conversations, and visual workflows.

Enable the 主控 switch in a role's settings to let it delegate tasks. Each task opens a conversation in the lead's workspace, and the executor's report returns to the lead as a conversation reference. The executor is picked from the task types and difficulty each role accepts, and roles and task types are managed on the roles page.

This directory is the plugin package loaded by the host. It embeds the `agent-drivers` Agent adapter layer.

- [Project home](../README.en.md): features, installation, and usage.
- [Development guide](../docs/development.md): building, testing, adding Agents, and submitting PRs.
- [Architecture guide](../docs/architecture.md): code structure, message paths, and data storage.
- [Agent adapter overview](agent-drivers/README.md): driver interfaces and the intake workflow.

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for copyright information and [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) for third-party dependencies, host UI components, and assets.
