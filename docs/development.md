# Development guide

This guide is for contributors modifying Nodo source code or submitting PRs. See the [architecture guide](architecture.md) for the code structure and runtime behavior.

## Environment

- Node.js 24 or later, and npm.
- A working dsh 0.2.0-rc.1 or later.
- The relevant Agent CLI and authentication configuration when real-environment verification is needed.

## Build and load

All plugin code is in `orchestrator/`. Run the following commands in that directory:

```sh
npm ci --ignore-scripts
npm run build
npm run build:check
```

When installing a third-party plugin on the dsh plugin page, enter the local path to `orchestrator/`. Reload the plugin and page after changing the code.

`agent-drivers/` is written in TypeScript; `npm run build` compiles it into `agent-drivers/dist/`, which is committed with the source. Do not edit `dist/` manually.

`client.js` is the browser entry generated from `src/client/` and `core/shared/`. The host loads it directly, so include it with the source in your commit. Do not edit `client.js` manually. After changing client source, run `npm run build`, then `npm run build:check` to confirm the generated file is current.

## Testing

Run only the test files relevant to your change:

```sh
node --test test/workflow-client.test.js
```

Run the full suite before submitting:

```sh
npm test
```

Automated tests do not depend on real Agents: `test/fixtures/` contains simulated Agent CLIs, and `test/helpers/` provides a mock host and reference drivers. Real CLI verification and host UI acceptance must be performed separately and reported separately in the PR. Passing protocol fixtures does not replace real-environment verification.

## Adding or extending an Agent

Follow the [Agent intake workflow](../orchestrator/agent-drivers/ENGINE_INTAKE.md) and use the corresponding verification entry point:

```sh
npm run verify:engine -- --engine <id> --route new
npm run verify:engine -- --engine <id> --route capability --capability <scope>
```

See the [Agent adapter overview](../orchestrator/agent-drivers/README.md) and [driver interface and event protocol](../orchestrator/agent-drivers/PROTOCOL.md) for the driver interfaces.

## Development conventions

- **Use only public Agent interfaces.** Do not modify Agent programs or read or write their private files. Explicitly mark capabilities the Agent does not expose as unsupported.
- **Follow existing module boundaries.** Host modules register through `install(rt)` and call each other only at runtime through `rt`; see [host modules](architecture.md#host-modules).
- **Follow the design system.** [DESIGN.md](../DESIGN.md) defines the palette, type scale, spacing, corners, and motion rules; use its tokens and the `.nodo-tag` label component instead of raw values or new badge classes.
- **Keep the code concise.** Do not introduce abstractions when a simple implementation works. Comments should explain only constraints the code cannot express.
- **Use mature libraries for general capabilities.** Do not implement formats, protocols, parsing, cryptography, dates, or similar low-level functionality from scratch.
- **Do not expose secrets.** Code, logs, tests, and PRs must not contain API keys, tokens, cookies, or contents of the plugin data directory.

## Submitting a PR

See the [contribution guide](../CONTRIBUTING.en.md) for the submission process and PR description requirements.
