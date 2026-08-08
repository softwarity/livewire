import { TestBed } from '@angular/core/testing';
import { MockServer } from '@softwarity/livewire-mock';
import { LiveList } from '../src/lib/live-list';
import { LiveTopic, liveLabels } from '../src/lib/live-topic';
import { LiveWindowDataSource } from '../src/lib/live-window.datasource';
import { LivewireClient } from '../src/lib/livewire.client';
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
      providers: [provideLivewire({ path: '', connect: () => server.connect() })],
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
    const source = new LiveWindowDataSource<LiveRow>();
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
