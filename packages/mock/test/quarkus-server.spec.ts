import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Conversation, scenariosFor } from '../src/index';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Wire } from '../src/conformance';

/**
 * The Quarkus server, put through the very same scenarios as the in-memory, NestJS and Go ones.
 *
 * The fixture it drives is `quarkus/conformance`: the two sources the scenarios expect, the two
 * commands, and a `/touch` endpoint to make the data move. It is packaged by Maven, then run as
 * the fast-jar a deployment runs.
 *
 * Skipped where Java is not installed - a front-end developer should not need a JDK to run the
 * TypeScript tests.
 */
const QUARKUS_DIR = join(__dirname, '../../../quarkus');
const RUN_JAR = join(QUARKUS_DIR, 'conformance/target/quarkus-app/quarkus-run.jar');
const hasJava = existsSync(join(QUARKUS_DIR, 'pom.xml')) && which('java');

function which(command: string): boolean {
  try {
    require('node:child_process').execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A port nothing listens on, asked of the system. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Whether something listens on that port now. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

(hasJava ? describe : describe.skip)('conformance: the Quarkus server', () => {
  let server: ChildProcessWithoutNullStreams;
  let address: string;

  beforeAll(async () => {
    execFileSync(join(QUARKUS_DIR, 'mvnw'), ['-q', 'package', '-DskipTests'], { cwd: QUARKUS_DIR, stdio: 'ignore' });
    const port = await freePort();
    server = spawn('java', [`-Dquarkus.http.port=${port}`, '-jar', RUN_JAR], { cwd: QUARKUS_DIR });
    // Ready once the port accepts a connection: Quarkus's start-up event fires before the
    // HTTP server binds, so nothing it prints says the socket is there yet.
    const deadline = Date.now() + 60_000;
    while (!(await accepts(port))) {
      if (Date.now() > deadline || server.exitCode !== null) {
        throw new Error('the Quarkus server did not start');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    address = `ws://127.0.0.1:${port}/ws`;
  }, 300_000);

  afterAll(() => {
    server?.kill();
  });

  /** A connection opened by that caller (SPEC §5.5: `?caller=` of the upgrade request). */
  function wireOf(caller = 'alice'): Wire {
    const socket = new WebSocket(`${address}?caller=${encodeURIComponent(caller)}`);
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
      as: (other) => wireOf(other),
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
