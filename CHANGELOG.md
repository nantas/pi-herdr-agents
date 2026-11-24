# Changelog

## Unreleased

- Add `hc_worker` (spawn, reuse, send, read, status, interrupt, close) and `hc_report` (done, blocked, peer, list_peers) with role-scoped prompt injection for `hc_lead`, `hc_worker`, `hc_peer`, `subagent`, and `standalone`.
- Spawn resolves an `hc` template or an agent profile, attaches the space, tab, and agent labels, renames a default-named tab once, and verifies the launch task landed.
- Reuse performs a two-phase, fail-closed `/new` reset with screen attestation and session-file corroboration.
- A named `hc_report` report file is validated for the `## Goal`, `## Changes`, `## Verification`, and `## Blockers` sections before the push.
- `createHcDelegationExtension` accepts composition deps so another extension can own the session state, the role resolution, and the persistence (`state`, `onPersist`, `ensureRole`, `managePrompts`), plus the launch/report policies it keeps itself (`pendingReportPath`, `verifyReportSections`, `spawnLabels`, `requireKnownTemplate`).
- Delegated roles lose `hc_run` and `hc_wait` (`hc_worker`, `hc_peer`, `subagent`), and the Lead loses `hc_run`: `hc_worker` is the launcher that owns labels, ownership, and first-message delivery. `/hc-role allow-subagents` still lifts the `hc run` half for a worker or peer.
- Remove TypeScript parameter properties from `HcClient`/`HcError` so the modules load under Node's strip-only type stripping.
- Let `hc_worker` callers select a model allowed by the agent profile.

## 0.2.0

- Let `hc_run` callers select a model allowed by the agent profile.
- Use the shared `models` field and `tools` syntax from `@johnnywu/pi-agent-profiles@0.2.0`.

## 0.1.1

- Use the parent Pi's `PATH` when launching a child through Herdr Core on Unix so Pi launchers can find Node.js.

## 0.1.0

- Load named Agent Markdown profiles through `@johnnywu/pi-agent-profiles`, with shared system prompt modes, skill selection, and tool guidance.

- Add Herdr Core tools to launch interactive Pi subagents, exchange messages among parent, child, and sibling agents, and wait for and manage child terminals.
- Set up the Pi extension package and development tooling.
