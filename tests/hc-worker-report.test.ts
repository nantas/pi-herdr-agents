import { describe, expect, test } from 'bun:test';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHcDelegationExtension } from '../extensions/hc-delegation.ts';
import {
  applyToolPlan,
  buildRolePlan,
  discoverAgentSummaries,
  emptySessionState,
  resolveRuntimeRole,
  screenShowsFreshSession,
  screenShowsPreviousUnit,
  sessionDirFor,
  type CommandResult,
  type FsIo,
} from '../extensions/hc-role.ts';
import {
  buildProfileSpawnArgs,
  buildSpawnArgs,
  missingReportSections,
  resolveSpawnMode,
} from '../extensions/hc-worker.ts';

const SPACE = 'spc123';
const TAB = 'tab456';
const HOME = '/home/tester';
const WORKSPACE = '/repo';
const EXTENSION = '/package/extensions/index.ts';
const PI = '/usr/local/bin/pi';

function ok(value: unknown): CommandResult {
  return {
    code: 0,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: '',
  };
}

function fail(stderr = 'boom', code = 1): CommandResult {
  return { code, stdout: '', stderr };
}

function fakeIo(files: Record<string, string>, dirs: string[] = []): FsIo {
  return {
    exists: (path) => dirs.includes(path) || path in files,
    listDir: (dir) => {
      if (!dirs.includes(dir)) return [];
      return Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1))
        .filter((name) => !name.includes('/'));
    },
    readFile: (file) => files[file] ?? null,
  };
}

type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => CommandResult | undefined | Promise<CommandResult | undefined>;

interface ExecCall {
  command: string;
  args: string[];
  options?: { cwd?: string };
}

interface HarnessOptions {
  env?: Record<string, string | undefined>;
  activeTools?: string[];
  entries?: unknown[];
  exec?: ExecFn;
  io?: FsIo;
  cwd?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  resetWindowMs?: number;
  resetPollMs?: number;
  profileName?: () => Promise<string | null>;
  /** Extra composition deps (state / onPersist / ensureRole / policies). */
  deps?: Record<string, unknown>;
}

const BASE_TOOLS = ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls', 'subagent'];

function harness(options: HarnessOptions = {}) {
  const hooks: Record<string, Array<(event: any, ctx?: any) => any>> = {};
  const tools: Record<string, any> = {};
  const entries: unknown[] = options.entries ? [...options.entries] : [];
  const execCalls: ExecCall[] = [];
  const setActiveCalls: string[][] = [];
  let active = [...(options.activeTools ?? BASE_TOOLS)];

  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => any) {
      (hooks[event] ??= []).push(handler);
      return () => {};
    },
    registerTool(definition: any) {
      tools[definition.name] = definition;
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ type: 'custom', customType, data });
    },
    getActiveTools: () => [...active],
    getAllTools: () => active.map((name) => ({ name })),
    setActiveTools(names: string[]) {
      setActiveCalls.push([...names]);
      active = [...names];
    },
    getFlag: () => undefined,
    exec() {
      throw new Error('the injected runner must be used');
    },
  };

  createHcDelegationExtension({
    env: options.env ?? {},
    io: options.io,
    homeDir: HOME,
    now: options.now ?? (() => 1000),
    sleep: options.sleep ?? (async () => {}),
    resetWindowMs: options.resetWindowMs ?? 1000,
    resetPollMs: options.resetPollMs ?? 100,
    extensionPath: EXTENSION,
    profileName: options.profileName,
    ...(options.deps ?? {}),
    run: async (command, args, execOptions) => {
      execCalls.push({ command, args: [...args], options: execOptions });
      const value = options.exec ? await options.exec(command, args, execOptions) : undefined;
      return value ?? ok('');
    },
  })(pi as any);

  const ctx = {
    cwd: options.cwd ?? WORKSPACE,
    sessionManager: { getEntries: () => entries },
    ui: { notify: () => {} },
  };

  return {
    entries,
    execCalls,
    hooks,
    setActiveCalls,
    activeTools: () => [...active],
    async fire(event: string, payload: any) {
      let result: any;
      for (const handler of hooks[event] ?? []) {
        const value = await handler(payload, ctx);
        if (value !== undefined) result = value;
      }
      return result;
    },
    callTool(name: string, params: Record<string, unknown>) {
      return tools[name].execute(
        'call-1',
        params,
        undefined,
        undefined,
        ctx as unknown as ExtensionToolContext,
      );
    },
    lastEntry: () => entries.at(-1) as any,
  };
}

function promptOptions() {
  return {
    selectedTools: [...BASE_TOOLS],
    toolSnippets: { subagent: 'one-shot' } as Record<string, string>,
    toolGuidelines: {} as Record<string, string[]>,
    promptGuidelines: [] as string[],
    sections: {} as Record<string, string>,
    cwd: WORKSPACE,
  };
}

function beforeStartEvent() {
  return {
    type: 'before_agent_start',
    messageType: 'user',
    prompt: 'go',
    systemPromptOptions: promptOptions(),
  };
}

const TEMPLATES = {
  templates: [
    { name: 'grunt', description: 'routine implementation', command: 'pi' },
    { name: 'workhorse', description: 'complex implementation', command: 'pi' },
    { name: 'peer', description: 'reach other agents', command: 'pi' },
  ],
};

const leadTerminal = {
  address: 't18',
  parent: null,
  template: null,
  state: 'live',
  labels: { 'herdr.space': SPACE },
};

const workerTerminal = {
  address: 't3g',
  parent: 't18',
  template: 'workhorse',
  state: 'live',
  cwd: WORKSPACE,
  labels: { 'herdr.space': SPACE, 'herdr.tab': TAB },
  status: { app: 'pi', state: 'idle' },
};

function appList(tabName: string, terminals: string[]) {
  return {
    spaces: [
      {
        id: SPACE,
        name: 'repo',
        tabs: [{ id: TAB, name: tabName, terminals: terminals.map((terminal) => ({ terminal })) }],
      },
    ],
  };
}

/** Lead-role routes, with an optional override per call. */
function leadExec(extra?: ExecFn): ExecFn {
  return async (command, args, options) => {
    const fromExtra = extra ? await extra(command, args, options) : undefined;
    if (fromExtra) return fromExtra;
    if (command === 'hc' && args[0] === 'get' && args[1] === 't18') return ok(leadTerminal);
    if (command === 'hc' && args[0] === 'templates') return ok(TEMPLATES);
    return ok('');
  };
}

/** Worker-role routes, with an optional override per call. */
function workerExec(extra?: ExecFn): ExecFn {
  return async (command, args, options) => {
    const fromExtra = extra ? await extra(command, args, options) : undefined;
    if (fromExtra) return fromExtra;
    if (command === 'hc' && args[0] === 'get' && args[1] === 't3g') return ok(workerTerminal);
    return ok('');
  };
}

// ===========================================================================
// Role resolution
// ===========================================================================

