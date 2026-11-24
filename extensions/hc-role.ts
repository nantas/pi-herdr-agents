/**
 * Role detection and role-scoped prompt content for `hc_worker` / `hc_report`.
 *
 * A Pi process resolves into one of five roles:
 *
 *   hc_lead      top-level human terminal inside a herdr space — delegates work
 *   hc_worker    terminal started by `hc_worker spawn` or `hc run <template>`
 *   hc_peer      a `peer` profile/template terminal: reaches other agents
 *   subagent     a `@johnnywu/pi-subagents` child (PI_SUBAGENT_DEPTH > 0)
 *   standalone   plain `pi`, outside `hc`
 *
 * Everything here is pure and injectable (`CommandRunner` / `FsIo`) so the
 * lifecycle in `hc-worker.ts` can be tested without a live herdr core.
 */

import { loadAgentDefinitions } from '@johnnywu/pi-agent-profiles';
import { join } from 'node:path';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<CommandResult>;

export interface FsIo {
  exists: (path: string) => boolean;
  listDir: (dir: string) => string[];
  readFile: (file: string) => string | null;
}

/** Custom entry type persisted by the extension; `audit.ts` reads the same entry. */
export const STATE_CUSTOM_TYPE = 'hc-delegation-state';

export const SECTION_DELEGATION = 'delegation';
export const SECTION_WORKER = 'hc_worker_role';
export const SECTION_PEER = 'hc_peer_role';
export const MANAGED_SECTIONS = [SECTION_DELEGATION, SECTION_WORKER, SECTION_PEER];

/** Templates the `peer` role is keyed on, and the documented spawn targets. */
export const BUILTIN_TEMPLATES = ['grunt', 'workhorse', 'peer'] as const;

/**
 * Roles whose behaviour the audit ledger judges.
 *
 * The ledger exists to answer "did the Lead accept evidence it never read", so
 * only a session acting as the Lead records: `hc_lead` owns intent and
 * acceptance, and `standalone` is still the human's top-level session.
 *
 * `hc_worker`, `hc_peer` and `subagent` are audited through the Lead that
 * dispatched them; their own input stream is full of worker envelopes they must
 * never bind.
 */
export const AUDITED_ROLE_KINDS = ['hc_lead', 'standalone'] as const;

/** `true` when this role's behaviour is the Lead's behaviour. */
export function isAuditedRole(role: { kind: string }): boolean {
  return (AUDITED_ROLE_KINDS as readonly string[]).includes(role.kind);
}

const SUBAGENT_SNIPPET =
  'One-shot delegated investigation (read-only barrier): results return once and the agent then ends; never resumable, never a follow-up worker';

const WORKER_SUBAGENT_SNIPPET =
  'One-shot delegation within the assigned scope. Returns a result and then ends.';

export interface HcTemplate {
  name: string;
  description: string;
  command: string;
}

export interface AgentSummary {
  name: string;
  description: string;
  scope: 'global' | 'project' | 'path';
}

export type RuntimeRole =
  | { kind: 'subagent'; depth: number; name: string | null }
  | { kind: 'standalone' }
  | {
      kind: 'hc_worker';
      terminalId: string;
      parent: string | null;
      template: string | null;
      spaceId: string | null;
    }
  | { kind: 'hc_peer'; terminalId: string; spaceId: string | null }
  | { kind: 'hc_lead'; terminalId: string; spaceId: string | null; templates: HcTemplate[] };

export type RoleKind = RuntimeRole['kind'];

export interface OwnedWorker {
  address: string;
  name: string;
  template: string | null;
  task: string | null;
  spawnedAt: number;
}

export interface DelegationSessionState {
  tabId: string | null;
  tabName: string | null;
  ownedWorkers: Record<string, OwnedWorker>;
  guardEnabled: boolean;
  roleOverride: 'allow_subagents' | null;
}

export interface RolePlan {
  /** Tool names this role must have active. */
  addTools: string[];
  /** Tool names this role must not have active. */
  removeTools: string[];
  /** System prompt sections to set; `null` deletes a stale section. */
  sections: Record<string, string | null>;
  /** Replacement `toolSnippets.subagent`, or `null` to leave it alone. */
  subagentSnippet: string | null;
}

