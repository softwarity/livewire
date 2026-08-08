# Livewire — instructions for an implementing agent

You are adding a live list to an application with Livewire. This file is the
whole brief: the model, the recipes, the rules that must not be broken, and the
symptoms that mean you broke one.

- Working **on the library** instead? Read [CLAUDE.md](./CLAUDE.md).
- Arguing about the protocol? [packages/protocol/SPEC.md](./packages/protocol/SPEC.md) is normative.

---

## 0. The model, in five lines

1. A client **subscribes to a query** over one WebSocket and receives its answer,
   then every answer after it.
2. The **window** — filters, sort, `offset`, `limit` — is part of the
   subscription. Scrolling *is* re-subscribing.
3. A source answers with the **whole window**, never a delta. The server turns
   that into a `patch`, per subscriber.
4. `updatedAt` is the **version** of a row, and it is what the diff compares.
5. A read whose window is unchanged **publishes nothing**.

Everything below follows from those. If a change you are about to make
contradicts one of them, it is the change that is wrong.

## 1. Decide what you are building

| You are writing | Use | Section |
|---|---|---|
| A long, scrollable list on a NestJS backend | `PagedSource<Filters>` | [2](#2-server--nestjs) |
| A short list, a settings row, a counter (NestJS) | `SingleWindowSource` | [2](#2-server--nestjs) |
| Anything whose question is not a page of a list (NestJS) | `WindowedSource<Q>` | [2](#2-server--nestjs) |
| The same, on a Go backend | `livewire.Source` | [3](#3-server--go) |
| The screen that shows a long list | `LiveWindowDataSource` | [4](#4-client--angular) |
| The screen that shows a short list | `liveLabels` or `LiveTopic.open` | [4](#4-client--angular) |
| A demo, a test, or a screen with no backend yet | `MockServer` | [5](#5-no-backend-yet) |

Install what you need:

```bash
npm install @softwarity/nestjs-livewire     # NestJS server
npm install @softwarity/livewire            # Angular client
npm install -D @softwarity/livewire-mock    # in-memory server, for tests and demos
go get github.com/softwarity/livewire/go    # Go server
```

## 2. Server — NestJS

### 2.1 Wire the gateway, once

```ts
// app.module.ts
import { LivewireModule } from '@softwarity/nestjs-livewire';

@Module({
  imports: [
    LivewireModule.forRoot({
      path: '/my-service/ws',
      // The only place this library touches your idea of identity. A gateway is
      // NOT an HTTP route: a global guard never sees the upgrade request, so
      // whatever that guard reads, read it again here.
      authorize: (request) => rolesOf(request).some((role) => KNOWN.includes(role)),
      refusal: () => 'no role reached this service',
    }),
    MessagesModule,
  ],
})
export class AppModule {}
```

Omitting `authorize` accepts every upgrade. That is right behind a gateway that
has already authenticated, and wrong on the open internet.

### 2.2 A long list

```ts
import { Injectable } from '@nestjs/common';
import { LiveTopic, PagedSource, onChanges, text } from '@softwarity/nestjs-livewire';
import type { JsonObject, LiveWindow } from '@softwarity/nestjs-livewire';
import type { Observable } from 'rxjs';

interface MessageFilters {
  search?: string;
  station?: string;
}

@Injectable()
@LiveTopic('messages')
export class MessagesSource extends PagedSource<MessageFilters> {
  constructor(
    private readonly messages: MessageService,
    private readonly events: EventsService,
  ) {
    super();
  }

  /** The trust boundary. What arrives is JSON off a socket: whitelist it. */
  protected readFilters(raw: JsonObject): MessageFilters {
    return { search: text(raw['search']), station: text(raw['station']) };
  }

  /** What makes two questions the same, so they share one read. */
  protected keyOfFilters(filters: MessageFilters): string {
    return [filters.search, filters.station].join('|');
  }

  /** The window as it stands. Whole, never a delta. `total` is the list length. */
  protected readPage(filters: MessageFilters, offset: number, limit: number): Observable<LiveWindow> {
    return this.messages.window(filters, offset, limit);
  }

  /** What makes it read again. Only the fact of an emission is read. */
  protected wake(): Observable<unknown> {
    return onChanges(this.events.changes);
  }
}
```

Register it as a provider in its own module. Nothing central to edit — the
registry finds it by its decorator.

`offset` and `limit` are read, clamped to `MAX_LIMIT` (200), folded into the key
and passed to `readPage` for you. Override `protected readonly pageSize = 50` to
change the default a client gets when it asks for no limit.

### 2.3 A short list, a setting, a counter

```ts
@Injectable()
@LiveTopic('stations')
export class StationsSource extends SingleWindowSource {
  protected read(): Observable<LiveWindow> {
    return this.stations.all();       // { rows: [{ id, updatedAt, label }] }
  }

  protected wake(): Observable<unknown> {
    return onChanges(this.events.changes);
  }
}
```

`readQuery` and `keyOf` are answered for you: there is one window and no
question to key on.

### 2.4 Anything else

`WindowedSource<Q>` — write the four: `readQuery(raw): Q` (public, the trust
boundary), `keyOf(query): string`, `read(query): Observable<LiveWindow>`,
`wake(): Observable<unknown>`.

### 2.5 Waking

```ts
protected wake() { return onChanges(this.events.changes); }        // a write happened
protected wake() { return of(null); }                              // static: read once
protected wake() { return onChanges(this.events.changes, 30_000); } // + a clock, see below
```

`onChanges(changes, tickMs = 0, coalesceMs = COALESCE_MS)` emits once on
subscription, then on each gathered burst. Add `tickMs` **only** when a window
moves with the clock and not with a write — a range bounded by "now", a row that
becomes late. Polling otherwise is a query per tick per open screen, spent on
nothing.

## 3. Server — Go

```go
registry := livewire.NewRegistry(0) // 0 = CoalesceDefault (300ms)
registry.Register("messages", &MessagesSource{db: db, changes: changes})

mux.Handle("/my-service/ws", livewire.NewServer(registry, livewire.Options{
    Authorize: func(r *http.Request) bool { return rolesOf(r).Any(known) },
    Refusal:   func(r *http.Request) string { return "no role reached this service" },
    Origins:   []string{"app.example.com"}, // empty means same-origin only
}))
```

```go
type query struct {
    search string
    offset int
    limit  int
}

type MessagesSource struct {
    db      *sql.DB
    changes chan struct{}
}

// The trust boundary.
func (s *MessagesSource) ReadQuery(raw json.RawMessage) (any, error) {
    asked := map[string]any{}
    _ = json.Unmarshal(raw, &asked)
    return query{
        search: livewire.Text(asked, "search"),
        offset: livewire.Whole(asked, "offset", 0),
        limit:  livewire.LimitOf(asked, "limit", 50), // clamped to MaxLimit
    }, nil
}

// Two questions with the same key share one read.
func (s *MessagesSource) Key(q any) string {
    asked := q.(query)
    return fmt.Sprintf("%s|%d|%d", asked.search, asked.offset, asked.limit)
}

// Must not be closed while the source is in use. Nothing to follow?
// Return a channel that never sends.
func (s *MessagesSource) Wake() <-chan struct{} { return s.changes }

// The window as it stands.
func (s *MessagesSource) Read(ctx context.Context, q any) (livewire.Window, error) {
    rows, total, err := s.page(ctx, q.(query))
    if err != nil {
        return livewire.Window{}, err // logged; nothing is published, the next wake retries
    }
    return livewire.Window{Rows: rows, Total: &total}, nil
}
```

A row marshals **flat** — its fields sit beside `id` and `updatedAt`:

```go
livewire.Row{
    ID:        "m-901",
    UpdatedAt: "v7",
    Data:      map[string]any{"text": "…", "station": "LFPG"},
}
```

Registration is explicit: Go has no decorators to discover, and a list of what a
server serves is worth reading anyway.

## 4. Client — Angular

Zoneless, signal-based, Angular 18+. The CDK is a peer dependency.

### 4.1 Provide the socket, once

```ts
// app.config.ts
providers: [provideLivewire({ path: '/my-service/ws', reconnectMs: 3000 })]
```

One socket per tab, opened on the first subscription and kept for the life of
the tab. A dropped socket reconnects on its own and re-subscribes every open
window. Do **not** create a client per screen.

### 4.2 A long list

```ts
@Component({ /* … */ })
export class MessagesComponent implements OnDestroy {
  private readonly topic = new LiveTopic<MessageRow>(inject(LivewireClient), 'messages');

  // A query the screen owns, so changing it re-subscribes on its own.
  private readonly filters = signal<MessageFilters>({});

  // `viewChild`, not `viewChild.required`: a viewport behind an `@if` is not
  // there on the first pass, and the effect below simply runs again when it is.
  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  readonly total = signal(0);
  readonly source = new LiveWindowDataSource<MessageRow>(
    (total) => this.total.set(total),  // the list length the server reports
    () => this.topic.resync(),         // a gap in the sequence: ask again
    100,                               // rows per window - see 4.4
  );

  constructor() {
    // A new question: a new subscription, and a snapshot to start from.
    effect(() => {
      const filters = this.filters();
      this.source.reset((offset, limit) => this.topic.window(filters, offset, limit));
    });

    // Where the eye is. An effect rather than `ngAfterViewInit`: the query is a
    // signal, so a viewport that appears later - a tab, a panel, anything
    // behind an `@if` - is picked up when it appears rather than never.
    effect(() => {
      const viewport = this.viewport();
      if (viewport) {
        this.source.track(viewport.renderedRangeStream);
      }
    });
  }

  search(filters: MessageFilters): void {
    this.filters.set(filters);
  }

  ngOnDestroy(): void {
    this.source.disconnect();
  }
}
```

```html
<cdk-virtual-scroll-viewport itemSize="48" minBufferPx="480" maxBufferPx="960">
  <div *cdkVirtualFor="let row of source" class="row"
       [class.fresh]="source.fresh(row?.id)">
    @if (row) { {{ row.text }} } @else { <span class="placeholder"></span> }
  </div>
</cdk-virtual-scroll-viewport>
```

Three things in there are load-bearing and look like they are not:

- **The data source is built in a component field**, and that is not a style
  choice: it injects that view's `ChangeDetectorRef` and calls `markForCheck()`
  on every publication, which marks the view dirty *and* notifies the zoneless
  scheduler. Without it a frame landing in a socket callback schedules nothing —
  the data is right and the screen is wrong. Built outside an injection context
  it throws, which is the intended answer: a data source with no view to repaint
  has nobody to answer.
- **`itemSize`, `minBufferPx`, `maxBufferPx`** must satisfy
  `maxBufferPx ≤ window × itemSize`. A buffer reaching past the window renders
  rows the window never loaded, and they stay placeholders for good.
- **`row` may be `undefined`.** The published array is as long as the whole list,
  with a hole wherever the window does not reach — that is what makes the
  scrollbar honest from the first frame.

`ngAfterViewInit` still works and is not deprecated, but it fires once: a
viewport rendered later never gets tracked. The effect above costs the same and
does not have that hole.

`source.fresh(id)` is true for a moment after a **patch** touched that row —
about a second, matching the `.fresh` animation. A snapshot marks nothing: it is
the answer to "what does this window hold", which is also what scrolling asks.

### 4.3 A short list

```ts
readonly stations = toSignal(liveLabels(inject(LivewireClient), 'stations'), { initialValue: [] });
```

Gives `{ id, label }[]`, kept in step. For a short list of full rows, use
`new LiveTopic<Row>(client, topic).open(query)` and feed a `LiveList`.

### 4.4 Choosing the window size

It is a **transport budget**, not a display choice:

```
rows × bytes-per-row  <  the frame ceiling you have tested
```

Some proxies silently drop a WebSocket frame past ~64 kB and close the
connection rather than the frame — the screen goes empty with no error anywhere.
100 rows suits a text row; 50 suits a wide one. **Measure before raising it**,
and never derive it from the viewport (see [8](#8-symptom--cause--fix)).

### 4.5 The indicator

```html
<lw-live-indicator />
```

```css
lw-live-indicator { --lw-live: #1b7f3b; --lw-down: #b26a00; }
```

Clicking it retries: down, it opens the socket now instead of waiting out the
delay; up, it asks every open window for a fresh snapshot. **It replaces the
refresh button — do not ship both.** On a live screen, a control offering to
fetch the list again implies that the rest of the time you are looking at
something stale.

## 5. No backend yet?

The in-memory server speaks the same protocol with no socket under it, and runs
the same conformance scenarios as the NestJS and Go servers.

```ts
const server = new MockServer();
server.register('messages', {
  readQuery: (raw) => ({ offset: Number(raw?.['offset'] ?? 0), limit: Number(raw?.['limit'] ?? 50) }),
  windowFor: (page) => ({ rows: rows.slice(page.offset, page.offset + page.limit), total: rows.length }),
});

// The client, unchanged, with a connection that has no network under it.
provideLivewire({ path: '', connect: () => server.connect() });

rows.unshift(newRow);
server.touched('messages');   // what a write announces
```

`new MockServer({ authorize, refusal, onTraffic })` — `onTraffic(direction, frame)`
reports every frame both ways, which is how you show or assert the protocol.

Running the conformance suite against your own server:

```ts
import { Conversation, SCENARIOS } from '@softwarity/livewire-mock';

for (const scenario of SCENARIOS) {
  it(`${scenario.spec} ${scenario.name}`, async () => {
    const wire: Wire = { ready, send, onFrame, touch };   // 4 functions, that is all
    await wire.ready;
    await scenario.run(new Conversation(wire));
  });
}
```

A conforming server exposes `rows` (a new row arrives at the **top**) and
`still` (never changes).

## 6. Rules you must not break

Each one has a failure mode that is invisible until it is expensive.

### 6.1 Everything a row shows must be in its version

`updatedAt` is what the diff compares. Not just what a write touched: **anything
the row displays**.

```ts
// WRONG: the row shows a lateness computed from the clock, but the version
// only moves when someone writes. The window compares equal, nothing is
// published, and the screen keeps a value that stopped being true.
updatedAt: row.modifiedAt.toISOString()

// RIGHT: fold in whatever else is displayed.
updatedAt: `${row.modifiedAt.toISOString()}|${isLate ? 'late' : 'on-time'}`
```

A version may be any string. Never reuse one for a different state of the same row.

### 6.2 A source returns the whole window, never a delta

Computing the patch is the server's job, per subscriber, because only it knows
what that client actually received. Return the rows the window holds now.

### 6.3 Never rebuild the list on the client

No client-side predicate deciding whether a row belongs to the filter, no
client-side comparator deciding where it goes. Those are copies of what the SQL
query already says, free to drift from it. Apply the frames; the order in
`order` is the answer.

### 6.4 The window size is a constant per screen

Derived from the viewport, it changes with the rendered range (58 rows here, 59
there), and every change is a new question, whose answer republishes, which
makes the viewport emit again. The renderer freezes outright.

### 6.5 One subscription id per window, never reused

A patch still in flight from the previous window lands on the new one, whose
sequence restarts — it reads as a gap, resyncs, and nothing publishes meanwhile.
`LiveTopic` handles this; if you call `client.watch` directly, you own it.

## 7. Before you claim it works

- [ ] Two tabs open on the same list. One write in the database, **both** move,
      with no refresh anywhere.
- [ ] A write that changes nothing this window shows sends **no frame**
      (watch the socket in devtools; the frame count must not move).
- [ ] Scroll fast to the middle of a long list: one `subscribe` per window move,
      no permanent placeholders, no frozen renderer.
- [ ] Restart the backend: the indicator goes amber, comes back green, and the
      list repopulates without anyone touching the screen.
- [ ] A row whose displayed value derives from the clock changes on screen with
      no write behind it (rule 6.1).
- [ ] A row that only *moved* is not re-sent: three arrivals at the top cost
      three rows on the wire, not a page.
- [ ] The refusal path: an unauthorised socket receives an `error` frame **and
      then** a close, not a bare disconnection.

## 8. Symptom → cause → fix

| Symptom | Cause | Fix |
|---|---|---|
| Frames arrive, the screen never repaints | The data source was built away from the component that shows the list | Build it in that component's own field, so the view it repaints is that one |
| A band of rows stays placeholder forever | Viewport buffers reach past the window | `maxBufferPx ≤ window × itemSize` |
| The renderer freezes; `subscribe` loops | Window size derived from the rendered range | Make it a constant |
| Many sockets for one list | A client per screen, or `rxjs/webSocket` | One `provideLivewire`; the client is root-provided |
| A displayed value goes stale, nothing arrives | It is not folded into `updatedAt` | Rule 6.1 |
| The list resyncs constantly | A subscription id reused across windows | A fresh id per window (`LiveTopic`) |
| Socket is up, no frame ever arrives | `wake()` never emits | `onChanges(...)`, or `of(null)` for a static list |
| `error` frame naming the topic | No source answers that topic | Check `@LiveTopic` / `Register` spelling and that the provider is registered |
| The screen goes empty above a certain window size | A proxy dropped an over-sized frame | Lower the window (section 4.4) |
| Everything repaints on every write | The window is genuinely changing — or `signatureOf` is being bypassed | Compare `total`/`pivot` too; do not diff windows by hand |
| A late subscriber sees a patch it cannot place | A patch was broadcast rather than computed per subscriber | Rule 6.2 |

## 9. API reference

### `@softwarity/nestjs-livewire`

| | |
|---|---|
| `LivewireModule.forRoot({ path, authorize?, refusal? })` | The gateway. Once. |
| `@LiveTopic(topic)` | Marks a provider as a source. Found by `DiscoveryService`. |
| `PagedSource<Filters>` | `readFilters`, `keyOfFilters`, `readPage`, `wake`; `pageSize = 50` |
| `SingleWindowSource` | `read`, `wake` |
| `WindowedSource<Q>` | `readQuery`, `keyOf`, `read`, `wake` |
| `onChanges(changes, tickMs?, coalesceMs?)` | The usual `wake` |
| `text(v)` / `whole(v, fallback)` / `limitOf(v, fallback)` | Query readers, clamped |
| `COALESCE_MS` = 300, `MAX_LIMIT` = 200 | |
| `LivewireRegistry.register(topic, source)` | Hand registration, for tests |

### `@softwarity/livewire` (Angular)

| | |
|---|---|
| `provideLivewire({ path, reconnectMs?, connect? })` | The one socket |
| `LivewireClient` | `live` signal, `watch(id, topic, query)`, `resync(id)`, `retry()` |
| `LiveTopic<Row>(client, topic)` | `window(query, offset, limit)`, `open(query)`, `resync()` |
| `LiveWindowDataSource<Row>(onTotal?, onDrift?, window?)` | `track`, `reset`, `ensure`, `at`, `length`, `pivot`, `fresh`, `changes`, `disconnect`. Built in an injection context. |
| `LiveList<Row>` | `apply(frame)` → false on drift; `rows`, `total`, `pivot` signals |
| `liveLabels(client, topic, query?)` | `Observable<{ id, label }[]>` |
| `LiveIndicatorComponent` | `<lw-live-indicator>`, `--lw-live` / `--lw-down` |

### `github.com/softwarity/livewire/go`

| | |
|---|---|
| `NewRegistry(coalesce)` / `Register(topic, source)` | |
| `NewServer(registry, Options{Authorize, Refusal, Origins, Logger})` | an `http.Handler` |
| `Source` | `ReadQuery(json.RawMessage) (any, error)`, `Key(any) string`, `Wake() <-chan struct{}`, `Read(ctx, any) (Window, error)` |
| `Row{ID, UpdatedAt, Data}` / `Window{Rows, Total *int, Pivot *int}` | |
| `Text` / `Whole` / `LimitOf`, `CoalesceDefault`, `MaxLimit` | |

### `@softwarity/livewire-mock`

| | |
|---|---|
| `new MockServer({ authorize?, refusal?, onTraffic? })` | |
| `.register(topic, { readQuery?, windowFor })`, `.connect()`, `.touched(topic?)` | |
| `SCENARIOS`, `Conversation`, `Wire` | The conformance suite |

## 10. On the wire, for debugging

```jsonc
// client → server
{ "event": "subscribe",   "data": { "id": "messages:3", "topic": "messages",
                                    "query": { "search": "delay", "offset": 100, "limit": 50 } } }
{ "event": "unsubscribe", "data": { "id": "messages:3" } }

// server → client — all three carry event "update"
{ "event": "update", "data": { "id": "messages:3", "type": "snapshot",
                               "rows": [ … ], "total": 13000, "sequence": 1 } }
{ "event": "update", "data": { "id": "messages:3", "type": "patch",
                               "upserted": [ { "id": "m-901", "updatedAt": "v7" } ],
                               "removed": [ "m-850" ],
                               "order": [ "m-901", "m-899", … ],
                               "total": 13001, "sequence": 42 } }
{ "event": "update", "data": { "id": "connection", "type": "error", "reason": "…" } }
```

`sequence` starts at 1 per subscription and increments by one per frame; `error`
frames do not consume a number. Subscribing under an open id **replaces** it and
restarts the sequence. A refused socket gets the `error` frame **first**, then a
close with code `1008`.

## 11. Things not to do

- **Do not** add a refresh button beside the indicator (4.5).
- **Do not** send `insert` / `update` / `delete` events "for efficiency" (6.3).
- **Do not** cache pages on the client. The window is the question; there is
  never a second one in flight.
- **Do not** re-sort or re-filter rows in the browser. The order in `order` is
  the answer.
- **Do not** put per-topic or per-row permissions in the transport: the contract
  has none. Filter inside the source.
- **Do not** widen a window to avoid a scroll. See the frame ceiling (4.4).
- **Do not** publish on every read "to be safe". Silence on an unchanged window
  is what makes a busy feed usable (6.1's neighbour: SPEC §5.3).
