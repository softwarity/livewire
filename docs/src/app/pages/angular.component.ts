import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-angular',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>Angular client</h2>

    <app-code lang="bash" [code]="install" />

    <p>
      Zoneless, signal-based, and built on one plain <code>WebSocket</code>. Angular 18 and up; the CDK
      is a peer dependency because the virtual-scroll data source is the part most screens want.
    </p>

    <h3>Provide the socket</h3>

    <app-code lang="ts" [code]="provide" />

    <p>
      One socket per tab, opened on the first subscription and kept for as long as the tab lives. A
      dropped socket reconnects on its own and every open window is asked for again — no screen has to
      know it happened.
    </p>

    <div class="callout">
      <code>connect</code> replaces how the socket is opened. That is how the
      <a routerLink="/demo">demo on this site</a> runs the real client with no backend at all.
    </div>

    <h3>A long list</h3>

    <p>
      <code>LiveWindowDataSource</code> is a CDK <code>DataSource</code> that publishes an array as long
      as the whole list, with a hole wherever the window does not reach. That is what makes the scrollbar
      tell the truth from the first frame: its height is the list, not the part being watched.
    </p>

    <app-code lang="ts" [code]="screen" />

    <app-code lang="html" [code]="markup" />

    <h3>Three things not to improve</h3>

    <p>Each of these cost a debugging session. They look like accidents; they are not.</p>

    <table>
      <thead>
        <tr><th>Looks improvable</th><th>What happens if you do</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>Dropping the <code>ChangeDetectorRef</code> passed to the data source, since nothing reads it</td>
          <td>A zoneless application schedules nothing when a frame lands in a socket callback: the data is right and the screen is wrong. The data source calls <code>markForCheck()</code> with it. Without one, a <code>source.revision()</code> read in the template is the other way — one of the two is required.</td>
        </tr>
        <tr>
          <td>Sizing the window from the viewport instead of fixing it</td>
          <td>The rendered range changes with the viewport — 58 rows here, 59 there — and every change is a new question, whose answer republishes, which makes the viewport emit again. The renderer freezes.</td>
        </tr>
        <tr>
          <td>Letting the viewport's buffers reach past the window</td>
          <td>The buffer renders rows the window never loaded, and they stay placeholders for good. Keep <code>minBufferPx</code> and <code>maxBufferPx</code> inside <code>window × itemSize</code>.</td>
        </tr>
      </tbody>
    </table>

    <div class="callout warn">
      The window size is a <strong>transport budget</strong>, not a display choice. Some proxies silently
      drop a WebSocket frame past ~64&nbsp;kB and close the connection rather than the frame — the screen
      goes empty with no error anywhere. The rule is <code>rows × bytes-per-row &lt; the ceiling you
      tested</code>, and the bytes differ per screen. Measure before raising it.
    </div>

    <h3>A short list</h3>

    <p>
      A filter list, a settings row, a counter: bounded by its filters rather than by a scroll position,
      so there is no offset to send.
    </p>

    <app-code lang="ts" [code]="labels" />

    <h3>The live indicator</h3>

    <p>
      <code>&lt;lw-live-indicator&gt;</code> says whether the socket is up, and gives the reader the one
      thing to do about it when it is not. Clicking it retries: down, that opens the socket now instead of
      waiting out the delay; up, it asks every open window for a fresh snapshot.
    </p>

    <app-code lang="html" [code]="indicator" />

    <app-code lang="text" [code]="theming" />

    <div class="callout">
      It deliberately does <em>not</em> report whether anything is arriving — a quiet feed at three in the
      morning is not a fault. And it replaces the refresh button rather than joining it: on a live screen,
      a control offering to fetch the list again implies that the rest of the time you are looking at
      something stale.
    </div>

    <h3>What is exported</h3>

    <table>
      <tbody>
        <tr><td><code>provideLivewire</code></td><td>The one socket, configured.</td></tr>
        <tr><td><code>LivewireClient</code></td><td><code>watch</code>, <code>resync</code>, <code>retry</code>, and a <code>live</code> signal.</td></tr>
        <tr><td><code>LiveTopic</code></td><td>One screen's window on one topic: unique ids, and a resync that names the right one.</td></tr>
        <tr><td><code>LiveList</code></td><td>Snapshot then patches, applied. Answers <code>false</code> when the two sides have drifted.</td></tr>
        <tr><td><code>LiveWindowDataSource</code></td><td>The CDK data source above.</td></tr>
        <tr><td><code>liveLabels</code></td><td>A short list of <code>&#123; id, label &#125;</code>, kept in step.</td></tr>
        <tr><td><code>LiveIndicatorComponent</code></td><td>The dot.</td></tr>
      </tbody>
    </table>
  `,
})
export class AngularComponent {
  protected readonly install = `npm install @softwarity/livewire`;

  protected readonly provide = `// app.config.ts
providers: [
  provideLivewire({ path: '/my-service/ws', reconnectMs: 3000 }),
]

// A demo or a test with no backend: the same client, another connection.
provideLivewire({ path: '', connect: () => server.connect() })`;

  protected readonly screen = `export class MessagesComponent implements OnDestroy {
  private readonly topic = new LiveTopic<MessageRow>(inject(LivewireClient), 'messages');

  // A query the screen owns, so changing it re-subscribes on its own.
  private readonly filters = signal<MessageFilters>({});

  // \`viewChild\`, not \`viewChild.required\`: a viewport behind an \`@if\` is not
  // there on the first pass, and the effect below simply runs again when it is.
  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  readonly total = signal(0);
  readonly source = new LiveWindowDataSource<MessageRow>(
    (total) => this.total.set(total),  // the list length the server reports
    () => this.topic.resync(),         // a gap in the sequence: ask again
    100,                               // rows per window - see 4.4
    inject(ChangeDetectorRef),         // what repaints a zoneless screen
  );

  constructor() {
    // A new question: a new subscription, and a snapshot to start from.
    effect(() => {
      const filters = this.filters();
      this.source.reset((offset, limit) => this.topic.window(filters, offset, limit));
    });

    // Where the eye is. An effect rather than \`ngAfterViewInit\`: the query is a
    // signal, so a viewport that appears later - a tab, a panel, anything
    // behind an \`@if\` - is picked up when it appears rather than never.
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
}`;

  protected readonly markup = `<cdk-virtual-scroll-viewport itemSize="48" minBufferPx="480" maxBufferPx="960">
  <div *cdkVirtualFor="let row of source" class="row"
       [class.fresh]="source.fresh(row?.id)">
    @if (row) { {{ row.text }} } @else { <span class="placeholder"></span> }
  </div>
</cdk-virtual-scroll-viewport>`;

  protected readonly labels = `// The values that actually exist, kept in step. Not a constant in the screen:
// offering a filter for something an installation has never seen answers nothing.
readonly stations = toSignal(liveLabels(inject(LivewireClient), 'stations'), { initialValue: [] });`;

  protected readonly indicator = `<lw-live-indicator />`;

  protected readonly theming = `lw-live-indicator { --lw-live: #1b7f3b; --lw-down: #b26a00; }`;
}