describe('resolveRuntimeRole', () => {
  test('a subagent depth skips hc entirely', async () => {
    const calls: string[][] = [];
    const role = await resolveRuntimeRole(
      { PI_SUBAGENT_DEPTH: '2', PI_SUBAGENT_NAME: 'scout' },
      async (_c, args) => {
        calls.push(args);
        return ok('');
      },
    );
    expect(role).toEqual({ kind: 'subagent', depth: 2, name: 'scout' });
    expect(calls).toEqual([]);
  });

  test('depth 0 is not a subagent', async () => {
    const role = await resolveRuntimeRole({ PI_SUBAGENT_DEPTH: '0' }, async () => ok(''));
    expect(role).toEqual({ kind: 'standalone' });
  });

  test('no HC_TERMINAL_ID resolves to standalone without running hc', async () => {
    const calls: string[][] = [];
    const role = await resolveRuntimeRole({}, async (_c, args) => {
      calls.push(args);
      return ok('');
    });
    expect(role).toEqual({ kind: 'standalone' });
    expect(calls).toEqual([]);
  });

  test('a failing hc get resolves to standalone', async () => {
    const role = await resolveRuntimeRole({ HC_TERMINAL_ID: 't7' }, async () => fail());
    expect(role).toEqual({ kind: 'standalone' });
  });

  test('a parent makes the terminal an hc_worker with its identity', async () => {
    const role = await resolveRuntimeRole({ HC_TERMINAL_ID: 't3g' }, async (_c, args) =>
      args[0] === 'get' ? ok(workerTerminal) : ok(TEMPLATES),
    );
    expect(role).toEqual({
      kind: 'hc_worker',
      terminalId: 't3g',
      parent: 't18',
      template: 'workhorse',
      spaceId: SPACE,
    });
  });

  test('a rootless peer template resolves to hc_peer', async () => {
    const role = await resolveRuntimeRole({ HC_TERMINAL_ID: 't39' }, async () =>
      ok({
        address: 't39',
        parent: null,
        template: 'peer',
        state: 'live',
        labels: { 'herdr.space': SPACE },
      }),
    );
    expect(role).toEqual({ kind: 'hc_peer', terminalId: 't39', spaceId: SPACE });
  });

  test('a top-level terminal resolves to hc_lead with its templates', async () => {
    const role = await resolveRuntimeRole({ HC_TERMINAL_ID: 't18' }, async (_c, args) =>
      args[0] === 'templates' ? ok(TEMPLATES) : ok(leadTerminal),
    );
    expect(role).toEqual({
      kind: 'hc_lead',
      terminalId: 't18',
      spaceId: SPACE,
      templates: [
        { name: 'grunt', description: 'routine implementation', command: 'pi' },
        { name: 'workhorse', description: 'complex implementation', command: 'pi' },
        { name: 'peer', description: 'reach other agents', command: 'pi' },
      ],
    });
  });

  test('a peer agent profile with no parent resolves to hc_peer', async () => {
    const role = await resolveRuntimeRole(
      { HC_TERMINAL_ID: 't39' },
      async () => ok({ address: 't39', parent: null, template: null, state: 'live' }),
      { profileName: 'peer' },
    );
    expect(role).toEqual({ kind: 'hc_peer', terminalId: 't39', spaceId: null });
  });

  test('a worker agent profile resolves to hc_worker and names the profile', async () => {
    const role = await resolveRuntimeRole(
      { HC_TERMINAL_ID: 't50' },
      async () => ok({ address: 't50', parent: 't18', template: null, state: 'live' }),
      { profileName: 'grunt' },
    );
    expect(role).toMatchObject({ kind: 'hc_worker', parent: 't18', template: 'grunt' });
  });

  test('a profile-launched child never falls back to standalone when hc get fails', async () => {
    const role = await resolveRuntimeRole({ HC_TERMINAL_ID: 't50' }, async () => fail(), {
      profileName: 'peer',
    });
    expect(role).toEqual({ kind: 'hc_peer', terminalId: 't50', spaceId: null });
  });
});

// ===========================================================================
// Prompt injection and tool activation
// ===========================================================================

describe('before_agent_start', () => {
  test('hc_lead gets hc_worker, loses hc_report and hc_wait, and lists templates and profiles', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-lead-'));
    try {
      await mkdir(join(cwd, '.pi', 'agents'), { recursive: true });
      await writeFile(
        join(cwd, '.pi', 'agents', 'grunt.md'),
        '---\nname: grunt\ndescription: routine implementation\n---\nWork.\n',
      );
      const h = harness({
        env: { HC_TERMINAL_ID: 't18' },
        exec: leadExec(),
        cwd,
        activeTools: [...BASE_TOOLS, 'hc_wait', 'hc_report'],
      });
      const event = beforeStartEvent();
      await h.fire('before_agent_start', event);

      expect(h.activeTools()).toContain('hc_worker');
      expect(h.activeTools()).not.toContain('hc_report');
      expect(h.activeTools()).not.toContain('hc_wait');
      expect(event.systemPromptOptions.selectedTools).toEqual(h.activeTools());

      const section = event.systemPromptOptions.sections.delegation;
      expect(section).toContain('You are the Lead in a herdr space');
      expect(section).toContain('Available hc templates:');
      expect(section).toContain('`grunt`');
      expect(section).toContain('Available agent profiles:');
      expect(section).toContain('`grunt` (project)');
      expect(section).toContain('Async push-first');
      expect(section).not.toContain('action: "wait"');
      expect(event.systemPromptOptions.sections.hc_worker_role).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('hc_worker gets hc_report, loses hc_worker, and is told its real identity', async () => {
    const h = harness({ env: { HC_TERMINAL_ID: 't3g' }, exec: workerExec() });
    const event = beforeStartEvent();
    await h.fire('before_agent_start', event);

    expect(h.activeTools()).toContain('hc_report');
    expect(h.activeTools()).not.toContain('hc_worker');
    const section = event.systemPromptOptions.sections.hc_worker_role;
    expect(section).toContain('You are an hc worker');
    expect(section).toContain('terminal `t3g`');
    expect(section).toContain('parent `t18`');
    expect(section).toContain('template `workhorse`');
    expect(section).toContain('Report with `hc_report');
    expect(section).toContain('Goal / Changes / Verification / Blockers');
    expect(event.systemPromptOptions.sections.delegation).toBeUndefined();
  });

  test('hc_peer gets the peer protocol and hc_report', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't39' },
      activeTools: [...BASE_TOOLS, 'hc_worker'],
      exec: async (command, args) => {
        if (command === 'hc' && args[0] === 'get') {
          return ok({
            address: 't39',
            parent: null,
            template: 'peer',
            state: 'live',
            labels: { 'herdr.space': SPACE },
          });
        }
        return ok('');
      },
    });
    const event = beforeStartEvent();
    await h.fire('before_agent_start', event);

    expect(h.activeTools()).toContain('hc_report');
    expect(h.activeTools()).not.toContain('hc_worker');
    expect(h.activeTools()).not.toContain('subagent');
    const section = event.systemPromptOptions.sections.hc_peer_role;
    expect(section).toContain('You are an hc peer');
    expect(section).toContain('list_peers');
    expect(event.systemPromptOptions.sections.delegation).toBeUndefined();
  });

  test('a subagent turn receives no delegation prompt at all', async () => {
    const h = harness({ env: { PI_SUBAGENT_DEPTH: '1' }, activeTools: ['bash', 'hc_worker'] });
    const event = beforeStartEvent();
    event.systemPromptOptions.sections = { delegation: 'stale', hc_worker_role: 'stale' };
    await h.fire('before_agent_start', event);
    expect(h.activeTools()).toEqual(['bash']);
    expect(event.systemPromptOptions.sections.delegation).toBeUndefined();
    expect(event.systemPromptOptions.sections.hc_worker_role).toBeUndefined();
  });

  test('standalone keeps subagent and only adds a fallback note', async () => {
    const h = harness({ activeTools: ['bash', 'subagent', 'hc_report'] });
    const event = beforeStartEvent();
    await h.fire('before_agent_start', event);
    expect(h.activeTools()).toEqual(['bash', 'subagent']);
    expect(event.systemPromptOptions.sections.delegation).toContain('Not running under `hc`');
  });

  test('the role plan is idempotent when the loadout already matches', async () => {
    const plan = buildRolePlan({ kind: 'standalone' }, emptySessionState());
    const active = ['bash', 'subagent'];
    expect(applyToolPlan(applyToolPlan(active, plan), plan)).toEqual(['bash', 'subagent']);
  });
});

// ===========================================================================
// Spawn argv and mode resolution
// ===========================================================================

