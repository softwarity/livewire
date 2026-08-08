import { SUBSCRIBE_EVENT, UNSUBSCRIBE_EVENT, UPDATE_EVENT } from '@softwarity/livewire-protocol';
import type { Envelope, UpdateFrame } from '@softwarity/livewire-protocol';

/**
 * What a server has to look like to be checked: a way to send a frame, a way to
 * receive one, and a way to make its data change.
 *
 * Deliberately not a WebSocket. The in-memory server has no socket, the NestJS
 * one is driven through `ws`, and a Go one through whatever Go uses - the
 * scenarios below know none of that.
 */
export interface Wire {
  /**
   * Resolves once the connection is usable.
   *
   * A real socket is not open the instant it is asked for, and a scenario that
   * sends before it is open sends into nothing. The in-memory server opens on
   * the next tick for exactly this reason - so that the same scenarios exercise
   * the same race.
   */
  ready?: Promise<void>;
  send(frame: string): void;
  /** Frames as they arrive. Called for each. */
  onFrame(listener: (frame: string) => void): void;
  /** Makes whatever the sources read change, then settles. */
  touch(): Promise<void>;
  /** How long to wait before deciding that no frame is coming. */
  quiet?: number;
  close?(): void;
}

export interface Scenario {
  name: string;
  /** The rule of SPEC.md this checks, for a failure that says what broke. */
  spec: string;
  run(wire: Conversation): Promise<void>;
}

/** A wire, plus what a scenario needs to say about it. */
export class Conversation {
  private readonly received: UpdateFrame[] = [];
  private waiting: ((frame: UpdateFrame) => void) | null = null;

  constructor(private readonly wire: Wire) {
    wire.onFrame((raw) => {
      const envelope = JSON.parse(raw) as Envelope<UpdateFrame>;
      if (envelope.event !== UPDATE_EVENT) {
        return;
      }
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(envelope.data);
        return;
      }
      this.received.push(envelope.data);
    });
  }

  subscribe(id: string, topic: string, query?: unknown): void {
    this.wire.send(JSON.stringify({ event: SUBSCRIBE_EVENT, data: { id, topic, query } }));
  }

  unsubscribe(id: string): void {
    this.wire.send(JSON.stringify({ event: UNSUBSCRIBE_EVENT, data: { id } }));
  }

  /** A frame exactly as written - for the cases a helper would smooth over. */
  send(raw: string): void {
    this.wire.send(raw);
  }

  touch(): Promise<void> {
    return this.wire.touch();
  }

  /** The next frame, or a failure saying what was expected. */
  next(what: string): Promise<UpdateFrame> {
    const held = this.received.shift();
    if (held) {
      return Promise.resolve(held);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error(`expected ${what}, nothing arrived`));
      }, this.wire.quiet ?? 500);
      this.waiting = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
    });
  }

  /** Asserts that nothing more arrives. */
  async silence(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.wire.quiet ?? 500));
    if (this.received.length > 0) {
      throw new Error(`expected silence, got ${JSON.stringify(this.received[0])}`);
    }
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * The scenarios every server implementation must pass.
 *
 * Two implementations of one protocol diverge within months - not through
 * carelessness, but through the cases nobody wrote down. This is that list,
 * driven over whatever wire the implementation offers.
 *
 * The sources a conforming server must expose to run them:
 *
 * - `rows` — a paged list. `touch()` adds one row at the top.
 * - `still` — a window that never changes, whatever happens.
 */
