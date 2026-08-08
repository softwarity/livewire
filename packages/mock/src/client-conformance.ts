import type { Envelope, JsonValue, LiveRow, UpdateFrame } from '@softwarity/livewire-protocol';

/**
 * What a client implementation must let the suite do to it.
 *
 * The server suite drives a socket and reads what comes back. This one is the
 * other way round: it feeds frames in and reads what the screen would show, and
 * what the client sent up in return.
 *
 * Both halves of a client are under test here - the transport, which decides
 * what goes on the wire and when, and the list, which decides what a frame does
 * to the rows. A client that got the second half right and the first half wrong
 * looks perfect in unit tests and holds an empty screen in production.
 */
export interface Consumer {
  /** Opens a subscription on a topic. */
  open(topic: string, query?: JsonValue): void;

  /** Closes the one that is open. */
  close(): void;

  /** Delivers a frame, as a socket would. */
  deliver(frame: UpdateFrame): void;

  /** Drops the socket without warning, as a gateway restart does. */
  drop(): void;

  /**
   * Lets whatever is in flight settle.
   *
   * A client opens its socket on a later tick, as a real one does, so nothing
   * can be asserted on the frame that follows an action without this.
   */
  settle(): Promise<void>;

  /** Everything the client has sent, oldest first. */
  sent(): Envelope<unknown>[];

  /** The rows the screen would render, in order. */
  rows(): LiveRow[];

  /** What the list is a page of, as the client last understood it. */
  total(): number | undefined;

  /** The index the server pointed at, or null. */
  pivot(): number | null;

  /** How many times the client asked for its window again. */
  resyncs(): number;
}

export interface ClientScenario {
  name: string;
  /** The clause of SPEC.md this defends. */
  spec: string;
  run(consumer: Consumer): Promise<void>;
}

function ids(consumer: Consumer): string[] {
  return consumer.rows().map((row) => row.id);
}

function frames(consumer: Consumer, event: string): Envelope<unknown>[] {
  return consumer.sent().filter((envelope) => envelope.event === event);
}

function rows(...given: [string, string][]): LiveRow[] {
  return given.map(([id, updatedAt]) => ({ id, updatedAt }));
}

function expect(actual: unknown, wanted: unknown, what: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(wanted);
  if (left !== right) {
    throw new Error(`${what}: expected ${right}, got ${left}`);
  }
}

/**
 * What every client implementation must do with what it is sent.
 *
 * The counterpart of `SCENARIOS`, which says what a server must send. Two
 * suites, one specification: a client that passes this and a server that passes
 * that can be written by people who never meet.
 */
