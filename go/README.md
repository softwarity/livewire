# livewire (Go)

Live query synchronisation: a client subscribes to a question, receives its
answer, then every answer after it.

```bash
go get github.com/softwarity/livewire/go
```

There is no registry to publish to — the import path is the repository, and a
version is a git tag. `go/v0.1.0` is what this module is fetched under; the npm
packages carry `v0.1.0` for the same release.

## A server

```go
registry := livewire.NewRegistry(0) // 0 = default coalescing window
registry.Register("messages", &MessagesSource{db: db})

mux.Handle("/my-service/ws", livewire.NewServer(registry, livewire.Options{
    Authorize: func(r *http.Request) bool { return rolesOf(r).Any(known) },
    Refusal:   func(r *http.Request) string { return "no role reached this service" },
}))
```

Registration is explicit. Go has no annotations to discover, and a list of what
a server serves is worth reading anyway.

## A source

```go
type MessagesSource struct{ db *sql.DB; changes chan struct{} }

func (s *MessagesSource) ReadQuery(raw json.RawMessage) (any, error) {
    asked := map[string]any{}
    _ = json.Unmarshal(raw, &asked)
    return query{
        search: livewire.Text(asked, "search"),
        offset: livewire.Whole(asked, "offset", 0),
        limit:  livewire.LimitOf(asked, "limit", 50),
    }, nil
}

func (s *MessagesSource) Key(q any) string { … }        // two identical questions
func (s *MessagesSource) Wake() <-chan struct{} { … }   // what makes it read again
func (s *MessagesSource) Read(ctx context.Context, q any) (livewire.Window, error) { … }
```

## What the registry does for you

- **One read per question.** Ten clients asking the same thing share one query.
- **Silence on an unchanged read.** A busy feed does not repaint a screen it did
  not move.
- **Bursts gathered.** A salvo of wakes becomes one read.
- **The diff, per subscription.** A client that joins mid-stream gets a
  snapshot, and its patches are computed against the rows it actually holds.
- **Cleanup.** The last watcher leaves, the read stops and the entry is dropped.

## The one rule to remember

`UpdatedAt` is the version of a row, and **everything the row shows has to be in
it** — not only what a write touched. A value read from the clock changes with
no write behind it, and a version that ignores it makes the server believe the
row unchanged: nothing is published and the client keeps a value that stopped
being true.

See [SPEC.md](../packages/protocol/SPEC.md) for the contract in full. Where this
implementation and the specification disagree, the specification is right.
