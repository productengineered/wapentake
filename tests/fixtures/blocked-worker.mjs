import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, Room } from '../../src/room.mjs';
import { Worker } from '../../src/worker.mjs';

const [state, phase] = process.argv.slice(2);
const store = new Store(state);
const room = new Room(store, readFileSync(join(state, 'operator.token'), 'utf8').trim());
// A pending Promise alone does not keep a process alive for a crash test.
setInterval(() => {}, 1000);
const fake = {
  async prepare({ participant }) {
    if (phase === 'preparing') {
      process.send('preparing');
      await new Promise(resolve => process.once('message', resolve));
    }
    return { participant, capabilities: { fixture: true } };
  },
  async run() {
    process.send('running');
    await new Promise(() => {});
  },
};
await new Worker(room, { adapters: new Map([['codex-chatgpt-astra', fake]]) }).runOnce();
