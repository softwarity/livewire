# Livewire — specification

Normative. An implementation that passes the conformance suite and contradicts
this document is wrong; a rule not written here is not part of the contract and
an implementation may do as it likes with it.

Keywords **MUST**, **MUST NOT**, **SHOULD** and **MAY** are used in the sense of
RFC 2119.

---

## 1. The connection

A client opens **one** WebSocket per tab and carries every subscription on it.

The server **MUST** decide, from the upgrade request alone, whether the socket
may be used. When it refuses it **MUST**, in this order:

1. send an `error` frame with `id: "connection"` and a human-readable `reason`;
2. close the socket with code `1008`.

The frame comes first and is not optional: a refusal arriving as a bare
disconnection is indistinguishable from a network fault, and a proxy that drops
the close code — which an upgrade through a gateway often does — would leave the
client showing nothing with no way to tell why.

A server **MUST NOT** require any frame before `subscribe`: there is no
handshake, no hello, no authentication frame. Whatever identifies the caller is
in the upgrade request.

## 2. Frames

Every frame, both ways, is JSON: `{ "event": string, "data": object }`.

A frame that is not valid JSON, or whose `data` is not an object, **MUST** be
ignored. It **MUST NOT** close the socket.

### 2.1 Client → server

| `event` | `data` |
|---|---|
| `subscribe` | `{ id, topic, query? }` |
| `unsubscribe` | `{ id }` |

`id` **MUST** be a non-empty string, unique among that socket's open
subscriptions. `topic` **MUST** be a non-empty string. `query` is opaque to the
transport and **MAY** be absent.

A `subscribe` whose `id` is missing or empty **MUST** be ignored silently: there
is no id to answer under.

### 2.2 Server → client

All three carry `event: "update"`.

| `data.type` | Fields |
|---|---|
| `snapshot` | `id`, `rows`, `sequence`, and optionally `total`, `pivot` |
| `patch` | `id`, `upserted`, `removed`, `order`, `sequence`, and optionally `total`, `pivot` |
| `error` | `id`, `reason` |

## 3. Subscriptions

### 3.1 Opening

On `subscribe` the server **MUST**:

- answer `error` if no source answers `topic`, and open nothing;
- otherwise send a `snapshot` with `sequence: 1` as soon as the source has an
  answer, then `patch` frames for every subsequent change.

The snapshot **MAY** be delayed — a source that has to read a database takes as
long as it takes — but the server **MUST NOT** send a `patch` before it.

### 3.2 Moving

`subscribe` under an `id` already open **replaces** it. The server **MUST**
close the previous subscription, and the next frame under that id **MUST** be a
`snapshot` with `sequence` restarting at 1.

This is what a client does when it scrolls, sorts, or changes a filter. There is
no separate "update subscription" frame.

### 3.3 Closing

`unsubscribe` closes the subscription. The server **MUST** send nothing further
under that id, and **MUST NOT** close the socket — the other subscriptions on it
are unaffected.

An `unsubscribe` for an unknown id **MUST** be ignored.

When the socket closes, every subscription on it closes.

## 4. Sequence

`sequence` starts at 1 for each subscription and increments by one per frame
sent under that id. `error` frames do not consume a number.

A client that receives a `sequence` other than the one it expects **SHOULD**
resubscribe under the same id rather than apply the frame. On one socket nothing
is lost and nothing overtakes, so a gap means the two sides disagree about what
was sent, and a list nobody can reproduce is worse than one that flickers.

## 5. Windows

A source answers with a **whole window**, never a delta. Turning that window into
a `patch` is the server's business, **per subscription**, because only it knows
what that client actually received: a client that subscribes mid-stream gets a
snapshot, and its patches are computed against the rows it holds.

### 5.1 Versions

`updatedAt` is the version of a row, and it is what the diff compares.

> **Everything a row shows MUST be in its version** — not only what a write
> touched.

A value derived from the clock (which side of "now" a row falls on, whether it
is late) changes with no write behind it. A version that ignores it makes the
server believe the row unchanged: the window compares equal to the previous one,
nothing is published, and the row never appears in a patch. The client then
holds a value that stopped being true.

A version **MAY** be anything a string can hold: a timestamp, a label, a
composite. It **MUST NOT** be reused for a different state of the same row.

### 5.2 Diff

Given `before` (what this client last received) and `after` (the window now):

- `upserted` = every row of `after` whose id is absent from `before` **or** whose
  version differs;
- `removed` = every id of `before` absent from `after`;
- `order` = the ids of `after`, in order.

A row that merely moved — same id, same version, different position — **MUST
NOT** be in `upserted`. It is in `order`, which is enough.

### 5.3 Silence

A read whose window is identical to the one last published **MUST NOT** produce
a frame. "Identical" means same `total`, same `pivot`, same ids in the same
order with the same versions.

This is not an optimisation. A source woken by a busy feed re-reads constantly,
and a screen repainting on every read is a screen nobody can use.

### 5.4 Sharing

Two subscriptions whose queries produce the same key **SHOULD** share one read.
The key is the source's business; the transport does not compute it.

## 6. What is not in this contract

- **How a source is woken.** Timers, database triggers, a message broker — the
  contract says what a window looks like, not what causes one to be read.
- **Authorisation beyond the socket.** There is no per-topic or per-row
  permission model. A caller who may open the socket may subscribe to any topic
  the server exposes; a server needing finer control filters inside the source.
- **Frame size.** WebSocket sets no useful limit, but proxies do — one of them
  silently drops frames over ~64 kB. Sizing a window is the source's
  responsibility, and an implementation **SHOULD** document the ceiling it was
  tested against.
- **Reconnection.** A client that loses the socket and reopens it **MUST**
  resubscribe; the server remembers nothing across connections.
- **Ordering between subscriptions.** Frames for two different ids may interleave
  in any order.

## 7. Conformance

`packages/mock/src/conformance.ts` holds the scenarios every server
implementation must pass. They are driven over an abstract wire, so the same
list runs against the in-memory server, the NestJS one and the Go one — the last
two over a real socket.

Two implementations of one protocol diverge within months — not through
carelessness, but through the cases nobody wrote down. The suite is what makes
"we also have a Go server" true rather than hopeful.
