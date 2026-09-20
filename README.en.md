# dsh-compact-agents

<div align="center">

**Plugin for DeepSeek Harness: force-compact session context — a model-callable `compact_agents` tool plus a parameter form in Settings**

Force compaction ignoring the automatic threshold · Covers **every live session** in the process (main session / ordinary sub-agents / AgentTeams members) · A busy target is queued and compacted the moment its turn ends · Per-target reporting of shadowed node count and estimated tokens · **Compaction is visible in the conversation** · **Auto-continues after an output-cap truncation** · **The parameters are editable on their own page in Settings** · No network, no dependencies, no build step

[![version](https://img.shields.io/badge/version-0.8.3-4176E6)](https://github.com/zhuto666/dsh-compact-agents)

[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org)

**English** | [中文](README.md)

</div>

---

## Installation

> Requires Node.js ≥ 20 and a DeepSeek Harness with `agent-presets`.

```sh
dsh plugin add E:\dsh-compact-agents --profile web    # official path, recommended
```

This repository also ships an equivalent, **idempotent** script for when the official path fails (or `--no-cli` was passed):

```sh
node scripts/install.mjs --dry-run    # preview what will change (writes nothing)
node scripts/install.mjs              # do it: profile dependency + bundle entry + junctions + preset row
node scripts/validate-presets.mjs     # check: mount row / referenced path / ratios / README badge / profile dependency
node scripts/uninstall.mjs --dry-run  # preview the uninstall
```

> The preset mount row holds an **absolute path**: a bare package name inside a preset resolves from the harness installation, not from a user directory, so a package living there can never be found. Move or rename the project and re-running `install.mjs` fixes the path automatically.

## What problem it solves

The only manual compaction entry point in DSH is a **human command**, `/compact`:

- headless **sub-agents / AgentTeams members** have no command surface, so they cannot run `/compact`;
- there is **no model-side tool** that can compact another session either — nothing under `packages/compaction/` calls `registerTool`;
- and automatic compaction (`compaction-basic`) is **threshold-driven**: below the line, nothing happens.

So "the conversation gets more expensive the longer it runs" used to be solved by **replacing the agent** (retire a member, create a new one). This plugin adds the missing model-side entry point.

> Observed: one member session re-sent **~400K tokens** of context on every call, reached 348 calls, and burned 140M cacheRead and ¥10.87 — simply because nobody could compact it.

## Restart `dsh` once after installing

The host composition changed (the profile has one more bundle), and a client module's rev is computed only when `dsh` **starts** — without a restart the form never shows up in Settings.

**The first install has an ordering conflict**: if you want your **existing** members/sub-agents compacted, do not rush into that restart — it drops every live session (`ctx.agents.list()` covers live sessions only), leaving nothing to compact. Compact first and then restart, or restart and re-open the members. The `compact_agents` tool itself does not depend on that restart: once the preset row is in place, a new conversation is enough.

Afterwards, changing preset parameters needs no restart (see the effect timings below).

## Usage

Called by the model, not by a human:

```
compact_agents(scope = "others" | "all" | "self" | "ids", ids?: string[], whenBusy = "queue" | "skip")
```

| scope | Meaning |
|---|---|
| `others` (default) | **Every live session** except the caller |
| `all` | **Every live session**, including the caller |
| `self` | Only the caller's own session — **works with no sub-agents at all** |
| `ids` | Only the sessions named in `ids` |

Typical prompts: "compact every other session" → `others`; "compact this conversation too" → `all` (you are queued and compacted when this turn ends); "compact only myself" → `self`.

> **Model did not call it?** The tool description already says to call it **immediately** when the user asks to compress context, never to ask back first — but a model may still choose to confirm. The most reliable phrasing **names the tool**:
>
> ```
> call compact_agents with scope=all to compress every session
> ```
>
> As long as the tool is in the catalog, naming it always executes.

One row is returned per target:

```
compact_agents: 3 compacted, 1 queued, 0 skipped, 0 failed (of 4 selected).
- sess_ab12: compacted, ~213,400 → ~49,800 tokens — shadowed surface 12-107
- sess_ef56: noop, ~0 tokens shadowed — nothing safely compactable (empty session, or one oversized retained unit)
- sess_gh78: queued — mid-turn; queued and will be compacted as soon as it goes idle
```

`beforeTokens` / `afterTokens` are the surface estimates measured with `ctx.tokenMeter`; `-1` means the meter was unavailable.

Behaviour boundaries: only a **top-level** agent may sweep others (a sub-agent may only use `scope: "self"`); a target must be **idle** to be compacted immediately (a busy one is queued per `whenBusy`, or reported as `busy` with `skip`); one sweep runs **serially**, with a 30-minute timeout (queued work runs after the turn and is not covered by it).

### Compaction leaves a visible notice in the conversation

**Every** compaction — including the threshold-triggered automatic one — appends a notice to the conversation. `compaction/start` is written **before** the summarization model call, so the notice covers exactly the wait that used to look frozen:

```
▸ 上下文注入 · dsh-compact-agents · 正在压缩上下文…（当前 213,400 tokens） · 触发线 ×0.35
▸ 上下文注入 · dsh-compact-agents · 上下文压缩完成：约 213,400 → 49,800 tokens，已遮蔽 37 个历史节点
```

That trailing `触发线 ×0.35` is the **value this session actually runs**. Only when the hot sync genuinely cannot get in does it add a line naming both values and the way out:

```
⚠️ 预设文件里现在是 ×0.5，本会话这个实例仍按 ×0.2（热同步没成功）：新开一条对话才会用上新值。
```

The row config `notice: false` turns it off. The notice is a `user/message`, so the model sees it on the next turn too — deliberately. See [design notes §6](docs/design.md).

### Auto-continue when the output cap truncates a turn

When a turn ends with `turn/end{reason: 'max-tokens'}`, the plugin sends **"继续" on the user's behalf** (`agent.followup` — the same path a message typed in the UI takes), so the conversation keeps itself going:

```
▸ 上下文注入 · dsh-compact-agents · 上一轮被输出上限截断，已自动续写（1/2）
继续                                    ← sent by the plugin as the user (identical to one you type)
```

The count is bounded by `maxAutoContinues` (**default 2**; `0` / `false` disables it); once exhausted it reports instead of looping, so it cannot burn tokens forever. **Any normally completed turn resets the count**, so the budget is a *consecutive* one. Why it is needed: after a compaction a preset often shrinks the next request's output budget, and with high reasoning effort the reasoning tokens share that budget and can consume all of it → zero characters of text and a truncated turn ([design notes §7](docs/design.md)).

### Editing these parameters in the UI

**Preferred: its own page in Settings.** Open **Settings** and pick **「压缩与自动续写」** in the sidebar — it sits at the **same level** as `通用设置` / `模型` / `内置插件` / `Agent 预设` (present on DSH 0.1.5 and 0.1.6 alike). Two more places render **the same form through the same controller**: this package's detail page on the sidebar Plugins page (DSH ≥ 0.1.6), and the collapsible card under **Settings → Plugins → Configurable** (DSH ≤ 0.1.5).

![The `Settings → 压缩与自动续写` page: the real UI on the left, numbered call-outs mapped to the legend on the right](docs/images/settings-section-annotated.png)

> In the screenshot the Settings sidebar shows it at the same level as `内置插件` (Plugins). The numbers in the shot are the live values from the machine it was taken on (both ratios carry the 已覆盖 / overridden tag), not the factory defaults — see the tables below. What the older card looked like on DSH ≤ 0.1.5 is archived in `docs/images/settings-card-annotated.png`.

This is a **pure parameter form**: the plugin has **no buttons of its own** in the UI — compaction and auto-continue both happen **automatically**, and the framework's own `Reset` is only a restore affordance. The only manual compaction entry point in DSH is the **built-in** human command `/compact` (not this plugin); what this plugin provides is the **model-side** tool `compact_agents`.

Field names and effect timings — the form groups its fields by when they take effect, and these three lines are the group headings:

**立即生效 · 动作发生时读取，改完下一次压缩或续写即生效。** (Immediate: read when the action happens.)

| Field (UI label) | Meaning | Values |
|---|---|---|
| `压缩提示播报` (compaction notices) | whether to announce the shadowed node count and estimated tokens in the conversation after a compaction; on by default | dropdown `开启` / `关闭` |
| `自动续写次数上限` (auto-continue budget) | how many automatic continues after an output-cap truncation; 0 disables it; default 2 | dropdown `0` `1` `2` `3` `5` `10` |

**写入预设并热同步 · 写进预设配置，同时热同步给正在运行的会话，下一次步边界即生效。** (Written to the preset *and* hot-synced into running sessions.)

| Field (UI label) | Meaning | Values |
|---|---|---|
| `压缩触发阈值比例` (compaction trigger ratio) | compact once the context reaches this share of the window; default 0.35, i.e. around 350K in a 1M-token window | 0.05 – 0.95 (the DSH factory value is `0.8` ≈ 800K in a 1M window, which effectively never fires) |
| `压缩后保留比例` (retained ratio) | how much recent context survives a compaction — the smaller, the harder it compacts; default 0.05, i.e. at least 50K tokens of verbatim history in a 1M window (aligned to whole messages, so usually a little more) | 0.01 – 0.5 |

**新建会话生效 · 写进预设配置，只在新会话读取，已在运行的会话不受影响。** (New sessions only.)

| Field (UI label) | Meaning | Values |
|---|---|---|
| `受控阶段输出预算` (controlled-phase output budget) | the per-request output budget during the short "controlled phase" after a compaction; it is an **output** budget and `max_tokens` counts reasoning tokens too, so at 1024 the reasoning alone can eat it and produce zero characters of text | integer, 1024 – 200000 |

The form also marks the fields **you have overridden**, each with its own `Reset` back to the preset value.

Tuning cheat sheet (rationale in [design notes §9](docs/design.md)):

| Goal | Adjustment |
|---|---|
| Cheaper and faster | smaller trigger ratio (compact earlier) + smaller retained ratio |
| Fewer interruptions, remembers what was just said | larger retained ratio (`0.08~0.1`) |
| The controlled phase keeps truncating (repeated auto-continues) | larger output budget (`32768`) |
| Compaction happens too often | larger trigger ratio (`0.3~0.4`) |

> Row config `notice: false` / `maxAutoContinues: 0` / `livePresetParams: false` disable the notices, the auto-continue and the hot sync respectively; `settings: false` turns the whole Settings surface off (the tool and the notices are unaffected).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No `压缩与自动续写` in Settings | `dsh` was not restarted after installing; a client module's rev is computed only at startup | restart `dsh` once |
| The form is there, but the sidebar Plugins page shows no trace of this package | the name was written only into `dsh.profile.bundles`, not into the profile `dependencies` — the new Plugins page lists only bundles that are `installed \|\| optional \|\| error`, **with no error at all** | `node scripts/install.mjs` (it writes both), then restart; `validate-presets.mjs` fails outright on that half-installed state |
| Neither a namespace nor a form appears, and **nothing is reported** | only the preset was mounted, the package was never registered as a profile bundle — the browser never receives `lib/client.js` | same as above ([§8.4](docs/design.md)) |
| The card vanishes from the old Settings page (DSH ≤ 0.1.5), silently | the old `settings.plugin.item` slot has no renderer on ≥ 0.1.6; `slots.inject` is **silent** for a slot nobody declares — registering neither throws nor shows | use `Settings → 压缩与自动续写` or the Plugins detail page; do not rely on the old slot ([§8.5](docs/design.md)) |
| The preset file holds the new ratio, yet the session still compacts by the old one | the hot sync could not get in (config shape changed / not writable); the notice prints both values | a new conversation is what picks up the new value ([§6](docs/design.md)) |
| The compaction notice says "a new conversation picks up the new value" | the effect check proved the engine still judges by the old ratio (evidence: the next **policy-driven** compaction) | same as above |
| After upgrading `@linxin666/*` the `compact_agents` tool is gone | the preset shipped inside that package is rewritten wholesale by its own upgrade, dropping our mount row | re-run `node scripts/install.mjs`; `validate-presets.mjs` tells you which preset lost the row |
| A preset you edited yourself has no effect | a **shipped** preset with the same id shadows the user one (`agent-presets` root order is shipped-first, user-last) | edit the shipped copy (and re-run the installer after its next upgrade), or give your own preset a different id |
| The Plugins page switch is off, yet `compact_agents` still works | that switch only acts on the host-composition bundle row; the tool comes from the **preset row** | to disable everything, run `node scripts/uninstall.mjs` |

## Update / uninstall

```sh
git -C dsh-compact-agents pull
node scripts/install.mjs              # re-run after updating; idempotent
node scripts/uninstall.mjs --dry-run  # preview the uninstall
node scripts/uninstall.mjs            # remove the mount row + bundle and dependency entries + the junctions it created
```

Uninstall removes only what it added: comments, `!!js` expressions and every other row in a preset are left alone (verified byte-for-byte round trip from installed back to original), and the profile `package.json` is edited line-wise with its original layout preserved. The plugin directory and the `.bak` / `.bak-compact-agents` backups are kept; remove them yourself. Uninstall changes the host composition too, so **the form only disappears after a `dsh` restart**.

## Deeper design

The README keeps conclusions only; root causes, contract citations, traps hit and the verification matrix live in [docs/design.md](docs/design.md):

| What you want to know | Where |
|---|---|
| Why DSH has no ready-made model-side compaction entry point | [§1](docs/design.md) |
| Coverage, event semantics, busy and queuing | [§2](docs/design.md) |
| Mounting and path resolution, the ESM module cache, other traps | [§3](docs/design.md) |
| Verification matrix: what each script asserts | [§4](docs/design.md) |
| Relationship to automatic compaction (`compaction-basic`) | [§5](docs/design.md) |
| Compaction notices and threshold hot-syncing | [§6](docs/design.md) |
| Output-cap truncation and auto-continue | [§7](docs/design.md) |
| The Settings surface: the host-composition row (§8.4), the two silent failures (§8.5), known limitations (§8.6), why a page of its own (§8.7) | [§8](docs/design.md) |
| What the compaction parameters govern, and tuning trade-offs | [§9](docs/design.md) |

Code layout: `index.js` (preset-row entry: registers the tool and the session listeners), `client-host.js` + `cordis.patch.yml` (host-composition row entry: ships the browser half and registers the settings namespace), `settings.js` (settings namespace and preset read/write), `lib/client.js` (the browser half — one hand-written file, no build step; **the only authority for UI wording**), `scripts/*` (install / uninstall / validate / tests).

Development:

```sh
node scripts/validate-presets.mjs   # mount row / paths / ratios / README badge / profile dependency
node scripts/inspect-presets.mjs    # read-only: the initial values the form will show
npm test                            # self-check / behaviour / real-machine integration / settings surface / browser half
```

Changing the plugin's `.js` (including `client-host.js` / `settings.js`) or anything host-composition related (`cordis.patch.yml`, the `dsh.*` declarations in `package.json`) **requires restarting `dsh`** — Node's ESM module cache is keyed by URL and re-mounting a preset does not clear it ([§3.4](docs/design.md)); changing only a preset needs nothing more than a new conversation. Any test that writes to disk must point at an explicit temp fixture instead of assuming "it surely will not write" ([§8.4](docs/design.md)).

## Known limitations

- **Live sessions only**: ended/archived sessions have no Agent handle, and compacting them after the fact would save nothing.
- **Compaction is not free**: each target costs a real summarization model call.
- **A single oversized retained unit cannot be repaired**: the contract says surface compaction cannot fix it, so the target reports `noop`.
- **`scope: "self"` is asynchronous**: the tool returns `queued` immediately; the actual compaction happens after the turn ends and the result goes to the DSH log, not to the tool result.
- **Already-composed sessions do not get the new tool**: a preset edit only affects new sessions; older ones need a new conversation (a restart would drop member sessions).
- **No orphan-data or state cleanup**: the plugin is stateless (zero persistence, zero network, no change to automatic compaction policy).
- **DSH dev-checkout layout only**: the installer requires the checkout to contain both `packages/core/tools` and `vendor/cordis`; a global `npm i -g` layout is unverified.
- **The Plugins page's enable/disable switch only covers the browser half**: turning it off acts on the host-composition row (`compact-agents-client-host`), so the form disappears — while the `compact_agents` tool comes from the **preset row** and keeps working.
- **A preset shipped inside a package gets wiped by that package's own upgrade**: the row in `<profile>/node_modules/@linxin666/*/presets/*/agent.cordis.yml` was inserted at install time and a plugin upgrade rewrites the whole file; re-run `node scripts/install.mjs`. The same spot has a second layer: a shipped preset with the same id shadows a user-created one.

## Changelog

- **v0.8.3** — **Docs and screenshots redone (no code change)**: README cut from 583 to 255 lines and reordered as install → use → troubleshooting → deeper design; the main image is now the real DSH 0.1.6 `Settings → 压缩与自动续写` page (call-outs ①–⑥ plus a legend), while the old Plugins-page card is demoted to a ≤0.1.5 archive; `docs/images/README.md` updated to match.
- **v0.8.2** — **documentation correction, no code change**: the form groups its fields by **when they take effect**, while the table under "Editing these parameters in the UI" still described the pre-v0.7.0 behaviour — it listed the **trigger ratio and retained ratio** as "new sessions only" (saving them actually hot-syncs into running sessions), and the field names did not match the UI word for word. Groups and field names now mirror the UI exactly.
- **v0.8.1** — the parameter form moved back to a page of its own in Settings: a new registration into the official `settings.section` slot puts **Settings → 「压缩与自动续写」** at the same level as `通用设置` / `模型` / `内置插件` / `Agent 预设` (present on 0.1.5 and 0.1.6 alike), with no need to dig into the Plugins page first. All three registrations share one body of markup and one controller, each in its own `try/catch`, so one failing does not affect the other two.
- **v0.8.0** — keeping up with DSH 0.1.6's Plugins page: upstream deleted the renderer for the old `settings.plugin.item` slot, so our card vanished with no error at all; the form now registers into both `plugins.bundle.config` (keyed by package name) and the old slot, and a second silent failure was fixed — a package listed only in `dsh.profile.bundles` and not in `dependencies` is filtered out of the Plugins page entirely.
- **v0.7.4** — the README version badge now matches `package.json` and is enforced by validation: the market reads the README, so a stale badge misleads visitors.
- **v0.7.3** — writing a preset value now also refreshes a **numeric** trailing comment (no more "value 0.02, comment still says 5%"); comments without digits are the user's own prose and are preserved.
- **v0.7.2** — UI wording is consistently Chinese, using the official term 预设 (the word `token` is kept as-is, matching DSH's own Chinese UI).
- **v0.7.1** — an **effect check** for hot-syncing: the next policy-driven compaction is used to prove whether the engine really judges by the new ratio; if not, the plugin stops claiming success.
- **v0.7.0** — the trigger ratio and retained ratio no longer wait for a new conversation: saving hot-syncs them into the running `compaction-basic` instance, effective at the next step boundary; `bootstrapMaxTokens` belongs to another plugin and still applies to new sessions only.
- **v0.6.1** — the compaction notice reports the **trigger line this session actually runs**, and states both values plus the way out when hot-syncing fails.
- **v0.6.0** — the default compaction trigger ratio moved from `0.2` (200K) to `0.35` (350K), so space that has not been used yet is no longer summarized early.
- **v0.4.0** — all five parameters moved into Settings: a new settings namespace plus a hand-written single-file browser half (zero dependencies); the first three values write the preset file, the last two apply immediately.
- **v0.3.0** — auto-continue after an output-cap truncation (`maxAutoContinues`), and the trigger behind it: the post-compaction controlled output budget being eaten by reasoning tokens.
- **v0.2.0** — compaction is no longer silent: a visible notice in the conversation (`notice: false` disables it), and before/after token counts on the tool rows.
- **v0.1.0** — first release: the `compact_agents` tool (four scopes, queue-when-busy), one-shot install/uninstall/validate scripts, four verification layers.

## License

[Apache-2.0](LICENSE)
