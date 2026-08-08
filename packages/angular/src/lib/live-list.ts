import { signal } from '@angular/core';
import type { Signal } from '@angular/core';
import type { LiveRow, PatchFrame, UpdateFrame } from '@softwarity/livewire-protocol';

/**
 * A list kept in step with what the server pushes.
 *
 * Snapshot then patches, applied and nothing more: what belongs in the list and
 * in what order is decided by the source's query, and a client that recomputed
 * either from its own idea of the filters would be a second implementation free
 * to disagree.
 */
export class LiveList<Row extends LiveRow> {
  private readonly held = signal<Row[]>([]);
  private readonly length = signal(0);
  private readonly marked = signal<number | null>(null);

  /** The list as it stands. Ordered by the server, never re-sorted here. */
  readonly rows: Signal<Row[]> = this.held.asReadonly();

  /** What the list is a page of, for a paged topic. Its own length otherwise. */
  readonly total: Signal<number> = this.length.asReadonly();

  /**
   * An index in the whole list the server pointed at, if it pointed at one.
   *
   * Meaningless here on purpose: the library carries the number and the screen
   * decides what it means - a boundary, a cursor, the first unread row.
   */
  readonly pivot: Signal<number | null> = this.marked.asReadonly();

  private sequence = 0;

  /**
   * Applies one frame. Answers false when the two sides have drifted, which is
   * the caller's cue to ask for the window again.
   */
  apply(update: UpdateFrame<Row>): boolean {
    if (update.type === 'error') {
      console.error(`Livewire subscription '${update.id}' refused: ${update.reason}`);
      return true;
    }
    if (update.type === 'snapshot') {
      this.sequence = update.sequence;
      this.held.set(update.rows);
      this.length.set(update.total ?? update.rows.length);
      this.marked.set(update.pivot ?? null);
      return true;
    }
    // On one socket nothing is lost and nothing overtakes, so a gap means the
    // two sides disagree about what was sent. Asking again is cheap; carrying
    // on would show a list nobody can reproduce.
    if (update.sequence !== this.sequence + 1) {
      return false;
    }
    const rebuilt = this.rebuild(update);
    if (!rebuilt) {
      return false;
    }
    this.sequence = update.sequence;
    this.held.set(rebuilt);
    this.length.set(update.total ?? rebuilt.length);
    this.marked.set(update.pivot ?? null);
    return true;
  }

  /** Forgets what it holds - a fresh subscription answers with a snapshot. */
  reset(): void {
    this.sequence = 0;
    this.held.set([]);
    this.length.set(0);
    this.marked.set(null);
  }

  /** Null when the patch names a row neither side holds - the caller resyncs. */
  private rebuild(update: PatchFrame<Row>): Row[] | null {
    const byId = new Map(this.held().map((row) => [row.id, row]));
    for (const id of update.removed) {
      byId.delete(id);
    }
    for (const row of update.upserted) {
      byId.set(row.id, row);
    }
    const next: Row[] = [];
    for (const id of update.order) {
      const row = byId.get(id);
      if (!row) {
        return null;
      }
      next.push(row);
    }
    return next;
  }
}
