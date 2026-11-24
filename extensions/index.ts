import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { registerAgentProfile } from './agent-prompt.ts';
import { createHcDelegationExtension } from './hc-delegation.ts';
import { registerHcTools } from './hc-tools.ts';

export default function (pi: ExtensionAPI): void {
  const address = process.env.HC_TERMINAL_ID;
  if (address) {
    const getScope = registerAgentProfile(pi);
    registerHcTools(pi, address, fileURLToPath(new URL('./index.ts', import.meta.url)), getScope);
  }
  // Role resolution, prompt injection and `hc_worker` / `hc_report` run in every
  // role, including `standalone` and `subagent` (which only get the fallback note).
  createHcDelegationExtension()(pi);
}
