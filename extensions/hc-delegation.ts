/**
 * `hc_worker` and `hc_report`: the full worker lifecycle and reporting contract.
 *
 * - `hc_worker` (spawn / reuse / send / read / status / interrupt / close) owns
 *   launch instead of hand-written `bash` + `hc run`: it sets the space/tab
 *   labels, takes over a still-default tab name, refuses duplicate live names,
 *   verifies the launch task was delivered, and tracks ownership in the
 *   `hc-delegation-state` custom entry so `audit.ts` can read it.
 * - `reuse` resets an owned worker's Pi session in place. Two phases, fail closed:
 *   before delivery the pane must carry Pi's fresh-session signature (screen gate),
 *   after delivery a new session file may corroborate the reset. Nothing here
 *   creates a terminal or touches the worker's worktree/branch.
 * - `hc_report` pushes one line plus a `report: <path>` pointer, and the report
 *   file itself must carry the four `## Goal / ## Changes / ## Verification /
 *   ## Blockers` sections.
 * - A push that lands on a busy or dialog-locked Lead (exit 9/10, or
 *   `blocked` / `status_mismatch` in the output) is reported as undelivered
 *   guidance instead of a retryable error: never retry-spam, never `--force`.
 */

import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';
import {
  loadAgentDefinitions,
  selectAgentModel,
  type AgentProfile,
} from '@johnnywu/pi-agent-profiles';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { agentFlag, childPiArgs, readLaunchedAgent, type AgentLaunch } from './agent-profiles.ts';
import {
  applyToolPlan,
  buildRolePlan,
  buildWorkerPrompt,
  corroborateReset,
  decideReset,
  discoverAgentSummaries,
  emptySessionState,
  isOccupiedTerminal,
  lastSessionFile,
  MANAGED_SECTIONS,
  newSessionFiles,
  SECTION_WORKER,
  nonEmpty,
  paneHeldByNonAgent,
  parseJson,
  resolveRuntimeRole,
  restoreDelegationState,
  screenShowsFreshSession,
  sessionDirFor,
  STATE_CUSTOM_TYPE,
  SUBAGENT_SNIPPET,
  WORKER_SUBAGENT_SNIPPET,
  type CommandResult,
  type CommandRunner,
  type DelegationSessionState,
  type FsIo,
  type HcTerminalInfo,
  type ResetCorroboration,
  type RuntimeRole,
} from './hc-role.ts';
import {
  buildProfileSpawnArgs,
  buildSpawnArgs,
  DEFAULT_SPAWN_LABELS,
  findTabName,
  missingReportSections,
  REPORT_SECTIONS,
  resolveSpawnMode,
  resolveTabFromAppList,
  shouldRenameTab,
  type HerdrTab,
  type SpawnLabel,
  type SpawnMode,
} from './hc-worker.ts';

export interface HcDelegationDeps {
  run?: CommandRunner;
  env?: Record<string, string | undefined>;
  io?: FsIo;
  homeDir?: string;
  now?: () => number;
  /** Wait between verification attempts. Injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** How long a `/new` may take to show up as a new session file. */
  resetWindowMs?: number;
  /** Poll interval while waiting for that file to appear. */
  resetPollMs?: number;
  /** Extension entry point the profile launch loads in the child Pi process. */
  extensionPath?: string;
  /** Agent profile name a child was launched with; defaults to the `hc-agent-profile` flag. */
  profileName?: () => Promise<string | null>;
  /**
   * Compose onto a session state a caller already owns (a guard/audit layer).
   * The caller keeps the object and the persistence; every mutation here goes
   * through `get()`, so the layers never hold two copies of the same facts.
   */
  state?: HcWorkerState;
  /** Replace the default `hc-delegation-state` append. Required when `state` is injected. */
  onPersist?: () => void;
  /** Reuse the caller's role resolution instead of resolving a second one. */
  ensureRole?: () => Promise<RuntimeRole>;
  /**
   * Register the role-scoped prompt/tool-plan hook. A caller that composes its
   * own prompt policy (extra guard rules, io-injected agent discovery) sets
   * this to `false` and registers `before_agent_start` itself.
   */
  managePrompts?: boolean;
  /**
   * The report path of a still-pending evidence acceptance for a worker, used by
   * `reuse` as the negative half of its reset gate. Defaults to none.
   */
  pendingReportPath?: (name: string) => string | null;
  /**
   * Validate a named `report_file` against the four required headings. On by
   * default: a pushed report must point at real evidence. A caller whose report
   * contract only appends the path turns it off.
   */
  verifyReportSections?: boolean;
  /** `--label` pairs attached to a template spawn. Defaults to this package's label. */
  spawnLabels?: readonly SpawnLabel[];
  /**
   * Resolve `template` against `hc templates` and the agent profiles before
   * spawning. On by default; a caller whose `hc run` owns the name passes
   * `false` and lets the core decide.
   */
  requireKnownTemplate?: boolean;
}

/** The session state `hc_worker` / `hc_report` read and mutate. */
export interface HcWorkerState {
  get(): DelegationSessionState;
  set(next: DelegationSessionState): void;
}

/** A state store this module owns, for a standalone extension. */
function ownedState(): HcWorkerState {
  let current: DelegationSessionState = emptySessionState();
  return {
    get: () => current,
    set: (next) => {
      current = next;
    },
  };
}

