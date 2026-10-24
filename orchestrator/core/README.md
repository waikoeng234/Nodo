# nodo-core

The host-side runtime of Nodo — workspaces, roles, conversations, dispatch, workflows and storage — as an embedded package shared by the dsh plugin (`../index.js`) and future hosts. The dsh plugin computes the data home and adds the dsh-specific modules (native session status, HTTP route) on top.

## createRuntime(host, config, plugins = [])

Installs the core modules in a fixed order, then each entry of `plugins` (a module exporting `install(rt)`), recovers unfinished workflow runs and returns the runtime. `config` must carry `home`, the data directory. `host` needs at least `effect` and `logger` (as in `test/helpers/host.js`); every other native capability is optional and simply inactive when absent.
