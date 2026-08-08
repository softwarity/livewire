import { Observable, Subject } from 'rxjs';
import type { IncomingMessage } from 'http';
import { LivewireGateway } from '../src/livewire.gateway';
import { LivewireNotifier } from '../src/livewire.notifier';
import { LivewireRegistry } from '../src/livewire.registry';
import type { LiveSource } from '../src/live-source';
import type { LiveWindow, UpdateFrame } from '@softwarity/livewire-protocol';

/** A socket that remembers what it was told, and whether it was closed. */
class FakeSocket {
  readonly sent: { event: string; data: UpdateFrame }[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }
}

/** A source driven by hand, so a test decides when the window moves. */
class Manual implements LiveSource<{ q: string }> {
  readonly windows = new Subject<LiveWindow>();
  lastQuery: { q: string } | null = null;
  closed = 0;

  readQuery(raw: unknown): { q: string } {
    return { q: String((raw as { q?: unknown })?.q ?? '') };
  }

  watch(query: { q: string }): Observable<LiveWindow> {
    this.lastQuery = query;
    return new Observable<LiveWindow>((subscriber) => {
      const sub = this.windows.subscribe((window) => subscriber.next(window));
      return () => {
        this.closed += 1;
        sub.unsubscribe();
      };
    });
  }
}

const request = {} as IncomingMessage;
const row = (id: string, version = 'v1') => ({ id, updatedAt: version });