function defaultIo(): FsIo {
  return {
    exists: (path) => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    listDir: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    readFile: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const HC_WORKER_ACTIONS = [
  'spawn',
  'reuse',
  'send',
  'read',
  'status',
  'interrupt',
  'close',
] as const;

const HC_REPORT_ACTIONS = ['done', 'blocked', 'peer', 'list_peers'] as const;

const hcWorkerParameters = Type.Object(
  {
    action: Type.Union(
      HC_WORKER_ACTIONS.map((action) => Type.Literal(action)),
      {
        description:
          'spawn: start an async worker in this Herdr space/tab; it pushes hc_report back when done or blocked. reuse: reset an owned worker Pi session in place and hand it the next unit (same pane, new session). send/read/status/interrupt: operate on a worker this session owns. close: only once its evidence is collected and no stray background process, temporary worktree or scratch file from it is left behind.',
      },
    ),
    name: Type.Optional(
      Type.String({
        description:
          'Worker name: 1-32 of a-z 0-9 - _. Required for spawn and reuse; the handle for every other action.',
      }),
    ),
    template: Type.Optional(
      Type.String({
        description:
          'hc template or agent profile to launch (e.g. grunt, workhorse, peer). A profile launch is used when `hc templates` does not own the name. Required for spawn.',
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Optional model override for the spawned worker (must match the profile's models allowlist when launching an agent profile).",
      }),
    ),
    task: Type.Optional(
      Type.String({
        description:
          "The worker's first message. List explicitly: the scope, the boundaries (what not to touch), the verification commands to run, and the required report format plus its report file path. Required for spawn and reuse.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory for the spawned worker. Defaults to the Lead's cwd.",
      }),
    ),
    text: Type.Optional(
      Type.String({ description: 'Message body for send. hc_worker never passes --force.' }),
    ),
  },
  { additionalProperties: false },
);

const hcReportParameters = Type.Object(
  {
    action: Type.Union(
      HC_REPORT_ACTIONS.map((action) => Type.Literal(action)),
      {
        description:
          'done: report completion to the parent. blocked: report a blocker to the parent. peer: message another agent in this space. list_peers: list the other agents in this space.',
      },
    ),
    summary: Type.Optional(
      Type.String({
        description:
          'One-line outcome for done/blocked/peer: the verification command and its actual result. Keep the detail in report_file.',
      }),
    ),
    report_file: Type.Optional(
      Type.String({
        description:
          'Path holding the full 4-section report (Goal / Changes / Verification / Blockers), e.g. /tmp/hc-report-<name>.md. Pushed to the recipient as `report: <path>`.',
      }),
    ),
    target: Type.Optional(
      Type.String({ description: 'Peer address for action=peer, exactly as hc ls lists it.' }),
    ),
  },
  { additionalProperties: false },
);

type HcWorkerParams = {
  action: (typeof HC_WORKER_ACTIONS)[number];
  name?: string;
  template?: string;
  model?: string;
  task?: string;
  cwd?: string;
  text?: string;
};

type HcReportParams = {
  action: (typeof HC_REPORT_ACTIONS)[number];
  summary?: string;
  report_file?: string;
  target?: string;
};

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text }], details };
}

function errorResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text }], details, isError: true };
}

/** `hc send` exit codes that mean "the recipient is busy or in a dialog". */
const UNDELIVERED_SEND_CODES = new Set([9, 10]);

/**
 * A push that cannot land right now is not a failure to retry: `hc send` exits 9
 * or 10, or says `blocked` / `status_mismatch`, while the recipient is working or
 * sitting in a human dialog.
 */
function isUndeliveredReport(sent: CommandResult): boolean {
  if (UNDELIVERED_SEND_CODES.has(sent.code)) return true;
  const combined = `${sent.stderr}\n${sent.stdout}`.toLowerCase();
  return combined.includes('blocked') || combined.includes('status_mismatch');
}

interface SpawnLaunchResult {
  address: string;
  firstMessage: { sent: boolean | null; reason?: string | null } | null;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export function createHcDelegationExtension(deps: HcDelegationDeps = {}) {
  return function hcDelegationFactory(pi: ExtensionAPI): void {
    const env = deps.env ?? (process.env as Record<string, string | undefined>);
    const io = deps.io ?? defaultIo();
    const homeDir = deps.homeDir ?? nonEmpty(env.HOME) ?? homedir();
    const now = deps.now ?? (() => Date.now());
    const extensionPath =
      deps.extensionPath ?? fileURLToPath(new URL('./index.ts', import.meta.url));
    const run: CommandRunner =
      deps.run ??
      (async (command, args, options) => {
        try {
          const result = await pi.exec(
            command,
            args,
            options?.cwd === undefined ? undefined : { cwd: options.cwd },
          );
          return {
            code: typeof result.code === 'number' ? result.code : 1,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
          };
        } catch (err) {
          return {
            code: -1,
            stdout: '',
            stderr: err instanceof Error ? err.message : String(err),
          };
        }
      });

    const stateStore: HcWorkerState = deps.state ?? ownedState();
    const getState = (): DelegationSessionState => stateStore.get();
    const verifyReportSections = deps.verifyReportSections !== false;
    const spawnLabels = deps.spawnLabels ?? DEFAULT_SPAWN_LABELS;
    const requireKnownTemplate = deps.requireKnownTemplate !== false;
    let rolePromise: Promise<RuntimeRole> | null = null;

    function persist(): void {
      if (deps.onPersist) {
        deps.onPersist();
        return;
      }
      const state = getState();
      pi.appendEntry(STATE_CUSTOM_TYPE, {
        tabId: state.tabId,
        tabName: state.tabName,
        ownedWorkers: state.ownedWorkers,
        guardEnabled: state.guardEnabled,
        roleOverride: state.roleOverride,
      });
    }

    /** Name of the agent profile this process was launched with, if any. */
    async function launchedProfileName(): Promise<string | null> {
      if (deps.profileName) return deps.profileName();
      let flag: boolean | string | undefined;
      try {
        flag = pi.getFlag(agentFlag);
      } catch {
        return null;
      }
      if (typeof flag !== 'string') return null;
      try {
        const launch = JSON.parse(flag) as AgentLaunch;
        if (!launch?.filePath) return null;
        return (await readLaunchedAgent(launch.filePath, launch.digest)).name;
      } catch {
        return null;
      }
    }

    function ensureRole(): Promise<RuntimeRole> {
      if (deps.ensureRole) return deps.ensureRole();
      rolePromise ??= (async () =>
        resolveRuntimeRole(env, run, { profileName: await launchedProfileName() }))();
      return rolePromise;
    }

    async function terminalInfo(target: string): Promise<HcTerminalInfo | null> {
      const result = await run('hc', ['get', target, '--json']);
      if (result.code !== 0) return null;
      return parseJson<HcTerminalInfo>(result.stdout);
    }

    /**
     * Resolve the tab holding `address`: its `herdr.tab` label first, `herdr-app ls`
     * matched by terminal address as the fallback. The tab name is read from
     * `herdr-app ls` when available so a rename never clobbers a named tab.
     */
    async function resolveTab(address: string): Promise<HerdrTab | null> {
      const role = await ensureRole();
      const info = await terminalInfo(address);
      const fromLabel = nonEmpty(info?.labels?.['herdr.tab']);
      const spaceId = 'spaceId' in role ? role.spaceId : null;

      if (spaceId) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (attempt > 0) await sleep(100);
          const listed = await run('herdr-app', ['ls']);
          if (
            listed.code !== 0 ||
            !Array.isArray(parseJson<{ spaces?: unknown }>(listed.stdout)?.spaces)
          ) {
            break;
          }
          if (fromLabel) {
            const tabName = findTabName(listed.stdout, fromLabel);
            if (tabName !== null) return { tabId: fromLabel, tabName };
          } else {
            const tab = resolveTabFromAppList(listed.stdout, spaceId, address);
            if (tab) return tab;
          }
        }
      }
      return fromLabel ? { tabId: fromLabel, tabName: null } : null;
    }

