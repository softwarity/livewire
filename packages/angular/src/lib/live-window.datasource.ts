import { DataSource } from '@angular/cdk/collections';
import { signal } from '@angular/core';
import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import { LiveList } from './live-list';
import type { ChangeDetectorRef } from '@angular/core';
import type { CollectionViewer, ListRange } from '@angular/cdk/collections';
import type { LiveRow, UpdateFrame } from '@softwarity/livewire-protocol';

/**
 * How many rows a window holds when the caller does not say.
 *
 * Fixed per screen, never derived from the viewport: a window sized from the
 * rendered range would change with it - 58 rows here, 59 there - and every
 * change is a new question, whose answer republishes, which makes the viewport
 * emit again. That loop freezes the renderer outright. Only the offset moves.
 *
 * The number is a transport budget, not a display choice. Some proxies silently
 * drop a WebSocket frame past ~64 kB and close the connection rather than the
 * frame, leaving the screen empty with no error anywhere. The rule is
 * `rows x bytes-per-row < the ceiling you tested`, and the bytes differ per
 * screen. Measure before raising it: the failure gives no clue at all.
 */
const DEFAULT_WINDOW = 100;

/**
 * How far the offset is rounded.
 *
 * Without it every scrolled pixel is a new question. Rounding means the
 * subscription only moves when the view has genuinely left what it was reading.
 */
const BLOCK = 50;

/**
 * How close the view may come to an edge before the window is moved.
 *
 * The hysteresis is what keeps this from running away: every publication makes
 * the list longer, the viewport recalculates and emits a range, and recentring
 * on each of those re-subscribes - which republishes, which emits again.
 */
const MARGIN = 10;

/**
 * How long a row that just changed stays marked.
 *
 * The `.fresh` styling on the consuming screen should run for exactly this
 * long. Shorter here cuts the animation off mid-way; longer leaves the row
 * plain while it is still marked.
 */
const FRESH_MS = 1000;

/**
 * One live window of a long list, as a CDK data source.
 *
 * The screen watches one thing: the rows around what it is showing. Scroll and
 * the window moves; something changes and the server pushes what that window
 * now holds. There is no page cache and no second question in flight - the
 * window *is* the question, which is what lets a paged list be pushed at all.
 *
 * The array handed to the viewport is the full length the server reports, with
 * a hole wherever the window does not reach. That is what makes the scrollbar
 * tell the truth from the first frame: its height is the whole list, not the
 * part being watched.
 */
export class LiveWindowDataSource<Row extends LiveRow> extends DataSource<Row | undefined> {
  private readonly published = new BehaviorSubject<(Row | undefined)[]>([]);
  private readonly viewing = new Subscription();
  private readonly stamp = signal(0);

  /**
   * Bumped on every publication, and meant to be read in the template.
   *
   * Zoneless applications schedule nothing when a row arrives from a socket
   * callback: the table is told its data changed but no pass is ever run, and
   * the screen holds stale rows until something unrelated wakes Angular up.
   *
   * Two ways to say it properly, and this is the one that needs nothing from
   * the caller: a signal the view reads. Hand a `ChangeDetectorRef` to the
   * constructor instead and the repaint is asked for here, leaving the template
   * to say only what it shows. (`ApplicationRef.tick()` is the third way and the
   * wrong one - it throws when it lands inside a cycle already in progress.)
   */
  readonly revision = this.stamp.asReadonly();

  private list = new LiveList<Row>();
  private watching: Subscription | null = null;

  /** The rows a patch touched a moment ago - see `fresh`. */
  private readonly recent = new Set<string>();

  /** Where the current subscription starts. Its length is always `window`. */
  private offset = 0;

  private open: ((offset: number, limit: number) => Observable<UpdateFrame<Row>>) | null = null;
  private range = { start: 0, end: 0 };

