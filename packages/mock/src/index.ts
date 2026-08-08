import {
  NOT_AUTHORISED,
  SUBSCRIBE_EVENT,
  UNSUBSCRIBE_EVENT,
  UPDATE_EVENT,
  patchOf,
  signatureOf,
  snapshotOf,
} from '@softwarity/livewire-protocol';
import type {
  Envelope,
  JsonValue,
  LiveRow,
  LiveWindow,
  SubscribeFrame,
  UnsubscribeFrame,
  UpdateFrame,
} from '@softwarity/livewire-protocol';

/**
 * One live list, in memory.
 *
 * `readQuery` is the same trust boundary as on a real server, and `windowFor`
 * answers the window for a question. Call `touched()` when whatever the source
 * reads has changed - that is what a write announces on a real one.
 */
export interface MockSource<Q = JsonValue> {
  readQuery?(raw: JsonValue | undefined): Q;
  windowFor(query: Q): LiveWindow;
}

/** What a client sees: the socket's own end of the wire. */
export interface MockSocket {
  send(frame: string): void;
  close(code?: number, reason?: string): void;
  /**
   * Called once the connection is usable.
   *
   * A real socket has this, and a client relies on it: it is where every open
   * subscription is (re)sent. A mock without it looks connected and answers
   * nothing, which is the least useful failure there is.
   */
  onopen?: () => void;
  onmessage?: (frame: string) => void;
  onclose?: (code: number, reason: string) => void;
}

export interface MockServerOptions {
  /** Whether a socket may be used at all. Absent accepts every connection. */
  authorize?: () => boolean;
  refusal?: () => string;
  /**
   * Every frame, both ways, as it goes past.
   *
   * What makes a demo teach the protocol rather than only show a list moving.
   */
  onTraffic?: (direction: 'in' | 'out', frame: Envelope<unknown>) => void;
}

/**
 * A Livewire server with no socket under it.
 *
 * The same protocol, the same diff - it imports `patchOf` and `snapshotOf` from
 * the contract package rather than reimplementing them - and the same rules
 * about sequences, silence and resubscription. What it does not have is a
 * network, a database or a clock.
 *
 * Three uses, and the third is the one that pays:
 *
 * 1. A demo that works offline, instantly, and lets a page provoke the cases a
 *    real backend will not produce on demand: a row arriving, a socket
 *    dropping, a window sliding.
 * 2. Testing a screen with no server yet.
 * 3. **Checking the specification.** It runs the same conformance scenarios as
 *    the NestJS and Go servers, so a rule that only one of the three obeys
 *    shows up as a failing test rather than as a bug six months later.
 */
export class MockServer {
  private readonly sources = new Map<string, MockSource<never>>();
  private readonly clients = new Set<Client>();

  constructor(private readonly options: MockServerOptions = {}) {}

  /** Adds a source under a topic. Registering twice replaces. */
  register<Q>(topic: string, source: MockSource<Q>): this {
    this.sources.set(topic, source as MockSource<never>);
    return this;
  }

  /**
   * Opens a connection, and answers the client's end of it.
   *
   * The returned object is what a screen talks to: `send` a frame in, receive
   * frames through `onmessage`. It is deliberately the shape of a `WebSocket`
   * so a client library can take either without knowing which.
   */
  connect(): MockSocket {
    const client = new Client(this, this.options);
    this.clients.add(client);
    client.onGone = () => this.clients.delete(client);
    // Opened on the next tick, as a real socket is: the caller has to be able
    // to attach its handlers before anything arrives, and a refusal frame sent
    // synchronously here would be sent to nobody.
    queueMicrotask(() => client.start());
    return client.socket;
  }

  /**
   * Says that something a source reads has changed.
   *
   * The whole feed by default, or one topic. Every open subscription on it
   * re-reads and publishes what moved - and publishes nothing at all if the
   * window came back the same, exactly as a real server does.
   */
  touched(topic?: string): void {
    for (const client of this.clients) {
      client.refresh(topic);
    }
  }

  find(topic: string): MockSource<never> | undefined {
    return this.sources.get(topic);
  }
}

