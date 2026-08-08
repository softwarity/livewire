import { Conversation, MockServer, SCENARIOS } from '../src/index';
import type { LiveWindow } from '@softwarity/livewire-protocol';
import type { Wire } from '../src/conformance';

/**
 * The in-memory server, put through the scenarios every implementation must
 * pass.
 *
 * The same list runs against the NestJS server and the Go one. A rule that only
 * two of the three obey shows up here as a failing test rather than as a bug in
 * six months - which is the whole reason the mock exists beside the demo it was
 * written for.
 */
describe('conformance: the in-memory server', () => {
  /** The two sources SCENARIOS expects, and nothing else. */
  function serverOf(): { server: MockServer; add: () => void } {
    let arrivals = 0;

    const server = new MockServer()
      .register('rows', {
        windowFor: (): LiveWindow => ({
          // Newest first, so an arrival pushes the others down without
          // changing them - which is what checks that a row that only moved is
          // not re-sent.
          rows: [
            ...Array.from({ length: arrivals }, (_, index) => ({
              id: `new-${arrivals - index}`,
              updatedAt: 'v1',
            })),
            { id: 'r1', updatedAt: 'v1' },
            { id: 'r2', updatedAt: 'v1' },
          ],
          total: 2 + arrivals,
        }),
      })
      .register('still', {
        windowFor: (): LiveWindow => ({ rows: [{ id: 'always', updatedAt: 'v1' }], total: 1 }),
      });

    return {
      server,
      add: () => {
        arrivals += 1;
        server.touched();
      },
    };
  }

  function wireOf(): Wire {
    const { server, add } = serverOf();
    const socket = server.connect();
    return {
      // The mock opens on the next tick, as a socket does.
      ready: Promise.resolve(),
      send: (frame) => socket.send(frame),
      onFrame: (listener) => {
        socket.onmessage = listener;
      },
      touch: async () => {
        add();
        // The mock is synchronous; a tick lets the frames settle the way a
        // socket would deliver them.
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      // Nothing here waits on a network.
      quiet: 30,
      close: () => socket.close(),
    };
  }

  for (const scenario of SCENARIOS) {
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

describe('the in-memory server, beyond the contract', () => {
  /**
   * SPEC §1: the frame first, then the close. A refusal arriving as a bare
   * disconnection cannot be told from a network fault.
   */
  it('refuses a connection with a frame before the close', async () => {
    const order: string[] = [];
    const server = new MockServer({ authorize: () => false, refusal: () => 'no role for you' });

    const socket = server.connect();
    socket.onmessage = (frame) => order.push(String(JSON.parse(frame).data.reason));
    socket.onclose = (code) => order.push(`closed ${code}`);
    await Promise.resolve();

    expect(order).toEqual(['no role for you', 'closed 1008']);
  });

  it('answers nothing at all on a refused connection', async () => {
    const seen: string[] = [];
    const server = new MockServer({ authorize: () => false });
    server.register('rows', { windowFor: () => ({ rows: [] }) });

    const socket = server.connect();
    socket.onmessage = (frame) => seen.push(frame);
    await Promise.resolve();
    socket.send(JSON.stringify({ event: 'subscribe', data: { id: 'a', topic: 'rows' } }));

    // Only the refusal, never a snapshot.
    expect(seen).toHaveLength(1);
  });

  it('reports every frame both ways, for a demo to show', async () => {
    const traffic: string[] = [];
    const server = new MockServer({ onTraffic: (direction, frame) => traffic.push(`${direction} ${frame.event}`) });
    server.register('rows', { windowFor: () => ({ rows: [] }) });

    const socket = server.connect();
    socket.onmessage = () => undefined;
    await Promise.resolve();
    socket.send(JSON.stringify({ event: 'subscribe', data: { id: 'a', topic: 'rows' } }));

    expect(traffic).toEqual(['in subscribe', 'out update']);
  });

  it('reads the query through the source, as a real server does', async () => {
    const asked: unknown[] = [];
    const server = new MockServer();
    server.register<string>('rows', {
      readQuery: (raw) => String((raw as { q?: string })?.q ?? ''),
      windowFor: (query) => {
        asked.push(query);
        return { rows: [] };
      },
    });

    const socket = server.connect();
    socket.onmessage = () => undefined;
    await Promise.resolve();
    socket.send(JSON.stringify({ event: 'subscribe', data: { id: 'a', topic: 'rows', query: { q: 'hello' } } }));

    expect(asked).toEqual(['hello']);
  });
});