describe('LivewireGateway', () => {
  let registry: LivewireRegistry;
  let source: Manual;

  function gatewayOf(options: Partial<{ authorize: () => boolean; refusal: () => string }> = {}): LivewireGateway {
    return new LivewireGateway(registry, { path: '/ws', ...options }, new LivewireNotifier());
  }

  /** Subscribes the way Nest does: it consumes the returned stream itself. */
  function subscribe(gateway: LivewireGateway, socket: FakeSocket, body: unknown) {
    const frames: UpdateFrame[] = [];
    const sub = gateway
      .subscribe(socket as never, body as never)
      .subscribe((response) => frames.push(response.data as UpdateFrame));
    return { frames, sub };
  }

  beforeEach(() => {
    registry = new LivewireRegistry({ getProviders: () => [] } as never, { getAllMethodNames: () => [] } as never);
    source = new Manual();
    registry.register('rows', source);
  });

  describe('the connection', () => {
    it('accepts every socket when nothing says otherwise', () => {
      const socket = new FakeSocket();
      gatewayOf().handleConnection(socket as never, request);

      expect(socket.closedWith).toBeNull();
    });

    /**
     * SPEC §1: the frame first, then the close. A refusal arriving as a bare
     * disconnection cannot be told from a network fault, and a proxy that drops
     * the close code leaves the screen with nothing to explain itself.
     */
    it('says why on the socket, and only then closes it', () => {
      const socket = new FakeSocket();
      gatewayOf({ authorize: () => false, refusal: () => 'no role for you' }).handleConnection(socket as never, request);

      expect(socket.sent).toEqual([
        { event: 'update', data: { id: 'connection', type: 'error', reason: 'no role for you' } },
      ]);
      expect(socket.closedWith).toEqual({ code: 1008, reason: 'Not authorised' });
    });

    it('refuses a subscription on a socket that was never accepted', () => {
      const gateway = gatewayOf({ authorize: () => false });
      const socket = new FakeSocket();
      gateway.handleConnection(socket as never, request);

      const { frames } = subscribe(gateway, socket, { id: 'a', topic: 'rows' });

      expect(frames).toEqual([]);
    });
  });

  describe('subscribing', () => {
    it('answers a snapshot first, then patches, numbered from one', () => {
      const gateway = gatewayOf();
      const socket = new FakeSocket();
      gateway.handleConnection(socket as never, request);
      const { frames } = subscribe(gateway, socket, { id: 'a', topic: 'rows', query: { q: 'x' } });

      source.windows.next({ rows: [row('r1')], total: 1 });
      source.windows.next({ rows: [row('r1'), row('r2')], total: 2 });

      expect(frames.map((one) => one.type)).toEqual(['snapshot', 'patch']);
      expect(frames.map((one) => (one as { sequence: number }).sequence)).toEqual([1, 2]);
      expect((frames[1] as { upserted: unknown[] }).upserted).toEqual([row('r2')]);
    });

    it('hands the source what the client asked for', () => {
      const gateway = gatewayOf();
      const socket = new FakeSocket();
      gateway.handleConnection(socket as never, request);
      subscribe(gateway, socket, { id: 'a', topic: 'rows', query: { q: 'hello' } });

      expect(source.lastQuery).toEqual({ q: 'hello' });
    });

    it('answers an error for a topic nothing serves, and opens nothing', () => {
      const gateway = gatewayOf();
      const socket = new FakeSocket();
      gateway.handleConnection(socket as never, request);
      const { frames } = subscribe(gateway, socket, { id: 'a', topic: 'nope' });

      expect(frames).toEqual([{ id: 'a', type: 'error', reason: "No topic 'nope'" }]);
    });

    it('ignores a subscribe with no id - there is nothing to answer under', () => {
      const gateway = gatewayOf();
      const socket = new FakeSocket();
      gateway.handleConnection(socket as never, request);

      expect(subscribe(gateway, socket, { topic: 'rows' }).frames).toEqual([]);
      expect(subscribe(gateway, socket, { id: '', topic: 'rows' }).frames).toEqual([]);
    });
  });

  describe('moving a subscription', () => {
    /**
     * SPEC §3.2. This is what a screen does when it scrolls or changes a
     * filter, and getting it wrong leaves two windows feeding one list and
     * interleaving their frames into it.
     */
    it('closes the previous window and restarts the sequence at one', () => {
      const gateway = gatewayOf();
      const socket = new FakeSocket();
      gateway.handleConnection(socket as never, request);

      const first = subscribe(gateway, socket, { id: 'a', topic: 'rows', query: { q: '1' } });
      source.windows.next({ rows: [row('r1')] });
      const second = subscribe(gateway, socket, { id: 'a', topic: 'rows', query: { q: '2' } });
      source.windows.next({ rows: [row('r9')] });

      expect(source.closed).toBe(1);
      expect(first.frames).toHaveLength(1);
      expect(second.frames).toEqual([{ id: 'a', type: 'snapshot', rows: [row('r9')], total: undefined, pivot: undefined, sequence: 1 }]);
    });

    it('leaves the other subscriptions on the socket alone', () => {
      const gateway = gatewayOf();
      const socket = new FakeSocket();
      gateway.handleConnection(socket as never, request);
      const other = subscribe(gateway, socket, { id: 'b', topic: 'rows' });

      subscribe(gateway, socket, { id: 'a', topic: 'rows' });
      subscribe(gateway, socket, { id: 'a', topic: 'rows' });
      source.windows.next({ rows: [row('r1')] });

      expect(other.frames).toHaveLength(1);
    });
  });

  describe('unsubscribing', () => {
    it('stops the frames, and closes the source', () => {
      const gateway = gatewayOf();
      const socket = new FakeSocket();
      gateway.handleConnection(socket as never, request);
      const { frames } = subscribe(gateway, socket, { id: 'a', topic: 'rows' });

      source.windows.next({ rows: [row('r1')] });
      gateway.unsubscribe(socket as never, { id: 'a' });
      source.windows.next({ rows: [row('r2')] });

      expect(frames).toHaveLength(1);
      expect(source.closed).toBe(1);
    });

    it('ignores an id it never opened', () => {
      const gateway = gatewayOf();
      const socket = new FakeSocket();
      gateway.handleConnection(socket as never, request);

      expect(() => gateway.unsubscribe(socket as never, { id: 'never' })).not.toThrow();
    });

    it('ignores an unsubscribe from a socket it does not know', () => {
      expect(() => gatewayOf().unsubscribe(new FakeSocket() as never, { id: 'a' })).not.toThrow();
    });
  });

  describe('disconnecting', () => {
    it('closes every subscription the socket held', () => {
      const gateway = gatewayOf();
      const socket = new FakeSocket();
      gateway.handleConnection(socket as never, request);
      const first = subscribe(gateway, socket, { id: 'a', topic: 'rows' });
      const second = subscribe(gateway, socket, { id: 'b', topic: 'rows' });

      gateway.handleDisconnect(socket as never);
      source.windows.next({ rows: [row('r1')] });

      expect(first.frames).toEqual([]);
      expect(second.frames).toEqual([]);
      expect(source.closed).toBe(2);
    });

    it('leaves the subscriptions of another socket running', () => {
      const gateway = gatewayOf();
      const leaving = new FakeSocket();
      const staying = new FakeSocket();
      gateway.handleConnection(leaving as never, request);
      gateway.handleConnection(staying as never, request);
      subscribe(gateway, leaving, { id: 'a', topic: 'rows' });
      const kept = subscribe(gateway, staying, { id: 'a', topic: 'rows' });

      gateway.handleDisconnect(leaving as never);
      source.windows.next({ rows: [row('r1')] });

      expect(kept.frames).toHaveLength(1);
    });
  });

  describe('the diff is per subscription', () => {
    /**
     * A client that arrives mid-stream gets a snapshot, and its patches are
     * computed against the rows it holds - not against a state the server
     * assumed everybody shared. Diffing once per window and broadcasting the
     * same patch is wrong for exactly this client.
     */
    it('gives a late subscriber a snapshot, then patches against what it has', () => {
      const gateway = gatewayOf();
      const socket = new FakeSocket();
      gateway.handleConnection(socket as never, request);

      const early = subscribe(gateway, socket, { id: 'early', topic: 'rows' });
      source.windows.next({ rows: [row('r1')] });

      const late = subscribe(gateway, socket, { id: 'late', topic: 'rows' });
      source.windows.next({ rows: [row('r1'), row('r2')] });

      expect(early.frames.map((one) => one.type)).toEqual(['snapshot', 'patch']);
      expect(late.frames.map((one) => one.type)).toEqual(['snapshot']);
      expect((late.frames[0] as { rows: unknown[] }).rows).toEqual([row('r1'), row('r2')]);
    });
  });
});