describe('spawn argv', () => {
  test('template launches attach the space, tab and agent labels', () => {
    expect(
      buildSpawnArgs({ name: 'w1', template: 'grunt', task: 'x', spaceId: SPACE, tabId: TAB }),
    ).toEqual([
      'run',
      '--bg',
      '--json',
      '--name',
      'w1',
      '--label',
      `herdr.space=${SPACE}`,
      '--label',
      `herdr.tab=${TAB}`,
      '--label',
      'pi-herdr-agents=agent',
      'grunt',
      'x',
    ]);
  });

  test('a profile launch runs Pi with the extension and the profile flag', () => {
    expect(
      buildProfileSpawnArgs({
        name: 'w1',
        spaceId: SPACE,
        tabId: null,
        parent: 't18',
        command: ['/usr/bin/env', 'PATH=/bin', PI],
        extensionPath: EXTENSION,
        childArgs: ['--hc-agent-profile', '{"depth":1}'],
      }),
    ).toEqual([
      'run',
      '--bg',
      '--json',
      '--name',
      'w1',
      '--label',
      `herdr.space=${SPACE}`,
      '--label',
      'pi-herdr-agents=agent',
      '--parent',
      't18',
      '--',
      '/usr/bin/env',
      'PATH=/bin',
      PI,
      '-e',
      EXTENSION,
      '--hc-agent-profile',
      '{"depth":1}',
    ]);
  });

  test('a profile wins only when hc templates does not own the name', () => {
    expect(resolveSpawnMode('grunt', { hcTemplates: ['grunt'], profileNames: ['grunt'] })).toEqual({
      mode: 'template',
    });
    expect(resolveSpawnMode('grunt', { hcTemplates: [], profileNames: ['grunt'] })).toEqual({
      mode: 'profile',
      profileName: 'grunt',
    });
    expect(
      resolveSpawnMode('grunt', {
        hcTemplates: ['grunt'],
        profileNames: ['grunt'],
        env: { PI_HERDR_USE_PROFILE_LAUNCH: '1' },
      }),
    ).toEqual({ mode: 'profile', profileName: 'grunt' });
    expect(resolveSpawnMode('grunt', { hcTemplates: ['grunt'], profileNames: [] })).toEqual({
      mode: 'template',
    });
    expect(resolveSpawnMode('nope', { hcTemplates: [], profileNames: [] })).toBeNull();
  });
});

// ===========================================================================
// hc_worker spawn
// ===========================================================================