  constructor(
    private readonly onTotal: (total: number) => void = () => undefined,
    /** Told when a patch cannot be applied, so the caller can ask again. */
    private readonly onDrift: () => void = () => undefined,
    /** Rows per window - see `DEFAULT_WINDOW` for how to choose one. */
    private readonly window: number = DEFAULT_WINDOW,
    /**
     * The view to repaint when something arrives. Optional, and the difference
     * it makes is on the screen's side, not here.
     *
     * `markForCheck()` marks the view dirty *and* notifies the zoneless
     * scheduler, so a frame landing in a socket callback gets a pass run for it.
     * Given one, a template needs no `revision()`; given none, it does.
     *
     * ```ts
     * readonly source = new LiveWindowDataSource<Row>(
     *   (total) => this.total.set(total),
     *   () => this.topic.resync(),
     *   100,
     *   inject(ChangeDetectorRef),
     * );
     * ```
     */
    private readonly repaint?: ChangeDetectorRef,
  ) {
    super();
  }

  connect(viewer: CollectionViewer): Observable<(Row | undefined)[]> {
    // Kept because a data source is asked for it, but not relied on: inside a
    // `mat-table` the viewer is the table, whose `viewChange` stays silent
    // while the CDK viewport does the scrolling. `track` is what actually
    // reports where the eye is.
    this.viewing.add(viewer.viewChange.subscribe((range) => this.moveTo(range)));
    return this.published;
  }

  /**
   * Follows a viewport's rendered range.
   *
   * The screen hands this over explicitly because the `CollectionViewer` a
   * table passes to `connect` does not carry it. Without this the window stays
   * where it started and everything below the first screen is a placeholder
   * that never fills.
   */
  track(ranges: Observable<ListRange>): void {
    this.viewing.add(ranges.subscribe((range) => this.moveTo(range)));
  }

  disconnect(): void {
    this.viewing.unsubscribe();
    this.watching?.unsubscribe();
  }

  /** How long the list is, as the server last reported it. */
  get length(): number {
    return this.list.total();
  }

  /**
   * The index the server pointed at, in the whole list rather than in the page.
   *
   * Whatever it means is the screen's business. It survives the window moving,
   * which is the point: a boundary the reader has scrolled away from is still
   * where it was.
   */
  get pivot(): number | null {
    return this.list.pivot();
  }

  /** Every republication, for a caller waiting on one row rather than on the viewport. */
  get changes(): Observable<(Row | undefined)[]> {
    return this.published.asObservable();
  }

  /** The row at that index, when the window reaches it. */
  at(index: number): Row | undefined {
    return this.published.value[index];
  }

  /**
   * Whether this row arrived, or changed, a moment ago.
   *
   * Only patches mark anything: a snapshot is the answer to "what does this
   * window hold", which is what arriving on the screen and what scrolling both
   * ask, and lighting up a whole page every time the window moves says nothing.
   *
   * A patch's `upserted` is exactly the rows whose version changed, so a row
   * that merely shifted because three arrived above it is not marked. The one
   * approximation: for a window part-way down the list, a row pushed into it
   * from just outside is new to this client without being new to the list.
   */
  fresh(id: string | undefined): boolean {
    return id !== undefined && this.recent.has(id);
  }

  /**
   * Starts again on a new question.
   *
   * A different question has a different answer, and a row kept from the
   * previous one would be an answer to neither.
   */
  reset(open: (offset: number, limit: number) => Observable<UpdateFrame<Row>>): void {
    this.open = open;
    this.range = { start: 0, end: BLOCK };
    this.offset = -1;
    this.list = new LiveList<Row>();
    this.recent.clear();
    this.published.next([]);
    // What is on the screen has just become the answer to a question nobody is
    // asking any more, and the snapshot lands a moment later. Emptying it
    // without saying so leaves the previous answer on display in between.
    //
    // `markForCheck` and not `touched`: a screen calls this from an `effect`,
    // and Angular 18 - which this package still supports - refuses a signal
    // write from inside one.
    this.repaint?.markForCheck();
    this.follow();
  }

  /**
   * Makes sure the window covers one row, wherever the viewport currently is.
   *
   * Stepping through a detail panel walks past the edge of what is loaded, and
   * the scroll that follows only reports where it lands - too late for the row
   * the panel is already opening on.
   */
  ensure(index: number): void {
    if (index >= this.offset && index < this.offset + this.window) {
      return;
    }
    // The offset is computed here rather than through `range`: that field is
    // where the viewport is, and writing a made-up position into it means the
    // next real range disagrees, moves the window back, and the two take turns
    // until the renderer gives up.
    //
    // Clamped the way `follow` clamps, and for the same reason: rounding to a
    // block can land beside the very row that was asked for.
    const centred = Math.round((index - this.window / 2) / BLOCK) * BLOCK;
    const wanted = Math.max(0, Math.min(index, Math.max(centred, index - this.window + 1)));
    if (wanted === this.offset) {
      return;
    }
    this.offset = wanted;
    this.subscribe();
  }