export const CLIENT_SCENARIOS: ClientScenario[] = [
  {
    name: 'opens with one subscribe naming the topic and the query',
    spec: '§2.1',
    async run(consumer) {
      consumer.open('rows', { search: 'delay' });
      await consumer.settle();

      const opened = frames(consumer, 'subscribe');
      if (opened.length === 0) {
        throw new Error('nothing was sent');
      }
      const data = opened[opened.length - 1].data as { id?: string; topic?: string; query?: JsonValue };
      expect(data.topic, 'rows', 'the topic');
      expect(data.query, { search: 'delay' }, 'the query');
      if (typeof data.id !== 'string' || data.id === '') {
        throw new Error(`the id: expected a non-empty string, got ${JSON.stringify(data.id)}`);
      }
    },
  },
  {
    /**
     * A cold load, which is where this went wrong once: a socket that is still
     * connecting throws on `send`, and a client that sends anyway takes the
     * exception through the subscription it was opening.
     */
    name: 'ends up subscribed even when it asked before the socket was open',
    spec: '§1',
    async run(consumer) {
      consumer.open('rows');
      await consumer.settle();

      if (frames(consumer, 'subscribe').length === 0) {
        throw new Error('the subscription never reached the server');
      }
      consumer.deliver({ id: 'ignored', type: 'snapshot', rows: rows(['a', 'v1']), total: 1, sequence: 1 });
      await consumer.settle();
      expect(ids(consumer), ['a'], 'the rows');
    },
  },
  {
    name: 'takes a snapshot as the list, with its total and its pivot',
    spec: '§5',
    async run(consumer) {
      consumer.open('rows');
      await consumer.settle();
      consumer.deliver({
        id: 'ignored',
        type: 'snapshot',
        rows: rows(['a', 'v1'], ['b', 'v1']),
        total: 42,
        pivot: 7,
        sequence: 1,
      });
      await consumer.settle();

      expect(ids(consumer), ['a', 'b'], 'the rows');
      expect(consumer.total(), 42, 'the total');
      expect(consumer.pivot(), 7, 'the pivot');
    },
  },
  {
    name: 'applies a patch: upserted, removed, and the order given',
    spec: '§5.2',
    async run(consumer) {
      consumer.open('rows');
      await consumer.settle();
      consumer.deliver({
        id: 'ignored',
        type: 'snapshot',
        rows: rows(['a', 'v1'], ['b', 'v1'], ['c', 'v1']),
        total: 3,
        sequence: 1,
      });
      consumer.deliver({
        id: 'ignored',
        type: 'patch',
        upserted: rows(['d', 'v1'], ['b', 'v2']),
        removed: ['a'],
        order: ['d', 'b', 'c'],
        total: 3,
        sequence: 2,
      });
      await consumer.settle();

      expect(ids(consumer), ['d', 'b', 'c'], 'the rows');
      expect(consumer.rows()[1].updatedAt, 'v2', "the upserted row's version");
    },
  },
  {
    /**
     * The saving of the whole design: three rows arriving at the top cost three
     * rows on the wire, not a page. A client that cannot place a row it already
     * holds from `order` alone would need the server to send it again.
     */
    name: 'reorders from ids alone, without being sent the rows again',
    spec: '§5.2',
    async run(consumer) {
      consumer.open('rows');
      await consumer.settle();
      consumer.deliver({
        id: 'ignored',
        type: 'snapshot',
        rows: rows(['a', 'v1'], ['b', 'v1']),
        total: 2,
        sequence: 1,
      });
      consumer.deliver({
        id: 'ignored',
        type: 'patch',
        upserted: [],
        removed: [],
        order: ['b', 'a'],
        total: 2,
        sequence: 2,
      });
      await consumer.settle();

      expect(ids(consumer), ['b', 'a'], 'the rows');
    },
  },
  {
    name: 'asks again rather than apply a frame out of sequence',
    spec: '§4',
    async run(consumer) {
      consumer.open('rows');
      await consumer.settle();
      consumer.deliver({ id: 'ignored', type: 'snapshot', rows: rows(['a', 'v1']), total: 1, sequence: 1 });
      await consumer.settle();
      const before = consumer.resyncs();

      // Sequence 3 where 2 was due: a frame went missing.
      consumer.deliver({
        id: 'ignored',
        type: 'patch',
        upserted: [],
        removed: [],
        order: [],
        total: 0,
        sequence: 3,
      });
      await consumer.settle();

      expect(ids(consumer), ['a'], 'the rows, which must not have moved');
      if (consumer.resyncs() <= before) {
        throw new Error('the gap was applied instead of being asked about again');
      }
    },
  },
  {
    name: 'asks again rather than apply a patch naming a row it does not hold',
    spec: '§4',
    async run(consumer) {
      consumer.open('rows');
      await consumer.settle();
      consumer.deliver({ id: 'ignored', type: 'snapshot', rows: rows(['a', 'v1']), total: 1, sequence: 1 });
      await consumer.settle();
      const before = consumer.resyncs();

      consumer.deliver({
        id: 'ignored',
        type: 'patch',
        upserted: [],
        removed: [],
        // `b` is in the order and in neither the snapshot nor the upserts.
        order: ['a', 'b'],
        total: 2,
        sequence: 2,
      });
      await consumer.settle();

      expect(ids(consumer), ['a'], 'the rows, which must not have moved');
      if (consumer.resyncs() <= before) {
        throw new Error('a row it never held was placed anyway');
      }
    },
  },
  {
    name: 'leaves the list alone on an error frame',
    spec: '§2.2',
    async run(consumer) {
      consumer.open('rows');
      await consumer.settle();
      consumer.deliver({ id: 'ignored', type: 'snapshot', rows: rows(['a', 'v1']), total: 1, sequence: 1 });
      consumer.deliver({ id: 'ignored', type: 'error', reason: 'no topic' });
      await consumer.settle();

      expect(ids(consumer), ['a'], 'the rows');
    },
  },
  {
    name: 'ignores a frame carrying another subscription id',
    spec: '§6',
    async run(consumer) {
      consumer.open('rows');
      await consumer.settle();
      consumer.deliver({ id: 'ignored', type: 'snapshot', rows: rows(['a', 'v1']), total: 1, sequence: 1 });
      consumer.deliver({
        id: 'somebody-else',
        type: 'snapshot',
        rows: rows(['x', 'v1'], ['y', 'v1']),
        total: 2,
        sequence: 1,
      });
      await consumer.settle();

      expect(ids(consumer), ['a'], 'the rows');
    },
  },
  {
    name: 'closes with an unsubscribe naming the id it opened',
    spec: '§3.3',
    async run(consumer) {
      consumer.open('rows');
      await consumer.settle();
      const opened = frames(consumer, 'subscribe').pop()?.data as { id: string };

      consumer.close();
      await consumer.settle();

      const closed = frames(consumer, 'unsubscribe').pop()?.data as { id?: string } | undefined;
      if (!closed) {
        throw new Error('nothing was sent to close the subscription');
      }
      expect(closed.id, opened.id, 'the id closed');
    },
  },
  {
    /**
     * The server remembers nothing across connections - SPEC §6 - so this is
     * the client's job and nobody else's. A screen must not have to know its
     * socket dropped.
     */
    name: 'subscribes again by itself after the socket drops',
    spec: '§6',
    async run(consumer) {
      consumer.open('rows');
      await consumer.settle();
      const before = frames(consumer, 'subscribe').length;

      consumer.drop();
      await consumer.settle();

      if (frames(consumer, 'subscribe').length <= before) {
        throw new Error('the subscription was not opened again on the new socket');
      }
    },
  },
];