describe('hc_worker spawn', () => {
  test('a template spawn places the worker, renames the default tab and persists state', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      exec: leadExec(async (command, args) => {
        if (command === 'hc' && args[0] === 'run') {
          return ok({ address: 't50', first_message: { sent: true } });
        }
        if (command === 'hc' && args[0] === 'get' && args[1] === 't50') {
          return ok({ address: 't50', labels: { 'herdr.space': SPACE, 'herdr.tab': TAB } });
        }
        if (command === 'herdr-app' && args[0] === 'ls') return ok(appList('1', ['t18', 't50']));
        return undefined;
      }),
    });
    await h.fire('before_agent_start', beforeStartEvent());
    const result = await h.callTool('hc_worker', {
      action: 'spawn',
      name: 'w1',
      template: 'grunt',
      task: 'implement X',
    });

    expect(result.isError).toBeUndefined();
    const runCall = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'run');
    expect(runCall!.args).toEqual([
      'run',
      '--bg',
      '--json',
      '--name',
      'w1',
      '--label',
      `herdr.space=${SPACE}`,
      '--label',
      'pi-herdr-agents=agent',
      'grunt',
      'implement X',
    ]);
    const rename = h.execCalls.find(
      (call) => call.command === 'herdr-app' && call.args[1] === 'tab.rename',
    );
    expect(rename!.args).toEqual(['do', 'tab.rename', '--id', TAB, '--name', 'w1']);
    expect(h.lastEntry()).toMatchObject({
      customType: 'hc-delegation-state',
      data: { tabId: TAB, tabName: 'w1' },
    });
    expect(h.lastEntry().data.ownedWorkers.w1.address).toBe('t50');
    expect(result.content[0].text).toContain('runs asynchronously');
    expect(result.content[0].text).not.toContain('hc wait');
  });

  test.each([
    { model: undefined, expectedModel: 'test/default' },
    { model: 'test/override', expectedModel: 'test/override' },
  ])(
    'a profile launch selects $expectedModel and passes --hc-agent-profile',
    async ({ model, expectedModel }) => {
      const cwd = await mkdtemp(join(tmpdir(), 'hc-profile-spawn-'));
      try {
        const agents = join(cwd, '.pi', 'agents');
        await mkdir(agents, { recursive: true });
        const profilePath = join(agents, 'grunt.md');
        await writeFile(
          profilePath,
          '---\nname: grunt\nmodels: test/default, test/override\nthinking: low\ntools: read\n---\nDo the unit.\n',
        );
        const h = harness({
          env: { HC_TERMINAL_ID: 't18', PATH: '/bin' },
          cwd,
          exec: leadExec(async (command, args) => {
            if (command === 'hc' && args[0] === 'templates') {
              return ok({ templates: [{ name: 'workhorse', description: '', command: 'pi' }] });
            }
            if (command === 'which') return ok(`${PI}\n`);
            if (command === 'hc' && args[0] === 'run') return ok({ address: 't50' });
            if (command === 'hc' && args[0] === 'wait') return ok({ reason: 'status' });
            if (command === 'hc' && args[0] === 'get' && args[1] === 't50') {
              return ok({
                address: 't50',
                parent: 't18',
                status: { app: 'pi', state: 'idle' },
                labels: { 'herdr.space': SPACE, 'herdr.tab': TAB },
              });
            }
            if (command === 'hc' && args[0] === 'send') return ok({ started: true, turn: 0 });
            return undefined;
          }),
        });
        await h.fire('before_agent_start', beforeStartEvent());
        const params = { action: 'spawn', name: 'w1', template: 'grunt', task: 'implement X' };
        const result = await h.callTool('hc_worker', model ? { ...params, model } : params);

        expect(result.isError).toBeUndefined();
        expect(result.details.launch).toBe('profile');
        const runCall = h.execCalls.find(
          (call) => call.command === 'hc' && call.args[0] === 'run',
        )!;
        const flagIndex = runCall.args.indexOf('--hc-agent-profile');
        expect(flagIndex).toBeGreaterThan(0);
        expect(JSON.parse(runCall.args[flagIndex + 1])).toMatchObject({
          filePath: profilePath,
          depth: 1,
        });
        expect(runCall.args).toContain('-e');
        expect(runCall.args).toContain(EXTENSION);
        expect(runCall.args).toContain(`herdr.space=${SPACE}`);
        expect(runCall.args[runCall.args.indexOf('--parent') + 1]).toBe('t18');
        expect(runCall.args).toContain('--model');
        expect(runCall.args[runCall.args.indexOf('--model') + 1]).toBe(expectedModel);

        const waitCall = h.execCalls.find(
          (call) => call.command === 'hc' && call.args[0] === 'wait',
        );
        expect(waitCall!.args).toEqual(['wait', '--timeout', '30', '--', 't50']);
        const sendCall = h.execCalls.find(
          (call) => call.command === 'hc' && call.args[0] === 'send',
        );
        expect(sendCall!.args).toEqual(['send', 't50', 'implement X']);
        expect(result.details.firstMessageSent).toBe(true);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  test('a queued parent message interrupts the wait before Pi is idle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-profile-wait-'));
    try {
      const agents = join(cwd, '.pi', 'agents');
      await mkdir(agents, { recursive: true });
      await writeFile(join(agents, 'grunt.md'), '---\nname: grunt\n---\nWork.\n');
      let waits = 0;
      const h = harness({
        env: { HC_TERMINAL_ID: 't18', PATH: '/bin', PI_HERDR_USE_PROFILE_LAUNCH: '1' },
        cwd,
        now: () => (waits === 0 ? 1000 : 2200),
        exec: leadExec(async (command, args) => {
          if (command === 'which') return ok(`${PI}\n`);
          if (command === 'hc' && args[0] === 'run') return ok({ address: 't50' });
          if (command === 'hc' && args[0] === 'wait') {
            waits += 1;
            if (waits === 1) {
              return ok({
                children: [],
                ended: false,
                exit_code: null,
                from: 't6b',
                reason: 'message',
                status: null,
                terminal: 't2',
                turn: 0,
              });
            }
            return ok({ reason: 'status' });
          }
          if (command === 'hc' && args[0] === 'get' && args[1] === 't50') {
            return ok({
              address: 't50',
              state: 'live',
              status: waits === 1 ? null : { app: 'pi', state: 'idle' },
              labels: { 'herdr.tab': TAB },
            });
          }
          if (command === 'herdr-app' && args[0] === 'ls') return ok(appList('hc-work', ['t50']));
          return undefined;
        }),
      });
      const result = await h.callTool('hc_worker', {
        action: 'spawn',
        name: 'w1',
        template: 'grunt',
        task: 'implement X',
      });

      expect(result.details.firstMessageSent).toBe(true);
      const deliveryCalls = h.execCalls
        .filter(({ command, args }) => command === 'hc' && args.includes('t50'))
        .map(({ args }) => args);
      expect(deliveryCalls).toEqual([
        ['wait', '--timeout', '30', '--', 't50'],
        ['get', 't50', '--json'],
        ['wait', '--timeout', '28', '--', 't50'],
        ['get', 't50', '--json'],
        ['send', 't50', 'implement X'],
        ['get', 't50', '--json'],
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('multiple queued parent messages do not exhaust status attempts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-profile-wait-'));
    try {
      const agents = join(cwd, '.pi', 'agents');
      await mkdir(agents, { recursive: true });
      await writeFile(join(agents, 'grunt.md'), '---\nname: grunt\n---\nWork.\n');
      let waits = 0;
      const h = harness({
        env: { HC_TERMINAL_ID: 't18', PATH: '/bin', PI_HERDR_USE_PROFILE_LAUNCH: '1' },
        cwd,
        now: () => 1000,
        exec: leadExec(async (command, args) => {
          if (command === 'which') return ok(`${PI}\n`);
          if (command === 'hc' && args[0] === 'run') return ok({ address: 't50' });
          if (command === 'hc' && args[0] === 'wait') {
            waits += 1;
            return ok({ reason: waits <= 10 ? 'message' : 'status' });
          }
          if (command === 'hc' && args[0] === 'get' && args[1] === 't50') {
            return ok({
              address: 't50',
              state: 'live',
              status: waits <= 10 ? null : { app: 'pi', state: 'idle' },
              labels: { 'herdr.tab': TAB },
            });
          }
          if (command === 'herdr-app' && args[0] === 'ls') return ok(appList('hc-work', ['t50']));
          return undefined;
        }),
      });
      const result = await h.callTool('hc_worker', {
        action: 'spawn',
        name: 'w1',
        template: 'grunt',
        task: 'implement X',
      });

      expect(waits).toBe(11);
      expect(result.details.firstMessageSent).toBe(true);
      expect(
        h.execCalls.some(
          ({ command, args }) =>
            command === 'hc' &&
            args[0] === 'send' &&
            args[1] === 't50' &&
            args[2] === 'implement X',
        ),
      ).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('a disallowed model is rejected before spawning a profile', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-profile-model-'));
    try {
      const agents = join(cwd, '.pi', 'agents');
      await mkdir(agents, { recursive: true });
      await writeFile(
        join(agents, 'grunt.md'),
        '---\nname: grunt\nmodels: test/allowed\n---\nWork.\n',
      );
      const h = harness({
        env: { HC_TERMINAL_ID: 't18', PI_HERDR_USE_PROFILE_LAUNCH: '1' },
        cwd,
        exec: leadExec(async () => undefined),
      });

      await expect(
        h.callTool('hc_worker', {
          action: 'spawn',
          name: 'w1',
          template: 'grunt',
          task: 'implement X',
          model: 'test/disallowed',
        }),
      ).rejects.toThrow('Model "test/disallowed" is not allowed for agent "grunt"');
      expect(h.execCalls.some((call) => call.command === 'hc' && call.args[0] === 'run')).toBe(
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('PI_HERDR_USE_PROFILE_LAUNCH=1 forces a profile launch over an hc template', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-profile-force-'));
    try {
      const agents = join(cwd, '.pi', 'agents');
      await mkdir(agents, { recursive: true });
      await writeFile(join(agents, 'grunt.md'), '---\nname: grunt\n---\nWork.\n');
      const h = harness({
        env: { HC_TERMINAL_ID: 't18', PATH: '/bin', PI_HERDR_USE_PROFILE_LAUNCH: '1' },
        cwd,
        exec: leadExec(async (command, args) => {
          if (command === 'which') return ok(`${PI}\n`);
          if (command === 'hc' && args[0] === 'run') return ok({ address: 't50' });
          if (command === 'hc' && args[0] === 'wait') return ok({});
          if (command === 'hc' && args[0] === 'get' && args[1] === 't50') {
            return ok({ address: 't50', status: { app: 'pi', state: 'idle' } });
          }
          return undefined;
        }),
      });
      await h.fire('before_agent_start', beforeStartEvent());
      const result = await h.callTool('hc_worker', {
        action: 'spawn',
        name: 'w1',
        template: 'grunt',
        task: 'x',
      });
      expect(result.isError).toBeUndefined();
      const runCall = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'run')!;
      expect(runCall.args).toContain('--hc-agent-profile');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('a duplicate live name is refused before any launch', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      exec: leadExec(async (command, args) => {
        if (command === 'hc' && args[0] === 'get' && args[1] === 'w1') {
          return ok({ address: 't50', state: 'live' });
        }
        return undefined;
      }),
    });
    const result = await h.callTool('hc_worker', {
      action: 'spawn',
      name: 'w1',
      template: 'grunt',
      task: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
    expect(h.execCalls.some((call) => call.args[0] === 'run')).toBe(false);
  });

  test('a tab that appears after the first listing is resolved', async () => {
    let listings = 0;
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      exec: leadExec(async (command, args) => {
        if (command === 'hc' && args[0] === 'run') {
          return ok({ address: 't50', first_message: { sent: true } });
        }
        if (command === 'hc' && args[0] === 'get' && args[1] === 't50') {
          return ok({ address: 't50', labels: { 'herdr.space': SPACE } });
        }
        if (command === 'herdr-app' && args[0] === 'ls') {
          listings += 1;
          return ok(appList('1', listings === 1 ? ['t18'] : ['t18', 't50']));
        }
        return undefined;
      }),
    });
    const result = await h.callTool('hc_worker', {
      action: 'spawn',
      name: 'w1',
      template: 'grunt',
      task: 'x',
    });

    expect(listings).toBe(2);
    expect(result.details).toMatchObject({ tabId: TAB, warnings: [] });
    expect(h.lastEntry().data.tabName).toBe('w1');
  });

  test('a tab the person already named is never renamed', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      exec: leadExec(async (command, args) => {
        if (command === 'hc' && args[0] === 'run')
          return ok({ address: 't50', first_message: { sent: true } });
        if (command === 'hc' && args[0] === 'get' && args[1] === 't50') {
          return ok({ address: 't50', labels: { 'herdr.space': SPACE, 'herdr.tab': TAB } });
        }
        if (command === 'herdr-app' && args[0] === 'ls') return ok(appList('hc-work', ['t50']));
        return undefined;
      }),
    });
    await h.callTool('hc_worker', { action: 'spawn', name: 'w1', template: 'grunt', task: 'x' });
    expect(
      h.execCalls.some((call) => call.command === 'herdr-app' && call.args[1] === 'tab.rename'),
    ).toBe(false);
  });

  test('a closed tab is dropped instead of being resurrected', async () => {
    const stateEntry = {
      type: 'custom',
      customType: 'hc-delegation-state',
      data: {
        tabId: TAB,
        tabName: 'hc-work',
        guardEnabled: true,
        roleOverride: null,
        ownedWorkers: {},
      },
    };
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      entries: [stateEntry],
      exec: leadExec(async (command, args) => {
        if (command === 'hc' && args[0] === 'run')
          return ok({ address: 't50', first_message: { sent: true } });
        if (command === 'hc' && args[0] === 'get' && args[1] === 't50') return fail('absent');
        if (command === 'herdr-app' && args[0] === 'ls') {
          return ok({
            spaces: [{ id: SPACE, tabs: [{ id: 'tab999', name: '1', terminals: [] }] }],
          });
        }
        return undefined;
      }),
    });
    await h.fire('session_start', { reason: 'startup' });
    await h.callTool('hc_worker', { action: 'spawn', name: 'w1', template: 'grunt', task: 'x' });
    const runCall = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'run')!;
    expect(runCall.args).not.toContain(`herdr.tab=${TAB}`);
  });

  test('an unknown template names both sources and never launches', async () => {
    const h = harness({ env: { HC_TERMINAL_ID: 't18' }, exec: leadExec() });
    const result = await h.callTool('hc_worker', {
      action: 'spawn',
      name: 'w1',
      template: 'nosuch',
      task: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown template `nosuch`');
    expect(result.content[0].text).toContain('grunt');
    expect(h.execCalls.some((call) => call.args[0] === 'run')).toBe(false);
  });

  test('an undelivered launch task is surfaced as a warning', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      exec: leadExec(async (command, args) => {
        if (command === 'hc' && args[0] === 'run') {
          return ok({ address: 't50', first_message: { sent: false, reason: 'blocked' } });
        }
        if (command === 'hc' && args[0] === 'get' && args[1] === 't50') return fail('absent');
        if (command === 'herdr-app' && args[0] === 'ls') return fail('no app');
        return undefined;
      }),
    });
    const result = await h.callTool('hc_worker', {
      action: 'spawn',
      name: 'w1',
      template: 'grunt',
      task: 'x',
    });
    expect(result.content[0].text).toContain('was NOT delivered');
    expect(result.details.firstMessageSent).toBe(false);
  });

  test('hc_worker is refused outside a lead role', async () => {
    const h = harness({ env: { HC_TERMINAL_ID: 't3g' }, exec: workerExec() });
    const result = await h.callTool('hc_worker', { action: 'status', name: 'w1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('only available to an hc Lead');
  });

  test('spawn forwards cwd to the launch', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      exec: leadExec(async (command, args) => {
        if (command === 'hc' && args[0] === 'run')
          return ok({ address: 't50', first_message: { sent: true } });
        if (command === 'hc' && args[0] === 'get' && args[1] === 't50') return fail('absent');
        return undefined;
      }),
    });
    await h.callTool('hc_worker', {
      action: 'spawn',
      name: 'w1',
      template: 'grunt',
      task: 'x',
      cwd: '/repo/work',
    });
    const runCall = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'run')!;
    expect(runCall.args[runCall.args.indexOf('--cwd') + 1]).toBe('/repo/work');
  });
});