  private moveTo(range: ListRange): void {
    // An empty range says nothing about where the eye is, and taking it at face
    // value moves the window to the top of the list. A viewport emits one every
    // time it is hidden or resized to nothing - which is what opening a drawer
    // over it does, and why the list behind came back blank.
    if (range.end <= range.start) {
      return;
    }
    this.range = range;
    this.follow();
  }

  /** Moves the window if the view has walked out of what it covers. */
  private follow(): void {
    if (!this.open) {
      return;
    }
    const { start, end } = this.range;

    // What is left once the rendered rows are covered, and therefore how much
    // of it can be spent as hysteresis on each side. Asking for the full MARGIN
    // regardless leaves a band of rows loaded by nothing: a window barely wider
    // than the viewport cannot both cover it and keep ten rows in hand.
    const spare = Math.max(0, this.window - (end - start));
    const margin = Math.min(MARGIN, Math.floor(spare / 2));
    if (this.offset >= 0 && start >= this.offset + margin && end <= this.offset + this.window - margin) {
      return;
    }

    // Centred on the view and rounded to a block - then pulled back until it
    // covers the rendered rows. Covering them is the requirement; the block is
    // only a way of not moving on every scrolled pixel, and rounding to one is
    // exactly how a window settles beside the rows it was meant to hold:
    // rendered [90, 120) rounded to [100, 150), leaving 90 to 99 in no window
    // at all - and, the offset being unchanged, leaving them there.
    const middle = (start + end) / 2;
    const centred = Math.round((middle - this.window / 2) / BLOCK) * BLOCK;
    // Never past the first rendered row, never so far back that the last one
    // falls out. When the viewport renders more rows than the window holds
    // there is no such position: the first row wins, which keeps the hole below
    // the fold rather than above it.
    const wanted = Math.max(0, Math.min(start, Math.max(centred, end - this.window)));
    if (wanted === this.offset) {
      return;
    }
    this.offset = wanted;
    this.subscribe();
  }

  private subscribe(): void {
    if (!this.open) {
      return;
    }
    this.watching?.unsubscribe();
    // A fresh list per subscription: the server answers a new window with a
    // snapshot, and rows from the previous one are at different offsets. The
    // marks go with them - they belonged to the window being left.
    this.list = new LiveList<Row>();
    this.recent.clear();
    this.watching = this.open(this.offset, this.window).subscribe({
      next: (update) => {
        if (!this.list.apply(update)) {
          this.onDrift();
          return;
        }
        if (update.type === 'patch') {
          this.mark(update.upserted.map((row) => row.id));
        }
        this.onTotal(this.list.total());
        this.publish();
      },
      error: (error: unknown) => console.error('[livewire] window failed', error),
    });
  }

  private mark(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    for (const id of ids) {
      this.recent.add(id);
    }
    // One timer per wave, clearing its own ids: a single shared timer would be
    // pushed back by every new arrival, so under a busy feed nothing would ever
    // stop being marked. The repaint is explicit because a zoneless application
    // schedules nothing for a set mutated outside the view.
    setTimeout(() => {
      for (const id of ids) {
        this.recent.delete(id);
      }
      this.touched();
    }, FRESH_MS);
  }

  /**
   * The whole length, holes and all.
   *
   * A new array each time: the viewport compares references to know something
   * changed, and the rows themselves are shared rather than copied.
   */
  private publish(): void {
    const rows = new Array<Row | undefined>(this.list.total());
    const held = this.list.rows();
    for (let index = 0; index < held.length; index += 1) {
      rows[this.offset + index] = held[index];
    }
    this.published.next(rows);
    this.touched();
  }

  /**
   * Says that the screen has something new to show.
   *
   * Both ways at once, and they do not overlap: the signal serves a template
   * that reads `revision()`, and `markForCheck()` serves one that does not.
   * Whichever the screen uses, the other costs a counter.
   */
  private touched(): void {
    this.stamp.update((count) => count + 1);
    this.repaint?.markForCheck();
  }
}
