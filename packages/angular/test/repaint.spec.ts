import { ChangeDetectorRef, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { LiveWindowDataSource } from '../src/lib/live-window.datasource';
import type { LiveRow, UpdateFrame } from '@softwarity/livewire-protocol';

/**
 * What repaints a zoneless screen when a frame lands in a socket callback.
 *
 * The data source injects the view's `ChangeDetectorRef` and calls
 * `markForCheck()`, which marks the view dirty *and* notifies the zoneless
 * scheduler. Nothing is asked of the screen.
 *
 * The component below reads **no signal at all** and uses no async pipe - it
 * renders a plain field, filled from a subscription. That is deliberate: it
 * strips out every other thing that could schedule a pass, so what is measured
 * is the notification itself and nothing else.
 */
describe('repainting a zoneless screen', () => {
  const feed = new Subject<UpdateFrame<LiveRow>>();

  function frame(...ids: string[]): UpdateFrame<LiveRow> {
    return {
      id: 'w',
      type: 'snapshot',
      rows: ids.map((id) => ({ id, updatedAt: 'v1' })),
      total: ids.length,
      sequence: 1,
    };
  }

  @Component({
    selector: 'test-screen',
    standalone: true,
    template: `<span class="ids">{{ ids }}</span>`,
  })
  class ScreenComponent {
    ids = '';

    // A component field, which is an injection context - the data source takes
    // this view's ChangeDetectorRef from it.
    readonly source = new LiveWindowDataSource<LiveRow>();

    constructor() {
      this.source.changes.subscribe((rows) => (this.ids = rows.map((row) => row?.id ?? '-').join(',')));
      this.source.reset(() => feed);
    }
  }

  it('repaints on a frame arriving from outside a change-detection cycle', async () => {
    const fixture = TestBed.createComponent(ScreenComponent);
    await fixture.whenStable();

    // Straight into the data source, as a socket callback would.
    feed.next(frame('a', 'b'));
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.ids').textContent).toBe('a,b');
  });

  it('repaints again on every later frame, not only the first', async () => {
    const fixture = TestBed.createComponent(ScreenComponent);
    await fixture.whenStable();

    for (const ids of [['a'], ['a', 'b'], ['a', 'b', 'c']]) {
      feed.next(frame(...ids));
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('.ids').textContent).toBe(ids.join(','));
    }
  });

  /**
   * The rule made structural: there is no way to build one that cannot repaint.
   * Left optional, the screens that forgot it would look right in development
   * and hold stale rows in production.
   */
  it('refuses to be built where there is no view to repaint', () => {
    expect(() => new LiveWindowDataSource<LiveRow>()).toThrow();
  });
});

/**
 * The other half of "it repaints": that it does so only when there is something
 * to repaint.
 *
 * A pass asked for on every read rather than on every change is how a live
 * screen becomes one nobody can use - and it would be invisible, since the
 * screen would look right the whole time.
 */
describe('what asks for a repaint, and what does not', () => {
  let asked: number;
  let feed: Subject<UpdateFrame<LiveRow>>;
  let source: LiveWindowDataSource<LiveRow>;

  function rows(count: number): LiveRow[] {
    return Array.from({ length: count }, (_, index) => ({ id: `r${index}`, updatedAt: 'v1' }));
  }

  beforeEach(() => {
    jest.useFakeTimers();
    asked = 0;
    // `ChangeDetectorRef` is a token like any other: provided here, the data
    // source injects this instead of a view's, and the calls can be counted.
    // Only `markForCheck` is ever called.
    TestBed.configureTestingModule({
      providers: [{ provide: ChangeDetectorRef, useValue: { markForCheck: () => (asked += 1) } }],
    });
    feed = new Subject<UpdateFrame<LiveRow>>();
    source = TestBed.runInInjectionContext(() => new LiveWindowDataSource<LiveRow>());
  });

  afterEach(() => jest.useRealTimers());

  it('asks once when the list is emptied for a new question', () => {
    source.reset(() => feed);

    expect(asked).toBe(1);
  });

  it('asks once per frame it could apply, and no more', () => {
    source.reset(() => feed);
    asked = 0;

    feed.next({ id: 'w', type: 'snapshot', rows: rows(3), total: 3, sequence: 1 });
    expect(asked).toBe(1);

    feed.next({
      id: 'w',
      type: 'patch',
      upserted: [{ id: 'new', updatedAt: 'v1' }],
      removed: [],
      order: ['new', 'r0', 'r1', 'r2'],
      total: 4,
      sequence: 2,
    });
    expect(asked).toBe(2);
  });

  /** A frame it cannot place changes nothing on the screen. It resyncs instead. */
  it('asks for nothing on a frame it had to reject', () => {
    source.reset(() => feed);
    feed.next({ id: 'w', type: 'snapshot', rows: rows(3), total: 3, sequence: 1 });
    asked = 0;

    // Sequence 3 where 2 was due.
    feed.next({ id: 'w', type: 'patch', upserted: [], removed: [], order: ['r0'], total: 1, sequence: 3 });

    expect(asked).toBe(0);
  });

  /** Moving the window is a question, not an answer. The snapshot repaints. */
  it('asks for nothing when the window moves, only when its answer lands', () => {
    source.reset(() => feed);
    feed.next({ id: 'w', type: 'snapshot', rows: rows(100), total: 13_000, sequence: 1 });
    asked = 0;

    source.ensure(9000);

    expect(asked).toBe(0);
  });

  /** The marks have to come off, and taking them off is a change like any other. */
  it('asks once more when the fresh marks expire, and then stops', () => {
    source.reset(() => feed);
    feed.next({ id: 'w', type: 'snapshot', rows: rows(3), total: 3, sequence: 1 });
    feed.next({
      id: 'w',
      type: 'patch',
      upserted: [{ id: 'new', updatedAt: 'v1' }],
      removed: [],
      order: ['new', 'r0', 'r1', 'r2'],
      total: 4,
      sequence: 2,
    });
    asked = 0;

    jest.advanceTimersByTime(1000);
    expect(asked).toBe(1);

    jest.advanceTimersByTime(10_000);
    expect(asked).toBe(1);
  });
});