// ===========================================================================
// hc_worker reuse: two-phase fail-closed session reset
// ===========================================================================

function ownedState() {
  return {
    type: 'custom',
    customType: 'hc-delegation-state',
    data: {
      tabId: TAB,
      tabName: 'hc-work',
      guardEnabled: true,
      roleOverride: null,
      ownedWorkers: {
        w1: {
          address: 't50',
          name: 'w1',
          template: 'grunt',
          task: 'implement the retry parser in src/retry.ts',
          spawnedAt: 0,
        },
      },
    },
  };
}

const SESSION_DIR = sessionDirFor(HOME, WORKSPACE);
const OLD_SESSION = '2023-12-31T00-00-00-000Z_old.jsonl';
const NEW_SESSION = '2024-01-01T00-00-01-000Z_new.jsonl';

interface ReuseOptions {
  terminal?: Record<string, unknown>;
  screen?: string;
  files?: Record<string, string>;
  exec?: ExecFn;
  deps?: Record<string, unknown>;
}

function reuseHarness(options: ReuseOptions = {}) {
  const files: Record<string, string> = {
    [`${SESSION_DIR}/${OLD_SESSION}`]: '',
    ...(options.files ?? {}),
  };
  const io = fakeIo(files, [SESSION_DIR]);
  const terminal = {
    address: 't50',
    parent: 't18',
    template: 'grunt',
    state: 'live',
    cwd: WORKSPACE,
    labels: { 'herdr.space': SPACE, 'herdr.tab': TAB },
    status: { app: 'pi', state: 'idle' },
    ...(options.terminal ?? {}),
  };
  return harness({
    env: { HC_TERMINAL_ID: 't18' },
    entries: [ownedState()],
    io,
    deps: options.deps,
    exec: async (command, args, execOptions) => {
      const fromExtra = options.exec ? await options.exec(command, args, execOptions) : undefined;
      if (fromExtra) return fromExtra;
      if (command === 'hc' && args[0] === 'get' && args[1] === 't18') return ok(leadTerminal);
      if (command === 'hc' && args[0] === 'templates') return ok(TEMPLATES);
      if (command === 'hc' && args[0] === 'get' && args[1] === 'w1') return ok(terminal);
      if (command === 'hc' && args[0] === 'keys') return ok('');
      if (command === 'hc' && args[0] === 'read') {
        return ok(options.screen ?? '✓ New session started\nTools (0): none');
      }
      if (command === 'hc' && args[0] === 'send') {
        // Pi persists the new session lazily, on that session's first message.
        files[`${SESSION_DIR}/${NEW_SESSION}`] = '';
        return ok({ started: true, turn: 0 });
      }
      return undefined;
    },
  });
}

