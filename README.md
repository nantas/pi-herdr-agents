# pi-herdr-agents

Launch interactive Pi subagents in Herdr Core, delegate tasks, exchange messages, and manage child terminals.

## Installation

You need Herdr Core (`hc`) 0.1.21 or later and Pi 1.6 or later. Make sure `hc` and `pi` are on Pi's `PATH`, and configure a model in Pi before starting the parent agent.

```sh
pi install npm:@johnnywu/pi-herdr-agents
```

## Usage

Start Pi in a Herdr Core terminal and attach to it.

```sh
hc run --bg --name pi-lead -- "$(command -v pi)"
hc attach pi-lead
```

For a local checkout, run `pi -e .` from the repository directory inside an hc terminal, or run `pi install .` to add the checkout to Pi's package settings. The extension registers its tools when `HC_TERMINAL_ID` is set. `hc_run` explicitly loads the same extension in the child Pi process, which uses its own model configuration.

| Tool | Usage |
| --- | --- |
| `hc_worker` | Lead-only lifecycle for async workers: `spawn` (name, template, task, cwd?, model?), `reuse` (name, task), `send`, `read`, `status`, `interrupt`, `close`. Active only in the `hc_lead` role; there is no wait action. |
| `hc_report` | Worker and peer reporting: `done` and `blocked` push one line plus a `report: <path>` pointer to the parent, `peer` messages another agent in the space, and `list_peers` lists them. A named `report_file` must carry the `## Goal`, `## Changes`, `## Verification`, and `## Blockers` headings. |
| `hc_run` | Pass `name`, `task`, and optionally `agent`, `model`, `cwd`, and `labels`. The first task is delivered once the child Pi is idle. |
| `hc_agents` | List the hc addresses and statuses of the current agent, its parent, its direct children, and its siblings. Set `include_finished` to include finished children and siblings. |
| `hc_ls` | List live terminals visible to Herdr Core, including terminals on connected machines. Set `include_finished` to add finished terminals. Returns the JSON from `hc ls`. |
| `hc_send` | Pass a `message`. Omit `target` to send it to the parent, or provide the address of a direct child or sibling. If Pi is working, it receives the message as a steering message. |
| `hc_wait` | Wait for a specific `target`, or set `children` to `"any"` or `"all"` to wait for direct child terminals reported by hc. An incoming message or a timeout can end the wait early. |
| `hc_read` | Read terminal output from a managed direct child by `target`. Optional `lines` defaults to 40 with a range of 0–200. |
| `hc_stop` | Pass a managed direct child’s `target` and an `action`. `interrupt` stops its current turn and `kill` ends its program. |
| `hc_rm` | Remove a managed direct child’s finished terminal by `target`. |

Pass `labels` as a map of string values, such as `{"role":"reviewer","project":"docs"}`. Each entry becomes a separate `hc run --label key=value` argument. The extension reserves the `pi-herdr-agents` key for discovering its agents. Herdr Core treats an empty value as removing that label.

For example, ask the parent agent to delegate code review and testing to two subagents. They can find each other with `hc_agents`, exchange findings with `hc_send`, and report back to the parent when they finish or get blocked. You can open any terminal with `hc attach <address>`.

Herdr Core delivers messages through Pi's input area. A successful send means hc delivered the message. The `started` field indicates whether hc observed a new turn. If `hc_run` returns `first_message.sent` as `false` or `null`, or `started` is `false`, inspect the terminal at the returned address. Respond to any approval prompt shown at startup. If the tool is canceled during delivery, use `hc_agents` to find the launched terminal by name.

By default, child agents exit when the program in their parent terminal exits. The tools operate within a single Herdr Core instance.

## Delegation roles

The extension resolves the running Pi process into one role at session start and only gives that role the tools and prompt sections it can use:

| Role | How it is detected | Tools activated |
| --- | --- | --- |
| `hc_lead` | A top-level terminal inside a Herdr space (`HC_TERMINAL_ID` with no parent and no template). | `hc_worker`; `hc_report` and `hc_wait` are removed so reporting stays push-first. |
| `hc_worker` | A terminal with a parent, a worker agent profile, or `hc_worker spawn`. | `hc_report`; `hc_worker` stays inactive so a worker cannot recurse. |
| `hc_peer` | A `peer` agent profile or template with no parent. | `hc_report` for `peer` and `list_peers`. |
| `subagent` | `PI_SUBAGENT_DEPTH > 0`. | No delegation tools or prompt sections. |
| `standalone` | Plain `pi` without a Herdr terminal. | A short note pointing at `subagent()`. |

