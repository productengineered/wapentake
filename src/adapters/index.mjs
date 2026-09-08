import { CodexAdapter } from './codex.mjs';
import { OpenCodeAdapter } from './opencode.mjs';
export { CodexAdapter } from './codex.mjs';
export { OpenCodeAdapter } from './opencode.mjs';
export function adapters(){return new Map([['codex-chatgpt-astra',new CodexAdapter()],['opencode-glm-plan',new OpenCodeAdapter()]]);}
