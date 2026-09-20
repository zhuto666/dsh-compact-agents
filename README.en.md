# dsh-compact-agents

<div align="center">

**A forced session-context compaction plugin for DeepSeek Harness: a model-callable `compact_agents` tool plus a parameter form inside Settings**

Force compaction that ignores the automatic threshold · covers every live session in the process (main session / ordinary sub-agents / AgentTeams members) · a busy target is queued and compacted as soon as its turn ends · per-target reporting of shadowed node count and estimated tokens · compaction is visible in the conversation · auto-continues when a turn is cut off by the output limit · the parameters are editable on their own page in Settings · zero network, zero dependencies, no build step

[![version](https://img.shields.io/badge/version-0.8.4-4176E6)](https://github.com/zhuto666/dsh-compact-agents)

[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org)

**English** | [中文](README.md)

</div>

---

## Installation

> Requires Node.js ≥ 20, `pnpm` on PATH, and a DeepSeek Harness **source checkout** with `agent-presets` (the installer uses it to locate `@deepseek-ai/dsh-tools` and `cordis`; a global `npm i -g` layout is unverified).

Installation has two steps: install the package (the official channel — pnpm fetches it from GitHub), then write the mount row into a preset. The second step is not optional: the `compact_agents` tool must sit inside the preset's `compaction` isolation group to reach `ctx.compaction`, and no package can ship that row itself.

```sh
# 1. Install the package: registers the profile dependency and bundle (the browser half, i.e. the Settings form)
dsh plugin --profile web add github:zhuto666/dsh-compact-agents

# 2. Mount the preset row: the tool itself + path self-healing (idempotent, safe to re-run)
node <profile-dir>/node_modules/dsh-compact-agents/scripts/install.mjs
```

Replace `--profile web` with the profile you actually boot; `dsh plugin` forwards the remaining arguments to `pnpm` inside that profile directory. Add `--dry-run` to step 2 to preview the changes without writing anything.

`<profile-dir>` is that profile's directory, by default `~/.dsh/profiles/<profile>`. `~` is expanded only on macOS, Linux and Git Bash, so those can copy the form as-is; Windows PowerShell and cmd do not expand it — write the full path instead, e.g. `<your home directory>\.dsh\profiles\web\node_modules\dsh-compact-agents\scripts\install.mjs`.

Installing from a local checkout (when developing this repository):

```sh
# run from the repository root; the path after add must be absolute — dsh runs pnpm inside the profile directory
dsh plugin --profile web add /absolute/path/to/dsh-compact-agents
node scripts/install.mjs
```

`install.mjs` is idempotent and does four things in order: create the `node_modules/@deepseek-ai/{dsh-tools,cordis,schemastery}` junctions → append the mount row to every preset that has a `compaction` group (repointing it when the path changed) → write the package name into both the profile `dependencies` and `dsh.profile.bundles` → call the official channel `dsh plugin add` (`--no-cli` skips it). When no preset is found at all, pass `--preset <agent.cordis.yml>` explicitly.

> The preset mount row holds an **absolute path**: a bare package name inside a preset resolves from the harness installation, not from a user directory, so a package living there can never be found. Move or rename the project and re-running `install.mjs` fixes the path automatically.

## What problem it solves

DSH has exactly one manual compaction entry point, and it is a human command, `/compact`:

- headless sub-agents / AgentTeams members have no command surface and cannot run `/compact`;
- no model-side tool can compact another session either — `packages/compaction/` contains no `registerTool`;
- automatic compaction (`compaction-basic`) is threshold-driven: below the threshold, nothing is compacted.

So "sessions get more expensive the longer they run" used to be solved only by swapping people out (retiring a member, creating a new one). This plugin adds the missing model-side entry point.

> Measured on a real session: one member session re-sent roughly 400K tokens of context per call and reached 348 calls, 140M cacheRead and ¥10.87 in total — its cost tracks directly with whether that session gets compacted.

## Restart `dsh` once after installing

The host composition changed (the profile gained a bundle), and a client module's rev is computed only when `dsh` starts; without a restart, the form does not appear in Settings.

The first install has an ordering problem: if existing members / sub-agents should be compacted too, do not restart right away — a restart drops every live session (`ctx.agents.list()` only covers sessions that are alive). Compact first and restart afterwards, or reopen the members. The `compact_agents` tool itself does not depend on that restart: once the preset row is in place, a new conversation can use it.

Afterwards, changing only preset parameters needs no restart (see the effect timing below).

## Usage

A model-side call, not a human command:

```
compact_agents(scope = "others" | "all" | "self" | "ids", ids?: string[], whenBusy = "queue" | "skip")
```

| scope | Meaning |
|---|---|
| `others` (default) | every live session except the caller |
| `all` | every live session, including the caller |
| `self` | only the caller — works even with no sub-agents |
| `ids` | only the sessions listed in `ids` |

In practice: "compact every other session" → `others`; "compact this conversation too" → `all` (the caller is queued and compacted when its turn ends); "only me" → `self`.

Returns one line per target:

```
compact_agents: 3 compacted, 1 queued, 0 skipped, 0 failed (of 4 selected).
- sess_ab12: compacted, ~213,400 → ~49,800 tokens — shadowed surface 12-107
- sess_ef56: noop, ~0 tokens shadowed — nothing safely compactable (empty session, or one oversized retained unit)
- sess_gh78: queued — mid-turn; queued and will be compacted as soon as it goes idle
```

`beforeTokens` / `afterTokens` are surface estimates measured through `ctx.tokenMeter`; they are `-1` when nothing can be measured.

Boundaries: only a top-level agent can scan others (a sub-agent can only use `scope: "self"`); every target must be idle to compact immediately (a busy target is queued per `whenBusy`, and `skip` reports `busy`); one scan runs serially with a 30-minute timeout (the queued part runs after the turn and does not count against it).

The tool description already says "call this immediately when the user asks to compact context; do not ask back", but a model may still confirm once. Naming the tool makes the call certain:

```
Call compact_agents with scope=all to compact every session.
```

### Compaction leaves a visible notice in the conversation

Every compaction (including threshold-triggered automatic ones) leaves one line in the conversation; `compaction/start` is written before the summarizer model is called, so it covers the wait that used to be invisible:

```
▸ 上下文注入 · dsh-compact-agents · 正在压缩上下文…（当前 213,400 tokens） · 触发线 ×0.35
▸ 上下文注入 · dsh-compact-agents · 上下文压缩完成：约 213,400 → 49,800 tokens，已遮蔽 37 个历史节点
```

The trailing `触发线 ×0.35` is the value actually in effect for this session; only when hot sync genuinely fails does one more line report both values and the way out:

```
⚠️ 预设文件里现在是 ×0.5，本会话这个实例仍按 ×0.2（热同步没成功）：新开一条对话才会用上新值。
```

Turn it off with the row option `notice: false`. The notice itself is a `user/message`, so the model sees it on its next turn too — that is intentional, so the model knows its context was just compacted. See [design notes §6](docs/design.md).

### Auto-continue when a turn is cut off by the output limit

When a turn ends with `turn/end{reason: 'max-tokens'}`, the plugin sends "continue" as the user (`agent.followup`, the same path as a message typed in the UI), letting the conversation go on:

```
▸ 上下文注入 · dsh-compact-agents · 上一轮被输出上限截断，已自动续写（1/2）
继续                                    ← sent by the plugin as the user (identical to a typed one)
```

The budget is `maxAutoContinues` (default 2; `0` / `false` disables it); once it is exhausted the plugin posts a notice instead of continuing, so it cannot burn tokens forever. Any normally finished turn resets the budget, so it counts consecutive continuations. Why it exists: after compaction a preset often shrinks the output budget of the next request, and with high reasoning enabled the thinking tokens share that budget and can consume all of it → zero text and a truncated turn ([design notes §7](docs/design.md)).

### Changing these parameters from the UI

The primary entry point is its own page in Settings: open **Settings** → sidebar **「压缩与自动续写」**, which sits at the same level as 「通用设置 / 模型 / 内置插件 / Agent 预设」 (present in DSH 0.1.5 and 0.1.6). The other two places share the same form and the same controller: the detail page of this package on the Plugins page (DSH ≥ 0.1.6), and the **Settings → Plugins → Configurable** collapsible card (DSH ≤ 0.1.5).

![The 「设置 → 压缩与自动续写」 page: the real UI on the left, numbered markers matched to the legend on the right](docs/images/settings-section-annotated.png)

> The Settings sidebar in the screenshot shows it at the same level as 「内置插件」. The values shown are that preset's live values as captured in the screenshot (two ratios carry an "overridden" marker); they are not the factory defaults — see the tables below. For the old card on DSH ≤ 0.1.5 see `docs/images/settings-card-annotated.png` (archive only).

The form is parameters only: the plugin adds no buttons of its own, compaction and auto-continue both happen automatically, and the framework's own "Reset" is just a revert entry point. The only manual compaction entry point in DSH is the built-in human command `/compact` (not this plugin) — what this plugin provides is the model-side tool `compact_agents`.

Field names and effect timing — the UI groups them by when they take effect, and the group titles are the three lines below:

**Immediate · read when the action happens, so the next compaction or continue uses the new value.**

| Field | Meaning | Values |
|---|---|---|
| `压缩提示播报` | whether to report the shadowed node count and estimated tokens in the conversation after compaction; on by default | dropdown `开启` / `关闭` |
| `自动续写次数上限` | maximum number of auto-continues when a reply is cut off by the output limit; 0 disables it, default 2 | dropdown `0` `1` `2` `3` `5` `10` |

**Written to the preset and hot-synced · written into the preset config and hot-synced into running sessions, taking effect at the next step boundary.**

| Field | Meaning | Values |
|---|---|---|
| `压缩触发阈值比例` | compaction triggers once context usage reaches this share of the window; default 0.35, i.e. about 350K of a 1M-token window | 0.05 – 0.95 (DSH's factory value is `0.8`, ≈ 800K of a 1M window, which in practice almost never triggers) |
| `压缩后保留比例` | share of context retained after compaction; smaller compacts harder; default 0.05, i.e. at least 50K tokens of a 1M-token window (aligned to whole messages, so slightly more in practice) | 0.01 – 0.5 |

**New sessions only · written into the preset config, read only by new sessions; running sessions are unaffected.**

| Field | Meaning | Values |
|---|---|---|
| `受控阶段输出预算` | output token budget for a single request inside the short "controlled phase" after compaction; it is an output budget and `max_tokens` counts thinking (reasoning) tokens too, so at 1024 the thinking alone can use it all up and no text is produced | integer, 1024 – 200000 |

The form also marks which fields you have overridden, and each field's 「重置」 reverts it to the preset value.

Tuning cheat sheet (mechanism and trade-offs: [design notes §9](docs/design.md)):

| Goal | How to tune |
|---|---|
| Cheaper and faster | lower the threshold (compact earlier) + lower the retained ratio |
| Fewer interruptions, keep what was just said | raise the retained ratio (`0.08~0.1`) |
| The controlled phase keeps getting cut off (repeated auto-continues) | raise the output budget (`32768`) |
| Compaction happens too often / too much summarizing | raise the threshold (`0.3~0.4`) |

> Row options `notice: false` / `maxAutoContinues: 0` / `livePresetParams: false` disable the notice, auto-continue and hot sync respectively; `settings: false` turns the whole Settings surface off (the tool and the notice are unaffected).

## Troubleshooting

> `scripts/install.mjs` below means the script inside the plugin installation directory: `scripts/install.mjs` in a source checkout, or `<profile>/node_modules/dsh-compact-agents/scripts/install.mjs` when installed from GitHub.

| Symptom | Cause | Fix |
|---|---|---|
| No 「压缩与自动续写」 in Settings | `dsh` was not restarted after installing; a client module's rev is computed only at startup | restart `dsh` once |
| The form is there, but the package is missing from the Plugins page | the name was written only into `dsh.profile.bundles`, not into the profile `dependencies` — the Plugins page lists only bundles in `installed \|\| optional \|\| error`, and reports nothing | re-run `scripts/install.mjs` (it writes both), then restart; `validate-presets.mjs` flags this half-installed state as FAIL |
| Neither the namespace nor the form appears, with no error at all | only the preset was mounted, the package was never registered as a profile bundle — the browser never receives `lib/client.js` | same as above ([§8.4](docs/design.md)) |
| On the old Settings page (DSH ≤ 0.1.5) the card vanishes silently | the old `settings.plugin.item` slot has no renderer on ≥ 0.1.6, and `slots.inject` is silent for a slot nobody declared: registering neither throws nor shows | use Settings → 「压缩与自动续写」 or the Plugins-page detail page; do not rely on the old slot ([§8.5](docs/design.md)) |
| The preset file has a new threshold but the session still compacts by the old one | hot sync did not get through (config shape changed / not writable); the notice reports both values | only a new conversation picks up the new value ([§6](docs/design.md)) |
| The compaction notice says "a new conversation is needed for the new value" | self-verification found the engine still judging by the old threshold (the evidence is the next compaction the policy decides by itself) | same as above |
| After upgrading `@linxin666/*` the `compact_agents` tool is gone | the shipped preset is rewritten wholesale by its own upgrade, dropping our mount row | re-run `scripts/install.mjs`; `validate-presets.mjs` tells you which preset it was |
| Your own preset edit has no effect | a shipped preset with the same id shadows the user preset (`agent-presets` roots order: shipped first, user last) | edit the shipped one (and re-run the installer after the next upgrade), or give your own preset another id |
| Turning the plugin off on the Plugins page leaves `compact_agents` usable | that switch only moves the bundle row in the host composition; the tool comes from the preset row | to disable it entirely, run `scripts/uninstall.mjs` |

## Update / uninstall

```sh
# source checkout
git -C <checkout> pull && node scripts/install.mjs

# installed from GitHub: pnpm re-resolves the git dependency, then re-apply the mount row
dsh plugin --profile web update dsh-compact-agents
node <profile-dir>/node_modules/dsh-compact-agents/scripts/install.mjs

# uninstall (preview with --dry-run first)
node <plugin-dir>/scripts/uninstall.mjs
```

Uninstall removes only what it added: comments, `!!js` expressions and every other row in the preset are left untouched (measured: after install → uninstall the file is byte-for-byte identical), and the profile `package.json` is edited line by line, preserving its formatting. The plugin directory and the `.bak` / `.bak-compact-agents` backups are kept — remove them yourself. Uninstall also changes the host composition, so the form disappears only after a `dsh` restart.

## Design notes

This document keeps the conclusions; root causes, contract references, the pitfalls we hit and the verification matrix are in [docs/design.md](docs/design.md):

| Question | Where |
|---|---|
| Why DSH has no ready-made model-side compaction entry point | [§1](docs/design.md) |
| Coverage, event semantics, busy handling and queueing | [§2](docs/design.md) |
| Mounting, path resolution, the ESM module cache and other pitfalls | [§3](docs/design.md) |
| Verification matrix: what each script asserts | [§4](docs/design.md) |
| Relationship to automatic compaction (`compaction-basic`) | [§5](docs/design.md) |
| Compaction notice and threshold hot sync | [§6](docs/design.md) |
| Output-limit truncation and auto-continue | [§7](docs/design.md) |
| Settings surface: the host-composition row (§8.4), the two silent failures (§8.5), known limitations (§8.6), why it has its own page (§8.7) | [§8](docs/design.md) |
| How the compaction parameters work and how to tune them | [§9](docs/design.md) |

Code layout: `index.js` (preset row entry: registers the tool and the session listeners), `client-host.js` + `cordis.patch.yml` (host-composition row entry: ships the browser half and registers the settings namespace), `settings.js` (settings namespace plus preset parameter reads and writes), `lib/client.js` (the browser half, a single hand-written file with no build step, and the single source of truth for UI wording), `scripts/*` (install / uninstall / verify / test).

Development:

```sh
node scripts/validate-presets.mjs   # mount row / referenced path / ratios / README badge / profile dependency
node scripts/inspect-presets.mjs    # read-only: the initial values the form will show
npm test                            # self-test / behaviour / live integration / settings surface / browser half
```

Changing a plugin `.js` file (including `client-host.js` / `settings.js`) or anything related to the host composition (`cordis.patch.yml`, the `dsh.*` declarations in `package.json`) requires a `dsh` restart — the ESM module cache is keyed by URL and re-mounting a preset does not clear it ([§3.4](docs/design.md)); changing only a preset needs just a new conversation. Any test that writes to disk must point at a temporary fixture explicitly instead of relying on "I assumed it would not write" ([§8.4](docs/design.md)).

## Known limitations

- **Alive sessions only**: finished or archived sessions have no Agent handle, and compacting them afterwards saves no tokens.
- **Compaction is not free**: each target really calls the summarizer model once, which costs tokens.
- **A single oversized retained unit cannot be fixed**: the contract is explicit that surface compaction cannot help there; the target reports `noop`.
- **`scope: "self"` is asynchronous**: the tool returns `queued` immediately, the actual compaction happens after the current turn ends, and the result goes to the DSH log rather than the tool result.
- **Already-composed sessions do not get the new tool**: a preset change only affects new sessions; older sessions need a new conversation (a restart drops member sessions).
- **No orphan-data / state cleanup**: the plugin is stateless (zero persistence, zero network, does not change the automatic compaction policy).
- **DSH development-checkout layout only**: the installer requires both `packages/core/tools` and `vendor/cordis` inside the checkout; a global `npm i -g` layout is unverified.
- **The Plugins-page enable / disable switch only covers the browser half**: turning it off moves the host-composition row (`compact-agents-client-host`) and the form disappears; the `compact_agents` tool comes from the preset row and keeps working, independently of that switch.
- **A shipped preset is wiped by its own plugin upgrade**: the row in `<profile>/node_modules/@linxin666/*/presets/*/agent.cordis.yml` is inserted at install time and a plugin upgrade rewrites the whole file; re-running `scripts/install.mjs` restores it. The same place has one more shadowing rule: a shipped preset with the same id overrides a user-built one.

## Changelog

Only changes that **affect how you use the plugin** are listed: behaviour, parameters, UI, installation, and fixes you can notice. Documentation, screenshots and badge-only changes are intentionally omitted here — look them up in the git history. Versions follow [Semantic Versioning](https://semver.org/); the date is the commit date of that release. This repository does not use tags — except for the newest entry, each version heading links to the commit it was released from.

### [0.8.1](https://github.com/zhuto666/dsh-compact-agents/commit/5f91f64) — 2026-09-18

**Added**

- Registered the official `settings.section` slot: a new 「压缩与自动续写」 page in the Settings sidebar, at the same level as `通用设置` / `模型` / `内置插件` / `Agent 预设` (works on DSH 0.1.5 and 0.1.6).

**Changed**

- The parameter form is registered in three places (Settings section, Plugins-page detail, ≤0.1.5 collapsible card) and shares one body plus one controller, each guarded separately: a failure in one registration does not affect the others.

### [0.8.0](https://github.com/zhuto666/dsh-compact-agents/commit/53e7837) — 2026-09-18

**Fixed**

- The parameter card was invisible on DSH 0.1.6: upstream removed the renderer for the old `settings.plugin.item` slot, and `ctx.slots.inject` fails silently on an undeclared slot. Added a `plugins.bundle.config` registration (keyed by package name).
- The package was filtered out of the Plugins page entirely: that page lists only bundles present in the profile `dependencies`, so registering in `dsh.profile.bundles` alone is not enough. The installer now writes both.

### [0.7.3](https://github.com/zhuto666/dsh-compact-agents/commit/daa5498) — 2026-09-15

**Fixed**

- Writing a preset parameter now refreshes trailing numeric comments too, so a value and its comment (e.g. `0.02` next to "5%") cannot contradict each other; comments without numbers are the user's own words and are always left alone.

### [0.7.2](https://github.com/zhuto666/dsh-compact-agents/commit/f07ac81) — 2026-09-15

**Changed**

- UI wording unified on DSH's official Chinese terms 「预设」 and 「提示词」 (`token` and similar are kept as-is).

### [0.7.1](https://github.com/zhuto666/dsh-compact-agents/commit/dd45ab4) — 2026-09-15

**Fixed**

- Hot sync now verifies its effect: it uses the next compaction the policy decides by itself to prove the engine really judges by the new threshold, and stops claiming success when that check fails.

### [0.7.0](https://github.com/zhuto666/dsh-compact-agents/commit/0f9167c) — 2026-09-15

**Added**

- Threshold and retained ratio are hot-synced into running `compaction-basic` instances on save, taking effect at the next step boundary — no new session, no `dsh` restart.
- `bootstrapMaxTokens` is unaffected: it is read by a different plugin and still applies to new sessions only.

### [0.6.1](https://github.com/zhuto666/dsh-compact-agents/commit/2e0f0fe) — 2026-09-15

**Added**

- The compaction notice reports **the trigger line actually in effect for this session**; when hot sync fails it prints both the preset value and the instance value, plus how to recover.

### [0.6.0](https://github.com/zhuto666/dsh-compact-agents/commit/e70f51e) — 2026-09-15

**Changed**

- Default compaction trigger ratio `0.2` → `0.35`, so unused window space is no longer summarized prematurely.

**Fixed**

- The test guard now compares full snapshots instead of a fragment, removing a long-standing false positive.

### [0.5.2](https://github.com/zhuto666/dsh-compact-agents/commit/9666200) — 2026-09-15

**Changed**

- The Settings card now uses the official plugin card's compact style.

### [0.5.1](https://github.com/zhuto666/dsh-compact-agents/commit/83a823a) — 2026-09-15

**Fixed**

- Line names in the host composition must be bare package names: a subpath line name is dropped silently.

### [0.5.0](https://github.com/zhuto666/dsh-compact-agents/commit/bd1ceb6) — 2026-09-15

**Fixed**

- Settings card missing: the browser half must be registered as a row in the host composition.

### [0.4.0](https://github.com/zhuto666/dsh-compact-agents/commit/61177ac) — 2026-09-15

**Added**

- The five parameters moved into the Settings UI: a new settings namespace plus a hand-written single-file browser half (zero dependencies); the first three are written to the preset file, the other two take effect immediately.

**Fixed**

- A threshold with a trailing inline comment could not be read, and writing it back wiped the comment.

### [0.3.0](https://github.com/zhuto666/dsh-compact-agents/commit/5b457af) — 2026-09-15

**Added**

- When a turn ends with `turn/end{reason: 'max-tokens'}`, the plugin continues the conversation as the user; the budget is bounded by `maxAutoContinues`.

### [0.2.0](https://github.com/zhuto666/dsh-compact-agents/commit/2ef2d3d) — 2026-09-15

**Added**

- A compaction notice visible in the conversation, reporting the shadowed node count and estimated tokens (`notice: false` turns it off).
- Tool receipts now include the token counts before and after compaction.

### [0.1.0](https://github.com/zhuto666/dsh-compact-agents/commit/d837b68) — 2026-09-15

**Added**

- First release: the `compact_agents` tool (4 scopes, busy targets queued), install / uninstall / verify scripts, and four layers of verification.

## License

[Apache-2.0](LICENSE)