describe('hc_worker reuse', () => {
  test('presses /new, gates on the fresh screen, delivers, then corroborates the session file', async () => {
    const h = reuseHarness({});
    await h.fire('session_start', { reason: 'startup' });
    const result = await h.callTool('hc_worker', { action: 'reuse', name: 'w1', task: 'unit two' });
    expect(result.isError).toBeUndefined();
    const keys = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'keys');
    expect(keys!.args).toEqual(['keys', 'w1', '/', 'n', 'e', 'w', 'enter']);
    const send = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'send');
    expect(send!.args).toEqual(['send', 'w1', 'unit two']);
    expect(result.details).toMatchObject({
      status: 'reused',
      name: 'w1',
      firstMessageSent: true,
      resetSent: true,
      resetConfidence: 'session-file',
      sessionBefore: OLD_SESSION,
      sessionAfter: NEW_SESSION,
      warnings: [],
    });
    expect(h.lastEntry().data.ownedWorkers.w1.task).toBe('unit two');
  });

  test('refuses a working worker without pressing /new', async () => {
    const h = reuseHarness({ terminal: { status: { app: 'pi', state: 'working' } } });
    const result = await h.callTool('hc_worker', { action: 'reuse', name: 'w1', task: 'x' });
    expect(result.isError).toBe(true);
    expect(result.details.reason).toBe('working');
    expect(h.execCalls.some((call) => call.args[0] === 'keys')).toBe(false);
  });

  test('refuses a pane held by a non-agent process', async () => {
    const h = reuseHarness({ terminal: { foreground: { name: 'vim' } } });
    const result = await h.callTool('hc_worker', { action: 'reuse', name: 'w1', task: 'x' });
    expect(result.isError).toBe(true);
    expect(result.details.reason).toBe('background-process');
    expect(h.execCalls.some((call) => call.args[0] === 'keys')).toBe(false);
  });

  test('refuses a terminal this session does not own and names its parent', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      exec: async (command, args) => {
        if (command === 'hc' && args[0] === 'get' && args[1] === 't18') return ok(leadTerminal);
        if (command === 'hc' && args[0] === 'templates') return ok(TEMPLATES);
        if (command === 'hc' && args[0] === 'get' && args[1] === 'w1') {
          return ok({ address: 't50', parent: 't99', state: 'live', status: { state: 'idle' } });
        }
        return ok('');
      },
    });
    const result = await h.callTool('hc_worker', { action: 'reuse', name: 'w1', task: 'x' });
    expect(result.isError).toBe(true);
    expect(result.details.reason).toBe('not-owned');
    expect(result.content[0].text).toContain('`t99`');
  });

  test('a missing task refuses before any reset', async () => {
    const h = reuseHarness({});
    await h.fire('session_start', { reason: 'startup' });
    const result = await h.callTool('hc_worker', { action: 'reuse', name: 'w1' });
    expect(result.isError).toBe(true);
    expect(result.details.reason).toBe('no-task');
    expect(h.execCalls.some((call) => call.args[0] === 'keys')).toBe(false);
  });

  test('a repainted pane without the fresh-session marker is unconfirmed', async () => {
    const h = reuseHarness({ screen: 'previous unit output\nTools (4): bash' });
    await h.fire('session_start', { reason: 'startup' });
    const result = await h.callTool('hc_worker', { action: 'reuse', name: 'w1', task: 'unit two' });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      status: 'reset-unconfirmed',
      reason: 'screen-ambiguous',
      resetSent: true,
      firstMessageSent: false,
    });
    expect(h.execCalls.some((call) => call.args[0] === 'send')).toBe(false);
    expect(h.lastEntry().data.ownedWorkers.w1.task).toBe(
      'implement the retry parser in src/retry.ts',
    );
  });

  test('a screen that still shows the previous unit refuses as screen-ambiguous', async () => {
    const h = reuseHarness({
      screen: 'New session started\nimplement the retry parser in src/retry.ts\nTools (0): none',
    });
    await h.fire('session_start', { reason: 'startup' });
    const result = await h.callTool('hc_worker', { action: 'reuse', name: 'w1', task: 'unit two' });
    expect(result.isError).toBe(true);
    expect(result.details.reason).toBe('screen-ambiguous');
  });

  test('a /new whose keys never land resets nothing and voids nothing', async () => {
    const h = reuseHarness({
      exec: async (command, args) => {
        if (command === 'hc' && args[0] === 'keys') return fail('terminal busy');
        return undefined;
      },
    });
    const result = await h.callTool('hc_worker', { action: 'reuse', name: 'w1', task: 'unit two' });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ status: 'reset-unconfirmed', resetSent: false });
    expect(result.content[0].text).toContain('pane is unchanged');
  });

  test('an undelivered task after a confirmed reset is a warning, not a silent success', async () => {
    const h = reuseHarness({
      exec: async (command, args) => {
        if (command === 'hc' && args[0] === 'send')
          return ok({ started: false, status: 'blocked' });
        return undefined;
      },
    });
    await h.fire('session_start', { reason: 'startup' });
    const result = await h.callTool('hc_worker', { action: 'reuse', name: 'w1', task: 'unit two' });
    expect(result.isError).toBeUndefined();
    expect(result.details.firstMessageSent).toBe(false);
    expect(result.details.warnings.join(' ')).toContain('was NOT delivered');
  });
});

// ===========================================================================
// hc_worker close
// ===========================================================================

describe('hc_worker close', () => {
  test('kills and removes an owned worker, then persists, naming leftover hazards', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      entries: [ownedState()],
      exec: async (command, args) => {
        if (command === 'hc' && args[0] === 'get' && args[1] === 't18') return ok(leadTerminal);
        if (command === 'hc' && args[0] === 'templates') return ok(TEMPLATES);
        if (command === 'hc' && args[0] === 'get' && args[1] === 'w1') {
          return ok({
            address: 't50',
            parent: 't18',
            template: 'grunt',
            state: 'live',
            foreground: { name: 'vim' },
          });
        }
        if (command === 'git' && args[0] === 'worktree') {
          return ok(
            'worktree /repo/.worktrees/w1\nHEAD abc\nbranch refs/heads/w1\n\nworktree /repo\nHEAD def\nbranch refs/heads/main\n',
          );
        }
        if (command === 'git' && args[0] === '-C') return ok(' M src/a.ts\n');
        if (command === 'hc' && (args[0] === 'kill' || args[0] === 'rm')) return ok('');
        return undefined;
      },
    });
    await h.fire('session_start', { reason: 'startup' });
    const result = await h.callTool('hc_worker', { action: 'close', name: 'w1' });
    expect(result.isError).toBeUndefined();
    const kill = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'kill');
    expect(kill!.args).toEqual(['kill', 'w1']);
    const rm = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'rm');
    expect(rm!.args).toEqual(['rm', 'w1']);
    const text = result.content[0].text as string;
    expect(text).toContain('closed `w1`');
    expect(text).toContain('non-agent process');
    expect(text).toContain('/repo/.worktrees/w1');
    expect(text).toContain('uncommitted changes');
    expect(h.lastEntry().data.ownedWorkers).toEqual({});
  });

  test('refuses a terminal this session does not own', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      exec: async (command, args) => {
        if (command === 'hc' && args[0] === 'get' && args[1] === 't18') return ok(leadTerminal);
        if (command === 'hc' && args[0] === 'templates') return ok(TEMPLATES);
        if (command === 'hc' && args[0] === 'get' && args[1] === 'w9') {
          return ok({ address: 't60', parent: 't99', state: 'live' });
        }
        return ok('');
      },
    });
    const result = await h.callTool('hc_worker', { action: 'close', name: 'w9' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Refusing to close');
    expect(h.execCalls.some((call) => call.args[0] === 'kill')).toBe(false);
  });
});

// ===========================================================================
// hc_report
// ===========================================================================

const VALID_REPORT = [
  '## Goal',
  'Deliver unit two.',
  '',
  '## Changes',
  '- extensions/a.ts',
  '',
  '## Verification',
  '`bun test` -> 12 pass, exit 0',
  '',
  '## Blockers',
  'none',
].join('\n');

function reportHarness(
  options: {
    role?: 'worker' | 'peer' | 'subagent';
    files?: Record<string, string>;
    exec?: ExecFn;
  } = {},
) {
  const role = options.role ?? 'worker';
  const io = fakeIo(options.files ?? {});
  return harness({
    env:
      role === 'subagent'
        ? { PI_SUBAGENT_DEPTH: '1' }
        : { HC_TERMINAL_ID: role === 'peer' ? 't39' : 't3g' },
    io,
    exec: async (command, args) => {
      const fromExtra = options.exec ? await options.exec(command, args) : undefined;
      if (fromExtra) return fromExtra;
      if (command === 'hc' && args[0] === 'get') {
        return role === 'peer'
          ? ok({
              address: 't39',
              parent: null,
              template: 'peer',
              state: 'live',
              labels: { 'herdr.space': SPACE },
            })
          : ok(workerTerminal);
      }
      return ok('');
    },
  });
}

