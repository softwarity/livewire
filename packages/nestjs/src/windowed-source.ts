import { Observable, ReplaySubject, merge, of, share, timer } from 'rxjs';
import { auditTime, distinctUntilChanged, switchMap } from 'rxjs/operators';
import type { JsonObject, JsonValue, LiveWindow } from '@softwarity/livewire-protocol';
import type { LiveSource } from './live-source';
import { signatureOf } from './patch';

/**
 * How long a burst of changes gathers before a window is read again.
 *
 * A feed that fires several times a second would otherwise spend itself
 * re-running the same query. Long enough to turn a salvo into one read, short
 * enough that nobody notices the wait.
 */
export const COALESCE_MS = 300;

/**
 * The widest window a client may ask for.
 *
 * Wider than a screen, narrower than a scan. The real ceiling is the wire, and
 * it is not this: some proxies silently drop frames over ~64 kB, so what fits
 * depends on the size of a row and is the source's business. This is the outer
 * bound past which no question is a window at all.
 */
export const MAX_LIMIT = 200;

/**
 * Every live list, minus what makes each one different.
 *
 * A source says what it reads and what wakes it; the sharing, the coalescing,
 * the silence on an unchanged read and the cleanup are here, once.
 *
 * Nothing in this class knows what a row means, and it must stay that way: the
 * point of the socket is that a screen and a source agree on the shape of a
 * window and on nothing else.
 */
export abstract class WindowedSource<Q> implements LiveSource<Q> {
  /** One read per distinct question, however many screens are watching it. */
  private readonly windows = new Map<string, Observable<LiveWindow>>();

  /** Whatever the client sent, turned into a question this source will act on. */
  abstract readQuery(raw: JsonValue | undefined): Q;

  /**
   * What makes this source read again - see `onChanges`.
   *
   * Only the fact of an emission is read, never its value, so anything a source
   * already has can be handed over as it is.
   */
  protected abstract wake(): Observable<unknown>;

  /** Two questions with the same key share one read. */
  protected abstract keyOf(query: Q): string;

  /** The window as it stands. Always whole, never a delta. */
  protected abstract read(query: Q): Observable<LiveWindow>;

  watch(query: Q): Observable<LiveWindow> {
    const key = this.keyOf(query);
    const existing = this.windows.get(key);
    if (existing) {
      return existing;
    }

    const shared = this.wake().pipe(
      switchMap(() => this.read(query)),
      // A tick on a quiet feed reads the same rows back, and so does a burst
      // that touched nothing this window holds. Comparing here rather than at
      // each client keeps a silent window silent all the way out.
      distinctUntilChanged((before, after) => signatureOf(before) === signatureOf(after)),
      // `resetOnComplete: false`, not `shareReplay({ refCount: true })`: that
      // one tears the sharing down when the source completes, and a source
      // whose `wake` is a plain `of(null)` - which is what a static list looks
      // like - completes at once. Every subscriber then read again, alone.
      share({
        connector: () => new ReplaySubject<LiveWindow>(1),
        resetOnComplete: false,
        resetOnRefCountZero: true,
      }),
    );

    // Counted by hand rather than left to `finalize`, which also fires when the
    // source completes: the key would be dropped while the window is still
    // perfectly good, and the next watcher would open a second one beside it.
    //
    // A window that has completed keeps its key for good. It has nothing left
    // to say and its last value is still true, so re-reading would cost a query
    // to learn the same thing - and only a source that never changes completes
    // at all, so there is no leak worth the name behind this.
    let watchers = 0;
    let done = false;
    const tracked = new Observable<LiveWindow>((subscriber) => {
      watchers += 1;
      const inner = shared.subscribe({
        next: (window) => subscriber.next(window),
        error: (error: unknown) => subscriber.error(error),
        complete: () => {
          done = true;
          subscriber.complete();
        },
      });
      return () => {
        inner.unsubscribe();
        watchers -= 1;
        if (watchers === 0 && !done) {
          this.windows.delete(key);
        }
      };
    });

    this.windows.set(key, tracked);
    return tracked;
  }
}

