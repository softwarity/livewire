import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { BrandComponent } from '../brand/brand.component';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-getting-started',
  imports: [CodeComponent, RouterLink, MatIconModule, BrandComponent],
  styles: [
    `
      .features {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px;
        margin: 0 0 28px 0;
      }
      .feature-card {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 14px 16px;
        background-color: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        text-decoration: none;
        transition: all 0.15s;
      }
      .feature-card:hover {
        border-color: var(--accent-purple);
        background-color: rgba(163, 113, 247, 0.1);
        text-decoration: none;
        transform: translateY(-1px);
      }
      /* A brand mark and a Material icon are both sized from here. */
      .feature-icon {
        font-size: 1.4rem;
        width: 1.4rem;
        height: 1.4rem;
        line-height: 1;
        color: var(--accent-purple);
      }
      .feature-title {
        font-weight: 600;
        color: var(--text-primary);
        font-size: 0.95rem;
      }
      .feature-desc {
        color: var(--text-secondary);
        font-size: 0.85rem;
        line-height: 1.45;
      }
      .feature-desc code {
        font-size: 0.85em;
      }
    `,
  ],
  template: `
    <h2>Getting started</h2>

    <p>
      <strong>Livewire</strong> keeps a screen in step with what a database holds. A client subscribes
      to a <em>query</em> over one WebSocket; it receives the answer, then every answer after it. No
      polling, no refresh button, and no list maintained twice.
    </p>

    <div class="callout">
      <strong>The idea in one line:</strong> the window — filters, sort, <code>offset</code>,
      <code>limit</code> — is part of the subscription. Scrolling and receiving are the same operation,
      which is what makes a <em>paged</em> list pushable at all.
    </div>

    <h3>What is in the box</h3>

    <div class="features">
      <a routerLink="/protocol" class="feature-card">
        <mat-icon class="feature-icon">swap_horiz</mat-icon>
        <span class="feature-title">One protocol</span>
        <span class="feature-desc">Two client frames, three server frames, and a normative spec.</span>
      </a>
      <a routerLink="/nestjs" class="feature-card">
        <app-brand class="feature-icon" brand="nestjs" />
        <span class="feature-title">NestJS server</span>
        <span class="feature-desc">A base class, a decorator, and your query. The rest is done.</span>
      </a>
      <a routerLink="/go" class="feature-card">
        <app-brand class="feature-icon" brand="go" />
        <span class="feature-title">Go server</span>
        <span class="feature-desc">The same protocol, one <code>http.Handler</code>, no reflection.</span>
      </a>
      <a routerLink="/angular" class="feature-card">
        <app-brand class="feature-icon" brand="angular" />
        <span class="feature-title">Angular client</span>
        <span class="feature-desc">Signals, one socket per tab, a virtual-scroll data source.</span>
      </a>
      <a routerLink="/conformance" class="feature-card">
        <mat-icon class="feature-icon">fact_check</mat-icon>
        <span class="feature-title">Conformance suite</span>
        <span class="feature-desc">The scenarios all three servers pass, run in CI.</span>
      </a>
      <a routerLink="/demo" class="feature-card">
        <mat-icon class="feature-icon">bolt</mat-icon>
        <span class="feature-title">Live demo</span>
        <span class="feature-desc">The real client against a server running in this page.</span>
      </a>
    </div>

    <h3>Install</h3>

    <app-code lang="bash" [code]="install" />

    <p>Or, for a Go server:</p>

    <app-code lang="bash" [code]="installGo" />

    <h3>The server: what this list is</h3>

    <p>
      A source answers one question: <em>what does this window hold, right now</em>. It never computes
      a delta — that is the server's business, and it is done per subscriber.
    </p>

    <app-code lang="ts" [code]="source" />

    <p>
      Register it as a provider in its own module. There is nothing central to edit — the registry
      finds it by its decorator.
    </p>

    <h3>The client: what this screen shows</h3>

    <app-code lang="ts" [code]="provide" />

    <app-code lang="ts" [code]="screen" />

    <app-code lang="html" [code]="markup" />

    <p>
      That is the whole integration. The viewport's rendered range moves the window, the window is
      re-subscribed, and the server answers with a snapshot — then patches until the screen asks
      something else.
    </p>

    <h3>The one rule to remember</h3>

    <div class="callout warn">
      <strong>Everything a row shows has to be in its version</strong> — not only what a write touched.
      <code>updatedAt</code> is what the diff compares. A value derived from the clock (is it late? which
      side of "now" is it on?) changes with no write behind it: a version that ignores it makes the
      server believe the row unchanged, nothing is published, and the client keeps a value that stopped
      being true.
    </div>

    <h3>What it is not</h3>

    <ul>
      <li>
        <strong>Not Firebase.</strong> No database of its own, no local cache, no optimistic writes, no
        conflict resolution. It runs on your Postgres, with your SQL.
      </li>
      <li>
        <strong>Not Laravel Livewire or Phoenix LiveView.</strong> Those push HTML, because the server
        owns the rendering. This pushes data and the client renders.
      </li>
      <li>
        <strong>Not a generic pub/sub.</strong> One client frame opens a subscription, one closes it.
        That is the whole vocabulary.
      </li>
    </ul>

    <h3>Status</h3>

    <p>
      Extracted from a service in production. The protocol is specified and frozen enough to implement
      against; three server implementations pass the same
      <a routerLink="/conformance">conformance suite</a>. See
      <a href="https://github.com/softwarity/livewire/blob/main/TODO.md" target="_blank" rel="noopener">TODO.md</a>
      for what is done, what is next, and why in that order.
    </p>
  `,
})
export class GettingStartedComponent {
  protected readonly install = `npm install @softwarity/nestjs-livewire   # the server
npm install @softwarity/livewire           # the Angular client`;

  protected readonly installGo = `go get github.com/softwarity/livewire/go`;

  protected readonly source = `@Injectable()
@LiveTopic('messages')
export class MessagesSource extends PagedSource<MessageFilters> {
  constructor(private readonly messages: MessageService, private readonly events: EventsService) {
    super();
  }

  // The trust boundary: what arrives is JSON off a socket.
  protected readFilters(raw: JsonObject): MessageFilters {
    return { search: text(raw['search']) };
  }

  // What two identical questions share, so they share one read.
  protected keyOfFilters(filters: MessageFilters): string {
    return filters.search ?? '';
  }

  // The window as it stands. Whole, never a delta.
  protected readPage(filters: MessageFilters, offset: number, limit: number) {
    return this.messages.window(filters, offset, limit);
  }

  // What makes it read again.
  protected wake() {
    return onChanges(this.events.changes);
  }
}`;

  protected readonly provide = `// app.config.ts
providers: [provideLivewire({ path: '/my-service/ws' })]`;

  protected readonly screen = `export class MessagesComponent {
  private readonly topic = new LiveTopic<MessageRow>(inject(LivewireClient), 'messages');

  readonly total = signal(0);
  readonly source = new LiveWindowDataSource<MessageRow>(
    (total) => this.total.set(total),
    () => this.topic.resync(),
  );

  search(filters: MessageFilters): void {
    this.source.reset((offset, limit) => this.topic.window(filters, offset, limit));
  }
}`;

  protected readonly markup = `<cdk-virtual-scroll-viewport itemSize="48">
  <div *cdkVirtualFor="let row of source" [class.fresh]="source.fresh(row?.id)">
    ...
  </div>
</cdk-virtual-scroll-viewport>`;
}
