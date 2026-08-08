# @softwarity/nestjs-livewire

Live query synchronisation for NestJS. A screen subscribes to a query over one
WebSocket; it gets the answer, then every answer after it.

```ts
// app.module.ts
LivewireModule.forRoot({
  path: '/my-service/ws',
  authorize: (request) => rolesOf(request).some((role) => KNOWN.includes(role)),
});
```

```ts
@Injectable()
@LiveTopic('messages')
export class MessagesSource extends PagedSource<MessageFilters> {
  constructor(private readonly messages: MessageService, private readonly events: EventsService) {
    super();
  }

  protected readFilters(raw: JsonObject): MessageFilters {
    return { search: text(raw['search']) };
  }

  protected keyOfFilters(filters: MessageFilters): string {
    return filters.search ?? '';
  }

  protected readPage(filters: MessageFilters, offset: number, limit: number) {
    return this.messages.window(filters, offset, limit);
  }

  protected wake() {
    return onChanges(this.events.changes);
  }
}
```

Register it as a provider in its own module. There is nothing central to edit -
the registry finds it by its decorator.

## What the base class does for you

- **One read per question.** Ten screens asking the same thing share one query.
- **Silence on an unchanged read.** A busy feed does not repaint a screen it did
  not move.
- **Bursts gathered.** A salvo of writes becomes one read.
- **The diff, per client.** A screen that joins mid-stream gets a snapshot, and
  its patches are computed against the rows it actually holds.
- **Cleanup.** The last watcher leaves, the read stops.

## Which base to extend

| | |
|---|---|
| `PagedSource<Filters>` | a long list: `offset`/`limit` are read, keyed and passed for you |
| `SingleWindowSource` | one window, no query: a filter list, a setting |
| `WindowedSource<Q>` | anything else - you write `readQuery` and `keyOf` too |

## The one rule to remember

`updatedAt` is the version of a row, and **everything the row shows has to be in
it** - not only what a write touched. A value read from the clock changes with no
write behind it, and a version that ignores it makes the server believe the row
unchanged: nothing is published and the client keeps a value that stopped being
true.

See [SPEC.md](../protocol/SPEC.md) for the contract in full.
