# @softwarity/livewire

Live query synchronisation for Angular. A screen subscribes to a query over one
WebSocket; it gets the answer, then every answer after it.

```ts
// app.config.ts
providers: [provideLivewire({ path: '/my-service/ws' })];
```

```ts
@Injectable()
export class MessagesService {
  private readonly topic = new LiveTopic<MessageRow>(inject(LivewireClient), 'messages');

  window = (query: object, offset: number, limit: number) => this.topic.window(query, offset, limit);
  resync = () => this.topic.resync();
}
```

```ts
readonly source = new LiveWindowDataSource<MessageRow>(
  () => this.messages.resync(),   // a gap in the sequence: ask again
  100,                            // rows per window - a transport budget
);

// What the list holds, as signals: read them in a template, derive from them
// in a `computed`. `source.length()` is what the server says the list is.

constructor() {
  effect(() => {
    const query = this.queryOf();
    this.source.reset((offset, limit) => this.messages.window(query, offset, limit));
  });
  effect(() => {
    const viewport = this.viewport();
    if (viewport) this.source.track(viewport.renderedRangeStream);
  });
}
```

```html
<cdk-virtual-scroll-viewport [itemSize]="44">
  <table mat-table [dataSource]="source">…</table>
</cdk-virtual-scroll-viewport>

<lw-live-indicator />
```

## Three rules that are not obvious

Each of these cost a debugging session in the application this came from.

**1. Build the data source in the component that shows the list.** A row
arriving from a socket callback schedules no change detection at all in a
zoneless application: the field is right and the screen is wrong. Built in a
component field, the data source injects that view's `ChangeDetectorRef` and
calls `markForCheck()` on every publication — which marks the view dirty *and*
notifies the zoneless scheduler. Built outside an injection context it throws,
and that is the intended answer: a data source with no view to repaint has
nobody to answer. (`ApplicationRef.tick()` is the other way and the wrong one:
it throws when it lands inside a cycle already in progress.)

**2. The window size is a constant per screen, never derived from the
viewport.** Deriving it loops: publish → the viewport re-measures → a new window
→ publish. It is a *transport* budget anyway — some proxies silently drop a
frame past ~64 kB — so it is `rows × bytes-per-row < the ceiling you tested`.
Measure before raising it: the failure gives no clue, just an empty screen.

**3. Viewport buffers have to fit inside the window**, with room to spare. The
rendered range is what the window must cover; a viewport rendering nearly as
many rows as the window holds leaves no hysteresis, and it moves on every
scrolled pixel.

## No backend yet?

`@softwarity/livewire-mock` speaks the same protocol in memory:

```ts
const server = new MockServer().register('messages', { windowFor: () => ({ rows, total: rows.length }) });
provideLivewire({ path: '', connect: () => server.connect() });
```

Same for a demo, and for tests.

## Theming the indicator

```css
lw-live-indicator {
  --lw-live: #1b7f3b;
  --lw-down: #b26a00;
}
```

See [SPEC.md](../protocol/SPEC.md) for the contract this speaks.
