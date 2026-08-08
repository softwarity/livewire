import { AfterViewInit, Component, OnDestroy, inject, signal, viewChild } from '@angular/core';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { LiveIndicatorComponent, LiveTopic, LiveWindowDataSource, LivewireClient } from '@softwarity/livewire';
import { CodeComponent } from '../code/code.component';
import { feed } from '../demo/demo-feed';
import type { BoardRow } from '../demo/demo-feed';
import type { Envelope } from '@softwarity/livewire-protocol';

/** How many rows the window holds. A transport budget, not a display choice. */
const WINDOW = 100;

/** How many frames the panel keeps. */
const KEPT = 14;

interface Traffic {
  key: number;
  direction: 'in' | 'out';
  label: string;
  detail: string;
  bytes: number;
}

@Component({
  selector: 'app-demo',
  imports: [CodeComponent, ScrollingModule, LiveIndicatorComponent],
  styles: [
    `
      .panel {
        display: grid;
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
        gap: 16px;
        margin: 16px 0 24px 0;
      }
      @media (max-width: 900px) {
        .panel {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .board,
      .wire {
        border: 1px solid var(--border-color);
        border-radius: 8px;
        background-color: var(--bg-primary);
        overflow: hidden;
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        background-color: var(--bg-secondary);
        border-bottom: 1px solid var(--border-color);
        font-size: 0.82rem;
        color: var(--text-muted);
      }
      .bar .title {
        color: var(--text-primary);
        font-weight: 600;
      }
      .bar .spacer {
        flex: 1;
      }
      lw-live-indicator {
        --lw-live: #3fb950;
        --lw-down: #d29922;
      }
      cdk-virtual-scroll-viewport {
        height: 340px;
      }
      .row {
        display: grid;
        grid-template-columns: 74px 1fr 62px 96px;
        align-items: center;
        gap: 8px;
        height: 40px;
        padding: 0 12px;
        border-bottom: 1px solid rgba(48, 54, 61, 0.6);
        font-size: 0.85rem;
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .row .flight {
        color: var(--text-primary);
        font-weight: 600;
      }
      .row .index {
        color: var(--text-muted);
        font-size: 0.75rem;
      }
      .status {
        justify-self: end;
        padding: 1px 8px;
        border-radius: 10px;
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        border: 1px solid currentColor;
      }
      .status.scheduled {
        color: var(--text-muted);
      }
      .status.boarding {
        color: var(--accent-blue);
      }
      .status.departed {
        color: #3fb950;
      }
      .status.delayed {
        color: var(--accent-yellow);
      }
      .row.fresh {
        animation: lit 1s ease-out;
      }
      @keyframes lit {
        from {
          background-color: rgba(163, 113, 247, 0.28);
        }
      }
      .placeholder {
        display: block;
        height: 10px;
        width: 60%;
        border-radius: 4px;
        background: linear-gradient(90deg, var(--bg-secondary), rgba(139, 148, 158, 0.18), var(--bg-secondary));
      }
      .frames {
        height: 340px;
        overflow-y: auto;
        font-family: 'Courier New', Consolas, monospace;
        font-size: 0.76rem;
        line-height: 1.5;
      }
      .frame {
        display: grid;
        grid-template-columns: 16px 82px 1fr auto;
        gap: 8px;
        align-items: baseline;
        padding: 3px 12px;
        border-bottom: 1px solid rgba(48, 54, 61, 0.45);
      }
      .frame .arrow {
        font-weight: 700;
      }
      .frame.in .arrow {
        color: var(--accent-blue);
      }
      .frame.out .arrow {
        color: #3fb950;
      }
      .frame .label {
        color: var(--text-primary);
      }
      .frame .detail {
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .frame .bytes {
        color: var(--text-muted);
      }
      .empty {
        padding: 14px 12px;
        color: var(--text-muted);
        font-size: 0.8rem;
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 0 0 20px 0;
      }
      button.action {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 7px 12px;
        border-radius: 6px;
        border: 1px solid var(--border-color);
        background-color: var(--bg-secondary);
        color: var(--text-primary);
        font-size: 0.84rem;
        cursor: pointer;
        transition: all 0.15s;
      }
      button.action:hover {
        border-color: var(--accent-purple);
        background-color: rgba(163, 113, 247, 0.12);
      }
      button.action.running {
        border-color: #3fb950;
        color: #3fb950;
      }
    `,
  ],
  template: `
    <h2>Live demo</h2>

    <p>
      Everything below is the real thing: the <strong>Angular client</strong> from
      <code>&#64;softwarity/livewire</code>, talking to a <strong>Livewire server</strong> from
      <code>&#64;softwarity/livewire-mock</code> — the same server the
      <a href="https://github.com/softwarity/livewire/tree/main/packages/mock" target="_blank" rel="noopener">conformance suite</a>
      runs its twelve scenarios against. No backend, no network, and nothing written for the occasion.
    </p>

    <div class="controls">
      <button type="button" class="action" (click)="arrive()">A row arrives</button>
      <button type="button" class="action" (click)="change()">A row changes</button>
      <button type="button" class="action" (click)="reread()">Re-read, unchanged</button>
      <button type="button" class="action" (click)="drop()">Drop the socket</button>
      <button type="button" class="action" (click)="refuse()">Refuse the next connection</button>
      <button type="button" class="action" [class.running]="running()" (click)="toggle()">
        {{ running() ? 'Stop the feed' : 'Start the feed' }}
      </button>
    </div>

    <div class="panel">
      <div class="board">
        <div class="bar">
          <lw-live-indicator />
          <span class="title">board</span>
          <span>{{ total() }} rows</span>
          <span class="spacer"></span>
          <span>window [{{ window().offset }}, {{ window().offset + window().limit }})</span>
        </div>

        <cdk-virtual-scroll-viewport itemSize="40" minBufferPx="400" maxBufferPx="800">
          <div
            *cdkVirtualFor="let row of source; let index = index"
            class="row"
            [class.fresh]="!!source.revision() && source.fresh(row?.id)"
          >
            @if (row) {
              <span class="flight">{{ row.flight }}</span>
              <span class="index">#{{ index }} &middot; {{ row.id }}</span>
              <span>{{ row.time }}</span>
              <span class="status" [class]="'status ' + row.status">{{ row.status }}</span>
            } @else {
              <span class="placeholder"></span>
            }
          </div>
        </cdk-virtual-scroll-viewport>
      </div>

      <div class="wire">
        <div class="bar">
          <span class="title">the wire</span>
          <span class="spacer"></span>
          <span>{{ frames() }} frames &middot; {{ bytes() }} bytes</span>
        </div>
        <div class="frames">
          @for (entry of traffic(); track entry.key) {
            <div class="frame" [class]="'frame ' + entry.direction">
              <span class="arrow">{{ entry.direction === 'in' ? '↑' : '↓' }}</span>
              <span class="label">{{ entry.label }}</span>
              <span class="detail">{{ entry.detail }}</span>
              <span class="bytes">{{ entry.bytes }}B</span>
            </div>
          } @empty {
            <div class="empty">Nothing on the wire yet.</div>
          }
        </div>
      </div>
    </div>

    <h3>What to try</h3>

    <table>
      <thead>
        <tr><th>Do this</th><th>Watch this</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>A row arrives</strong></td>
          <td>
            One <code>patch</code>, a few hundred bytes: <code>upserted</code> holds the new row and
            nothing else. The ninety-nine rows that moved down are in <code>order</code> — by id, because
            their versions did not change.
          </td>
        </tr>
        <tr>
          <td><strong>Re-read, unchanged</strong></td>
          <td>
            The server re-reads and publishes <em>nothing</em>. The frame counter does not move.
            That is SPEC §5.3, and it is what keeps a busy feed from repainting a screen it did not move.
          </td>
        </tr>
        <tr>
          <td><strong>Scroll, fast</strong></td>
          <td>
            The window follows in blocks of fifty, and only once the view has genuinely walked out of what
            it covers — watch <code>window [a, b)</code> in the header. Each move is one
            <code>subscribe</code> and one <code>snapshot</code>; there is never a second question in
            flight.
          </td>
        </tr>
        <tr>
          <td><strong>Drop the socket</strong></td>
          <td>
            The dot turns amber, the client reconnects on its own, and every open window is re-subscribed
            — a fresh <code>snapshot</code>, sequence back to 1. The screen never asked for any of it.
          </td>
        </tr>
        <tr>
          <td><strong>Refuse the next connection</strong></td>
          <td>
            An <code>error</code> frame with <code>id: "connection"</code>, <em>then</em> the close. In
            that order, so a refusal can be told apart from a network fault. The attempt after it is
            allowed through.
          </td>
        </tr>
        <tr>
          <td><strong>Click the dot</strong></td>
          <td>
            Up, it asks every open window for a fresh snapshot; down, it skips the reconnection delay.
            One gesture for the reader's one complaint: <em>this may not be what is true</em>.
          </td>
        </tr>
      </tbody>
    </table>

    <h3>The whole of the client side</h3>

    <p>This page is not a special case. It is the code on the Angular page, with one line changed.</p>

    <app-code lang="ts" [code]="wiring" />

    <app-code lang="ts" [code]="client" />

    <h3>And the server</h3>

    <app-code lang="ts" [code]="server" />

    <div class="callout">
      The fake server is in the tested set, not beside it. Writing the conformance suite against it found
      three real defects in an evening — a window compared without <code>total</code>, a connection opened
      synchronously, and a missing <code>onopen</code>. A demo that lies is worse than no demo, and the
      suite is what says which one this is.
    </div>
  `,
})
export class DemoComponent implements AfterViewInit, OnDestroy {
  protected readonly wiring = `// app.config.ts - the one line: a connection with no network under it
provideLivewire({ path: '', reconnectMs: 1500, connect: () => feed.connect() })`;

