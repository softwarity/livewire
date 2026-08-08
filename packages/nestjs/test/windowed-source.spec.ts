import { Observable, Subject, of } from 'rxjs';
import { toArray, take } from 'rxjs/operators';
import { PagedSource, SingleWindowSource, WindowedSource, limitOf, onChanges, text, whole } from '../src/windowed-source';
import type { JsonObject, JsonValue, LiveWindow } from '@softwarity/livewire-protocol';

interface Query {
  key: string;
}

/** A source whose reads are counted, so sharing and silence can be observed. */
class Counting extends WindowedSource<Query> {
  reads = 0;
  window: LiveWindow = { rows: [{ id: 'a', updatedAt: 'v1' }] };

  constructor(private readonly feed: Observable<unknown>) {
    super();
  }

  readQuery(raw: JsonValue | undefined): Query {
    const asked = (raw ?? {}) as JsonObject;
    return { key: text(asked['key']) ?? '' };
  }

  protected wake(): Observable<unknown> {
    return this.feed;
  }

  protected keyOf(query: Query): string {
    return query.key;
  }

  protected read(): Observable<LiveWindow> {
    this.reads += 1;
    return of(this.window);
  }
}

describe('WindowedSource', () => {
  jest.useFakeTimers();

  function sourceOf(): { source: Counting; feed: Subject<unknown> } {
    const feed = new Subject<unknown>();
    return { source: new Counting(onChanges(feed)), feed };
  }

  it('reads once for two subscriptions asking the same question', () => {
    const { source } = sourceOf();

    source.watch({ key: 'a' }).subscribe();
    source.watch({ key: 'a' }).subscribe();

    expect(source.reads).toBe(1);
  });

  it('reads twice for two different questions', () => {
    const { source } = sourceOf();

    source.watch({ key: 'a' }).subscribe();
    source.watch({ key: 'b' }).subscribe();

    expect(source.reads).toBe(2);
  });

  it('gives a late subscriber what the window already holds', () => {
    const { source } = sourceOf();
    source.watch({ key: 'a' }).subscribe();

    let seen: LiveWindow | null = null;
    source.watch({ key: 'a' }).subscribe((window) => (seen = window));

    expect(seen).toEqual(source.window);
    expect(source.reads).toBe(1);
  });

  /**
   * The leak this guards against: one entry per filter ever typed, held for the
   * life of the process.
   */
  it('forgets the question when the last subscriber leaves', () => {
    const { source } = sourceOf();
    const first = source.watch({ key: 'a' }).subscribe();
    const second = source.watch({ key: 'a' }).subscribe();

    first.unsubscribe();
    second.unsubscribe();
    source.watch({ key: 'a' }).subscribe();

    expect(source.reads).toBe(2);
  });

  it('publishes nothing when a read returns the same window', () => {
    const { source, feed } = sourceOf();
    const seen: LiveWindow[] = [];
    source.watch({ key: 'a' }).subscribe((window) => seen.push(window));

    feed.next(null);
    jest.advanceTimersByTime(400);
    feed.next(null);
    jest.advanceTimersByTime(400);

    expect(source.reads).toBe(3);
    expect(seen).toHaveLength(1);
  });

  it('publishes when the window actually moved', () => {
    const { source, feed } = sourceOf();
    const seen: LiveWindow[] = [];
    source.watch({ key: 'a' }).subscribe((window) => seen.push(window));

    source.window = { rows: [{ id: 'a', updatedAt: 'v2' }] };
    feed.next(null);
    jest.advanceTimersByTime(400);

    expect(seen).toHaveLength(2);
  });

  it('gathers a burst into one read', () => {
    const { source, feed } = sourceOf();
    source.watch({ key: 'a' }).subscribe();

    for (let i = 0; i < 50; i += 1) {
      feed.next(null);
    }
    jest.advanceTimersByTime(400);

    // One at subscription, one for the whole burst.
    expect(source.reads).toBe(2);
  });
});

describe('SingleWindowSource', () => {
  class Filters extends SingleWindowSource {
    protected wake(): Observable<unknown> {
      return of(null);
    }

    protected read(): Observable<LiveWindow> {
      return of({ rows: [{ id: 'FPL', updatedAt: 'FPL' }] });
    }
  }

  it('takes no query and shares one window', () => {
    const source = new Filters();

    expect(source.readQuery()).toBeNull();
    expect(source.watch(null)).toBe(source.watch(null));
  });

  /**
   * A static list is written `wake() { return of(null) }`, which completes at
   * once. `shareReplay({ refCount: true })` tears the sharing down on complete,
   * so every subscriber read again, alone - the one thing the sharing exists to
   * prevent, in the simplest source anyone would write.
   */
  it('still shares one read when its wake completes', () => {
    let reads = 0;
    class Static extends SingleWindowSource {
      protected wake(): Observable<unknown> {
        return of(null);
      }

      protected read(): Observable<LiveWindow> {
        reads += 1;
        return of({ rows: [] });
      }
    }
    const source = new Static();

    source.watch(null).subscribe();
    source.watch(null).subscribe();
    source.watch(null).subscribe();

    expect(reads).toBe(1);
  });
});

