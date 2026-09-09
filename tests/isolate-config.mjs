import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests and their child CLIs must never consume the operator's personal model file.
const configRoot = mkdtempSync(join(tmpdir(), 'wapentake-test-config-'));
process.env.XDG_CONFIG_HOME = configRoot;
for (const name of ['MODELS_FILE', 'MODEL_PROFILE', 'TOKEN', 'STATE_DIR', 'CLI', 'NODE', 'INSTALL_ROOT']) {
  delete process.env[`WAPENTAKE_${name}`];
}
process.once('exit', () => rmSync(configRoot, { recursive: true, force: true }));
