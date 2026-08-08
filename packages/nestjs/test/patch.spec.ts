import { patchOf, signatureOf, snapshotOf } from '../src/patch';
import type { LiveRow, LiveWindow } from '@softwarity/livewire-protocol';

const row = (id: string, version = 'v1'): LiveRow => ({ id, updatedAt: version });
const window = (rows: LiveRow[], extra: Partial<LiveWindow> = {}): LiveWindow => ({ rows, ...extra });

describe('snapshotOf', () => {
  it('carries the window whole, with its sequence', () => {
    const frame = snapshotOf('w', window([row('a'), row('b')], { total: 42, pivot: 7 }), 1);

    expect(frame).toEqual({
      id: 'w',
      type: 'snapshot',
      rows: [row('a'), row('b')],
      total: 42,
      pivot: 7,
      sequence: 1,
    });
  });

  it('leaves total and pivot absent when the source did not set them', () => {
    const frame = snapshotOf('w', window([row('a')]), 1);

    expect(frame.total).toBeUndefined();
    expect(frame.pivot).toBeUndefined();
  });
});

describe('patchOf', () => {
  it('upserts a row that was not there', () => {
    const frame = patchOf('w', [row('a')], window([row('a'), row('b')]), 2);

    expect(frame.upserted).toEqual([row('b')]);
    expect(frame.removed).toEqual([]);
    expect(frame.order).toEqual(['a', 'b']);
  });

  it('upserts a row whose version changed', () => {
    const frame = patchOf('w', [row('a', 'v1')], window([row('a', 'v2')]), 2);

    expect(frame.upserted).toEqual([row('a', 'v2')]);
  });

  /**
   * The rule an implementation gets wrong first: a row that only moved is in
   * `order` and nowhere else. Re-sending it would double the size of every
   * patch on a list where anything is inserted at the top.
   */
  it('does NOT upsert a row that only moved', () => {
    const frame = patchOf('w', [row('a'), row('b')], window([row('b'), row('a')]), 2);

    expect(frame.upserted).toEqual([]);
    expect(frame.removed).toEqual([]);
    expect(frame.order).toEqual(['b', 'a']);
  });

  it('removes what is no longer in the window', () => {
    const frame = patchOf('w', [row('a'), row('b')], window([row('a')]), 2);

    expect(frame.removed).toEqual(['b']);
    expect(frame.upserted).toEqual([]);
  });

  it('empties the window when everything went', () => {
    const frame = patchOf('w', [row('a'), row('b')], window([]), 2);

    expect(frame.removed).toEqual(['a', 'b']);
    expect(frame.order).toEqual([]);
  });

  it('says nothing at all when nothing changed', () => {
    const frame = patchOf('w', [row('a'), row('b')], window([row('a'), row('b')]), 2);

    expect(frame.upserted).toEqual([]);
    expect(frame.removed).toEqual([]);
  });

  it('carries total and pivot through', () => {
    const frame = patchOf('w', [], window([row('a')], { total: 9, pivot: 3 }), 2);

    expect(frame.total).toBe(9);
    expect(frame.pivot).toBe(3);
  });

  /** A window that slid: rows in, rows out, and the ones that stayed silent. */
  it('handles a window sliding over a longer list', () => {
    const before = [row('c'), row('d'), row('e')];
    const frame = patchOf('w', before, window([row('a'), row('b'), row('c')]), 2);

    expect(frame.upserted.map((one) => one.id)).toEqual(['a', 'b']);
    expect(frame.removed).toEqual(['d', 'e']);
    expect(frame.order).toEqual(['a', 'b', 'c']);
  });
});

describe('signatureOf', () => {
  it('is the same for two identical windows', () => {
    expect(signatureOf(window([row('a'), row('b')], { total: 2 }))).toBe(
      signatureOf(window([row('a'), row('b')], { total: 2 })),
    );
  });

  it('differs when a version changes', () => {
    expect(signatureOf(window([row('a', 'v1')]))).not.toBe(signatureOf(window([row('a', 'v2')])));
  });

  it('differs when the order changes', () => {
    expect(signatureOf(window([row('a'), row('b')]))).not.toBe(signatureOf(window([row('b'), row('a')])));
  });

  it('differs when the total changes, though the page did not', () => {
    expect(signatureOf(window([row('a')], { total: 10 }))).not.toBe(signatureOf(window([row('a')], { total: 11 })));
  });

  /**
   * `pivot` is read from the clock on some sources - which side of now a row
   * falls on - and moves with no row being written. A signature that ignored it
   * would call the window unchanged and publish nothing.
   */
  it('differs when only the pivot moved', () => {
    expect(signatureOf(window([row('a')], { pivot: 1 }))).not.toBe(signatureOf(window([row('a')], { pivot: 2 })));
  });
});
