import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const APP_NAME = 'Wapentake';
export const PACKAGE_NAME = '@productengineered/wapentake';

export function setting(name, env = process.env) {
  return env[`WAPENTAKE_${name}`];
}

export function present(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function userPath(kind, env = process.env) {
  const base = kind === 'models'
    ? env.XDG_CONFIG_HOME || join(homedir(), '.config')
    : env.XDG_STATE_HOME || join(homedir(), '.local/state');
  const tail = kind === 'models' ? ['models.json'] : [];
  return resolve(join(base, 'wapentake', ...tail));
}