    /** Machine-readable form of the four headings, for tool details. */
    function reportSectionReport(source: string | null) {
      const missing = source === null ? [...REPORT_SECTIONS] : missingReportSections(source);
      return { required: [...REPORT_SECTIONS], missing, readable: source !== null };
    }
    // -- Reuse: reset a pane in place ---------------------------------------

    const resetWindowMs = deps.resetWindowMs ?? 8000;
    const resetPollMs = deps.resetPollMs ?? 250;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

    /**
     * Reset an owned worker's Pi session in place and deliver the next unit's task.
     *
     * Two phases, fail closed at the first: before delivery the pane itself must
     * carry Pi's fresh-session signature (`hc get` not working, `New session
     * started` on screen, none of the previous unit's text); after delivery a new
     * session file may corroborate the reset, and its absence is a warning, never a
     * refusal.
     */
    async function reuseWorker(
      role: Extract<RuntimeRole, { kind: 'hc_lead' }>,
      name: string,
      task: string,
    ): Promise<ToolResult> {
      const owned = getState().ownedWorkers[name];
      const before = await terminalInfo(name);
      const address = nonEmpty(before?.address) ?? nonEmpty(owned?.address) ?? null;
      const parent = nonEmpty(before?.parent);
      const turnBefore = typeof before?.turn === 'number' ? before.turn : null;

      const refused = (text: string, reason: string): ToolResult =>
        errorResult(text, {
          status: 'refused',
          reason,
          name,
          address,
          sessionBefore: null,
          sessionAfter: null,
          turnBefore,
          turnAfter: turnBefore,
          resetConfidence: null,
          firstMessageSent: false,
          resetSent: false,
          warnings: [],
        });

      if (!owned && parent !== role.terminalId) {
        return refused(
          `Refusing to reuse \`${name}\`: this session does not own it and its parent is \`${
            parent ?? 'none'
          }\`, not \`${role.terminalId}\`. Only the terminal that started a worker may reuse it.`,
          'not-owned',
        );
      }
      if (!before) {
        return refused(
          `No terminal named \`${name}\` to reuse (hc get found none).`,
          'no-terminal',
        );
      }
      if (before.state === 'finished') {
        return refused(
          `Refusing to reuse \`${name}\`: the terminal is ${before.state ?? 'finished'}, so there is no live session to reset. Close it and spawn a fresh worker.`,
          'not-live',
        );
      }
      if (before.status?.state === 'working') {
        return refused(
          `Refusing to reuse \`${name}\`: it is working. Resetting the pane would discard the unit in flight — wait for its \`hc_report\` push, or interrupt it first.`,
          'working',
        );
      }
      if (paneHeldByNonAgent(before)) {
        const holder =
          nonEmpty(before.foreground?.name) ?? nonEmpty(before.foreground?.argv?.[0]) ?? 'unknown';
        return refused(
          `Refusing to reuse \`${name}\`: a non-agent process (\`${holder}\`) holds the pane, so the Pi session cannot be reset in place. Close the worker and spawn a fresh one.`,
          'background-process',
        );
      }

      // Facts captured before the `/new`: what the previous unit looked like.
      const cwd = nonEmpty(before.cwd);
      const dir = cwd === null ? null : sessionDirFor(homeDir, cwd);
      const dirReadable = dir !== null && io.exists(dir);
      const listingBefore = dirReadable ? io.listDir(dir!) : [];
      const sessionBefore = lastSessionFile(listingBefore);
      const previousTask = nonEmpty(owned?.task);
      // The bound report path of a still-pending acceptance belongs to the same
      // negative screen check. A composing caller that keeps an evidence ledger
      // supplies it; without one there is nothing to look for.
      const previousReportPath: string | null = deps.pendingReportPath
        ? deps.pendingReportPath(name)
        : null;
      const resetSentAt = now();

      // `/new` is typed, not sent. `hc send` wraps every message in an `<hc from="…">`
      // envelope and Pi then dispatches it as a prompt — the pane would receive
      // `<hc from="t41">/new</hc>` and answer it. `hc keys` presses raw characters
      // after a quiet period with no envelope.
      const reset = await run('hc', ['keys', name, '/', 'n', 'e', 'w', 'enter']);
      if (reset.code !== 0) {
        // The keys never landed, so the pane is untouched: no reset to confirm,
        // no acceptance to void, and the unit did not start.
        return errorResult(
          `\`hc keys ${name} / n e w enter\` failed (exit ${reset.code}): ${
            reset.stderr.trim() || reset.stdout.trim()
          }. \`${name}\` was not reset and \`task\` was not delivered; the pane is unchanged.`,
          {
            status: 'reset-unconfirmed',
            reason: null,
            name,
            address,
            sessionBefore,
            sessionAfter: null,
            turnBefore,
            turnAfter: turnBefore,
            resetConfidence: null,
            firstMessageSent: false,
            resetSent: false,
            warnings: [],
          },
        );
      }

      // Phase 1 — gate, before delivery. `hc keys` returns as soon as the
      // characters are pressed, before Pi has repainted, so the gate keeps looking
      // until it can decide: the fresh-session signature appears, the pane starts
      // `working`, or the window expires.
      const gateStartedAt = now();
      const gateAttempts = Math.max(1, Math.ceil(resetWindowMs / Math.max(1, resetPollMs)));
      let after: HcTerminalInfo | null = null;
      let screen: string | null = null;
      let screenReads = 0;
      let resetLatencyMs: number | null = null;
      for (let attempt = 0; attempt < gateAttempts; attempt += 1) {
        after = await terminalInfo(name);
        // A vanished terminal and a busy pane are both decided without more reads.
        if (after === null) break;
        if (nonEmpty(after.status?.state) === 'working') break;
        const read = await run('hc', ['read', name]);
        screenReads += 1;
        screen = read.code === 0 ? read.stdout : null;
        if (screen !== null && screenShowsFreshSession(screen)) {
          resetLatencyMs = now() - gateStartedAt;
          break;
        }
        if (attempt < gateAttempts - 1) await sleep(resetPollMs);
      }
      const turnAfter = typeof after?.turn === 'number' ? after.turn : null;
      const postStatusState = nonEmpty(after?.status?.state);
      const decision = decideReset({
        postGetFailed: after === null,
        postStatusState,
        screen,
        previousTask,
        previousReportPath,
      });

      if (decision.status === 'unconfirmed') {
        // Say what the gate actually saw, so a refusal is diagnosable without
        // re-reading the pane: how long it looked, and which half failed.
        const gateNote =
          after === null
            ? ''
            : ` The gate read the pane ${screenReads} time(s) over ${resetWindowMs} ms after the keys` +
              (postStatusState === 'working'
                ? ' and found the pane working'
                : resetLatencyMs === null
                  ? '; the fresh-session signature never appeared'
                  : `; the signature appeared after ${resetLatencyMs} ms, but the previous unit was still on screen`) +
              '.';
        return errorResult(
          `Refusing to deliver to \`${name}\`: the Pi session reset could not be confirmed (${
            decision.reason
          }).${gateNote} No second \`/new\` was pressed and \`task\` was not delivered; the pane is otherwise untouched. ` +
            `Read it with hc_worker({ action: "read", name: "${name}" }) and either reuse it again or close it and spawn a fresh worker.`,
          {
            status: 'reset-unconfirmed',
            reason: decision.reason,
            name,
            address,
            sessionBefore,
            sessionAfter: null,
            turnBefore,
            turnAfter,
            resetConfidence: decision.resetConfidence,
            firstMessageSent: false,
            resetSent: true,
            resetLatencyMs,
            screenReads,
            voidedAcceptance: previousReportPath,
            warnings: [],
          },
        );
      }

      const delivered = await run('hc', ['send', name, task]);
      const sent = delivered.code === 0 && !isUndeliveredReport(delivered);
      const warnings: string[] = [];
      if (!sent) {
        warnings.push(
          `the unit's task was NOT delivered to the worker (reason: ${
            delivered.code !== 0
              ? `hc send exit ${delivered.code}`
              : delivered.stderr.trim() || delivered.stdout.trim() || 'blocked'
          }). The session was reset, so the pane now holds an idle new session: send the task again with hc_worker({ action: "send", name: "${name}", text: <task> }).`,
        );
      }

      // Phase 2 — corroboration, after delivery. The new session's first message
      // is `task`, so its file is written now; exactly one new file is attributed
      // to this pane. Zero, several or an unreadable directory degrade to a
      // warning: the gate already confirmed the reset and `task` is on the pane.
      let corroboration: ResetCorroboration = {
        sessionAfter: null,
        resetConfidence: 'screen-only',
        warning: null,
      };
      if (sent && dirReadable) {
        const attempts = Math.max(1, Math.ceil(resetWindowMs / Math.max(1, resetPollMs)));
        let newFiles: string[] = [];
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          newFiles = newSessionFiles(listingBefore, io.listDir(dir!), resetSentAt);
          if (newFiles.length > 0) break;
          if (attempt < attempts - 1) await sleep(resetPollMs);
        }
        corroboration = corroborateReset(newFiles, resetWindowMs);
      } else if (sent) {
        corroboration = corroborateReset(null, resetWindowMs);
      }
      if (corroboration.warning) warnings.push(corroboration.warning);

