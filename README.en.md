# dsh-compact-agents

<div align="center">

**Plugin for DeepSeek Harness: force-compact session context from the model itself (`compact_agents`)**

Force compaction ignoring the automatic threshold · Covers **every live session** in the process (main session / ordinary sub-agents / AgentTeams members alike) · The main session can compact itself even with no sub-agents · A busy target is queued and compacted the moment its turn ends · Per-target reporting of shadowed node count and estimated tokens · Only a top-level agent may sweep, sub-agent overreach is refused · Serial (non-concurrent) tool scheduling · Host-only plugin: no network, no persistence, no client bundle

[![version](https://img.shields.io/badge/version-0.1.0-4176E6)](https://github.com/zhuto666/dsh-compact-agents)

**v0.1.0**: first release. It supplies the model-side manual compaction entry point DSH was missing — `/compact` only serves interactive UI adapters, headless sub-agents and team members have no command surface, and a captain had no tool to compact them. See the [design notes](docs/design.md).

[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org)

**English** | [中文](README.md)

</div>

---

## Feature overview

| Capability | Entry / parameter | Description |
|---|---|---|
| Force compaction (**ignores the automatic threshold**) | `compact_agents(scope)` | Calls `ctx.compaction.compactNow`, whose contract reads *"Explicitly compact useful history **even below automatic pressure thresholds**"*. Automatic compaction waits for the threshold; this tool does not |
| Covers **every live session** | `scope: "others"` (default) / `"all"` | The range is `ctx.agents.list()` — the main session, ordinary sub-agents and AgentTeams members are treated **alike**; it is not limited to team members |
| The main session compacts itself | `scope: "self"` | **Works with no sub-agents at all**: the caller is always mid-turn, so it necessarily takes the queued path and is compacted when its own turn ends |
| Named targets | `scope: "ids"` + `ids: [...]` | Compacts only the listed sessions; unknown ids are reported separately instead of being silently dropped |
| Queue when busy | `whenBusy: "queue"` (default) | A target that is mid-turn is not abandoned: its `agent/status → idle` is watched and it is compacted **the moment that turn ends**. `"skip"` reports `busy` and leaves it untouched |
| Per-target reporting | return value `results[]` | Each target gets `compacted` / `queued` / `noop` / `busy` / `error`, plus shadowed node count and estimated tokens |
| Overreach protection | — | Only a **top-level** agent may sweep others; a sub-agent may only use `scope: "self"`, so members cannot compact each other or their captain |
| Serial scheduling | — | Registered as fail-closed `exclusive`: one sweep never runs alongside another call that might compact the same session. Timeout 30 minutes (queued work runs after the turn and is not covered by it) |
| Automatic threshold (companion) | `compaction-basic` config | This plugin does **not** change automatic policy; the installer also reports `thresholdRatio` (the DSH default 0.8 × 1M = 800K effectively never fires; 0.3 ⇒ 300K is recommended) |

## Why it is needed

DSH's only manual compaction entry point is the **human command** `/compact` (registered by `@deepseek-ai/dsh-command-compact` through `ctx.commands.register`, serving interactive UI adapters only). Consequently:

- headless **sub-agents / AgentTeams members** have no command surface and cannot run `/compact`;
- a **captain has no tool at all** to compact them — there is no `registerTool` anywhere under `packages/compaction/`;
- automatic compaction (`compaction-basic`) is **threshold-driven**: below the line, nothing happens.

So "sessions get more expensive the longer they run" used to be solvable only by **swapping people** (retire a member, spawn a new one). This plugin supplies the missing model-side entry point.

> A real lesson: one member session was re-sending roughly **400K tokens of context per call** by its 348th call — 140M cacheRead tokens, ¥10.87 — purely because nobody could compact it.

## Installation

> Requirements: Node.js ≥ 20 + DeepSeek Harness (a version that ships `agent-presets`).

### One-shot install (recommended)

```sh
git clone https://github.com/zhuto666/dsh-compact-agents.git E:/dsh-compact-agents
cd E:/dsh-compact-agents
node scripts/install.mjs --dry-run     # preview the changes first (touches nothing)
node scripts/install.mjs               # apply
```

The script does exactly two things, and is **idempotent**:

1. **Creates two directory junctions** so the plugin can resolve `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` — this project is deliberately **dependency-free** (no `node_modules` install). Node resolves junctions to their real path, so the plugin gets the **same module instance** as the host, with no duplicate-instance hazard.
2. **Appends one mount row** to the `compaction` isolate group of each preset:

```yaml
    - id: compact-agents
      name: 'E:/dsh-compact-agents/index.js'
```

It auto-discovers `$DSH_HOME/.agent-presets/*/agent.cordis.yml` and `$DSH_HOME/profiles/*/node_modules/@linxin666/*/presets/*/agent.cordis.yml`; use `--preset <file>` to name files explicitly, or `--dsh <checkout>` to point at the DSH checkout (auto-detected by default). A `.bak` backup is written before any edit, and presets without a `compaction` group are skipped.

**That path is not hard-coded — it is computed at install time.** `install.mjs` derives `PLUGIN_ENTRY` from its own location, so:

- wherever you clone or keep this project, that is what the row points at;
- **after moving or renaming the project, re-running `install.mjs` fixes it automatically**: a row pointing at a path that no longer exists is repaired outright; if the old path is still valid (say a second copy exists) it only warns, and `--force` repoints it.

```sh
node scripts/install.mjs --dry-run    # preview (touches nothing)
node scripts/install.mjs              # apply; repairs a stale path automatically
node scripts/install.mjs --force      # repoint even when the old path is still valid
```

> **Why can it not simply name a package, like an ordinary dependency?** That is DSH's own semantics, not laziness: a **bare package name in a preset row resolves from the harness installation** (`agent-presets/src/mount.ts`, `PresetTree.import`: *"a package name resolves from the harness base"*), not from the user directory, so a package installed in a workspace or home directory is simply not found. A third-party preset row therefore has exactly two options — an absolute path, or shipping the plugin file inside the preset directory. This project takes the first: **a single source of truth**, with no per-preset copies to drift.

### Activation

**Opening a new conversation is enough — no `dsh` restart required.** Preset edits hot-reload through the standing mount's **file stamp** (the `stat` `mtimeMs` + `size`): when the stamp changes, the next new session mounts a fresh generation and gets the tool. Sessions that are already composed keep the old generation because `select` / `swap` refuses with `agent-preset/locked`, exactly as designed.

> **To compact the members you already have, do not restart DSH** — a restart drops every member/sub-agent session (`ctx.agents.list()` only covers live sessions), leaving nothing to compact. Opening a new conversation leaves them untouched.

### Verifying the install

```sh
node scripts/validate-presets.mjs
```

It reports the mount row's location per preset, whether the referenced file exists, and `compaction-basic`'s `thresholdRatio` / `retainRatio`. Expected output:

```
.agent-presets/liangshen/agent.cordis.yml
  rows           = compaction-basic,command-compact,compact-agents,tool-result-pruner
  thresholdRatio = 0.3  retainRatio = 0.05
  compact-agents -> E:/dsh-compact-agents/index.js (存在)
ALL OK (4 preset mounted)
```

### Update / uninstall

```sh
git -C E:/dsh-compact-agents pull          # update: pull, then re-run install.mjs (idempotent)
node scripts/uninstall.mjs --dry-run       # uninstall: preview first
node scripts/uninstall.mjs                 # remove the mount row + delete the junctions it created
```

Uninstall removes only what it added: comments, `!!js` expressions and every other row in a preset are left alone (verified byte-for-byte round trip from installed back to original). The plugin directory and the `.bak` backups are kept; remove them yourself.

### Local development

```sh
node scripts/integration-test.mjs    # real-machine load test (real cordis Context + real ToolRuntime)
node scripts/deferred-test.mjs       # queue-then-compact behaviour test (fake ctx)
node scripts/selftest.mjs            # module import + defineTool spec self-check
```

Editing `index.js` **requires a `dsh` restart to take effect** — an easy trap:

- Node's **ESM module cache is keyed by URL**, and re-mounting a preset does **not** clear it (DSH's own HMR plugin can hot-reload only because it explicitly clears `internal.loadCache`, and it ships `disabled` in the profile);
- so "open a new conversation" only re-mounts the **preset**; the plugin module itself is still the copy already cached in the process;
- the `scripts/*.mjs` files are plain scripts executed fresh each time, so they are **not** affected.

> A new conversation is enough only when you changed `install.mjs` or a preset; **changing the plugin `.js` requires restarting `dsh`**.

## Usage

Called by the model (it is not a human command):

```
compact_agents(scope = "others" | "all" | "self" | "ids", ids?: string[], whenBusy = "queue" | "skip")
```

| scope | Meaning |
|---|---|
| `others` (default) | **Every live session** except the caller |
| `all` | **Every live session**, including the caller |
| `self` | Only the caller's own session — **works with no sub-agents at all** |
| `ids` | Only the sessions named in `ids` |

Typical prompts:

- "compact every other session" → `scope: "others"`
- "compact this conversation too" → `scope: "all"` (you are queued and compacted when this turn ends)
- "compact only myself" → `scope: "self"`

> **Model did not call it?** The tool description already says to call this **immediately** when the user asks to compress context, never to ask back first — but a model may still choose to confirm. The most reliable phrasing **names the tool**:
>
> ```
> call compact_agents with scope=all to compress every session
> ```
>
> The tool is independent of model behaviour: as long as it is in the tool catalog, naming it always executes.

One row is returned per target, for example:

```
compact_agents: 3 compacted, 1 queued, 0 skipped, 0 failed (of 4 selected).
- sess_ab12: compacted, ~182340 tokens in 96 nodes — shadowed surface 12-107
- sess_cd34: compacted, ~45120 tokens in 31 nodes — shadowed surface 3-33
- sess_ef56: noop — nothing safely compactable (empty session, or one oversized retained unit)
- sess_gh78: queued — mid-turn; queued and will be compacted as soon as it goes idle
```

## How it works

For each target it calls `ctx.compaction.compactNow(agent, signal)` and turns the outcome into a report row.

It does **not** bypass the contract's own constraints:

| Constraint | Reason |
|---|---|
| A target must be **idle** to compact immediately | `compactNow` goes through `agent.runMaintenance`, which throws `ManualCompactionError('busy')` synchronously while an agent is running a turn |
| **The caller is always busy** | It is executing this very tool call — so it takes `queue` and is compacted at the **end of its own turn** |
| Only a **top-level** agent may sweep | Prevents members from compacting each other or their captain; a sub-agent may only use `scope: "self"` |
| One summarization model call per target, **serially** | Every target costs a real model call; queued work runs after the turn and is not covered by the tool timeout |
| **Live** sessions only | Ended/archived sessions have no live agent and `compactNow` needs an Agent handle; compacting a dead session saves nothing |
| Compaction **cannot** fix a single oversized unit | Per contract, one oversized retained unit or request envelope cannot be repaired by surface compaction; such a target reports `noop` |

Details (contract citations, event semantics, pitfalls) are in the [design notes](docs/design.md).

## State and side effects

- **Zero persistence**: writes no files, keeps no ledger, changes no configuration; the compaction result is recorded by DSH's own session log.
- **Zero network**: the only model call is the summarization issued by `compaction-basic` through the host LLM channel; the plugin itself makes no outbound requests.
- **Does not alter automatic policy**: the threshold and retention ratio belong to `compaction-basic` in the preset; this plugin does not override them.
- **Removable at any time**: delete the mount row and nothing is left behind.

## Architecture

```
dsh-compact-agents
├── index.js                     # the plugin: registers the compact_agents tool (single entry point)
├── package.json                 # ESM package declaration (main -> index.js)
├── scripts/
│   ├── lib/presets.mjs          # shared by the three scripts: path constants + preset discovery (one definition)
│   ├── install.mjs              # one-shot install/repair: junctions + preset row (idempotent, keeps .bak)
│   ├── uninstall.mjs            # uninstall: remove the mount row + delete the junctions it created
│   ├── validate-presets.mjs     # validate mount row / threshold / path
│   ├── integration-test.mjs     # real-machine load test (real Context + real ToolRuntime)
│   ├── deferred-test.mjs        # queue-then-compact behaviour test (fake ctx)
│   └── selftest.mjs             # module and defineTool spec self-check
├── docs/
│   └── design.md                # design notes: contract citations, constraints, pitfalls, test matrix
└── node_modules/@deepseek-ai/   # junctions created by install.mjs (not committed)
    ├── dsh-tools -> <dsh checkout>/packages/core/tools
    └── cordis    -> <dsh checkout>/vendor/cordis
```

The plugin imports exactly one thing: `defineTool` (from `@deepseek-ai/dsh-tools`). The `cordis` junction is needed only by `integration-test.mjs`.

**Why the preset row must be an absolute path**: `agent-presets/src/specifier.ts` classifies an absolute drive-letter path through `pathToFileURL` (its comment says this is *"required for drive-letter paths on Windows"*), producing a `file:` row. A **bare package name inside a preset is resolved from the harness**, not from the caller's directory, so a package installed under the user directory would fail to resolve.

## Development and verification

```sh
node --check index.js                 # syntax check
node scripts/selftest.mjs             # module import + defineTool spec + parameter enums
node scripts/deferred-test.mjs        # busy -> queued -> compacted on idle (fake ctx, no DSH)
node scripts/integration-test.mjs     # real machine: real Context + real ToolRuntime, full chain
node scripts/validate-presets.mjs     # mount rows and thresholds of all presets
node scripts/install.mjs --dry-run    # install rehearsal (touches nothing)
```

`integration-test.mjs` covers what a fake ctx cannot, at **zero model calls and zero cost** (it substitutes three minimal stub services — `systemPrompt`, `compaction`, `agents`): `inject` really resolves, `ctx.tools.register(defineTool(...))` is really accepted by the registry, `ctx.tools.get()` finds the tool, `ctx.tools.executionMode()` really resolves to `exclusive`, an end-to-end `execute()` return value really passes the output schema, `render()` really produces a text block, and a non-top-level sweep really is refused. The full assertion list is in the [design notes](docs/design.md#4-验证矩阵).

## Known limitations

- **Live sessions only**: ended/archived sessions have no Agent handle, so historical sessions cannot be compacted after the fact (and compacting them would save nothing).
- **Compaction is not free**: each target costs a real summarization model call. The point is to trade that for the huge prefix re-sent on every subsequent call.
- **A single oversized retained unit cannot be repaired**: the contract says surface compaction cannot fix it, so the target reports `noop`.
- **`scope: "self"` is asynchronous**: the tool returns `queued` immediately and the actual compaction happens after the turn ends, with the result written to the DSH log (`ctx.logger.info`) rather than the tool result.
- **Already-composed sessions do not get the new tool**: a preset edit only affects new sessions; older ones need a new conversation (or a DSH restart, which would drop member sessions).
- **No orphan-data or state cleanup**: this plugin is stateless, so there is nothing to clean up.

## Changelog

- **v0.1.0** — first release: the `compact_agents` tool (four scopes, queue-when-busy), one-shot install/uninstall/validate scripts, and four verification layers (self-check / behaviour test / real-machine integration test / preset validation).

## License

[Apache-2.0](LICENSE)