  protected readonly client = `private readonly topic = new LiveTopic<BoardRow>(inject(LivewireClient), 'board');

readonly source = new LiveWindowDataSource<BoardRow>(
  (total) => this.total.set(total),
  () => this.topic.resync(),
  100,
);

ngAfterViewInit(): void {
  this.source.track(this.viewport().renderedRangeStream);
  this.source.reset((offset, limit) => this.topic.window({}, offset, limit));
}`;

  protected readonly server = `const server = new MockServer({ authorize: () => !refusing });

server.register('board', {
  // The trust boundary, exactly as on a real server.
  readQuery: (raw) => ({ offset: whole(raw?.offset, 0), limit: limitOf(raw?.limit, 50) }),
  windowFor: (page) => ({ rows: rows.slice(page.offset, page.offset + page.limit), total: rows.length }),
});

// What a write announces. Everything after it - the diff, the silence, the
// sequence - is the server's business.
server.touched('board');`;

  private readonly topic = new LiveTopic<BoardRow>(inject(LivewireClient), 'board');
  private readonly viewport = viewChild.required(CdkVirtualScrollViewport);

  protected readonly total = signal(0);
  protected readonly window = signal({ offset: 0, limit: WINDOW });
  protected readonly traffic = signal<Traffic[]>([]);
  protected readonly frames = signal(0);
  protected readonly bytes = signal(0);
  protected readonly running = signal(feed.running);

