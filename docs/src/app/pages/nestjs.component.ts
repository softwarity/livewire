import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-nestjs',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>NestJS server</h2>

    <app-code lang="bash" [code]="install" />

    <h3>Wiring the gateway</h3>

    <p>
      One module call, once. It builds the gateway on the path you give it — the path is a decorator
      argument, so the configured gateway class is created inside <code>forRoot</code> rather than read
      from a token at runtime.
    </p>

    <app-code lang="ts" [code]="module" />

    <div class="callout warn">
      <strong>A gateway is not an HTTP route.</strong> A global guard never sees the upgrade request, so
      whatever that guard reads, read it again in <code>authorize</code>. Left out, every upgrade is
      accepted — right behind a gateway that has already authenticated, wrong on the open internet.
    </div>

    <h3>A source</h3>

    <p>
      A source is an ordinary provider carrying <code>&#64;LiveTopic</code>. Register it in its own
      module; the registry finds it through Nest's <code>DiscoveryService</code>, so there is no central
      list to keep up to date.
    </p>

    <app-code lang="ts" [code]="source" />

    <h3>Which base to extend</h3>

    <table>
      <thead>
        <tr><th>Base</th><th>What you write</th><th>When</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>PagedSource&lt;Filters&gt;</code></td>
          <td><code>readFilters</code>, <code>keyOfFilters</code>, <code>readPage</code>, <code>wake</code></td>
          <td>A long list. <code>offset</code> and <code>limit</code> are read, clamped, keyed and passed for you.</td>
        </tr>
        <tr>
          <td><code>SingleWindowSource</code></td>
          <td><code>read</code>, <code>wake</code></td>
          <td>One window, no query: a filter list, a settings row, a counter.</td>
        </tr>
        <tr>
          <td><code>WindowedSource&lt;Q&gt;</code></td>
          <td>the four above, plus <code>readQuery</code> and <code>keyOf</code></td>
          <td>Anything whose question is not a page of a list.</td>
        </tr>
      </tbody>
    </table>

    <h3>What the base class does for you</h3>

    <ul>
      <li><strong>One read per question.</strong> Ten screens asking the same thing share one query.</li>
      <li><strong>Silence on an unchanged read.</strong> A busy feed does not repaint a screen it did not move.</li>
      <li><strong>Bursts gathered.</strong> A salvo of writes becomes one read — <code>COALESCE_MS</code>, 300&nbsp;ms by default.</li>
      <li><strong>The diff, per client.</strong> A screen that joins mid-stream gets a snapshot, and its patches are computed against the rows it holds.</li>
      <li><strong>Cleanup.</strong> The last watcher leaves, the read stops.</li>
    </ul>

    <div class="callout">
      Sharing is <em>reference-counted, not cached</em>. A completed window keeps its key — a static list
      whose <code>wake()</code> is <code>of(null)</code> completes immediately, and an implementation that
      dropped the key on completion would hand every later subscriber its own private read.
    </div>

    <h3>Waking a source</h3>

    <p>
      <code>wake()</code> is the one thing the contract says nothing about: it is whatever tells this
      source it may have something new to say. Only the fact of an emission is read, never its value.
    </p>

    <app-code lang="ts" [code]="wake" />

    <h3>Reading a query</h3>

    <p>
      <code>readQuery</code> — or <code>readFilters</code> on a paged source — is the trust boundary.
      What arrives is JSON off a socket: whitelist it, default it, clamp it, and hand back something
      <code>read</code> can act on without checking again.
    </p>

    <table>
      <thead>
        <tr><th>Helper</th><th></th></tr>
      </thead>
      <tbody>
        <tr><td><code>text(value)</code></td><td>A trimmed, non-empty string, or <code>undefined</code>.</td></tr>
        <tr><td><code>whole(value, fallback)</code></td><td>A non-negative integer, or the fallback.</td></tr>
        <tr><td><code>limitOf(value, fallback)</code></td><td>The same, clamped to <code>MAX_LIMIT</code> (200) — a window is a transport budget, and the client does not get to set it.</td></tr>
      </tbody>
    </table>

    <h3>Commands and notifications</h3>

    <p>
      Level 2, and optional. A command is marked on a <strong>method</strong>, unlike
      <code>&#64;LiveTopic</code>: a topic is a list and there is one per class, while commands come in
      families sharing dependencies.
    </p>

    <app-code lang="ts" [code]="commands" />

    <div class="callout warn">
      <strong>What a command changed does not go in its answer.</strong> A list it touched is republished
      by its own subscription, on that source's schedule. Putting the new rows in <code>result</code>
      would be a second version of them, free to disagree with the one on screen.
    </div>

    <div class="callout">
      <code>LivewireModule</code> is global, so <code>LivewireNotifier</code> is injectable in any feature
      module — <code>forRoot</code> runs once at the root and there is no second chance to import it.
    </div>

    <h3>The one rule to remember</h3>

    <div class="callout warn">
      <code>updatedAt</code> is the version of a row, and <strong>everything the row shows has to be in
      it</strong>. A value read from the clock changes with no write behind it: a version that ignores it
      makes the server believe the row unchanged, nothing is published, and the client keeps a value that
      stopped being true. See <a routerLink="/protocol">the protocol</a>.
    </div>

    <h3>Testing a source</h3>

    <p>
      A source is an ordinary provider: instantiate it and subscribe. For the wire itself, the
      <a routerLink="/conformance">conformance suite</a> runs against a real socket in a few lines, and
      the registry accepts a hand-registered source so a test needs no decorator scan.
    </p>

    <app-code lang="ts" [code]="testing" />
  `,
})
export class NestjsComponent {
  protected readonly install = `npm install @softwarity/nestjs-livewire`;

  protected readonly module = `// app.module.ts
