<p align="center">
  <a href="https://www.softwarity.io/">
    <img src="https://www.softwarity.io/img/softwarity.svg" alt="Softwarity" height="60">
  </a>
</p>

# Livewire

<p align="center">
  <a href="https://github.com/softwarity/livewire/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license">
  </a>
</p>

**Subscribe to a query. Get its answer, and every answer after it.**

Livewire keeps a screen in step with what a database holds, over one WebSocket,
without asking the browser to maintain the list itself.

The server says what a list is — in NestJS, Go or Quarkus, the same four answers:

```ts
// NestJS
@LiveTopic('messages')
export class MessagesSource extends WindowedSource<MessageQuery> {
  readQuery(raw) { … }                    // the trust boundary
  protected wake() { … }                  // what makes it read again
  protected keyOf(q) { … }                // what two identical questions share
  protected read(q) { … }                 // the window as it stands
}
```

```go
// Go
func (s *MessagesSource) ReadQuery(raw json.RawMessage) (any, error)              { … } // the trust boundary
func (s *MessagesSource) Wake() <-chan struct{}                                  { … } // what makes it read again
func (s *MessagesSource) Key(q any) string                                       { … } // what two identical questions share
func (s *MessagesSource) Read(ctx context.Context, q any) (livewire.Window, error) { … } // the window as it stands

registry.Register("messages", &MessagesSource{db: db})
mux.Handle("/ws", livewire.NewServer(registry, livewire.Options{}))
```

```java
// Quarkus
@LiveTopic("messages")
@ApplicationScoped
public class MessagesSource implements Source<MessageQuery> {
    public MessageQuery readQuery(JsonNode raw) { … }   // the trust boundary
    public Multi<?> wake() { … }                        // what makes it read again
    public String key(MessageQuery q) { … }             // what two identical questions share
    public Window read(MessageQuery q) { … }            // the window as it stands, on a worker
}
```

The client says what a screen shows:

```ts
// client: what this screen shows
readonly source = new LiveWindowDataSource<MessageRow>(
  (total) => this.total.set(total),
  () => this.service.resync(),
);
```

## Why not just push changes?

Because the obvious design is the wrong one. Pushing `insert` / `update` /
`delete` and letting the client keep its own list means writing, in the browser,
a predicate deciding whether a row belongs to the current filter and a
comparator deciding where it goes — two copies of what the SQL query already
says, free to drift from it. The drift is invisible until somebody is reading a
list nobody can reproduce.

Livewire pushes **the result of the query**. The window — filters, offset,
order — is part of the subscription, so scrolling and receiving are the same
operation, and the sort order stays in the database where it was written.

## Packages

| Package | |
|---|---|
| [`@softwarity/livewire-protocol`](./packages/protocol) | the wire contract, and the [normative spec](./packages/protocol/SPEC.md) |
| [`@softwarity/nestjs-livewire`](./packages/nestjs) | server implementation for NestJS |
| [`@softwarity/livewire`](./packages/angular) | client implementation for Angular |
| [`@softwarity/livewire-mock`](./packages/mock) | an in-memory server, and the [conformance scenarios](./packages/mock/src/conformance.ts) every server passes |
| [`github.com/softwarity/livewire/go`](./go) | server implementation for Go |
| [`io.softwarity:quarkus-livewire`](./quarkus) | server implementation for Quarkus |

Everything npm ships carries one version; the Go module is tagged `go/vX.Y.Z`
in the same release, and the Quarkus library carries that number too.

## What it is not

- **Not Firebase.** No database of its own, no local cache, no optimistic
  writes, no conflict resolution. It runs on your Postgres, with your SQL.
- **Not Laravel Livewire or Phoenix LiveView.** Those push HTML because the
  server owns the rendering; this pushes data and the client renders.
- **Not a generic pub/sub.** One frame opens a subscription, one closes it, one
  asks for something to be done. There is no channel to join and no topic to
  broadcast on for its own sake.

## Documentation

**[softwarity.github.io/livewire](https://softwarity.github.io/livewire/)** —
including a live demo: the real Angular client against a Livewire server running
in the page, with every frame shown both ways.

## Status

Extracted from a service in production. The protocol is specified, and four
server implementations pass the same nineteen conformance scenarios — in-memory,
NestJS, Go and Quarkus. Published: npm, the Go module proxy and Maven Central. See [TODO.md](./TODO.md) for what is
done, what is next, and why in that order.
