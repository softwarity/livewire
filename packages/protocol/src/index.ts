/**
 * The wire contract, and nothing else.
 *
 * Types only - this package emits no runtime code. Both the server and the
 * client depend on it, which is the whole point: the contract is described in
 * one place instead of being copied into two and versioned by convention.
 *
 * A Go server is expected to implement the same thing. What is normative is
 * `SPEC.md` beside this file, not these declarations - TypeScript cannot say
 * "an unchanged window publishes nothing", and that rule is as much part of the
 * contract as the shape of a frame.
 */

/**
 * What comes off the wire: JSON, parsed.
 *
 * Narrower than `unknown` on purpose. A query has crossed a socket and been
 * through `JSON.parse`, so it cannot be a function, a Date or a Map - and
 * saying so lets a source read it without casting its way in.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** An object as JSON carries it - what a query almost always is. */
export type JsonObject = { [key: string]: JsonValue };

/** What every row a source publishes must carry. */
export interface LiveRow {
  id: string;
  /**
   * The version of this row. Changes whenever anything the row shows changes.
   *
   * Not necessarily a timestamp: a filter entry whose only content is its label
   * uses the label, and a row carrying a value derived from the clock has to
   * fold that value in - otherwise the server believes the row unchanged and
   * never sends it again. See SPEC.md, "Versions".
   */
  updatedAt: string;
}

/** What a source answers with: a window of rows, and what it is a window of. */
export interface LiveWindow<Row extends LiveRow = LiveRow> {
  rows: Row[];
  /** The length the window is a page of. Absent when the source does not page. */
  total?: number;
  /**
   * An index in the whole list the source points the client at.
   *
   * A number and nothing more - neither side interprets it. A departure board
   * uses it for the boundary between what has left and what has not: a position
   * in the list that a client holding one page of six hundred cannot work out
   * from the rows it happens to have.
   */
  pivot?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client → server
// ─────────────────────────────────────────────────────────────────────────────

/** Opens a subscription, or moves an open one. */
export interface SubscribeFrame {
  /** The client's handle on this subscription. Unique per socket. */
  id: string;
  /** Which source answers. */
  topic: string;
  /** Whatever that source's `readQuery` makes of it. */
  query?: JsonValue;
}

export interface UnsubscribeFrame {
  id: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server → client
// ─────────────────────────────────────────────────────────────────────────────

/** First frame on a subscription: the window as it stands. */
export interface SnapshotFrame<Row extends LiveRow = LiveRow> {
  id: string;
  type: 'snapshot';
  rows: Row[];
  total?: number;
  pivot?: number;
  /** Increments per subscription, from 1. A gap means the client missed one. */
  sequence: number;
}

/**
 * Every frame after that.
 *
 * `order` carries the whole window's ids, not only the changed ones. The sort
 * key belongs to the source, and reproducing it client-side would be a second
 * implementation free to disagree; a few dozen strings buy that away.
 */
export interface PatchFrame<Row extends LiveRow = LiveRow> {
  id: string;
  type: 'patch';
  upserted: Row[];
  removed: string[];
  order: string[];
  total?: number;
  pivot?: number;
  sequence: number;
}

/** Sent when a subscription names a topic nothing answers. */
export interface ErrorFrame {
  id: string;
  type: 'error';
  reason: string;
}

export type UpdateFrame<Row extends LiveRow = LiveRow> = SnapshotFrame<Row> | PatchFrame<Row> | ErrorFrame;

/** Every frame travels in an envelope naming what it is. */
export interface Envelope<Data> {
  event: string;
  data: Data;
}

/** The event name a client sends to open or move a subscription. */
export const SUBSCRIBE_EVENT = 'subscribe';

/** The event name a client sends to close one. */
export const UNSUBSCRIBE_EVENT = 'unsubscribe';

/** The event name every push carries, whatever opened the subscription. */
export const UPDATE_EVENT = 'update';

/** Policy violation (RFC 6455): the socket opened, the caller may not use it. */
export const NOT_AUTHORISED = 1008;

export { snapshotOf, patchOf, signatureOf } from './patch.js';
