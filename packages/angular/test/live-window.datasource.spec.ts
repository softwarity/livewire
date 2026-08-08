import { ChangeDetectorRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { LiveWindowDataSource } from '../src/lib/live-window.datasource';
import type { CollectionViewer } from '@angular/cdk/collections';
import type { LiveRow, UpdateFrame } from '@softwarity/livewire-protocol';

/**
 * The data source injects the view it repaints, so it is built in an injection
 * context here as it is in a component field. Nothing in this file is about
 * repainting - `repaint.spec.ts` covers that - so the ref is a stub.
 */
function build<Row extends LiveRow>(...args: ConstructorParameters<typeof LiveWindowDataSource>): LiveWindowDataSource<Row> {
  return TestBed.runInInjectionContext(() => new LiveWindowDataSource<Row>(...args));
}

beforeEach(() =>
  TestBed.configureTestingModule({
    providers: [{ provide: ChangeDetectorRef, useValue: { markForCheck: () => undefined } }],
  }),
);

function rows(from: number, count: number): LiveRow[] {
  return Array.from({ length: count }, (_, index) => ({ id: `r${from + index}`, updatedAt: 'v1' }));
}

describe('LiveWindowDataSource', () => {
  let opened: { offset: number; limit: number }[];
  let feed: Subject<UpdateFrame<LiveRow>>;
  let source: LiveWindowDataSource<LiveRow>;
  let viewChange: Subject<{ start: number; end: number }>;

  function sourceOf(window?: number): void {
    opened = [];
    feed = new Subject<UpdateFrame<LiveRow>>();
    source = build<LiveRow>(() => undefined, () => undefined, window);
    viewChange = new Subject<{ start: number; end: number }>();
    source.connect({ viewChange } as unknown as CollectionViewer);
    source.reset((offset, limit) => {
      opened.push({ offset, limit });
      return feed;
    });
  }

  function answer(offset: number, total: number, held = 100): void {
    feed.next({ id: 'w', type: 'snapshot', rows: rows(offset, held), total, sequence: 1 });
  }

  beforeEach(() => sourceOf());

  it('opens one window, not one per page', () => {
    expect(opened).toEqual([{ offset: 0, limit: 100 }]);
  });

  /**
   * The loop this guards against freezes the renderer: every publication makes
   * the list longer, the viewport recalculates and emits a range, and anything
   * that re-subscribes on that range publishes again.
   */
  it('stays put while the view is inside the window', () => {
    answer(0, 13_000);
    opened.length = 0;

    for (const total of [13_010, 13_020, 13_030]) {
      viewChange.next({ start: 20, end: 78 });
      answer(0, total);
    }

    expect(opened).toEqual([]);
  });

  it('moves once the view walks out, and only then', () => {
    answer(0, 13_000);
    opened.length = 0;

    viewChange.next({ start: 60, end: 98 });
    expect(opened).toHaveLength(1);
    expect(opened[0].offset).toBeGreaterThan(0);

    const moved = opened[0].offset;
    answer(moved, 13_000);
    opened.length = 0;
    viewChange.next({ start: moved + 20, end: moved + 78 });

    expect(opened).toEqual([]);
  });

  /**
   * A viewport reduced to nothing - a drawer opening over it - emits an empty
   * range. Taken at face value it moves the window to the top of the list, and
   * the list behind the panel comes back blank.
   */
  it('ignores an empty range rather than treating it as a position', () => {
    viewChange.next({ start: 5000, end: 5058 });
    const moved = opened.at(-1)?.offset ?? 0;
    answer(moved, 13_000);
    opened.length = 0;

    viewChange.next({ start: 0, end: 0 });

    expect(opened).toEqual([]);
    expect(source.at(moved)).toBeDefined();
  });

  it('moves the window to cover a row asked for outright', () => {
    answer(0, 13_000);
    opened.length = 0;

    source.ensure(9000);

    expect(opened).toHaveLength(1);
    expect(opened[0].offset).toBeLessThanOrEqual(9000);
    expect(opened[0].offset + 100).toBeGreaterThan(9000);
  });

  it('places the rows it holds at their own offset in the published list', () => {
    viewChange.next({ start: 5000, end: 5058 });
    const moved = opened.at(-1)?.offset ?? 0;
    answer(moved, 13_000);

    expect(source.length).toBe(13_000);
    expect(source.at(moved)).toEqual({ id: `r${moved}`, updatedAt: 'v1' });
    expect(source.at(0)).toBeUndefined();
  });

  it('carries the pivot through, whatever it means', () => {
    feed.next({ id: 'w', type: 'snapshot', rows: rows(0, 10), total: 500, pivot: 42, sequence: 1 });

    expect(source.pivot).toBe(42);
  });

  it('resyncs rather than applying a frame it cannot place', () => {
    let drifted = 0;
    opened = [];
    feed = new Subject<UpdateFrame<LiveRow>>();
    source = build<LiveRow>(
      () => undefined,
      () => (drifted += 1),
    );
    source.reset(() => feed);

    feed.next({ id: 'w', type: 'snapshot', rows: rows(0, 3), total: 3, sequence: 1 });
    // Sequence 3 where 2 was due: a frame went missing.
    feed.next({ id: 'w', type: 'patch', upserted: [], removed: [], order: ['r0'], total: 1, sequence: 3 });

    expect(drifted).toBe(1);
  });

  /**
   * The mark that lights a row for a moment. The trap it has to avoid is
   * lighting the whole screen: a snapshot is what arriving on the list and what
   * scrolling both get back, and neither means anything arrived.
   */
  describe('what counts as fresh', () => {
    beforeEach(() => answer(0, 13_000));

    it('marks nothing on a snapshot - a window that moved is not news', () => {
      expect(source.fresh('r0')).toBe(false);
      expect(source.fresh('r40')).toBe(false);
    });

    it('marks the rows a patch actually changed, and only those', () => {
      feed.next({
        id: 'w',
        type: 'patch',
        upserted: [{ id: 'new1', updatedAt: 'v1' }],
        removed: ['r99'],
        order: ['new1', ...rows(0, 99).map((row) => row.id)],
        total: 13_001,
        sequence: 2,
      });

      expect(source.fresh('new1')).toBe(true);
      // Shifted down by one, unchanged, not in `upserted` - and not marked.
      expect(source.fresh('r0')).toBe(false);
    });

    it('says nothing about a row it was never told about', () => {
      expect(source.fresh(undefined)).toBe(false);
    });
  });

  /**
   * The flight list, whose rows are heavy enough that its window holds fifty.
   *
   * That is where a band of rows loaded by nothing showed up, between one
   * window and the next: the offset was centred on the view and then rounded to
   * a block, with nothing checking that the result still covered the rows being
   * rendered. Rendered [90, 120) rounded to [100, 150) - and since that was
   * already the offset, the ten rows above it stayed placeholders for good.
   */
  describe('a window barely wider than the viewport', () => {
    const WINDOW = 50;

    beforeEach(() => {
      sourceOf(WINDOW);
      feed.next({ id: 'w', type: 'snapshot', rows: rows(0, WINDOW), total: 13_000, sequence: 1 });
      opened.length = 0;
    });

    it('always covers every rendered row, whatever the block rounding says', () => {
      for (const start of [30, 55, 90, 91, 137, 4321]) {
        const range = { start, end: start + 30 };
        viewChange.next(range);
        const offset = opened.at(-1)?.offset ?? 0;
        expect(offset).toBeLessThanOrEqual(range.start);
        expect(offset + WINDOW).toBeGreaterThanOrEqual(range.end);
        feed.next({ id: 'w', type: 'snapshot', rows: rows(offset, WINDOW), total: 13_000, sequence: 1 });
      }
    });

    it('leaves no hole in the rows the viewport is showing', () => {
      viewChange.next({ start: 90, end: 120 });
      const offset = opened.at(-1)?.offset ?? 0;
      feed.next({ id: 'w', type: 'snapshot', rows: rows(offset, WINDOW), total: 13_000, sequence: 1 });

      for (let index = 90; index < 120; index += 1) {
        expect(source.at(index)).toBeDefined();
      }
    });

    it('still stands still once it covers the view, however tight the fit', () => {
      viewChange.next({ start: 90, end: 120 });
      const offset = opened.at(-1)?.offset ?? 0;
      feed.next({ id: 'w', type: 'snapshot', rows: rows(offset, WINDOW), total: 13_000, sequence: 1 });
      opened.length = 0;

      viewChange.next({ start: 90, end: 120 });
      viewChange.next({ start: 90, end: 120 });

      expect(opened).toEqual([]);
    });
  });
});
