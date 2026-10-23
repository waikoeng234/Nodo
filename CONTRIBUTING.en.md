# Contributing

[简体中文](CONTRIBUTING.md) | English

Thank you for helping improve Nodo. Issue reports, documentation corrections, bug fixes, and new Agent integrations are welcome.

## Reporting issues

Before opening an issue, search for an existing report of the same problem. Include:

- Steps to reproduce, expected behavior, and actual behavior.
- Versions of your operating system, dsh, Nodo, and the relevant Agent.
- Relevant logs or screenshots.

Redact logs and screenshots first. Do not include API keys, tokens, cookies, authentication configuration, or contents of the plugin data directory.

## Suggesting features

Describe the problem and use case in an issue, rather than only proposing an implementation.

Nodo uses only public Agent interfaces. Features that require changing an Agent program or relying on its private interfaces will not be accepted.

## Contributing code

1. **Discuss the change in an issue first.** Open an issue before adding dependencies, changing public interfaces or data formats, or making substantial feature changes. Small fixes and documentation changes can go directly to a PR.
2. **Fork and create a branch.** Branch from `main`. Keep each PR focused on one change, without unrelated formatting or refactoring.
3. **Develop and test.** See the [development guide](docs/development.md) for the environment, build, testing, and coding conventions, and the [architecture guide](docs/architecture.md) for the code structure. Follow the [Agent intake workflow](orchestrator/agent-drivers/ENGINE_INTAKE.md) when adding or extending an Agent.
4. **Rebuild after client changes.** After changing `src/client/` or `src/shared/`, run `npm run build` and include the generated `client.js` in your commit.
5. **Submit a PR.** Describe:
   - The scope and reason for the change, and any related issue.
   - Tests actually run and their results.
   - Whether you verified with a real Agent or the host UI; state explicitly when you have not.

## License

Contributions to this repository are licensed under [Apache-2.0](LICENSE), consistent with the project itself.
