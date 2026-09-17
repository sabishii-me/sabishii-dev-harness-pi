# sabishii-me-harness-pi — the pi plugin

pi is a coding-agent harness; its runtime is the official `@earendil-works/pi-coding-agent` release. The adapter speaks the runtime's own headless protocol over stdio — the harness's TUI is never involved.

This repository is one harness plugin for
[`sabishii-me-agent-hub`](https://github.com/sabishii-me/sabishii-me-agent-hub): the
adapter that drives pi, its manifest, the harness-side extensions it installs,
and (where the harness needs one) the preset definitions it applies. The hub's
`docs/PROTOCOL.md` is the contract this adapter implements.

```
manifest.json          id, command, runtime pin, extensions, capabilities
pi-adapter.cjs      the adapter (adapter-v1 over stdio)
extensions/            agent-presets, plan
presets/               preset definitions (standard, heavy-review)
```

* runtime: `@earendil-works/pi-coding-agent@0.85.1` → `node runtime/dist/cli.js` (materialised under `runtime/`, not committed)
* protocol: adapter-v1, version 0
* capabilities declared: models, presets, plan, review, fork, stats, compact, rename, skills

## How the hub uses this directory

The hub never contains harness code. A deployment points it at a plugins directory
(`AGENT_HUB_PLUGINS_DIR`, default `<hub>/plugins`); the hub scans it for directories with a
`manifest.json`, and this directory *is* the plugin:

| what | who reads it |
| --- | --- |
| `manifest.json` | the hub: id, `command`, the runtime pin, the extension ids, and the capabilities this adapter implements |
| `pi-adapter.cjs` | the hub spawns it (`command`) and speaks `adapter-v1` with it |
| `extensions/<id>/` | the hub copies the ids the manifest declares into that harness's own data dir and hands the adapter the path (`AGENT_HUB_INSTALLED_EXTENSIONS_DIR`); the adapter places them where its harness reads extensions |
| `presets/` | the adapter, which lists them for `presets` and writes the chosen one where its harness-side extension reads it (`AGENT_HUB_PRESETS_DIR`) |
| `runtime/` | the harness itself — an official npm release, **never committed** (`.gitignore`) |

The runtime is materialised from the manifest's pin — by THIS ADAPTER, through its
`runtime/prepare` method, so "which version runs" is answered here and nowhere else:

```
POST /v1/hub/plugins/pi/prepare        # asks this adapter; answers {ready, package, version, target, detail}
```

The hub also asks for it by itself, before the first `session/start`, whenever the
declared command is not on disk yet — so a freshly installed plugin simply works: the
session waits for the install instead of failing. The hub installs no harness itself and
knows no package names.

A hub started against a plugins directory that contains this one lists `pi` in
`GET /v1/harnesses`, and the hub's boot self-check validates this manifest against
`contract/adapter-v1.json` (declared fields, protocol version, capability ⇔ adapter
method) before it serves anything.

## Changing it

This repository is the plugin's home: edit here, commit, push. A deployment that
composes plugins pins a commit (later a tag) of this repository and bumps the pointer
there. The harness's own protocol quirks live in the adapter and belong to whoever
tracks that harness.
