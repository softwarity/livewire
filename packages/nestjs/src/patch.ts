import type { LiveRow, LiveWindow, PatchFrame, SnapshotFrame } from '@softwarity/livewire-protocol';

/**
 * The first frame on a subscription: the window as it stands.
 */
export function snapshotOf(id: string, window: LiveWindow, sequence: number): SnapshotFrame {
  return { id, type: 'snapshot', rows: window.rows, total: window.total, pivot: window.pivot, sequence };
}

/**
 * What one client has not seen yet.
 *
 * `updatedAt` is the version: a row whose stamp is unchanged is the same row,
 * whatever moved around it, so an unchanged row is not re-sent because the one
 * above it left the window. It is in `order`, which is enough to place it.
 *
 * See SPEC §5.2. The rule that catches implementations out is the one about
 * versions, not this function: a row carrying a value derived from the clock
 * has to fold that value into `updatedAt`, or the comparison below calls it
 * unchanged and it is never sent again.
 */
export function patchOf(id: string, before: LiveRow[], after: LiveWindow, sequence: number): PatchFrame {
  const held = new Map(before.map((row) => [row.id, row.updatedAt]));
  const kept = new Set(after.rows.map((row) => row.id));
  return {
    id,
    type: 'patch',
    upserted: after.rows.filter((row) => held.get(row.id) !== row.updatedAt),
    removed: before.filter((row) => !kept.has(row.id)).map((row) => row.id),
    order: after.rows.map((row) => row.id),
    total: after.total,
    pivot: after.pivot,
    sequence,
  };
}

/**
 * Same rows, same order, same versions, same length, same pivot - or the window
 * moved.
 *
 * Used to stay silent on a read that changed nothing (SPEC §5.3). Not an
 * optimisation: a source woken by a busy feed re-reads constantly, and a screen
 * repainting on every read is a screen nobody can use.
 */
export function signatureOf(window: LiveWindow): string {
  return `${window.total}:${window.pivot}:${window.rows.map((row) => `${row.id}@${row.updatedAt}`).join(',')}`;
}