describe('hc_report', () => {
  test('done pushes one line plus a validated report file path', async () => {
    const h = reportHarness({ files: { '/tmp/hc-report-w1.md': VALID_REPORT } });
    const result = await h.callTool('hc_report', {
      action: 'done',
      summary: 'bun test -> 12 pass',
      report_file: '/tmp/hc-report-w1.md',
    });
    expect(result.isError).toBeUndefined();
    const send = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'send');
    expect(send!.args).toEqual([
      'send',
      't18',
      'done: bun test -> 12 pass report: /tmp/hc-report-w1.md',
    ]);
    expect(send!.args).not.toContain('--force');
    expect(result.details.reportSections).toEqual({
      required: ['## Goal', '## Changes', '## Verification', '## Blockers'],
      missing: [],
      readable: true,
    });
  });

  test('a report file missing sections is refused before the push', async () => {
    const h = reportHarness({ files: { '/tmp/partial.md': '## Goal\nx\n' } });
    const result = await h.callTool('hc_report', {
      action: 'done',
      summary: 'done',
      report_file: '/tmp/partial.md',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'missing required sections: ## Changes, ## Verification, ## Blockers',
    );
    expect(result.content[0].text).toContain('each on its own line');
    expect(h.execCalls.some((call) => call.args[0] === 'send')).toBe(false);
  });

  test('an unreadable report file is refused before the push', async () => {
    const h = reportHarness({});
    const result = await h.callTool('hc_report', {
      action: 'blocked',
      summary: 'need the vault path',
      report_file: '/tmp/missing.md',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('could not read report_file');
    expect(h.execCalls.some((call) => call.args[0] === 'send')).toBe(false);
  });

  test('blocked pushes the blocker to the parent', async () => {
    const h = reportHarness({});
    await h.callTool('hc_report', { action: 'blocked', summary: 'need the vault path' });
    const send = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'send');
    expect(send!.args).toEqual(['send', 't18', 'blocked: need the vault path']);
  });

  for (const [label, failure] of [
    ['exit 9', fail('', 9)],
    ['exit 10', fail('', 10)],
    ['blocked text', fail('terminal is blocked')],
    ['status_mismatch', ok('status_mismatch')],
  ] as Array<[string, CommandResult]>) {
    test(`a ${label} push is undelivered guidance, not a retryable error`, async () => {
      const h = reportHarness({
        files: { '/tmp/r.md': VALID_REPORT },
        exec: async (command, args) => {
          if (command === 'hc' && args[0] === 'send') return failure;
          return undefined;
        },
      });
      const result = await h.callTool('hc_report', {
        action: 'done',
        summary: 'ok',
        report_file: '/tmp/r.md',
      });
      expect(result.isError).toBeUndefined();
      expect(result.details.status).toBe('undelivered (lead_blocked)');
      expect(result.content[0].text).toContain('Do NOT retry-spam');
      expect(result.content[0].text).toContain('NEVER use --force');
      expect(result.content[0].text).toContain('/tmp/r.md');
      const sends = h.execCalls.filter((call) => call.command === 'hc' && call.args[0] === 'send');
      expect(sends.length).toBe(1);
      expect(sends[0].args).not.toContain('--force');
    });
  }

  test('a genuine send failure stays an error', async () => {
    const h = reportHarness({
      exec: async (command, args) => {
        if (command === 'hc' && args[0] === 'send') return fail('no such terminal');
        return undefined;
      },
    });
    const result = await h.callTool('hc_report', { action: 'done', summary: 'ok' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('hc send to parent `t18` failed');
  });

  test('a long pushed summary gets a one-line reminder', async () => {
    const h = reportHarness({ files: { '/tmp/r.md': VALID_REPORT } });
    const result = await h.callTool('hc_report', {
      action: 'done',
      summary: `done: ${'x'.repeat(320)}`,
      report_file: '/tmp/r.md',
    });
    expect(result.content[0].text).toContain('note: this pushed summary is');
    expect(result.content[0].text).toContain('one line');
  });

  test('list_peers filters out this terminal and reports the space', async () => {
    const h = reportHarness({
      role: 'peer',
      exec: async (command, args) => {
        if (command === 'hc' && args[0] === 'ls') {
          expect(args).toEqual(['ls', '--label', `herdr.space=${SPACE}`, '--json']);
          return ok({
            terminals: [
              { address: 't39', name: 'peer', template: 'peer', state: 'live' },
              { address: 't50', name: 'w1', template: 'grunt', state: 'live' },
            ],
          });
        }
        return undefined;
      },
    });
    const result = await h.callTool('hc_report', { action: 'list_peers' });
    expect(result.content[0].text).toContain('peers in `spc123`');
    expect(result.content[0].text).toContain('t50');
    expect(result.content[0].text).not.toContain('t39 (peer)');
  });

  test('peer pushes a prefixed message with the report path', async () => {
    const h = reportHarness({ role: 'peer' });
    const result = await h.callTool('hc_report', {
      action: 'peer',
      target: 't39',
      summary: 'look',
      report_file: '/tmp/p.md',
    });
    expect(result.isError).toBeUndefined();
    const send = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'send');
    expect(send!.args).toEqual(['send', 't39', 'peer: t39 look report: /tmp/p.md']);
  });

  test('hc_report is refused from a subagent', async () => {
    const h = reportHarness({ role: 'subagent' });
    const result = await h.callTool('hc_report', { action: 'done', summary: 'ok' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not available in role `subagent`');
  });

  test('done and peer require their mandatory fields', async () => {
    const h = reportHarness({ role: 'peer' });
    expect((await h.callTool('hc_report', { action: 'done' })).isError).toBe(true);
    expect((await h.callTool('hc_report', { action: 'peer', summary: 'x' })).isError).toBe(true);
  });
});

// ===========================================================================
// Pure helpers
// ===========================================================================

describe('report and reset helpers', () => {
  test('missingReportSections matches whole headings only', () => {
    expect(missingReportSections(VALID_REPORT)).toEqual([]);
    expect(missingReportSections('mentions ## Goal inline\n## Changes\n## Verification\n')).toEqual(
      ['## Goal', '## Blockers'],
    );
    expect(
      missingReportSections('## Goal\r\n## Changes\r\n## Verification\r\n## Blockers\r\n'),
    ).toEqual([]);
  });

  test('screenShowsFreshSession needs the marker and a zero tool counter', () => {
    expect(screenShowsFreshSession('New session started')).toBe(true);
    expect(screenShowsFreshSession('New session started\nTools (0): none')).toBe(true);
    expect(screenShowsFreshSession('New session started\nTools (2): bash')).toBe(false);
    expect(screenShowsFreshSession('no marker\nTools (0)')).toBe(false);
  });

  test('screenShowsPreviousUnit uses a distinctive task prefix and the report path', () => {
    expect(
      screenShowsPreviousUnit('implement the parser now', 'implement the parser now', null),
    ).toBe(true);
    expect(screenShowsPreviousUnit('/tmp/report.md', null, '/tmp/report.md')).toBe(true);
    expect(screenShowsPreviousUnit('short', 'short', null)).toBe(false);
  });

  test('discoverAgentSummaries lists project profiles', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-agents-'));
    try {
      await mkdir(join(cwd, '.pi', 'agents'), { recursive: true });
      await writeFile(
        join(cwd, '.pi', 'agents', 'grunt.md'),
        '---\nname: grunt\ndescription: routine work\n---\nWork.\n',
      );
      const agents = await discoverAgentSummaries(cwd);
      expect(agents).toContainEqual({
        name: 'grunt',
        description: 'routine work',
        scope: 'project',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Tool policy: a delegated role must not reach hc_run / hc_wait
// ===========================================================================

describe('buildRolePlan tool policy', () => {
  const withOverride = (roleOverride: 'allow_subagents' | null) => ({
    ...emptySessionState(),
    roleOverride,
  });

  test('the lead loses hc_run along with hc_wait and hc_report', () => {
    const plan = buildRolePlan(
      { kind: 'hc_lead', terminalId: 't18', spaceId: SPACE, templates: [] },
      withOverride(null),
    );
    // `hc_worker` is the Lead's launcher: `hc_run` would start the same terminal
    // with no labels, no ownership and no first-message check.
    expect(plan.addTools).toEqual(['hc_worker']);
    expect(plan.removeTools).toEqual(['hc_report', 'hc_wait', 'hc_run']);
  });

  test('a worker loses hc_run and hc_wait, and keeps hc_run only when the override lifts the guard', () => {
    const role = {
      kind: 'hc_worker',
      terminalId: 't3g',
      parent: 't18',
      template: 'grunt',
      spaceId: SPACE,
    } as const;
    expect(buildRolePlan(role, withOverride(null)).removeTools).toEqual([
      'hc_worker',
      'hc_run',
      'hc_wait',
    ]);
    expect(buildRolePlan(role, withOverride('allow_subagents')).removeTools).toEqual([
      'hc_worker',
      'hc_wait',
    ]);
  });

  test('a peer loses both nested-terminal tools, and subagent only by default', () => {
    const role = { kind: 'hc_peer', terminalId: 't39', spaceId: SPACE } as const;
    expect(buildRolePlan(role, withOverride(null)).removeTools).toEqual([
      'hc_worker',
      'subagent',
      'hc_run',
      'hc_wait',
    ]);
    expect(buildRolePlan(role, withOverride('allow_subagents')).removeTools).toEqual([
      'hc_worker',
      'hc_wait',
    ]);
  });

  test('a subagent never keeps hc_run or hc_wait', () => {
    const plan = buildRolePlan({ kind: 'subagent', depth: 1, name: 'scout' }, withOverride(null));
    expect(plan.removeTools).toEqual(['hc_worker', 'hc_report', 'hc_run', 'hc_wait']);
  });

  test('a registered hc_run and hc_wait are deactivated on the next worker turn', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't3g' },
      activeTools: [...BASE_TOOLS, 'hc_run', 'hc_wait'],
      exec: workerExec(),
    });
    await h.fire('before_agent_start', beforeStartEvent());

    expect(h.activeTools()).not.toContain('hc_run');
    expect(h.activeTools()).not.toContain('hc_wait');
    expect(h.activeTools()).toContain('hc_report');
  });

  test('the allow_subagents override keeps hc_run for a worker but never hc_wait', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't3g' },
      activeTools: [...BASE_TOOLS, 'hc_run', 'hc_wait'],
      entries: [
        {
          type: 'custom',
          customType: 'hc-delegation-state',
          data: { roleOverride: 'allow_subagents' },
        },
      ],
      exec: workerExec(),
    });
    await h.fire('session_start', { reason: 'startup' });
    await h.fire('before_agent_start', beforeStartEvent());

    expect(h.activeTools()).toContain('hc_run');
    expect(h.activeTools()).not.toContain('hc_wait');
  });
});

// ===========================================================================
// Composition: a guard/audit layer that already owns the session state
// ===========================================================================

describe('composition deps', () => {
  /** Lead routes for a spawn that succeeds and lands in a known tab. */
  const spawnExec: ExecFn = async (command, args) => {
    if (command === 'hc' && args[0] === 'run') {
      return ok({ address: 't50', first_message: { sent: true } });
    }
    if (command === 'hc' && args[0] === 'get' && args[1] === 't50') {
      return ok({
        address: 't50',
        parent: 't18',
        template: 'grunt',
        state: 'live',
        labels: { 'herdr.space': SPACE, 'herdr.tab': TAB },
      });
    }
    if (command === 'herdr-app' && args[0] === 'ls') return ok(appList('hc-work', ['t18']));
    return undefined;
  };

  test('an injected state store owns the facts and onPersist replaces the state entry', async () => {
    let state = emptySessionState();
    let persisted = 0;
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      deps: {
        state: {
          get: () => state,
          set: (next: typeof state) => {
            state = next;
          },
        },
        onPersist: () => {
          persisted += 1;
        },
        ensureRole: async () => ({
          kind: 'hc_lead',
          terminalId: 't18',
          spaceId: SPACE,
          templates: [{ name: 'grunt', description: '', command: 'pi' }],
        }),
        managePrompts: false,
      },
      exec: leadExec(spawnExec),
    });

    // A composing layer registers the prompt hook itself.
    expect(h.hooks.before_agent_start).toBeUndefined();
    const spawned = await h.callTool('hc_worker', {
      action: 'spawn',
      name: 'w1',
      template: 'grunt',
      task: 'x',
    });
    expect(spawned.isError).toBeUndefined();
    expect(Object.keys(state.ownedWorkers)).toEqual(['w1']);
    expect(persisted).toBe(1);
    expect(h.entries).toEqual([]);
  });

  test('spawnLabels:[] spawns without the package label', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      deps: { spawnLabels: [] },
      exec: leadExec(spawnExec),
    });
    await h.fire('before_agent_start', beforeStartEvent());
    await h.callTool('hc_worker', { action: 'spawn', name: 'w1', template: 'grunt', task: 'x' });
    const runCall = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'run')!;
    expect(runCall.args).not.toContain('pi-herdr-agents=agent');
    expect(runCall.args).toContain(`herdr.space=${SPACE}`);
  });

  test('requireKnownTemplate:false hands an unknown name to hc run instead of refusing', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      deps: { requireKnownTemplate: false },
      exec: leadExec(async (command, args) => {
        if (command === 'hc' && args[0] === 'templates') return fail('core unavailable');
        return spawnExec(command, args);
      }),
    });
    await h.fire('before_agent_start', beforeStartEvent());
    const result = await h.callTool('hc_worker', {
      action: 'spawn',
      name: 'w1',
      template: 'reviewer',
      task: 'x',
    });
    expect(result.isError).toBeUndefined();
    const runCall = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'run')!;
    expect(runCall.args).toContain('reviewer');
  });

  test('by default an unknown template name is refused with both lists', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't18' },
      exec: leadExec(async (command, args) => {
        if (command === 'hc' && args[0] === 'templates') return ok(TEMPLATES);
        return undefined;
      }),
    });
    await h.fire('before_agent_start', beforeStartEvent());
    const result = await h.callTool('hc_worker', {
      action: 'spawn',
      name: 'w1',
      template: 'nope',
      task: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown template `nope`');
    expect(h.execCalls.some((call) => call.args[0] === 'run')).toBe(false);
  });

  test('verifyReportSections:false pushes a report path without reading it', async () => {
    const h = harness({
      env: { HC_TERMINAL_ID: 't3g' },
      deps: { verifyReportSections: false },
      exec: workerExec(async (command, args) => {
        if (command === 'hc' && args[0] === 'send') return ok({ started: true, turn: 1 });
        return undefined;
      }),
    });
    const result = await h.callTool('hc_report', {
      action: 'done',
      summary: 'verified: bun test -> 3 pass',
      report_file: '/tmp/does-not-exist-report.md',
    });
    expect(result.isError).toBeUndefined();
    const send = h.execCalls.find((call) => call.command === 'hc' && call.args[0] === 'send')!;
    expect(send.args).toEqual([
      'send',
      't18',
      'done: verified: bun test -> 3 pass report: /tmp/does-not-exist-report.md',
    ]);
  });

  test('pendingReportPath feeds the negative half of the reuse gate', async () => {
    // The previous unit's bound report path is still on screen: the reset did not
    // happen, even though the fresh-session marker is there.
    const pending = reuseHarness({
      screen: '✓ New session started\nTools (0): none\nreport: /tmp/hc-report-unit1.md',
      deps: { pendingReportPath: () => '/tmp/hc-report-unit1.md' },
    });
    const refused = await pending.callTool('hc_worker', {
      action: 'reuse',
      name: 'w1',
      task: 'unit two',
    });
    expect(refused.isError).toBe(true);
    expect(refused.details.reason).toBe('screen-ambiguous');

    const clean = reuseHarness({ deps: { pendingReportPath: () => '/tmp/hc-report-unit1.md' } });
    const reused = await clean.callTool('hc_worker', {
      action: 'reuse',
      name: 'w1',
      task: 'unit two',
    });
    expect(reused.isError).toBeUndefined();
    expect(reused.details.voidedAcceptance).toBe('/tmp/hc-report-unit1.md');
  });
});
