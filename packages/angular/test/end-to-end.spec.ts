import { ChangeDetectorRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockServer } from '@softwarity/livewire-mock';
import { LiveList } from '../src/lib/live-list';
import { LiveTopic, liveLabels } from '../src/lib/live-topic';
import { LiveWindowDataSource } from '../src/lib/live-window.datasource';
import { LivewireClient } from '../src/lib/livewire.client';
import type { LivewireSocket } from '../src/lib/livewire.client';
import { provideLivewire } from '../src/lib/provide-livewire';
import type { LiveRow, LiveWindow } from '@softwarity/livewire-protocol';

/**
 * The client against the in-memory server: the whole loop, with nothing faked
 * in between.
 *
 * The mock speaks the protocol and passes the conformance suite, so what this
 * checks is the client's half - that it opens one socket, applies snapshots and
 * patches, tells a screen when to resync, and closes what it opened.
 */
describe('the client, end to end', () => {
  let server: MockServer;
  let rows: LiveRow[];

  function clientOf(): LivewireClient {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideLivewire({ path: '', connect: () => server.connect() }),
        // The data source repaints a view; here there is none, so the ref is a
        // stub. `repaint.spec.ts` is where the repainting itself is checked.
        { provide: ChangeDetectorRef, useValue: { markForCheck: () => undefined } },
      ],
    });
    return TestBed.inject(LivewireClient);
  }

  /** The mock opens on the next tick, as a socket does. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    rows = [
      { id: 'a', updatedAt: 'v1' },
      { id: 'b', updatedAt: 'v1' },
    ];
    server = new MockServer();
    server.register('rows', { windowFor: (): LiveWindow => ({ rows, total: rows.length }) });
    server.register('kinds', {
      windowFor: (): LiveWindow => ({ rows: [{ id: 'FPL', updatedAt: 'FPL', label: 'Flight plan' } as LiveRow] }),
    });
  });

  it('reports the socket as up once it opens', async () => {
    const client = clientOf();
    client.watch('a', 'rows', null).subscribe();
    await settle();

    expect(client.live()).toBe(true);
  });

  it('answers a snapshot, then a patch when the data moves', async () => {
    const client = clientOf();
    const seen: string[] = [];
    client.watch('a', 'rows', null).subscribe((frame) => seen.push(frame.type));
    await settle();

    rows = [{ id: 'c', updatedAt: 'v1' }, ...rows];
    server.touched();

    expect(seen).toEqual(['snapshot', 'patch']);
  });

  it('applies both into a list a screen can read', async () => {
    const client = clientOf();
    const list = new LiveList<LiveRow>();
    client.watch<LiveRow>('a', 'rows', null).subscribe((frame) => list.apply(frame));
    await settle();

    rows = [{ id: 'c', updatedAt: 'v1' }, ...rows];
    server.touched();

    expect(list.rows().map((row) => row.id)).toEqual(['c', 'a', 'b']);
    expect(list.total()).toBe(3);
  });

  it('says nothing when the window did not move', async () => {
    const client = clientOf();
    const seen: string[] = [];
    client.watch('a', 'rows', null).subscribe((frame) => seen.push(frame.type));
    await settle();

    server.touched();
    server.touched();

    expect(seen).toEqual(['snapshot']);
  });

  it('opens one socket for two subscriptions', async () => {
    let connections = 0;
    const counting = new MockServer();
    counting.register('rows', { windowFor: (): LiveWindow => ({ rows, total: rows.length }) });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideLivewire({
          path: '',
          connect: () => {
            connections += 1;
            return counting.connect();
          },
        }),
      ],
    });
    const client = TestBed.inject(LivewireClient);

    client.watch('a', 'rows', null).subscribe();
    client.watch('b', 'rows', null).subscribe();
    await settle();

    expect(connections).toBe(1);
  });

  it('stops delivering once a screen unsubscribes', async () => {
    const client = clientOf();
    const seen: string[] = [];
    const watching = client.watch('a', 'rows', null).subscribe((frame) => seen.push(frame.type));
    await settle();

    watching.unsubscribe();
    rows = [{ id: 'c', updatedAt: 'v1' }, ...rows];
    server.touched();

    expect(seen).toEqual(['snapshot']);
  });

  it('feeds a virtual-scroll source from end to end', async () => {
    const client = clientOf();
    const topic = new LiveTopic<LiveRow>(client, 'rows');
    // Built in an injection context, as it is in a component field: the data
    // source takes the view it repaints from there.
    const source = TestBed.runInInjectionContext(() => new LiveWindowDataSource<LiveRow>());
    source.reset((offset, limit) => topic.window({}, offset, limit));
    await settle();

    expect(source.length).toBe(2);
    expect(source.at(0)).toEqual({ id: 'a', updatedAt: 'v1' });

    rows = [{ id: 'c', updatedAt: 'v1' }, ...rows];
    server.touched();

    expect(source.at(0)).toEqual({ id: 'c', updatedAt: 'v1' });
    expect(source.fresh('c')).toBe(true);
    expect(source.fresh('a')).toBe(false);
  });

  it('reads a short list as labels', async () => {
    const client = clientOf();
    const seen: { id: string; label: string }[][] = [];
    liveLabels(client, 'kinds').subscribe((labels) => seen.push(labels));
    await settle();

    expect(seen.at(-1)).toEqual([{ id: 'FPL', label: 'Flight plan' }]);
  });

  it('asks again for every open window when told to retry', async () => {
    const client = clientOf();
    const seen: string[] = [];
    client.watch('a', 'rows', null).subscribe((frame) => seen.push(frame.type));
    await settle();

    client.retry();

    // A resubscribe answers with a snapshot, whatever the window holds.
    expect(seen).toEqual(['snapshot', 'snapshot']);
  });
});

/**
 * What a cold load does to the first subscriptions.
 *
 * A `WebSocket` that is still connecting throws on `send` rather than ignoring
 * it. A screen subscribing before the handshake completes - which on a page
 * refresh is every list it asks for - would take that exception straight out of
 * `watch`, and the subscription would die there and never come back.
 *
 * The in-memory server cannot show this on its own: its socket accepts frames
 * at any time. So the socket here behaves like the real one.
 */