export interface HcTerminalInfo {
  address?: string;
  parent?: string | null;
  template?: string | null;
  /** `hc` terminal state: `"live"` or a finished state such as `"finished"`. */
  state?: string;
  labels?: Record<string, string>;
  /** The directory the pane's program runs in; keys the Pi session directory. */
  cwd?: string;
  /** Herdr-observed turn counter. Supporting evidence only, never identity. */
  turn?: number | null;
  /** The pane's foreground process, as herdr sees it. */
  foreground?: { name?: string | null; pid?: number | null; argv?: string[] } | null;
  /** `{ app, state }`: `state` is `"working"` while the agent is mid-turn. */
  status?: { app?: string | null; state?: string | null } | null;
}

export function parseJson<T>(text: string): T | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

export function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Fail closed: `hc get` succeeds only for a known terminal, so anything that is
 * not explicitly finished still occupies the name.
 */
export function isOccupiedTerminal(info: HcTerminalInfo | null): info is HcTerminalInfo {
  if (!info) return false;
  return info.state !== 'finished';
}

/** Best-effort `hc templates --json`; an unavailable core yields an empty list. */
export async function discoverTemplates(run: CommandRunner): Promise<HcTemplate[]> {
  const result = await run('hc', ['templates', '--json']);
  if (result.code !== 0) return [];
  const parsed = parseJson<{ templates?: unknown }>(result.stdout);
  const raw = parsed?.templates;
  if (!Array.isArray(raw)) return [];
  const templates: HcTemplate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = nonEmpty(record.name);
    if (!name) continue;
    templates.push({
      name,
      description: nonEmpty(record.description) ?? '',
      command: nonEmpty(record.command) ?? '',
    });
  }
  return templates;
}

export interface RuntimeRoleOptions {
  /**
   * Name of the agent profile this child was launched with (`--hc-agent-profile`).
   * A `peer` profile with no parent resolves to `hc_peer`; any other profile (or
   * any profile with a parent) resolves to `hc_worker`.
   */
  profileName?: string | null;
}

/**
 * Resolve the runtime role. Deterministic given `env`, the injectable
 * `CommandRunner` and the launched profile name.
 */
export async function resolveRuntimeRole(
  env: Record<string, string | undefined>,
  run: CommandRunner,
  options: RuntimeRoleOptions = {},
): Promise<RuntimeRole> {
  const depth = Number(env.PI_SUBAGENT_DEPTH ?? 0);
  if (Number.isFinite(depth) && depth > 0) {
    return { kind: 'subagent', depth, name: nonEmpty(env.PI_SUBAGENT_NAME) };
  }

  const terminalId = nonEmpty(env.HC_TERMINAL_ID);
  if (!terminalId) return { kind: 'standalone' };

  const profileName = nonEmpty(options.profileName);
  const result = await run('hc', ['get', terminalId, '--json']);
  const info = result.code === 0 ? parseJson<HcTerminalInfo>(result.stdout) : null;

  if (!info) {
    // A profile-launched child that hc cannot describe is still delegated work:
    // it was started by a parent, so it must never fall back to Lead powers.
    if (!profileName) return { kind: 'standalone' };
    return profileName === 'peer'
      ? { kind: 'hc_peer', terminalId, spaceId: null }
      : { kind: 'hc_worker', terminalId, parent: null, template: profileName, spaceId: null };
  }

  const parent = nonEmpty(info.parent);
  const template = nonEmpty(info.template) ?? profileName;
  const spaceId = nonEmpty(info.labels?.['herdr.space']);
  const name = profileName ?? template;

  if (parent !== null) {
    return { kind: 'hc_worker', terminalId, parent, template: name ?? template, spaceId };
  }
  if (name === 'peer') return { kind: 'hc_peer', terminalId, spaceId };
  if (name !== null) {
    return { kind: 'hc_worker', terminalId, parent: null, template: name, spaceId };
  }
  return { kind: 'hc_lead', terminalId, spaceId, templates: await discoverTemplates(run) };
}

export function emptySessionState(): DelegationSessionState {
  return {
    tabId: null,
    tabName: null,
    ownedWorkers: {},
    guardEnabled: true,
    roleOverride: null,
  };
}