/** One connection, and the subscriptions open on it. */
class Client {
  readonly socket: MockSocket;
  onGone?: () => void;

  private readonly open = new Map<
    string,
    { topic: string; query: unknown; sent: LiveRow[] | null; signature: string; sequence: number }
  >();
  private authorised = false;

  constructor(
    private readonly server: MockServer,
    private readonly options: MockServerOptions,
  ) {
    this.socket = {
      send: (frame: string) => this.onFrame(frame),
      close: () => this.close(),
    };
  }

  start(): void {
    if (this.options.authorize && !this.options.authorize()) {
      const reason = this.options.refusal?.() ?? 'Not authorised';
      // The frame first, then the close - SPEC §1.
      this.push({ id: 'connection', type: 'error', reason });
      this.socket.onclose?.(NOT_AUTHORISED, 'Not authorised');
      this.onGone?.();
      return;
    }
    this.authorised = true;
    this.socket.onopen?.();
  }

  private onFrame(raw: string): void {
    let envelope: Envelope<unknown>;
    try {
      envelope = JSON.parse(raw) as Envelope<unknown>;
    } catch {
      // Unreadable: ignored, and the connection stays up - SPEC §2.
      return;
    }
    if (typeof envelope !== 'object' || envelope === null || typeof envelope.data !== 'object' || envelope.data === null) {
      return;
    }
    this.options.onTraffic?.('in', envelope);

    if (!this.authorised) {
      return;
    }
    if (envelope.event === SUBSCRIBE_EVENT) {
      this.subscribe(envelope.data as SubscribeFrame);
    } else if (envelope.event === UNSUBSCRIBE_EVENT) {
      this.open.delete((envelope.data as UnsubscribeFrame).id);
    }
  }

  private subscribe(frame: SubscribeFrame): void {
    if (typeof frame.id !== 'string' || frame.id === '') {
      // No id, nothing to answer under.
      return;
    }
    const source = this.server.find(frame.topic);
    if (!source) {
      this.push({ id: frame.id, type: 'error', reason: `No topic '${frame.topic}'` });
      return;
    }

    // Subscribing under an open id replaces it, and the sequence restarts.
    const query = source.readQuery ? source.readQuery(frame.query) : frame.query;
    this.open.set(frame.id, { topic: frame.topic, query, sent: null, signature: '', sequence: 0 });
    this.publish(frame.id);
  }

  /** Re-reads every subscription on a topic, and publishes what moved. */
  refresh(topic?: string): void {
    for (const [id, subscription] of this.open) {
      if (!topic || subscription.topic === topic) {
        this.publish(id);
      }
    }
  }

  private publish(id: string): void {
    const subscription = this.open.get(id);
    const source = subscription && this.server.find(subscription.topic);
    if (!subscription || !source) {
      return;
    }
    const window = source.windowFor(subscription.query as never);

    // An unchanged window publishes nothing - SPEC §5.3. Compared with the
    // contract's own signature rather than by hand: `total` and `pivot` are
    // part of "unchanged", and a value read from the clock moves the pivot
    // without a single row being written.
    const signature = signatureOf(window);
    if (subscription.sent !== null && signature === subscription.signature) {
      return;
    }
    subscription.signature = signature;

    subscription.sequence += 1;
    const frame =
      subscription.sent === null
        ? snapshotOf(id, window, subscription.sequence)
        : patchOf(id, subscription.sent, window, subscription.sequence);
    subscription.sent = window.rows;
    this.push(frame);
  }

  private push(frame: UpdateFrame): void {
    const envelope: Envelope<UpdateFrame> = { event: UPDATE_EVENT, data: frame };
    this.options.onTraffic?.('out', envelope);
    this.socket.onmessage?.(JSON.stringify(envelope));
  }

  private close(): void {
    this.open.clear();
    this.onGone?.();
    this.socket.onclose?.(1000, '');
  }
}

export { Conversation, SCENARIOS } from './conformance.js';
export type { Scenario, Wire } from './conformance.js';

// The other direction: what a *client* must do with what it is sent.
export { CLIENT_SCENARIOS } from './client-conformance.js';
export type { ClientScenario, Consumer } from './client-conformance.js';