      getState().ownedWorkers[name] = {
        address: address ?? '',
        name,
        template: owned?.template ?? nonEmpty(before.template),
        task,
        spawnedAt: owned?.spawnedAt ?? now(),
      };
      persist();

      const lines = [
        `reused \`${name}\` → ${address ?? 'unknown address'} (same pane, new Pi session${
          corroboration.sessionAfter ? `: \`${corroboration.sessionAfter}\`` : ''
        }; reset confirmed by ${corroboration.resetConfidence}; fresh-session signature seen after ${
          resetLatencyMs ?? 0
        } ms (${screenReads} screen read(s)))`,
        `the worker runs asynchronously: it pushes \`hc_report\` when it is done or blocked, and that push starts your next turn. ` +
          `Do not wait. Tell the person in one line that it is running, then end your turn (or keep only non-blocking local work); ` +
          `\`hc_worker({ action: "status", name: "${name}" })\` is the cheap liveness check.`,
      ];
      for (const warning of warnings) lines.push(`warning: ${warning}`);
      return textResult(lines.join('\n'), {
        status: 'reused',
        name,
        address,
        sessionBefore,
        sessionAfter: corroboration.sessionAfter,
        resetConfidence: corroboration.resetConfidence,
        turnBefore,
        turnAfter,
        firstMessageSent: sent,
        resetSent: true,
        resetLatencyMs,
        screenReads,
        voidedAcceptance: previousReportPath,
        warnings,
      });
    }

    // -- Spawn --------------------------------------------------------------

    /** Resolve the Pi executable, wrapped so the hc server's PATH cannot hide Node. */
    async function piCommand(): Promise<string[]> {
      const lookup = await run(process.platform === 'win32' ? 'where.exe' : 'which', ['pi']);
      const executable = lookup.stdout.split(/\r?\n/, 1)[0]?.trim();
      if (lookup.code !== 0 || !executable || !isAbsolute(executable)) {
        throw new Error('Could not find the Pi executable on PATH.');
      }
      const path = nonEmpty(env.PATH);
      return process.platform !== 'win32' && path
        ? ['/usr/bin/env', `PATH=${path}`, executable]
        : [executable];
    }

    /**
     * Deliver a profile-launched child's first message once Pi is idle. The task
     * cannot be a positional `hc run` argument here because the child command is
     * explicit, so delivery is verified instead of assumed.
     */
    async function deliverFirstMessage(
      address: string,
      task: string,
    ): Promise<SpawnLaunchResult['firstMessage']> {
      let timeout = 30;
      const deadline = now() + timeout * 1000;
      for (let attempt = 0; attempt < 8 && timeout > 0; attempt += 1) {
        const waited = await run('hc', ['wait', '--timeout', String(timeout), '--', address]);
        const waitInfo = parseJson<{ ended?: boolean; reason?: string; status?: string }>(
          waited.stdout,
        );
        const current = await terminalInfo(address);
        if (current?.state && current.state !== 'live') break;
        if (current?.status?.state === 'idle' && current.status.app === 'pi') {
          const sent = await run('hc', ['send', address, task]);
          if (sent.code !== 0 || isUndeliveredReport(sent)) {
            return {
              sent: false,
              reason: sent.code !== 0 ? `hc send exit ${sent.code}` : 'the terminal is busy',
            };
          }
          return { sent: true };
        }

        // A message to the parent can end `hc wait` while the child is still starting.
        const interrupted =
          waitInfo?.reason === 'message' || (waitInfo?.ended === false && !waitInfo.reason);
        const statusPending = waitInfo?.reason === 'status' && current?.status == null;
        if (!interrupted && !statusPending) break;
        timeout = Math.floor((deadline - now()) / 1000);
      }
      return {
        sent: false,
        reason:
          'Pi did not reach idle. Inspect the existing terminal with hc_worker({ action: "read" }) before sending the task.',
      };
    }

    async function profileNamesFor(cwd: string) {
      try {
        const { agents } = await loadAgentDefinitions({ cwd });
        return agents;
      } catch {
        return [] as AgentProfile[];
      }
    }

    async function spawnWorker(
      role: Extract<RuntimeRole, { kind: 'hc_lead' }>,
      params: HcWorkerParams,
      ctx: ExtensionToolContext,
    ): Promise<ToolResult> {
      const name = nonEmpty(params.name);
      const template = nonEmpty(params.template);
      const task = nonEmpty(params.task);
      if (!name) return errorResult('hc_worker requires `name`.');
      if (!template) return errorResult('hc_worker spawn requires `template`.');
      if (!task)
        return errorResult("hc_worker spawn requires `task` (the worker's first message).");

      const existing = await terminalInfo(name);
      if (isOccupiedTerminal(existing)) {
        return errorResult(
          `A terminal named \`${name}\` already exists (address ${
            existing.address ?? name
          }, state ${existing.state ?? 'unknown'}). ` +
            `Pick another name or use hc_worker({ action: "close", name: "${name}" }) first.`,
          { name, address: existing.address ?? null, state: existing.state ?? null },
        );
      }

      const cwd = nonEmpty(params.cwd);
      const profiles = requireKnownTemplate ? await profileNamesFor(ctx.cwd) : [];
      // A caller that owns the launch contract passes the name straight to
      // `hc run` and lets the core accept or reject it; the default resolves the
      // name against `hc templates` and the agent profiles first.
      const mode: SpawnMode | null = requireKnownTemplate
        ? resolveSpawnMode(template, {
            hcTemplates: role.templates.map((entry) => entry.name),
            profileNames: profiles.map((profile) => profile.name),
            env,
          })
        : { mode: 'template' };
      if (!mode) {
        const availableTemplates = role.templates.map((entry) => entry.name);
        const availableProfiles = profiles.map((profile) => profile.name);
        return errorResult(
          `Unknown template \`${template}\`. Available hc templates: ${
            availableTemplates.join(', ') || '(none)'
          }. Available agent profiles: ${availableProfiles.join(', ') || '(none)'}.`,
          { name, template, availableTemplates, availableProfiles },
        );
      }

      // A tab the person closed must not be resurrected: drop the stale label so
      // Herdr opens a fresh tab. `herdr-app ls` failing keeps the old
      // conservative behaviour of reusing the recorded label.
      if (role.spaceId && getState().tabId) {
        const recordedTabId = getState().tabId as string;
        const listed = await run('herdr-app', ['ls']);
        if (listed.code === 0 && findTabName(listed.stdout, recordedTabId) === null) {
          getState().tabId = null;
          getState().tabName = null;
        }
      }

      let launched: SpawnLaunchResult;
      if (mode.mode === 'template') {
        const args = buildSpawnArgs(
          {
            name,
            template,
            task,
            cwd,
            spaceId: role.spaceId,
            tabId: getState().tabId,
          },
          spawnLabels,
        );
        const spawned = await run('hc', args);
        if (spawned.code !== 0) {
          return errorResult(
            `hc run failed (exit ${spawned.code}): ${spawned.stderr.trim() || spawned.stdout.trim()}`,
            { args },
          );
        }
        const info = parseJson<{
          address?: string;
          first_message?: { sent?: boolean | null; reason?: string | null; turn?: number | null };
        }>(spawned.stdout);
        const address = nonEmpty(info?.address);
        if (!address) {
          return errorResult(`hc run returned no terminal address: ${spawned.stdout.trim()}`, {
            args,
          });
        }
        const firstMessage = info?.first_message;
        launched = {
          address,
          firstMessage: firstMessage
            ? { sent: firstMessage.sent ?? null, reason: firstMessage.reason ?? null }
            : null,
          warnings: [],
        };
      } else {
        const profile = profiles.find((candidate) => candidate.name === mode.profileName);
        if (!profile) {
          return errorResult(
            `Agent profile \`${mode.profileName}\` was chosen for launch but could not be read; check the profile file and retry.`,
            { name, template },
          );
        }
        const selectedModel = selectAgentModel(
          profile,
          params.model,
          () => ctx.modelRegistry?.getAvailable?.() ?? [],
        );
        let command: string[];
        try {
          command = await piCommand();
        } catch (error) {
          return errorResult(
            `Agent profile launch needs the Pi executable: ${error instanceof Error ? error.message : String(error)}`,
            { name, template },
          );
        }
        const args = buildProfileSpawnArgs({
          name,
          cwd,
          spaceId: role.spaceId,
          tabId: getState().tabId,
          parent: role.terminalId,
          command,
          extensionPath,
          childArgs: await childPiArgs(profile, undefined, selectedModel),
        });
        const spawned = await run('hc', args);
        if (spawned.code !== 0) {
          return errorResult(
            `hc run failed (exit ${spawned.code}): ${spawned.stderr.trim() || spawned.stdout.trim()}`,
            { args },
          );
        }
        const info = parseJson<{ address?: string }>(spawned.stdout);
        const address = nonEmpty(info?.address);
        if (!address) {
          return errorResult(`hc run returned no terminal address: ${spawned.stdout.trim()}`, {
            args,
          });
        }
        launched = {
          address,
          firstMessage: await deliverFirstMessage(address, task),
          warnings: [],
        };
      }

      const warnings = launched.warnings;
      if (!getState().tabId) {
        const tab = await resolveTab(launched.address);
        if (tab) {
          getState().tabId = tab.tabId;
          getState().tabName = tab.tabName;
          if (shouldRenameTab(tab.tabName)) {
            const renamed = await run('herdr-app', [
              'do',
              'tab.rename',
              '--id',
              tab.tabId,
              '--name',
              name,
            ]);
            if (renamed.code === 0) getState().tabName = name;
            else warnings.push('tab.rename failed; the tab keeps its current name');
          }
        } else {
          warnings.push(
            "could not resolve the worker's Herdr tab; later spawns will attach `herdr.space` only",
          );
        }
      }

      if (launched.firstMessage && launched.firstMessage.sent === false) {
        warnings.push(
          `the launch task was NOT delivered to the worker (reason: ${
            launched.firstMessage.reason ?? 'unknown'
          }). Send it again with hc_worker({ action: "send", name: "${name}", text: <task> }).`,
        );
      }

      getState().ownedWorkers[name] = {
        address: launched.address,
        name,
        template,
        task,
        spawnedAt: now(),
      };
      persist();

      const lines = [
        `spawned \`${name}\` → ${launched.address} (${mode.mode} \`${template}\`)${
          getState().tabId ? ` in tab \`${getState().tabId}\`` : ''
        }`,
        `the worker runs asynchronously: it pushes \`hc_report\` when it is done or blocked, and that push starts your next turn. ` +
          `Do not wait. Tell the person in one line that it is running, then end your turn (or keep only non-blocking local work); ` +
          `\`hc_worker({ action: "status", name: "${name}" })\` is the cheap liveness check.`,
      ];
      for (const warning of warnings) lines.push(`warning: ${warning}`);
      return textResult(lines.join('\n'), {
        name,
        address: launched.address,
        template,
        launch: mode.mode,
        tabId: getState().tabId,
        firstMessageSent: launched.firstMessage?.sent ?? null,
        warnings,
      });
    }

    // -- Close --------------------------------------------------------------

    interface LinkedWorktree {
      path: string;
      branch: string | null;
    }

    /** Parsed `git worktree list --porcelain`; empty outside a git repository. */
    async function linkedWorktrees(cwd: string): Promise<LinkedWorktree[]> {
      const listed = await run('git', ['worktree', 'list', '--porcelain'], { cwd });
      if (listed.code !== 0) return [];
      const worktrees: LinkedWorktree[] = [];
      for (const block of listed.stdout.split(/\n\s*\n/)) {
        let path: string | null = null;
        let branch: string | null = null;
        for (const line of block.split('\n')) {
          if (line.startsWith('worktree ')) path = nonEmpty(line.slice('worktree '.length));
          if (line.startsWith('branch ')) branch = nonEmpty(line.slice('branch '.length));
        }
        if (path) worktrees.push({ path, branch });
      }
      return worktrees;
    }

    /**
     * Close-time hygiene: a worker may leave a stray foreground process in its
     * pane, a temporary git worktree, or uncommitted state in that worktree. The
     * checks report what is still there; they never delete anything.
     */
    async function closeHygiene(
      name: string,
      info: HcTerminalInfo | null,
      cwd: string,
    ): Promise<string[]> {
      const warnings: string[] = [];
      if (paneHeldByNonAgent(info)) {
        const holder =
          nonEmpty(info?.foreground?.name) ?? nonEmpty(info?.foreground?.argv?.[0]) ?? 'unknown';
        warnings.push(`a non-agent process (\`${holder}\`) still holds the pane; hc kill ends it.`);
      }
      for (const worktree of await linkedWorktrees(cwd)) {
        const label = `${basename(worktree.path)} ${worktree.branch ?? ''}`;
        if (!label.includes(name)) continue;
        const status = await run('git', ['-C', worktree.path, 'status', '--short'], { cwd });
        const dirty = status.code === 0 && status.stdout.trim().length > 0;
        warnings.push(
          `worker worktree still exists at \`${worktree.path}\`${
            worktree.branch ? ` (branch \`${worktree.branch}\`)` : ''
          }${dirty ? ' and has uncommitted changes' : ''}.`,
        );
      }
      return warnings;
    }

    async function closeWorker(
      role: Extract<RuntimeRole, { kind: 'hc_lead' }>,
      name: string,
      ctx: ExtensionToolContext,
    ): Promise<ToolResult> {
      const owned = getState().ownedWorkers[name];
      const info = await terminalInfo(name);
      if (!owned) {
        const owner = nonEmpty(info?.parent);
        if (owner !== role.terminalId) {
          return errorResult(
            `Refusing to close \`${name}\`: this session does not own it and its parent is \`${
              owner ?? 'none'
            }\`, not \`${role.terminalId}\`. Only the terminal that started a worker may close it.`,
            { name, owner },
          );
        }
      }

      const warnings = await closeHygiene(name, info, ctx.cwd);
      const killed = await run('hc', ['kill', name]);
      const removed = await run('hc', ['rm', name]);
      delete getState().ownedWorkers[name];
      persist();

      if (killed.code !== 0) warnings.push(`hc kill failed: ${killed.stderr.trim()}`);
      if (removed.code !== 0) warnings.push(`hc rm failed: ${removed.stderr.trim()}`);
      const lines = [`closed \`${name}\``];
      for (const warning of warnings) lines.push(`warning: ${warning}`);
      return textResult(lines.join('\n'), { name, owned: Boolean(owned), warnings });
    }

    // -- Lifecycle hooks ----------------------------------------------------

    pi.on('session_start', async (_event, ctx) => {
      const entries = ctx.sessionManager.getEntries() ?? [];
      stateStore.set(restoreDelegationState(entries));
      rolePromise = null;
      await ensureRole();
    });

    // A composing caller owns the prompt policy (its own guard sections and its
    // own agent discovery), so it registers `before_agent_start` itself.
    if (deps.managePrompts !== false) pi.on('before_agent_start', applyRolePlan);

    async function applyRolePlan(
      event: BeforeAgentStartEvent,
      ctx: { cwd: string },
    ): Promise<undefined> {
      const role = await ensureRole();
      const state = getState();

      const profiles = role.kind === 'hc_lead' ? await discoverAgentSummaries(ctx.cwd) : [];
      const plan = buildRolePlan(role, state, profiles);

      const active = pi.getActiveTools();
      const desired = applyToolPlan(active, plan);
      const changed =
        desired.length !== active.length || desired.some((tool, i) => tool !== active[i]);
      if (changed) pi.setActiveTools(desired);

      const options = event.systemPromptOptions;
      const effective = changed ? pi.getActiveTools() : active;
      if (role.kind === 'hc_worker') {
        const subagentActive = effective.includes('subagent');
        const workerAgents = subagentActive ? await discoverAgentSummaries(ctx.cwd) : [];
        plan.sections[SECTION_WORKER] = buildWorkerPrompt(
          role,
          state.roleOverride === 'allow_subagents',
          subagentActive,
          workerAgents,
        );
        if (subagentActive) plan.subagentSnippet = WORKER_SUBAGENT_SNIPPET;
        else if (options.toolSnippets) {
          const snippet = options.toolSnippets.subagent;
          if (snippet === WORKER_SUBAGENT_SNIPPET || snippet === SUBAGENT_SNIPPET) {
            delete options.toolSnippets.subagent;
          }
        }
      }
      const selected = options.selectedTools ?? [];
      if (
        selected.length !== effective.length ||
        selected.some((tool, i) => tool !== effective[i])
      ) {
        options.selectedTools = [...effective];
      }

      // Mutate in place: returning { systemPrompt } would force a full prompt
      // replacement and invalidate the cached prefix.
      if (!options.sections) options.sections = {};
      for (const key of MANAGED_SECTIONS) {
        const value = plan.sections[key];
        if (value === null || value === undefined) delete options.sections[key];
        else options.sections[key] = value;
      }
      if (plan.subagentSnippet) {
        if (!options.toolSnippets) options.toolSnippets = {};
        options.toolSnippets.subagent = plan.subagentSnippet;
      }

      return undefined;
    }

    // -- hc_worker ----------------------------------------------------------

    pi.registerTool({
      name: 'hc_worker',
      label: 'hc worker',
      description:
        'Manage hc workers in this Herdr space: spawn, reuse, send, read, status, interrupt, close. ' +
        'Spawn places every worker of this session into one shared tab with the space and tab labels set, ' +
        'takes over a tab that still has its default numeric name, and verifies the launch task was actually delivered. ' +
        'A template that `hc templates` does not own is launched as an agent profile (`--hc-agent-profile`). ' +
        'Reuse resets an owned worker Pi session in place (`/new`), verifies fail-closed that the session really was ' +
        "replaced, and delivers the next unit's task to the same pane without creating a terminal. " +
        'Workers run asynchronously and push hc_report back when done or blocked; there is no wait action.',
      promptSnippet:
        'Start, reuse or manage an async hc worker terminal (spawn/reuse/send/read/status/interrupt/close)',
      promptGuidelines: [
        'Use hc_worker({ action: "spawn" }) instead of bash + `hc run <template>`: it sets the space/tab labels, tracks ownership, and verifies first_message delivery.',
        'Pane economy: hand the next unit to an owned worker with hc_worker({ action: "reuse", name, task }) — same pane, new session — and `spawn` only for real concurrency or a contaminated pane.',
        'After spawn or reuse the worker is asynchronous: tell the person it is running and end the turn; never park the turn in `hc wait`. Its hc_report push starts your next turn.',
        'Use hc_worker({ action: "close" }) for workers this session started once their unit is over and nothing is queued: after its evidence is collected and no stray background process, temporary worktree or scratch file from it is left behind.',
      ],
      parameters: hcWorkerParameters,
      defaultActive: false,
      async execute(_toolCallId, rawParams, signal, _onUpdate, ctx): Promise<ToolResult> {
        const params = rawParams as HcWorkerParams;
        // Pi passes a context, but a direct caller may omit it.
        const toolCtx = ctx ?? ({ cwd: process.cwd() } as ExtensionToolContext);
        const role = await ensureRole();

        if (role.kind !== 'hc_lead') {
          return errorResult(
            'hc_worker is only available to an hc Lead (a top-level terminal inside a Herdr space). ' +
              `Current role: ${role.kind}. Report with hc_report instead.`,
          );
        }

        const name = nonEmpty(params.name);
        if (!name) return errorResult('hc_worker requires `name`.');

        if (params.action === 'spawn') return spawnWorker(role, params, toolCtx);

        if (params.action === 'reuse') {
          const task = nonEmpty(params.task);
          if (!task) {
            return errorResult(
              "hc_worker reuse requires `task` (the next unit's first message). Resetting the pane without a task would leave it empty.",
              {
                status: 'refused',
                reason: 'no-task',
                name,
                firstMessageSent: false,
                resetSent: false,
              },
            );
          }
          return reuseWorker(role, name, task);
        }

        if (params.action === 'close') return closeWorker(role, name, toolCtx);

        if (params.action === 'send') {
          const text = nonEmpty(params.text);
          if (!text) return errorResult('hc_worker send requires `text`.');
          // Never --force: sending into a blocked dialog would answer it for the worker.
          const sent = await run('hc', ['send', name, text]);
          if (sent.code !== 0) {
            return errorResult(`hc send failed: ${sent.stderr.trim() || sent.stdout.trim()}`);
          }
          return textResult(`sent to \`${name}\``, { name });
        }

        if (params.action === 'read') {
          const read = await run('hc', ['read', name]);
          if (read.code !== 0) {
            return errorResult(`hc read failed: ${read.stderr.trim() || read.stdout.trim()}`, {
              name,
            });
          }
          return textResult(read.stdout, { name });
        }

        if (params.action === 'status') {
          const info = await terminalInfo(name);
          if (!info) return errorResult(`no terminal named \`${name}\``, { name });
          return textResult(JSON.stringify(info), { name, info });
        }

        if (params.action !== 'interrupt') {
          return errorResult(`Unknown hc_worker action: ${String(params.action)}`, {
            action: params.action,
          });
        }
        if (signal?.aborted) return errorResult('Cancelled.', { name });

        const interrupted = await run('hc', ['interrupt', name]);
        if (interrupted.code !== 0) {
          return errorResult(
            `hc interrupt failed: ${interrupted.stderr.trim() || interrupted.stdout.trim()}`,
            { name },
          );
        }
        return textResult(interrupted.stdout.trim() || `interrupted \`${name}\``, { name });
      },
    });

    // -- hc_report ---------------------------------------------------------

    pi.registerTool({
      name: 'hc_report',
      label: 'hc report',
      description:
        'Report to the parent terminal (done/blocked) or message another agent in this Herdr space (peer/list_peers). ' +
        'Pushes are one line plus a report file path; the full Goal / Changes / Verification / Blockers report lives in that file' +
        (verifyReportSections ? ', and its four headings are validated before the push. ' : '. ') +
        'Messages are formatted and sent with hc; --force is never used.',
      promptSnippet: 'Report done/blocked to the parent terminal, or message a peer in this space',
      promptGuidelines: [
        'Use hc_report({ action: "done", summary, report_file }) when a delegated scope is finished: `summary` is one line with the verification command and its result, `report_file` holds the full Goal / Changes / Verification / Blockers report.',
        'Use hc_report({ action: "blocked", summary, report_file }) when a delegated scope cannot proceed; say what you need and what you already tried.',
        'If hc_report says the push is undelivered, do not retry-spam it and never use --force: keep the report file and wait for the Lead to ping you after its dialog closes.',
      ],
      parameters: hcReportParameters,
      defaultActive: false,
      async execute(_toolCallId, rawParams): Promise<ToolResult> {
        const params = rawParams as HcReportParams;
        const role = await ensureRole();

        if (role.kind === 'subagent' || role.kind === 'standalone') {
          return errorResult(
            `hc_report is not available in role \`${role.kind}\`: there is no herdr terminal to report to.`,
          );
        }

        const summary = nonEmpty(params.summary);
        const reportFile = nonEmpty(params.report_file);
        // `report: <path>` keeps the pushed line one line while the file holds the detail.
        const withReport = (message: string): string =>
          reportFile ? `${message} report: ${reportFile}` : message;
        const lengthNote =
          summary && summary.length > 300
            ? `note: this pushed summary is ${summary.length} chars. Keep pushed summaries one line and move the detail into report_file (Goal / Changes / Verification / Blockers).`
            : null;

        if (params.action === 'done' || params.action === 'blocked') {
          if (!summary) return errorResult(`hc_report ${params.action} requires \`summary\`.`);

          // A report file is the evidence carrier: when one is named, it must carry
          // all four sections, so the Lead never receives a truncated report. A
          // caller whose contract only appends the path turns this off.
          let sections = reportSectionReport(null);
          if (reportFile && verifyReportSections) {
            const source = io.readFile(reportFile);
            if (source === null) {
              return errorResult(
                `hc_report could not read report_file \`${reportFile}\`. Write the full report first (${REPORT_SECTIONS.join(', ')}) and retry.`,
                { report_file: reportFile, reportSections: sections },
              );
            }
            sections = reportSectionReport(source);
            if (sections.missing.length > 0) {
              return errorResult(
                `hc_report ${params.action} report_file \`${reportFile}\` is missing required sections: ${sections.missing.join(
                  ', ',
                )}. A report must contain exactly these headings, each on its own line: ${REPORT_SECTIONS.join(', ')}.`,
                { report_file: reportFile, reportSections: sections },
              );
            }
          }

          let parent = role.kind === 'hc_worker' ? role.parent : null;
          if (!parent) {
            const info = await terminalInfo(role.terminalId);
            parent = nonEmpty(info?.parent);
          }
          if (!parent) {
            return errorResult(
              `No parent terminal found for \`${role.terminalId}\`; nothing to report to.`,
            );
          }
          const message = withReport(`${params.action}: ${summary}`);
          const sent = await run('hc', ['send', parent, message]);
          if (isUndeliveredReport(sent)) {
            // Not an error and not retryable: the Lead is busy or in a human dialog.
            return textResult(
              [
                `status: undelivered (lead_blocked) — hc send to \`${parent}\` did not land (exit ${sent.code}).`,
                'The Lead is busy or in a human dialog. Do NOT retry-spam this report and NEVER use --force.',
                `The full report stays in ${reportFile ?? "this terminal's visible output"} and is remembered as undelivered.`,
                'Wait silently: the Lead pings you after it closes its dialog.',
              ].join('\n'),
              {
                parent,
                message,
                status: 'undelivered (lead_blocked)',
                code: sent.code,
                reportFile,
                undelivered: true,
              },
            );
          }
          if (sent.code !== 0) {
            return errorResult(
              `hc send to parent \`${parent}\` failed: ${sent.stderr.trim() || sent.stdout.trim()}`,
              { parent },
            );
          }
          const reported = `reported ${params.action} to \`${parent}\``;
          return textResult(lengthNote ? `${reported}\n${lengthNote}` : reported, {
            parent,
            message,
            reportFile,
            reportSections: sections,
          });
        }

        if (params.action === 'list_peers') {
          const spaceId = 'spaceId' in role ? role.spaceId : null;
          if (!spaceId) {
            return errorResult(
              'No `herdr.space` label on this terminal, so peers cannot be listed.',
            );
          }
          const listed = await run('hc', ['ls', '--label', `herdr.space=${spaceId}`, '--json']);
          if (listed.code !== 0) {
            return errorResult(`hc ls failed: ${listed.stderr.trim() || listed.stdout.trim()}`);
          }
          const parsed = parseJson<{
            terminals?: Array<{
              address?: string;
              name?: string;
              template?: string;
              state?: string;
            }>;
          }>(listed.stdout);
          const peers = (parsed?.terminals ?? []).filter(
            (terminal) => nonEmpty(terminal?.address) && terminal.address !== role.terminalId,
          );
          if (peers.length === 0) {
            return textResult('no peers in this space', { spaceId, peers: [] });
          }
          const lines = peers.map(
            (peer) =>
              `- ${peer.address}${peer.name ? ` (${peer.name})` : ''}${
                peer.template ? ` [${peer.template}]` : ''
              }${peer.state ? ` ${peer.state}` : ''}`,
          );
          return textResult(`peers in \`${spaceId}\`:\n${lines.join('\n')}`, {
            spaceId,
            peers,
          });
        }

        // peer
        const target = nonEmpty(params.target);
        if (!target) return errorResult('hc_report peer requires `target` (a peer address).');
        if (!summary) return errorResult('hc_report peer requires `summary`.');
        const message = withReport(`peer: ${role.terminalId} ${summary}`);
        const sent = await run('hc', ['send', target, message]);
        if (sent.code !== 0) {
          return errorResult(
            `hc send to \`${target}\` failed: ${sent.stderr.trim() || sent.stdout.trim()}`,
            { target },
          );
        }
        const sentLine = `sent peer message to \`${target}\``;
        return textResult(lengthNote ? `${sentLine}\n${lengthNote}` : sentLine, {
          target,
          message,
          reportFile,
        });
      },
    });
  };
}