/** Replay the latest `hc-delegation-state` entry from a session. */
export function restoreDelegationState(entries: readonly unknown[]): DelegationSessionState {
  const restored = emptySessionState();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'custom' || record.customType !== STATE_CUSTOM_TYPE) continue;
    const data = record.data as Partial<DelegationSessionState> | undefined;
    if (!data || typeof data !== 'object') continue;
    restored.tabId = nonEmpty(data.tabId);
    restored.tabName = nonEmpty(data.tabName);
    restored.guardEnabled = data.guardEnabled !== false;
    restored.roleOverride = data.roleOverride === 'allow_subagents' ? 'allow_subagents' : null;
    restored.ownedWorkers = {};
    if (data.ownedWorkers && typeof data.ownedWorkers === 'object') {
      for (const [name, worker] of Object.entries(data.ownedWorkers)) {
        if (!worker || typeof worker !== 'object') continue;
        const owned = worker as Partial<OwnedWorker>;
        restored.ownedWorkers[name] = {
          address: nonEmpty(owned.address) ?? '',
          name: nonEmpty(owned.name) ?? name,
          template: nonEmpty(owned.template),
          task: nonEmpty(owned.task),
          spawnedAt: typeof owned.spawnedAt === 'number' ? owned.spawnedAt : 0,
        };
      }
    }
  }
  return restored;
}

// ---------------------------------------------------------------------------
// Pi session identity (the only structured reset signal)
// ---------------------------------------------------------------------------

/**
 * Pi's session directory slug for a cwd: `/Users/x/pi-config` → `--Users-x-pi-config--`.
 * Only `/` is folded to `-`; every other character (dots, unicode) survives.
 */
export function sessionSlug(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  return `-${trimmed.replace(/\//g, '-')}--`;
}

/** `~/.pi/agent/sessions/<slug>/` for a cwd. */
export function sessionDirFor(homeDir: string, cwd: string): string {
  return join(homeDir, '.pi', 'agent', 'sessions', sessionSlug(cwd));
}

/**
 * Creation time of a Pi session file (`<iso>_<uuid>.jsonl`), or `null` when the
 * name does not carry a parseable stamp.
 */
