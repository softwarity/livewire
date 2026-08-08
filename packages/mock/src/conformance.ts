import {
  ACK_EVENT,
  COMMAND_EVENT,
  NOTIFY_EVENT,
  SUBSCRIBE_EVENT,
  UNSUBSCRIBE_EVENT,
  UPDATE_EVENT,
} from '@softwarity/livewire-protocol';
import type { AckFrame, Envelope, NotifyFrame, UpdateFrame } from '@softwarity/livewire-protocol';

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
  /**
   * Which level of the specification this belongs to.
   *
   * Absent or 1: every server must pass it. 2: commands and notifications,
   * which a server may not implement at all - a harness skips them unless the
   * server says it has them.
   */
  level?: 1 | 2;
  /** The rule of SPEC.md this checks, for a failure that says what broke. */
  spec: string;
  run(wire: Conversation): Promise<void>;
}

/** A wire, plus what a scenario needs to say about it. */
/**
 * The scenarios a server claiming that level of the specification must pass.
 *
 * Level 2 - commands and notifications - is optional, so a server that does not
 * have it is not failing anything. Saying which level a fixture claims is how
 * that stays honest: a suite that quietly skipped them would look the same as
 * one that passed.
 */
export function scenariosFor(level: 1 | 2): Scenario[] {
  return SCENARIOS.filter((scenario) => (scenario.level ?? 1) <= level);
}

export class Conversation {
  private readonly received: UpdateFrame[] = [];
  private waiting: ((frame: UpdateFrame) => void) | null = null;

  /** Acknowledgements and notifications, kept apart from the windows. */
  private readonly acks: AckFrame[] = [];
  private readonly notices: NotifyFrame[] = [];

  constructor(private readonly wire: Wire) {
    wire.onFrame((raw) => {
      const envelope = JSON.parse(raw) as Envelope<UpdateFrame>;
      if (envelope.event === ACK_EVENT) {
        this.acks.push(envelope.data as unknown as AckFrame);
        return;
      }
      if (envelope.event === NOTIFY_EVENT) {
        this.notices.push(envelope.data as unknown as NotifyFrame);
        return;
      }
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

  /** Asks for something to be done - SPEC §6.1. Answered by exactly one ack. */
  command(id: string, name: string, payload?: unknown): void {
    this.wire.send(JSON.stringify({ event: COMMAND_EVENT, data: { id, name, payload } }));
  }

  /** The acknowledgement carrying that id, or a failure saying none came. */
  async ack(id: string): Promise<AckFrame> {
    const deadline = Date.now() + (this.wire.quiet ?? 500);
    for (;;) {
      const found = this.acks.find((frame) => frame.id === id);
      if (found) {
        return found;
      }
      if (Date.now() >= deadline) {
        throw new Error(`expected an ack for '${id}', nothing arrived`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** How many acknowledgements have arrived under that id. */
  acksFor(id: string): number {
    return this.acks.filter((frame) => frame.id === id).length;
  }

  /** The notifications seen so far, oldest first - SPEC §6.2. */
  notified(): NotifyFrame[] {
    return [...this.notices];
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
 *
 * And, for the level 2 scenarios only:
 *
 * - a command `touch`, which does what `touch()` does and succeeds.
 * - a command `announce`, which succeeds and sends one notification on the
 *   topic `announcements`.
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

  // ── Level 2, SPEC §6. A server may implement neither, either or both; the
  // suite skips these where `commands` says the server does not claim them.
  {
    name: 'answers a command with exactly one ack, carrying its id',
    spec: '§6.1',
    level: 2,
    async run(talk) {
      talk.command('c-1', 'touch');
      const ack = await talk.ack('c-1');

      expect(ack.ok === true, `expected the command to succeed, got ${JSON.stringify(ack)}`);
      await talk.silence();
      expect(talk.acksFor('c-1') === 1, `expected one ack, got ${talk.acksFor('c-1')}`);
    },
  },
  {
    name: 'answers a command it does not know with ok:false and a reason',
    spec: '§6.1',
    level: 2,
    async run(talk) {
      talk.command('c-2', 'no-such-command');
      const ack = await talk.ack('c-2');

      expect(ack.ok === false, 'expected an unknown command to be refused');
      expect(typeof ack.reason === 'string' && ack.reason !== '', 'expected a reason to show a reader');
    },
  },
  {
    name: 'a command that changes the data reaches an open window the ordinary way',
    spec: '§6.1',
    level: 2,
    async run(talk) {
      talk.subscribe('w', 'rows');
      await talk.next('the first snapshot');

      talk.command('c-3', 'touch');
      await talk.ack('c-3');
      const frame = await talk.next('the patch the command caused');

      expect(frame.type === 'patch', `expected a patch, got ${frame.type}`);
      expect(frame.id === 'w', 'the change must arrive on the subscription, not on the ack');
    },
  },
  {
    name: 'a command with no id is ignored silently',
    spec: '§2.1',
    level: 2,
    async run(talk) {
      talk.send(JSON.stringify({ event: 'command', data: { name: 'touch' } }));
      await talk.silence();
    },
  },
  {
    name: 'a notification arrives with its topic and nothing to apply',
    spec: '§6.2',
    level: 2,
    async run(talk) {
      talk.command('c-4', 'announce');
      await talk.ack('c-4');
      // Nothing orders an ack against what it caused, so give the notice a
      // moment of its own.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const notices = talk.notified();
      expect(notices.length > 0, 'expected a notification');
      expect(notices[0].topic === 'announcements', `expected the topic 'announcements', got '${notices[0].topic}'`);
    },
  },
];