  protected readonly source = new LiveWindowDataSource<BoardRow>(
    (total) => this.total.set(total),
    () => this.topic.resync(),
    WINDOW,
  );

  private counted = 0;

  constructor() {
    feed.onTraffic = (direction, frame) => this.record(direction, frame);
  }

  ngAfterViewInit(): void {
    // Where the eye is. A viewport reports its rendered range and nothing else
    // has to be arranged: that range is what moves the window.
    this.source.track(this.viewport().renderedRangeStream);
    this.source.reset((offset, limit) => {
      this.window.set({ offset, limit });
      return this.topic.window({}, offset, limit);
    });
  }

  ngOnDestroy(): void {
    feed.stop();
    feed.onTraffic = undefined;
    this.source.disconnect();
  }

  protected arrive(): void {
    feed.arrive();
  }

  protected change(): void {
    feed.change();
  }

  protected reread(): void {
    feed.reread();
  }

  protected drop(): void {
    feed.drop();
  }

  protected refuse(): void {
    feed.refuseNext();
  }

  protected toggle(): void {
    if (feed.running) {
      feed.stop();
    } else {
      feed.start();
    }
    this.running.set(feed.running);
  }

  /** One line of the panel, summarised the way a protocol trace would be. */
  private record(direction: 'in' | 'out', envelope: Envelope<unknown>): void {
    const bytes = JSON.stringify(envelope).length;
    const entry: Traffic = { key: (this.counted += 1), direction, bytes, ...describe(envelope) };
    this.traffic.update((kept) => [entry, ...kept].slice(0, KEPT));
    this.frames.update((count) => count + 1);
    this.bytes.update((total) => total + bytes);
  }
}

/** What a frame is, in a line. */
function describe(envelope: Envelope<unknown>): { label: string; detail: string } {
  const data = envelope.data as Record<string, unknown>;
  if (envelope.event === 'subscribe') {
    const query = (data['query'] ?? {}) as { offset?: number; limit?: number };
    return { label: 'subscribe', detail: `${String(data['id'])} · offset ${query.offset ?? 0} limit ${query.limit ?? '—'}` };
  }
  if (envelope.event === 'unsubscribe') {
    return { label: 'unsubscribe', detail: String(data['id']) };
  }
  const type = String(data['type']);
  if (type === 'snapshot') {
    const rows = (data['rows'] ?? []) as unknown[];
    return { label: 'snapshot', detail: `${rows.length} rows · total ${String(data['total'])} · seq ${String(data['sequence'])}` };
  }
  if (type === 'patch') {
    const upserted = (data['upserted'] ?? []) as unknown[];
    const removed = (data['removed'] ?? []) as unknown[];
    return { label: 'patch', detail: `+${upserted.length} −${removed.length} · seq ${String(data['sequence'])}` };
  }
  return { label: 'error', detail: String(data['reason']) };
}