export function sessionFileCreatedMs(name: string): number | null {
  const match = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Session files a reset created: names absent from `before` whose stamp is at or
 * after the `/new` keys were pressed. Pi persists a session file lazily, on the
 * session's first message, so these can only appear *after* `task` is delivered —
 * which is why they corroborate a reset and never gate one. An undatable name is
 * excluded on purpose: it cannot be attributed to this reset.
 */
export function newSessionFiles(
  before: readonly string[],
  after: readonly string[],
  sinceMs: number,
): string[] {
  const known = new Set(before);
  return after
    .filter((name) => name.endsWith('.jsonl') && !known.has(name))
    .filter((name) => {
      const created = sessionFileCreatedMs(name);
      return created !== null && created >= sinceMs;
    })
    .sort();
}

/** The newest session file in a listing (names start with an ISO stamp), or `null`. */
export function lastSessionFile(names: readonly string[]): string | null {
  const files = names.filter((name) => name.endsWith('.jsonl')).sort();
  return files.length > 0 ? files[files.length - 1] : null;
}

export type ResetReason = 'no-worker-attestation' | 'hc-get-failed' | 'screen-ambiguous';

export type ResetConfidence = 'session-file' | 'screen-only';

export interface ResetDecision {
  status: 'confirmed' | 'unconfirmed';
  reason: ResetReason | null;
  /** Always `"screen-only"` here: the gate runs before any session file can exist. */
  resetConfidence: ResetConfidence | null;
}

/** What the post-delivery session file added, if anything. */
export interface ResetCorroboration {
  sessionAfter: string | null;
  resetConfidence: ResetConfidence;
  /** The degradation to report, or `null` when exactly one file corroborated the reset. */
  warning: string | null;
}

/**
 * Does this screen still show the previous unit? The comparison is negative-only:
 * the reset is confirmed because the old task text and the old bound report path
 * are gone, not because anything new appeared.
 */
export function screenShowsPreviousUnit(
  screen: string,
  task: string | null,
  reportPath: string | null,
): boolean {
  const flat = screen.replace(/\s+/g, ' ');
  if (reportPath !== null && reportPath.length > 0 && flat.includes(reportPath)) return true;
  if (task === null) return false;
  const probe = task.replace(/\s+/g, ' ').trim().slice(0, 80);
  // A short probe matches by accident; only a distinctive prefix is evidence.
  return probe.length >= 12 && flat.includes(probe);
}

/** Pi core's own marker, rendered by `handleClearCommand` after `/new` and nowhere else. */
const FRESH_SESSION_MARKER = 'New session started';
/** The project tool-counter widget, when it is on screen: `Tools (N): …`. */
const TOOL_COUNTER = /\bTools \((\d+)\)/;

/**
 * Does this screen carry Pi's fresh-session signature? Two positive facts, both
 * required because either alone is spoofable:
 *
 * - `New session started` — Pi core renders it only for `/new`. A worker reused
 *   earlier keeps that marker above its *later* conversation, so the marker alone
 *   proves nothing; the caller's negative checks carry that half.
 * - a tool counter of zero, when the tool-counter widget is rendered at all. Pi
 *   re-runs every extension factory on `/new`, so a fresh session shows
 *   `Tools (0)`; a non-zero count is a session that has already worked. An absent
 *   widget (another cwd) is not a contradiction.
 */
export function screenShowsFreshSession(screen: string): boolean {
  const flat = screen.replace(/\s+/g, ' ');
  if (!flat.includes(FRESH_SESSION_MARKER)) return false;
  const counter = flat.match(TOOL_COUNTER);
  if (counter && Number(counter[1]) > 0) return false;
  return true;
}

/**
 * Fail-closed reset gate. It runs after the `/new` keys and before `task` is
 * delivered, so the only evidence that can exist is the pane itself: `hc get` and
 * the visible screen. The previous unit's text must be gone (negative) and Pi's
 * fresh-session marker must be present (positive); a pane that is `working` is
 * answering a prompt, not sitting in a fresh session.
 */
export function decideReset(input: {
  /** The post-reset `hc get` failed or returned no terminal. */
  postGetFailed: boolean;
  /** The pane's `status.state` after the `/new` keys, or `null` when absent. */
  postStatusState: string | null;
  /** `hc read` output (the visible screen), or `null` when it could not be read. */
  screen: string | null;
  /** The previous unit's delivered task, for the negative screen check. */
  previousTask: string | null;
  /** The previous unit's bound report path, for the negative screen check. */
  previousReportPath: string | null;
}): ResetDecision {
  if (input.postGetFailed) {
    return { status: 'unconfirmed', reason: 'hc-get-failed', resetConfidence: null };
  }
  if (input.postStatusState === 'working') {
    return { status: 'unconfirmed', reason: 'screen-ambiguous', resetConfidence: null };
  }
  // Without the previous unit there is nothing to look for, and the marker alone
  // is spoofable (it stays above a reused worker's later conversation).
  if (input.previousTask === null && input.previousReportPath === null) {
    return { status: 'unconfirmed', reason: 'no-worker-attestation', resetConfidence: null };
  }
  if (input.screen === null) {
    return { status: 'unconfirmed', reason: 'screen-ambiguous', resetConfidence: null };
  }
  if (screenShowsPreviousUnit(input.screen, input.previousTask, input.previousReportPath)) {
    return { status: 'unconfirmed', reason: 'screen-ambiguous', resetConfidence: null };
  }
  if (!screenShowsFreshSession(input.screen)) {
    return { status: 'unconfirmed', reason: 'screen-ambiguous', resetConfidence: null };
  }
  return { status: 'confirmed', reason: null, resetConfidence: 'screen-only' };
}

/**
 * Post-delivery corroboration. `newSessions` is `null` when the worker's session
 * directory could not be listed. Exactly one new file is attributed to the reset;
 * anything else is a degradation reported as a warning, never a refusal: the gate
 * already confirmed the reset and `task` is already on the pane.
 */
export function corroborateReset(
  newSessions: readonly string[] | null,
  windowMs: number,
): ResetCorroboration {
  if (newSessions === null) {
    return {
      sessionAfter: null,
      resetConfidence: 'screen-only',
      warning:
        "the worker's Pi session directory could not be listed, so no new session file could corroborate the reset; it is confirmed by the pane's fresh-session signature only.",
    };
  }
  if (newSessions.length === 1) {
    return { sessionAfter: newSessions[0], resetConfidence: 'session-file', warning: null };
  }
  if (newSessions.length === 0) {
    return {
      sessionAfter: null,
      resetConfidence: 'screen-only',
      warning: `no new Pi session file appeared for the worker's cwd within ${windowMs} ms of delivery, so the reset is confirmed by the pane's fresh-session signature only.`,
    };
  }
  return {
    sessionAfter: null,
    resetConfidence: 'screen-only',
    warning: `${newSessions.length} new Pi session files appeared for the worker's cwd, so none can be attributed to this pane; the reset is confirmed by the pane's fresh-session signature only.`,
  };
}

/**
 * Is a non-agent process holding the pane? `hc get` exposes only the foreground
 * process, so a `&` job inside Pi's own TUI is not visible from here; what this
 * catches is a pane whose agent is gone and whose shell (or a stray command) owns
 * the foreground — the pane a reuse must not take over.
 */
export function paneHeldByNonAgent(info: HcTerminalInfo | null): boolean {
  if (!info) return false;
  const foreground = info.foreground;
  if (!foreground) return false;
  const head = nonEmpty(foreground.name) ?? nonEmpty(foreground.argv?.[0]);
  if (head === null) return false;
  const base = head.split(/[\\/]/).pop() ?? head;
  return !['pi', 'node', 'bun', 'deno'].includes(base.replace(/\.exe$/i, ''));
}

// ---------------------------------------------------------------------------
// Agent profiles (`.pi/agents/*.md` project, `~/.pi/agent/agents/*.md` global)
// ---------------------------------------------------------------------------

/**
 * Discover dispatchable agent profiles with `@johnnywu/pi-agent-profiles`, so the
 * Lead prompt lists exactly the names `hc_worker` can spawn. A project file
 * overrides a global file of the same name, mirroring Pi's own resolution order.
 */
export async function discoverAgentSummaries(cwd: string): Promise<AgentSummary[]> {
  let agents: Awaited<ReturnType<typeof loadAgentDefinitions>>['agents'];
  try {
    ({ agents } = await loadAgentDefinitions({ cwd }));
  } catch {
    return [];
  }
  return agents
    .map((agent) => ({
      name: agent.name,
      description: agent.description ?? '',
      scope: agent.source,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Role plan: tools, sections, snippets
// ---------------------------------------------------------------------------

export function buildLeadPrompt(
  role: Extract<RuntimeRole, { kind: 'hc_lead' }>,
  agents: AgentSummary[],
): string {
  const lines: string[] = [
    `<${SECTION_DELEGATION}>`,
    `You are the Lead in a herdr space (terminal \`${role.terminalId}\`${
      role.spaceId ? `, space \`${role.spaceId}\`` : ''
    }). You own intent, coordination and acceptance — not execution.`,
    '',
    'Division of labor:',
    '- All multi-file work (>=2 files) belongs to `hc_worker`, in any file type: code, config, docs, and workflow/planning artifacts (specs, plans, ADRs, task lists).',
    '- Every worker task prompt must require the worker to run the verification commands and report the exact commands, the observed output, or the log paths.',
    '- You align intent, prompt and coordinate workers, then audit their results, diffs and verification evidence. Do not run test/build/lint/verification suites in your own bash.',
    '- `subagent()` is a one-shot read-only barrier: the result comes back and the agent ends, so a follow-up edit needs `hc_worker({ action: "send" })` or a new spawn.',
    '- Never start workers with `bash` + `hc run <template>`. Use `hc_worker({ action: "spawn" })`: it sets the space/tab labels, tracks ownership, and verifies the first message landed.',
    '',
    'Pane economy — a worker is a terminal pane a human watches, so an idle pane is a liability, not a reserve:',
    '- When the next unit of the same shape is for a worker you already own, hand it over with `hc_worker({ action: "reuse", name, task })`. It resets that pane\'s Pi session in place, keeps the terminal and both labels, and delivers `task` as the new session\'s first message — same pane, new unit.',
    "- `spawn` is for genuine concurrency (units that must run at the same time) or for a contaminated pane: a live background process, a session whose reset you could not verify, or leftover state that would make the new unit's evidence unreadable.",
    '- When a worker finishes its unit and nothing is queued for it, `close` it in the same turn. Do not park an idle pane for later.',
    '- This is guidance, not a gate: it never blocks a `spawn` (or any other) call, so use your judgement and say which case you took.',
    '',
    '`hc_worker` actions: `spawn` (name, template, task, cwd?), `reuse` (name, task), `send`, `read`, `status`, `interrupt`, `close`. Send follow-up edits to the existing worker with `send`.',
    '',
    'Async push-first: dispatch, confirm `first_message.sent`, tell the person in one line that the worker is running, then end your turn. The worker pushes `hc_report` when it is done or blocked and that push starts your next turn. Never park the conversation in `hc wait` — it is not an action here and it freezes the human-facing turn. While the worker runs, keep only non-blocking local work; `hc_worker({ action: "status" })` is the cheap liveness check.',
    'After you close an interactive dialog (`ask_user` etc.), run a lightweight `hc_worker({ action: "status" })` per live worker (never a bulk `read`) and ping only `idle`/`done` workers asking for any undelivered report; never disturb a `working` worker.',
  ];

  if (role.templates.length > 0) {
    lines.push('', 'Available hc templates:');
    for (const template of role.templates) {
      lines.push(
        `- \`${template.name}\`${template.description ? `: ${template.description}` : ''}`,
      );
    }
  }
  if (agents.length > 0) {
    lines.push('', 'Available agent profiles:');
    for (const agent of agents) {
      lines.push(
        `- \`${agent.name}\` (${agent.scope})${agent.description ? `: ${agent.description}` : ''}`,
      );
    }
  } else if (role.templates.length === 0) {
    lines.push(
      '',
      `No hc templates and no agent profiles are discoverable; \`${BUILTIN_TEMPLATES.join('`, `')}\` are the documented templates to check with \`hc templates\`.`,
    );
  }
  lines.push(`</${SECTION_DELEGATION}>`);
  return lines.join('\n');
}

export function buildWorkerPrompt(
  role: Extract<RuntimeRole, { kind: 'hc_worker' }>,
  allowHcRun: boolean,
  subagentActive: boolean,
  agents: AgentSummary[],
): string {
  const lines = [
    `<${SECTION_WORKER}>`,
    `You are an hc worker (terminal \`${role.terminalId}\`, parent \`${role.parent ?? 'none'}\`, template \`${
      role.template ?? 'none'
    }\`${role.spaceId ? `, space \`${role.spaceId}\`` : ''}).`,
    '- Work only inside the assigned scope. Do not widen it, and do not re-decide the goal.',
    allowHcRun
      ? '- `/hc-role allow-subagents` lifts the `hc run` guard for this session. Use it only if the assigned scope explicitly needs a nested hc terminal. `hc_worker` stays inactive.'
      : '- The anti-recursion guard blocks `bash` + `hc run` and `hc_worker` is inactive.',
    subagentActive
      ? '- Use `subagent()` for one-shot delegation within the assigned scope. It returns a result and then ends.'
      : '- `subagent` is unavailable. If you planned to delegate with it, pause that subtask and use `hc_report` with `action: "blocked"` to report the planned work and known blocker.',
    '- Report with `hc_report({ action: "done" | "blocked", summary, report_file })`: write the full 4-section report (`Goal / Changes / Verification / Blockers`) to a report file (e.g. `/tmp/hc-report-<name>.md`) or an ignored scratch file, keep it in this terminal, and push ONLY a one-line `summary` plus that `report_file`. Pushes are async: the Lead reads the file, not a wall of text.',
    '- Verification evidence must come from real runs in this turn — the command, its exit code, the paths. Never delete, skip or weaken a check to turn it green; a pre-existing baseline failure is reported in one line instead of being hidden.',
    '- Stay alive after reporting: follow-up tweaks arrive as messages in this same terminal.',
  ];
  if (agents.length > 0) {
    lines.push('', 'Available `subagent()` agents:');
    for (const agent of agents) {
      lines.push(
        `- \`${agent.name}\` (${agent.scope})${agent.description ? `: ${agent.description}` : ''}`,
      );
    }
  }
  lines.push(`</${SECTION_WORKER}>`);
  return lines.join('\n');
}

