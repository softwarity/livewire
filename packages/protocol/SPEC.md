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
| `command` | `{ id, name, payload? }` |

`id` **MUST** be a non-empty string, unique among what that socket has in
flight. `topic` and `name` **MUST** be non-empty strings. `query` and `payload`
are opaque to the transport and **MAY** be absent.

A frame whose `id` is missing or empty **MUST** be ignored silently: there is no
id to answer under.

Subscriptions and commands share the `id` namespace. Reusing an open
subscription's id for a command is a client error, and the server **MAY** answer
either as it sees fit — it is not required to detect it.

### 2.2 Server → client

| `event` | `data` |
|---|---|
| `update` | one of the three below |
| `ack` | `{ id, ok, result? }` or `{ id, ok: false, reason }` |
| `notify` | `{ topic, payload? }` |

The three shapes an `update` carries:

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

## 6. Commands and notifications

Level 2. A server **MAY** implement neither, either, or both; a client **MUST**
tolerate a server that implements neither. Everything in §1–§5 stands whether or
not these exist.

### 6.1 `command` — client → server, acknowledged

A `command` names something to do, not something to read.

The server **MUST** answer exactly one `ack` carrying the same `id`, whatever
happens: a command that succeeded, one that failed, and one naming something the
server does not know all end in an `ack`. A client that never hears back cannot
tell a slow write from a lost frame.

- `ok: true` **MAY** carry a `result`, which is opaque to the transport.
- `ok: false` **MUST** carry a human-readable `reason`.
- A command naming something the server does not handle **MUST** answer
  `ok: false`.

> **The acknowledgement is not the new state.** A command that changes what a
> list holds is followed by whatever that list's subscription publishes, through
> the ordinary path of §5. Putting the new rows in `result` would be a second
> answer to the same question, free to disagree with the first — the mistake
> this whole protocol exists to avoid.

The `ack` **MAY** arrive before or after the frames the command caused. Nothing
orders them: a write announced to a source is read and published on that
source's own schedule.

Commands **MUST NOT** open, move or close a subscription.

### 6.2 `notify` — server → client, one-off

A `notify` is an event, not a window: no `id`, no `sequence`, no diff, nothing
to apply. `topic` says what it is about; `payload` is opaque.

Which sockets receive one is the server's business — the transport carries no
subscription for notifications, and a client **MUST** ignore a `topic` it does
not know rather than treat it as an error.

A `notify` **MUST NOT** be used to carry what a subscription would carry. If a
screen needs to hold it, show it, or reconcile it, it is a window and belongs in
§5. What this is for is what has no state: a job finished, an import failed,
something happened that a reader should be told once.

## 7. What is not in this contract

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

## 8. Conformance

Two suites, one specification.

`packages/mock/src/conformance.ts` holds the scenarios every **server** must
pass. They are driven over an abstract wire, so the same list runs against the
in-memory server, the NestJS one and the Go one — the last two over a real
socket.

`packages/mock/src/client-conformance.ts` holds the scenarios every **client**
must pass. It works the other way: it feeds frames in and reads what the screen
would show, and what the client sent back. Both halves of a client are covered —
the transport, which decides what goes on the wire and when, and the list, which
decides what a frame does to the rows. A client that gets the second right and
the first wrong passes every unit test and holds an empty screen on a refresh,
which is exactly what happened before this suite existed.

Two implementations of one protocol diverge within months — not through
carelessness, but through the cases nobody wrote down. The suite is what makes
"we also have a Go server" true rather than hopeful.