/**
 * A source with one window and no question to ask: a filter list, a setting.
 *
 * It still follows the writes - what changes it is a write, and a write is
 * announced. It simply has nothing to key on, so `readQuery` and `keyOf` are
 * answered here and an implementation writes `wake` and `read`, nothing else.
 */
export abstract class SingleWindowSource extends WindowedSource<null> {
  readQuery(): null {
    return null;
  }

  protected keyOf(): string {
    return '';
  }
}

/** A question, plus the slice of its answer a screen is showing. */
export type Paged<Filters> = Filters & { offset: number; limit: number };

/**
 * A source whose window is a page: the long lists.
 *
 * The window is part of the question - that is what makes a paged list pushable
 * at all - and reading `offset`/`limit`, folding them into the key and passing
 * them to the read is the same code in every such source. It is written here so
 * an implementation is left with what is actually its own: which filters it
 * takes, what makes two of them the same, and how to read a page.
 *
 * ```ts
 * @LiveTopic('messages')
 * export class MessagesSource extends PagedSource<MessageFilters> {
 *   protected readFilters(raw: JsonObject): MessageFilters {
 *     return { search: text(raw['search']) };
 *   }
 *   protected keyOfFilters(f: MessageFilters): string {
 *     return f.search ?? '';
 *   }
 *   protected readPage(f: MessageFilters, offset: number, limit: number) {
 *     return this.messages.window(f, offset, limit);
 *   }
 *   protected wake() {
 *     return onChanges(this.events.changes);
 *   }
 * }
 * ```
 */
export abstract class PagedSource<Filters> extends WindowedSource<Paged<Filters>> {
  /** The filters this source takes, read from what the client sent. */
  protected abstract readFilters(raw: JsonObject): Filters;

  /** What makes two sets of filters the same question. */
  protected abstract keyOfFilters(filters: Filters): string;

  /** One page of the answer. `total` says what it is a page of. */
  protected abstract readPage(filters: Filters, offset: number, limit: number): Observable<LiveWindow>;

  /** How many rows a page holds when the client does not say. */
  protected readonly pageSize: number = 50;

  readQuery(raw: JsonValue | undefined): Paged<Filters> {
    const asked: JsonObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
    return {
      ...this.readFilters(asked),
      offset: whole(asked['offset'], 0),
      limit: limitOf(asked['limit'], this.pageSize),
    };
  }

  protected keyOf(query: Paged<Filters>): string {
    return `${this.keyOfFilters(query)}|${query.offset}|${query.limit}`;
  }

  protected read(query: Paged<Filters>): Observable<LiveWindow> {
    return this.readPage(query, query.offset, query.limit);
  }
}

/**
 * Wakes on the feed: once at subscription, then on each gathered burst.
 *
 * `tickMs` adds a clock beside it, and only a window that moves without
 * anything arriving needs one - one bounded by hours either side of now, or by
 * a calendar day. Everything else is driven by the writes alone: polling a
 * table to learn what the service that writes it already knows is a query per
 * tick spent on nothing, times every open screen.
 *
 * `coalesceMs` is how long a burst gathers. Longer for a list that changes once
 * a day than for a window a reader is watching, since the only cost of waiting
 * is when the change shows.
 */
export function onChanges(changes: Observable<unknown>, tickMs = 0, coalesceMs = COALESCE_MS): Observable<unknown> {
  return merge(tickMs > 0 ? timer(0, tickMs) : of(null), changes.pipe(auditTime(coalesceMs)));
}

/** A non-empty string, trimmed, or nothing at all. */
export function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** A whole number, at least zero, or the fallback. */
export function whole(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Whatever was asked for, kept to a window this service will actually send. */
export function limitOf(value: JsonValue | undefined, fallback = 50): number {
  return Math.min(MAX_LIMIT, Math.max(1, whole(value, fallback)));
}