export function buildPeerPrompt(
  role: Extract<RuntimeRole, { kind: 'hc_peer' }>,
  allowSubagents: boolean,
): string {
  return [
    `<${SECTION_PEER}>`,
    `You are an hc peer (terminal \`${role.terminalId}\`${role.spaceId ? `, space \`${role.spaceId}\`` : ''}).`,
    '- `hc_report({ action: "list_peers" })` lists the other agents in this space; `hc_report({ action: "peer", target, summary })` sends them a message prefixed with your terminal id.',
    allowSubagents
      ? '- `/hc-role allow-subagents` was enabled for this session. The `hc run` block is lifted, active `subagent` stays available, and `hc_worker` stays inactive. Use nested delegation only if the assigned scope explicitly needs it.'
      : '- Do not start agents: `hc_worker` and `subagent` are inactive here and the anti-recursion guard blocks `bash` + `hc run`.',
    '- Reply with `hc_report({ action: "peer", ... })`; do not start a worker to answer.',
    `</${SECTION_PEER}>`,
  ].join('\n');
}

export function buildStandalonePrompt(): string {
  return [
    `<${SECTION_DELEGATION}>`,
    'Not running under `hc`, so there are no terminals, spaces or workers here.',
    'For multi-file exploration or independent implementation, delegate with `subagent({ agent, task })`.',
    'Subagents are one-shot: the result returns once and the agent ends, so put everything it needs in `task`.',
    `</${SECTION_DELEGATION}>`,
  ].join('\n');
}

/**
 * Tools no delegated role may use unless `/hc-role allow-subagents` was granted.
 *
 * `hc_run` starts a nested hc terminal and `hc_wait` parks the turn, so a role
 * that is itself delegated work (a worker, a peer) must not reach either: the
 * anti-recursion guard already blocks `bash` + `hc run`, and leaving the tool
 * registered would be the same bypass through a different door. A subagent
 * inherits `HC_TERMINAL_ID`, so it is covered too.
 */
const DELEGATED_ROLE_BLOCKED = ['hc_run', 'hc_wait'] as const;

/** Compute the role-scoped tool set, prompt sections and snippets for one turn. */
export function buildRolePlan(
  role: RuntimeRole,
  state: DelegationSessionState,
  agents: AgentSummary[] = [],
): RolePlan {
  const allowSubagents = state.roleOverride === 'allow_subagents';

  switch (role.kind) {
    case 'hc_lead':
      return {
        // `subagent` is deliberately not added: a Lead that turned it off keeps it
        // off. `hc_wait` is removed because async push-first is the contract: the
        // worker's `hc_report` push starts the Lead's next turn, and parking the
        // human-facing turn in a wait blocks the person at the terminal. `hc_run`
        // is removed because it starts an untracked terminal: `hc_worker` spawn is
        // the Lead's launcher and it owns labels, ownership and first-message
        // delivery.
        addTools: ['hc_worker'],
        removeTools: ['hc_report', 'hc_wait', 'hc_run'],
        sections: {
          [SECTION_DELEGATION]: buildLeadPrompt(role, agents),
          [SECTION_WORKER]: null,
          [SECTION_PEER]: null,
        },
        subagentSnippet: SUBAGENT_SNIPPET,
      };
    case 'hc_worker':
      return {
        addTools: ['hc_report'],
        removeTools: allowSubagents
          ? ['hc_worker', 'hc_wait']
          : ['hc_worker', ...DELEGATED_ROLE_BLOCKED],
        sections: {
          [SECTION_DELEGATION]: null,
          [SECTION_PEER]: null,
        },
        subagentSnippet: null,
      };
    case 'hc_peer':
      return {
        addTools: ['hc_report'],
        removeTools: allowSubagents
          ? ['hc_worker', 'hc_wait']
          : ['hc_worker', 'subagent', ...DELEGATED_ROLE_BLOCKED],
        sections: {
          [SECTION_PEER]: buildPeerPrompt(role, allowSubagents),
          [SECTION_DELEGATION]: null,
          [SECTION_WORKER]: null,
        },
        subagentSnippet: null,
      };
    case 'subagent':
      return {
        addTools: [],
        removeTools: ['hc_worker', 'hc_report', ...DELEGATED_ROLE_BLOCKED],
        sections: {
          [SECTION_DELEGATION]: null,
          [SECTION_WORKER]: null,
          [SECTION_PEER]: null,
        },
        subagentSnippet: null,
      };
    case 'standalone':
      return {
        addTools: [],
        removeTools: ['hc_worker', 'hc_report'],
        sections: {
          [SECTION_DELEGATION]: buildStandalonePrompt(),
          [SECTION_WORKER]: null,
          [SECTION_PEER]: null,
        },
        subagentSnippet: null,
      };
  }
}

/** Apply a role plan to an active tool list, preserving the existing order. */
export function applyToolPlan(active: readonly string[], plan: RolePlan): string[] {
  const next = active.filter((tool) => !plan.removeTools.includes(tool));
  for (const tool of plan.addTools) {
    if (!next.includes(tool)) next.push(tool);
  }
  return next;
}

export { SUBAGENT_SNIPPET, WORKER_SUBAGENT_SNIPPET };