`hc_worker spawn` accepts either an `hc` template or an agent profile. A name that `hc templates --json` does not own launches through `--hc-agent-profile`, so `.pi/agents/{grunt,workhorse,peer}.md` works even when the Herdr Core templates are absent; set `PI_HERDR_USE_PROFILE_LAUNCH=1` to prefer the profile even when both exist.

`hc_worker reuse` resets an owned worker's Pi session in place. It is fail-closed: before the next task is delivered the pane must show Pi's fresh-session signature, and after delivery a new session file under `~/.pi/agent/sessions/<cwd-slug>/` must corroborate the reset. Ownership and tab state are persisted as an `hc-delegation-state` custom entry.

## Agent definitions

`hc_run` can use the same Agent Markdown files as `pi-subagents`. Put definitions in `~/.pi/agent/agents/` or `.pi/agents/` in the parent Pi workspace. Project definitions take precedence by frontmatter `name`. The child runs in the directory selected by `cwd`, where Pi discovers project context and skills.

```markdown
---
name: reviewer
description: Review changes for correctness and regressions.
tools: read, grep, find, ls
models: anthropic/claude-sonnet-4-6, magpie/claude/*
thinking: high
systemPrompt: replace
---

Review the requested changes. Report actionable findings with file and line references.
```

Invoke it with `hc_run({ "name": "review-auth", "agent": "reviewer", "task": "Review the authentication changes." })`. The `name` identifies the terminal. The `agent` selects the Markdown definition. Omit `agent` to launch a child with its usual Pi configuration, where the parent's delegation rules permit it.

| Field | Behavior |
| --- | --- |
| `name`, `description` | Required profile name and optional summary. |
| `models` | Optional comma-separated model IDs and `*` patterns. Pass `model` to `hc_run` or to a profile launch through `hc_worker` to select an allowed model. With no selection, the first entry is used. A wildcard default uses the first available Pi model that matches. An omitted or empty list allows any selection. |
| `thinking` | Optional Pi thinking level. Defaults to `off` for a named profile. |
| `systemPrompt` | `append` (default) adds the body to the normal prompt. `replace` substitutes the default prompt and keeps project context. `replace-all` also disables project context. Both replacement modes include a tool list and guidelines from the active tools. |
| `tools` | Optional comma-separated Pi tool list. `subagent` selects `hc_run`. HC includes `hc_send` and `hc_agents` for reporting and coordination. |
| `skills` | Comma-separated names or `*` patterns matched against skills available to the child Pi, including enabled package skills. Only matching skills are advertised in the prompt. |
| `allowedAgents`, `maxDepth` | Optional comma-separated list of profiles available for HC delegation and maximum delegation depth (default `10`). Descendants inherit the applicable limits. `maxDepth: 0` prevents the named child from delegating. |
| `debug` | Set to `true` to write `debug-system-prompt.md` in the child workspace when a turn starts. |

Rename an existing `model:` field to `models:`. Profile lookup reports a migration warning for definitions with the old field.

The optional `<pi-subagents-runtime-tools />` marker places the runtime tool block at a specific point in a replacement prompt. Without the marker, HC places it after the body.

## Local development

You need Node.js 22.19 or later and Bun.

```sh
bun install
bun run lint
bun test
```

## Project structure

- `extensions/index.ts` is the sole Pi extension entry point.
- `extensions/hc-tools.ts` registers the terminal tools, and `extensions/hc-client.ts` runs hc commands and resolves terminal relationships.
- `extensions/hc-role.ts` resolves the runtime role, role-scoped tool plans, prompt sections, and Pi session identity helpers.
- `extensions/hc-worker.ts` builds `hc_worker` launch argv, resolves Herdr tabs, and validates report sections.
- `extensions/hc-delegation.ts` implements `hc_worker` and `hc_report`.
- `tests/` covers Pi package loading, terminal tools, and the worker/report lifecycle.