describe('onChanges', () => {
  jest.useFakeTimers();

  it('reads once immediately, without waiting for a change', async () => {
    const seen = await new Promise<unknown[]>((resolve) => {
      onChanges(new Subject<unknown>())
        .pipe(take(1), toArray())
        .subscribe(resolve);
    });

    expect(seen).toHaveLength(1);
  });

  it('adds a clock only when asked', () => {
    const ticks: unknown[] = [];
    onChanges(new Subject<unknown>(), 1000).subscribe((tick) => ticks.push(tick));

    jest.advanceTimersByTime(2500);

    // One at zero, then two ticks.
    expect(ticks).toHaveLength(3);
  });
});

describe('query helpers', () => {
  it('reads a non-empty trimmed string, or nothing', () => {
    expect(text('  HVN ')).toBe('HVN');
    expect(text('   ')).toBeUndefined();
    expect(text(42)).toBeUndefined();
    expect(text(undefined)).toBeUndefined();
  });

  it('reads a whole number at least zero, or the fallback', () => {
    expect(whole(3.7, 0)).toBe(3);
    expect(whole(-1, 5)).toBe(5);
    expect(whole('12', 5)).toBe(5);
    expect(whole(Number.NaN, 5)).toBe(5);
  });

  it('keeps a limit inside what the server will actually send', () => {
    expect(limitOf(50)).toBe(50);
    expect(limitOf(0)).toBe(1);
    expect(limitOf(9999)).toBe(200);
    expect(limitOf(undefined, 25)).toBe(25);
  });
});

describe('PagedSource', () => {
  interface Filters {
    search?: string;
  }

  class Paged extends PagedSource<Filters> {
    readonly pages: { filters: Filters; offset: number; limit: number }[] = [];

    protected readFilters(raw: JsonObject): Filters {
      return { search: text(raw['search']) };
    }

    protected keyOfFilters(filters: Filters): string {
      return filters.search ?? '';
    }

    protected readPage(filters: Filters, offset: number, limit: number): Observable<LiveWindow> {
      this.pages.push({ filters, offset, limit });
      return of({ rows: [], total: 0 });
    }

    protected wake(): Observable<unknown> {
      return onChanges(new Subject<unknown>());
    }
  }

  it('reads the window out of the query, so a source does not have to', () => {
    const source = new Paged();

    expect(source.readQuery({ search: ' HVN ', offset: 100, limit: 25 })).toEqual({
      search: 'HVN',
      offset: 100,
      limit: 25,
    });
  });

  it('defaults and clamps what the client sent', () => {
    const source = new Paged();

    expect(source.readQuery({})).toMatchObject({ offset: 0, limit: 50 });
    expect(source.readQuery({ offset: -5, limit: 9999 })).toMatchObject({ offset: 0, limit: 200 });
  });

  it('survives a query that is not an object at all', () => {
    const source = new Paged();

    expect(source.readQuery(undefined)).toMatchObject({ offset: 0, limit: 50 });
    expect(source.readQuery('nonsense')).toMatchObject({ offset: 0, limit: 50 });
    expect(source.readQuery([1, 2])).toMatchObject({ offset: 0, limit: 50 });
  });

  /**
   * The window is part of the question: two offsets are two questions, and
   * sharing a read between them would show one screen the other's page.
   */
  it('makes two slices of one filter two different questions', () => {
    const source = new Paged();

    source.watch(source.readQuery({ search: 'a', offset: 0 })).subscribe();
    source.watch(source.readQuery({ search: 'a', offset: 50 })).subscribe();
    source.watch(source.readQuery({ search: 'a', offset: 0 })).subscribe();

    expect(source.pages.map((one) => one.offset)).toEqual([0, 50]);
  });

  it('hands the page its filters and its bounds', () => {
    const source = new Paged();

    source.watch(source.readQuery({ search: 'HVN', offset: 20, limit: 10 })).subscribe();

    expect(source.pages[0]).toEqual({ filters: { search: 'HVN', offset: 20, limit: 10 }, offset: 20, limit: 10 });
  });
});