export const SCENARIOS: Scenario[] = [
  {
    name: 'answers a snapshot first, numbered one',
    spec: '§3.1',
    async run(wire) {
      wire.subscribe('a', 'rows');
      const frame = await wire.next('a snapshot');
      expect(frame.type === 'snapshot', `first frame was ${frame.type}`);
      expect('sequence' in frame && frame.sequence === 1, 'first sequence was not 1');
    },
  },
  {
    name: 'answers patches after it, numbering up',
    spec: '§4',
    async run(wire) {
      wire.subscribe('a', 'rows');
      await wire.next('a snapshot');
      await wire.touch();
      const frame = await wire.next('a patch');
      expect(frame.type === 'patch', `second frame was ${frame.type}`);
      expect('sequence' in frame && frame.sequence === 2, 'second sequence was not 2');
    },
  },
  {
    name: 'a row that only moved is not upserted',
    spec: '§5.2',
    async run(wire) {
      wire.subscribe('a', 'rows');
      const snapshot = await wire.next('a snapshot');
      expect(snapshot.type === 'snapshot', 'no snapshot');
      const before = snapshot.type === 'snapshot' ? snapshot.rows.map((row) => row.id) : [];

      await wire.touch();
      const patch = await wire.next('a patch');
      expect(patch.type === 'patch', 'no patch');
      if (patch.type !== 'patch') {
        return;
      }
      const stillThere = patch.order.filter((id) => before.includes(id));
      const upserted = patch.upserted.map((row) => row.id);
      for (const id of stillThere) {
        expect(!upserted.includes(id), `row '${id}' was re-sent though only its position changed`);
      }
    },
  },
  {
    name: 'a window that did not change publishes nothing',
    spec: '§5.3',
    async run(wire) {
      wire.subscribe('a', 'still');
      await wire.next('a snapshot');
      await wire.touch();
      await wire.silence();
    },
  },
  {
    name: 'an unknown topic answers an error and opens nothing',
    spec: '§3.1',
    async run(wire) {
      wire.subscribe('a', 'nothing-answers-this');
      const frame = await wire.next('an error');
      expect(frame.type === 'error', `frame was ${frame.type}`);
      await wire.touch();
      await wire.silence();
    },
  },
  {
    name: 'a subscribe with no id is ignored',
    spec: '§2.1',
    async run(wire) {
      wire.send(JSON.stringify({ event: SUBSCRIBE_EVENT, data: { topic: 'rows' } }));
      wire.send(JSON.stringify({ event: SUBSCRIBE_EVENT, data: { id: '', topic: 'rows' } }));
      await wire.silence();
    },
  },
  {
    name: 'an unreadable frame is ignored, and the connection stays up',
    spec: '§2',
    async run(wire) {
      wire.send('{not json at all');
      wire.send('"a string, not an envelope"');
      wire.subscribe('a', 'rows');
      const frame = await wire.next('a snapshot');
      expect(frame.type === 'snapshot', 'the connection did not survive');
    },
  },
  {
    name: 'resubscribing under an open id replaces it and restarts the sequence',
    spec: '§3.2',
    async run(wire) {
      wire.subscribe('a', 'rows');
      await wire.next('a snapshot');
      await wire.touch();
      await wire.next('a patch');

      wire.subscribe('a', 'rows', { moved: true });
      const frame = await wire.next('a second snapshot');
      expect(frame.type === 'snapshot', `frame was ${frame.type}`);
      expect('sequence' in frame && frame.sequence === 1, 'the sequence did not restart at 1');
    },
  },
  {
    name: 'unsubscribing stops the frames',
    spec: '§3.3',
    async run(wire) {
      wire.subscribe('a', 'rows');
      await wire.next('a snapshot');
      wire.unsubscribe('a');
      await wire.touch();
      await wire.silence();
    },
  },
  {
    name: 'unsubscribing an unknown id is ignored',
    spec: '§3.3',
    async run(wire) {
      wire.unsubscribe('never-opened');
      wire.subscribe('a', 'rows');
      const frame = await wire.next('a snapshot');
      expect(frame.type === 'snapshot', 'the connection did not survive');
    },
  },
  {
    name: 'unsubscribing one subscription leaves the others alone',
    spec: '§3.3',
    async run(wire) {
      wire.subscribe('a', 'rows');
      await wire.next('a snapshot for a');
      wire.subscribe('b', 'rows');
      await wire.next('a snapshot for b');

      wire.unsubscribe('a');
      await wire.touch();
      const frame = await wire.next('a patch for b');
      expect(frame.id === 'b', `frame was for '${frame.id}'`);
    },
  },
  {
    name: 'a late subscription gets a snapshot of where things are',
    spec: '§5',
    async run(wire) {
      wire.subscribe('early', 'rows');
      await wire.next('a snapshot for early');
      await wire.touch();
      await wire.next('a patch for early');

      wire.subscribe('late', 'rows');
      const frame = await wire.next('a snapshot for late');
      expect(frame.type === 'snapshot', `frame was ${frame.type}`);
      expect(frame.id === 'late', `frame was for '${frame.id}'`);
    },
  },
];
