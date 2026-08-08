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
  (total) => this.total.set(total),
  () => this.messages.resync(),
);
readonly revision = this.source.revision;

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
<cdk-virtual-scroll-viewport [attr.data-revision]="revision()" [itemSize]="44">
  <table mat-table [dataSource]="source">…</table>
</cdk-virtual-scroll-viewport>

<lw-live-indicator />
```

## Three rules that are not obvious

Each of these cost a debugging session in the application this came from.

**1. Read `revision()` in the template.** A row arriving from a socket callback
schedules no change detection at all in a zoneless application, and the screen
holds stale rows. A signal read in the view is how a push is made to repaint.
`ApplicationRef.tick()` is the other way, and it throws when it lands inside a
cycle already in progress.

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
