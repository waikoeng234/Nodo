# Manual probes

These scripts drive real Agent CLIs or a real DSH host. They are not part of `npm test` and may need an installed CLI, a logged-in account, or macOS Desktop.

Run from `orchestrator/`:

```sh
node scripts/manual/check-dsh.mjs
node scripts/manual/check-zcode.mjs zcode
node scripts/manual/check-es03.mjs
```

`check-native-dsh.mjs` loads `native-ui-probe.mjs`, the three `native-*-probe` files and the two `native-*-client.cjs` browser fixtures. Keep them in this folder.

Build and automated checks stay one level up: `build-client.mjs`, `check-drivers-build.mjs`, `verify-engine.mjs`.