describe('subscribing before the socket is open', () => {
  it('waits for the handshake instead of dying on it', async () => {
    const rows: LiveRow[] = [{ id: 'a', updatedAt: 'v1' }];
    const server = new MockServer();
    server.register('labels', { windowFor: () => ({ rows, total: rows.length }) });

    TestBed.configureTestingModule({
      providers: [
        provideLivewire({
          path: '',
          connect: () => {
            const socket = server.connect();
            let open = false;
            const onopen = () => {
              open = true;
            };
            return {
              // A real socket refuses to send until it is open.
              send: (frame: string) => {
                if (!open) {
                  throw new Error('InvalidStateError: still CONNECTING');
                }
                socket.send(frame);
              },
              close: () => socket.close(),
              set onopen(listener: (() => void) | null) {
                socket.onopen = () => {
                  onopen();
                  listener?.();
                };
              },
              set onmessage(listener: ((frame: string) => void) | null) {
                socket.onmessage = (frame) => listener?.(frame);
              },
              set onclose(listener: ((code: number, reason: string) => void) | null) {
                socket.onclose = (code, reason) => listener?.(code, reason);
              },
            } as LivewireSocket;
          },
        }),
      ],
    });

    const seen: string[] = [];
    const failed: unknown[] = [];
    liveLabels(TestBed.inject(LivewireClient), 'labels').subscribe({
      next: (labels) => seen.push(...labels.map((label) => label.id)),
      error: (error: unknown) => failed.push(error),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(failed).toEqual([]);
    expect(seen).toEqual(['a']);
  });
});
