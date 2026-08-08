import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { LiveWindowDataSource } from '../src/lib/live-window.datasource';
import type { LiveRow, UpdateFrame } from '@softwarity/livewire-protocol';

/**
 * What repaints a zoneless screen when a frame lands in a socket callback.
 *
 * Two ways, and the point of this file is that the second one works: a signal
 * the template reads, or a `ChangeDetectorRef` handed to the data source.
 *
 * The templates here read **no signal at all** and use no async pipe - they
 * render a plain field, filled from a subscription. That is deliberate: it
 * strips out every other thing that could schedule a pass, so what the test
 * measures is the notification itself and nothing else.
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
    selector: 'test-told',
    standalone: true,
    template: `<span class="ids">{{ ids }}</span>`,
  })
  class ToldComponent {
    ids = '';

    readonly source = new LiveWindowDataSource<LiveRow>(
      () => undefined,
      () => undefined,
      100,
      inject(ChangeDetectorRef),
    );

    constructor() {
      this.source.changes.subscribe((rows) => (this.ids = rows.map((row) => row?.id ?? '-').join(',')));
      this.source.reset(() => feed);
    }
  }

  @Component({
    selector: 'test-silent',
    standalone: true,
    template: `<span class="ids">{{ ids }}</span>`,
  })
  class SilentComponent {
    ids = '';

    readonly source = new LiveWindowDataSource<LiveRow>();

    constructor() {
      this.source.changes.subscribe((rows) => (this.ids = rows.map((row) => row?.id ?? '-').join(',')));
      this.source.reset(() => feed);
    }
  }

  it('repaints on its own when it was given a ChangeDetectorRef', async () => {
    const fixture = TestBed.createComponent(ToldComponent);
    await fixture.whenStable();

    // Straight into the data source, as a socket callback would - nothing here
    // runs inside a change-detection cycle.
    feed.next(frame('a', 'b'));
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.ids').textContent).toBe('a,b');
  });

  /**
   * The other half of the claim, and the reason the rule exists: without either
   * notification the field is right and the screen is wrong. A test that only
   * checked the first case would pass just as well if something else in the
   * fixture were scheduling the pass.
   */
  it('does not, when it was given neither a ChangeDetectorRef nor a revision() read', async () => {
    const fixture = TestBed.createComponent(SilentComponent);
    await fixture.whenStable();

    feed.next(frame('a', 'b'));
    await fixture.whenStable();

    expect(fixture.componentInstance.ids).toBe('a,b');
    expect(fixture.nativeElement.querySelector('.ids').textContent).toBe('');
  });

  it('repaints again on every later frame, not only the first', async () => {
    const fixture = TestBed.createComponent(ToldComponent);
    await fixture.whenStable();

    for (const ids of [['a'], ['a', 'b'], ['a', 'b', 'c']]) {
      feed.next(frame(...ids));
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('.ids').textContent).toBe(ids.join(','));
    }
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
  let repaint: ChangeDetectorRef;
  let feed: Subject<UpdateFrame<LiveRow>>;
  let source: LiveWindowDataSource<LiveRow>;

  function rows(count: number): LiveRow[] {
    return Array.from({ length: count }, (_, index) => ({ id: `r${index}`, updatedAt: 'v1' }));
  }

  beforeEach(() => {
    jest.useFakeTimers();
    asked = 0;
    // Only `markForCheck` is ever called; the rest of the interface is not
    // worth stubbing to count one thing.
    repaint = { markForCheck: () => (asked += 1) } as unknown as ChangeDetectorRef;
    feed = new Subject<UpdateFrame<LiveRow>>();
    source = new LiveWindowDataSource<LiveRow>(
      () => undefined,
      () => undefined,
      100,
      repaint,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('asks once when the list is emptied for a new question', () => {
    source.reset(() => feed);

    expect(asked).toBe(1);
  });

  /**
   * A screen calls `reset` from an `effect`, and Angular 18 refuses a signal
   * write from inside one. So emptying the list asks for a pass without
   * touching `revision` - which stays where the frames bump it.
   */
  it('empties the list without writing a signal', () => {
    const before = source.revision();

    source.reset(() => feed);

    expect(source.revision()).toBe(before);
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
