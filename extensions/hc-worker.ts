/**
 * Spawn argv builders, herdr tab resolution and report-file validation.
 *
 * Two launch shapes exist and both must stay exact:
 *
 * - `template`: `hc run <template> <task>` — the template owns the command, and
 *   `hc` delivers the task as the child's first message. Compatibility contract:
 *   `--name`, `--label herdr.space=…`, `--label herdr.tab=…`,
 *   `--label pi-herdr-agents=agent`.
 * - `profile`: `hc run … -- <pi> -e <extension> --hc-agent-profile <json>` — used
 *   when the name resolves to an agent profile (`.pi/agents/<name>.md` or the Pi
 *   user agents directory) that `hc templates` does not own, or when
 *   `PI_HERDR_USE_PROFILE_LAUNCH=1` asks for profile launch explicitly. The task
 *   is delivered after the child reaches idle, and delivery is verified.
 */

import { agentLabel, agentLabelKey } from './hc-client.ts';
import { parseJson, nonEmpty } from './hc-role.ts';

export const WORKER_SESSION_LABEL = 'pi-herdr-agents.session-dir';

export interface SpawnArgsInput {
  name: string;
  template: string;
  task: string;
  cwd?: string | null;
  spaceId: string | null;
  tabId: string | null;
}

/** One `--label key=value` pair attached to a spawn. */
export type SpawnLabel = readonly [key: string, value: string];

/**
 * Labels this package attaches to its own template spawns, so `hc ls --label`
 * can tell agent-managed terminals apart from hand-started ones. A composing
 * extension that keeps its own bookkeeping passes an empty list instead.
 */
export const DEFAULT_SPAWN_LABELS: readonly SpawnLabel[] = [[agentLabelKey, 'agent']];

/** `hc run` argv for a template-spawned worker. */
export function buildSpawnArgs(
  input: SpawnArgsInput,
  labels: readonly SpawnLabel[] = DEFAULT_SPAWN_LABELS,
): string[] {
  const args = ['run', '--bg', '--json', '--name', input.name];
  if (input.spaceId) args.push('--label', `herdr.space=${input.spaceId}`);
  if (input.tabId) args.push('--label', `herdr.tab=${input.tabId}`);
  for (const [key, value] of labels) args.push('--label', `${key}=${value}`);
  if (input.cwd) args.push('--cwd', input.cwd);
  args.push(input.template, input.task);
  return args;
}

export interface ProfileSpawnArgsInput {
  name: string;
  cwd?: string | null;
  spaceId: string | null;
  tabId: string | null;
  parent: string;
  /** Resolved Pi executable, already wrapped for the server PATH when needed. */
  command: string[];
  extensionPath: string;
  sessionDir?: string;
  /** `--hc-agent-profile <json>` plus the profile's Pi flags. */
  childArgs: string[];
}

/** `hc run` argv for an agent-profile-spawned worker. */
export function buildProfileSpawnArgs(input: ProfileSpawnArgsInput): string[] {
  const args = ['run', '--bg', '--json', '--name', input.name];
  if (input.spaceId) args.push('--label', `herdr.space=${input.spaceId}`);
  if (input.tabId) args.push('--label', `herdr.tab=${input.tabId}`);
  args.push('--label', agentLabel);
  if (input.sessionDir) args.push('--label', `${WORKER_SESSION_LABEL}=worker`);
  if (input.cwd) args.push('--cwd', input.cwd);
  args.push('--parent', input.parent, '--', ...input.command);
  args.push('-e', input.extensionPath, ...input.childArgs);
  if (input.sessionDir) args.push('--session-dir', input.sessionDir);
  return args;
}

export interface SpawnSources {
  /** Template names from `hc templates --json`. */
  hcTemplates: readonly string[];
  /** Agent profile names from `loadAgentDefinitions`. */
  profileNames: readonly string[];
  env?: Record<string, string | undefined>;
}

export type SpawnMode = { mode: 'template' } | { mode: 'profile'; profileName: string };

/**
 * Decide how a requested `template` is launched.
 *
 * A profile wins when `hc templates` does not own the name (so `.pi/agents/<name>.md`
 * works with the herdr templates removed) or when `PI_HERDR_USE_PROFILE_LAUNCH=1`
 * asks for it. A name only `hc templates` knows stays a template launch. `null`
 * means the name is unknown in both sources.
 */
export function resolveSpawnMode(template: string, sources: SpawnSources): SpawnMode | null {
  const profile = sources.profileNames.includes(template);
  const hcTemplate = sources.hcTemplates.includes(template);
  const forceProfile = sources.env?.PI_HERDR_USE_PROFILE_LAUNCH === '1';
  if (profile && (forceProfile || !hcTemplate)) return { mode: 'profile', profileName: template };
  if (hcTemplate) return { mode: 'template' };
  if (profile) return { mode: 'profile', profileName: template };
  return null;
}

export interface HerdrTab {
  tabId: string;
  /** Known tab name, or `null` when `herdr-app ls` could not tell us. */
  tabName: string | null;
}

interface HerdrAppList {
  spaces?: Array<{
    id?: string;
    tabs?: Array<{
      id?: string;
      name?: string;
      terminals?: Array<{ terminal?: string }>;
    }>;
  }>;
}

/** Name of tab `tabId` as reported by `herdr-app ls`, or `null` when unknown. */
export function findTabName(appListJson: string, tabId: string): string | null {
  const parsed = parseJson<HerdrAppList>(appListJson);
  if (!parsed?.spaces) return null;
  for (const space of parsed.spaces) {
    for (const tab of space?.tabs ?? []) {
      if (tab?.id === tabId) return nonEmpty(tab.name) ?? '';
    }
  }
  return null;
}

/**
 * `herdr-app ls` fallback: locate the tab that holds `address` inside `spaceId`.
 * Used only when the terminal's own `herdr.tab` label is unavailable.
 */
export function resolveTabFromAppList(
  appListJson: string,
  spaceId: string,
  address: string,
): HerdrTab | null {
  const parsed = parseJson<HerdrAppList>(appListJson);
  if (!parsed?.spaces) return null;
  for (const space of parsed.spaces) {
    if (space?.id !== spaceId) continue;
    for (const tab of space.tabs ?? []) {
      const holds = (tab.terminals ?? []).some((terminal) => terminal?.terminal === address);
      const tabId = nonEmpty(tab.id);
      if (holds && tabId) {
        return { tabId, tabName: nonEmpty(tab.name) ?? '' };
      }
    }
  }
  return null;
}

/**
 * Only a tab still carrying its default numeric name is safe to rename. A tab the
 * person already named (or one whose name we could not read) is left alone.
 */
export function shouldRenameTab(tabName: string | null): boolean {
  if (tabName === null) return false;
  return /^\d+$/.test(tabName.trim());
}

/** The four headings every pushed worker report must carry, in this order. */
export const REPORT_SECTIONS = ['## Goal', '## Changes', '## Verification', '## Blockers'] as const;

/**
 * Headings a report file is missing. Headings are matched as whole lines (leading
 * and trailing whitespace ignored) so a heading mentioned inline never counts.
 */
export function missingReportSections(source: string): string[] {
  const lines = source
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim());
  return REPORT_SECTIONS.filter((heading) => !lines.includes(heading));
}