@Module({
  imports: [
    LivewireModule.forRoot({
      path: '/my-service/ws',
      authorize: (request) => rolesOf(request).some((role) => KNOWN.includes(role)),
      refusal: () => 'no role reached this service',
    }),
    MessagesModule,
  ],
})
export class AppModule {}`;

  protected readonly source = `@Injectable()
@LiveTopic('messages')
export class MessagesSource extends PagedSource<MessageFilters> {
  constructor(private readonly messages: MessageService, private readonly events: EventsService) {
    super();
  }

  protected readFilters(raw: JsonObject): MessageFilters {
    return { search: text(raw['search']), station: text(raw['station']) };
  }

  protected keyOfFilters(filters: MessageFilters): string {
    return [filters.search, filters.station].join('|');
  }

  protected readPage(filters: MessageFilters, offset: number, limit: number): Observable<LiveWindow> {
    return this.messages.window(filters, offset, limit);
  }

  protected wake(): Observable<unknown> {
    return onChanges(this.events.changes);
  }
}`;

  protected readonly wake = `// A broker, a trigger, an EventEmitter - anything that emits on a write.
protected wake() {
  return onChanges(this.events.changes);
}

// Nothing to follow: read once, and never again.
protected wake() {
  return of(null);
}

// Nothing to follow, but the answer moves with the clock. The second argument
// is a floor, and it is the honest way to say "this row ages".
protected wake() {
  return onChanges(this.events.changes, 30_000);
}`;

  protected readonly commands = `@Injectable()
export class FlightCommands {
  constructor(
    private readonly flights: FlightService,
    private readonly livewire: LivewireNotifier,
  ) {}

  // Something to do, answered by exactly one ack - whatever happens. Throwing,
  // or an observable that errors, refuses it: the message becomes the reason.
  @LiveCommand('flight.acknowledge')
  acknowledge(payload: JsonObject): Observable<void> {
    return this.flights.acknowledge(text(payload['id']));
  }

  // Something that happened, told once, outside any window.
  finished(count: number): void {
    this.livewire.notify('import.finished', { count });
  }
}`;

  protected readonly testing = `const registry = app.get(LivewireRegistry);
registry.register('rows', new FakeSource());`;
}
