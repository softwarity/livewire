import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Conversation, scenariosFor } from '../src/index';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Wire } from '../src/conformance';

/**
 * The Go server, put through the very same scenarios.
 *
 * This is the point of writing two implementations: the list of rules is one
 * list, and a server that obeys eleven of twelve says so here rather than on
 * somebody's screen. The fixture it drives is `go/cmd/conformance`, which
 * exposes the two sources the scenarios expect and a `/touch` endpoint to make
 * the data move.
 *
 * Skipped where Go is not installed - a front-end developer should not need a
 * Go toolchain to run the TypeScript tests.
 */
const GO_DIR = join(__dirname, '../../../go');
const hasGo = existsSync(join(GO_DIR, 'go.mod')) && which('go');

function which(command: string): boolean {
  try {
    require('node:child_process').execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

(hasGo ? describe : describe.skip)('conformance: the Go server', () => {
  let server: ChildProcessWithoutNullStreams;
  let address: string;

  beforeAll(async () => {
    // Built, then run. `go run` leaves a parent process between us and the
    // server, so killing it leaves the server listening and jest never exits.
    const binary = join(mkdtempSync(join(tmpdir(), 'livewire-')), 'conformance');
    execFileSync('go', ['build', '-o', binary, './cmd/conformance'], { cwd: GO_DIR });
    server = spawn(binary, ['-addr', '127.0.0.1:0'], { cwd: GO_DIR });
    address = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the Go server did not start')), 20_000);
      server.stdout.on('data', (chunk: Buffer) => {
        const found = /listening (\S+)/.exec(chunk.toString());
        if (found) {
          clearTimeout(timer);
          resolve(`ws://${found[1]}/ws`);
        }
      });
      server.on('error', reject);
    });
  }, 60_000);

  afterAll(() => {
    server?.kill();
  });

  function wireOf(): Wire {
    const socket = new WebSocket(address);
    return {
      ready: new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      }),
      send: (frame) => socket.send(frame),
      onFrame: (listener) => socket.on('message', (data: Buffer) => listener(data.toString())),
      touch: async () => {
        await fetch(`${address.replace('ws://', 'http://').replace('/ws', '')}/touch`, { method: 'POST' });
        await new Promise((resolve) => setTimeout(resolve, 80));
      },
      quiet: 250,
      close: () => socket.close(),
    };
  }

  for (const scenario of scenariosFor(2)) {
    it(`${scenario.spec} ${scenario.name}`, async () => {
      const wire = wireOf();
      const conversation = new Conversation(wire);
      await wire.ready;
      try {
        await scenario.run(conversation);
      } finally {
        wire.close?.();
      }
    });
  }
});
