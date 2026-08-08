import { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { LiveList } from './live-list';
import { LivewireClient } from './livewire.client';
import type { JsonValue, LiveRow, UpdateFrame } from '@softwarity/livewire-protocol';

/**
 * One screen's live window on one topic.
 *
 * The bookkeeping every feature service would otherwise repeat: the counter,
 * the id it last opened, and the resync that has to name it. Small, and worth
 * having once - the id rule below is the kind of thing that is right in one
 * copy and wrong in the next.
 */
export class LiveTopic<Row extends LiveRow> {
  /** Counts subscriptions, so no two ever share an id. */
  private opened = 0;

  /** The id of the current window, for `resync`. */
  private watching: string | null = null;

  constructor(
    private readonly client: LivewireClient,
    private readonly topic: string,
  ) {}

  /**
   * The rows the screen is showing, and again whenever they change.
   *
   * One subscription for the screen, not one per page: the window is part of
   * the question, which is what makes a paged list pushable at all. The server
   * does not send an insertion for the client to place - it sends what rows
   * `[offset, offset+limit)` now hold, so three rows arriving at the top shift
   * no index. The window simply holds something else than it did.
   */
  window(query: object, offset: number, limit: number): Observable<UpdateFrame<Row>> {
    // Unique per subscription. Reusing an id means a patch still in flight from
    // the window before lands on the new one, whose sequence starts over - it
    // reads as a gap, resyncs, and nothing publishes in the meantime.
    this.watching = `${this.topic}:${(this.opened += 1)}`;
    return this.client.watch<Row>(this.watching, this.topic, { ...query, offset, limit } as JsonValue);
  }

  /**
   * The same, for a list the server sends whole.
   *
   * A short list is bounded by its filters rather than by a scroll position, so
   * there is no offset to send. Everything around it is unchanged: one live
   * subscription at a time, a fresh id each time, and a resync that names it.
   */
  open(query: JsonValue | null): Observable<UpdateFrame<Row>> {
    this.watching = `${this.topic}:${(this.opened += 1)}`;
    return this.client.watch<Row>(this.watching, this.topic, query);
  }

  /** Asks the server for the window again - answered with a snapshot. */
  resync(): void {
    if (this.watching) {
      this.client.resync(this.watching);
    }
  }
}

/**
 * A short list, kept in step: the values that actually exist.
 *
 * Not a constant in the screen - offering a filter for something an
 * installation has never seen answers nothing. These lists are small and
 * unpaged, so there is one subscription per topic and its id is the topic.
 */
export function liveLabels(
  client: LivewireClient,
  topic: string,
  query: JsonValue | null = null,
): Observable<{ id: string; label: string }[]> {
  const list = new LiveList<LiveRow & { label?: string }>();
  return client.watch<LiveRow & { label?: string }>(topic, topic, query).pipe(
    filter((update) => list.apply(update)),
    // A topic that sends no label is a list of bare values - the value is its
    // own label.
    map(() => list.rows().map((row) => ({ id: row.id, label: row.label ?? row.id }))),
  );
}
