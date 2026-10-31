# Agent intake and capability extension

This guide is for contributors adding Agent adapters or extending existing Agent capabilities. See [PROTOCOL.md](PROTOCOL.md) for driver interfaces and event definitions; [src/spi.ts](src/spi.ts) is authoritative for required primitives and optional methods.

Adapters use only public Agent protocols and capabilities. Declare unsupported features explicitly. Distinguish protocol documentation, automated tests, and real-environment verification when reporting the basis for support.

## Adding an Agent

1. **Confirm the protocol and session behavior.** Record the CLI version, public protocol sources, launch and authentication requirements, and session creation, restoration, and writer ownership. Claims of sharing sessions with the Agent's own application require verification of the same session ID and live observation.
2. **Implement the driver.** Add `index.ts` and a README under `src/<engine>/`. Implement the eight required SPI primitives and provide `info/create/validate/check`, plus optional entries such as `scan/commands` where supported. ACP drivers reuse the [shared ACP core](src/acp/README.md); other JSON-RPC protocols can reuse `src/json-rpc-process.ts`.
3. **Register the Agent.** Register the driver and metadata in `ENGINES` in [src/index.ts](src/index.ts). Reuse the common configuration form and model picker. Keep Agent-specific launch, configuration, and compatibility logic in its own directory.
4. **Add tests.** Add `../test/<engine>.test.js` and `../test/fixtures/<engine>-cli.cjs`. Cover final replies and cancellation through the driver tests.
5. **Verify and submit a PR.** Run automated checks through the `--route new` entry below. Describe the support scope, test results, and real-environment verification in the PR.

Optional brand icons go in `../src/client/assets/engines/<engine>.svg` and are discovered by the build; otherwise a generic icon is used. Update the [third-party notices](../THIRD_PARTY_NOTICES.txt) when adding assets.

## Extending an existing Agent

1. Describe the affected capability, supported versions, protocol sources, and behavior when unsupported.
2. Update the owning driver's implementation, capability declarations, and README, following existing events and host mappings.
3. Add targeted tests for success and refusal paths. For streaming or interaction changes, check incremental updates, snapshots, duplicate events, cancellation, and restoration boundaries.
4. Verify with `--route capability --capability <scope>`. Add `--shared acp` when changing the shared ACP core; changes to other shared modules must also cover affected consumers.

Reverify the relevant baseline scenarios when session creation, restoration, or cancellation behavior changes. Capability declarations must match the implementation. New public interfaces or events require corresponding SPI, protocol documentation, and test updates.

## Registration metadata

In addition to the driver entry, `ENGINES` supports the following metadata:

| Field | Purpose |
| --- | --- |
| `name` | Product display name; defaults to `info.label` |
| `shared: ['acp']` | Identifies a shared protocol core so the verification entry can select regression coverage |
| `tests` | Overrides the default `test/<id>.test.js` test name for nonstandard layouts |

`engineMetadata()` supplies registration data to client builds and verification scripts. See the [driver package overview](README.md) for optional entries such as model scanning.

## Automated verification

Install dependencies in `orchestrator/` before running these commands. Run `npm run build` first after changing driver code, client code or Agent display names.

```sh
# New Agent: check all capability scopes
npm run verify:engine -- --engine <id> --route new

# Capability extension: --capability can be repeated
npm run verify:engine -- --engine <id> --route capability --capability interaction --capability stream

# Shared ACP core change: include all registered consumers
npm run verify:engine -- --engine opencode --route capability --capability interaction --shared acp

# Show the check plan only
npm run verify:engine -- --engine <id> --route new --plan
```

| `--capability` | Verification scope |
| --- | --- |
| `session` | Session creation, restoration, and isolation |
| `models` | Model and thinking-level scanning and selection |
| `identity` | Role identity, identity files, and identity MCP |
| `interaction` | Approvals, questions, steering, and cancellation |
| `stream` | Streaming, status, usage, file changes, and restored display |
| `attachments` | Images and ordinary file inputs |
| `commands` | Command and skill catalogs |

The entry combines tests for the selected driver, shared core, and capabilities, and finally checks client build consistency. Failures return a nonzero status; `--plan` only lists the plan.

The automated entry uses protocol fixtures and a mock host. It does not install dependencies or start real CLIs or models, and does not replace real-environment verification.

## Verification and PR requirements

Describe the purpose, protocol sources and versions, supported and unsupported capabilities, and commands actually run with their results. Explicitly mark checks not run, and redact logs and screenshots.

Use isolated workspaces and configuration for real-environment verification. At minimum, check the affected scenarios:

- Initialization, the first send, two consecutive turns in one session, and isolation of multiple sessions in one workspace.
- Restoration of the original session ID, workspace, and context after restarting; verify shared-native-session claims separately.
- Role identity, model, thinking-level, and permission settings taking effect or being explicitly rejected.
- Supported approvals, questions, cancellation, attachments, commands, and compaction.
- Live and restored display and final replies.

Report protocol fixtures, real CLIs, local mock models, production models, and host UI verification as separate scopes. `check().ok` only indicates a successful environment check; it does not prove authentication, model access, or the complete integration works.
