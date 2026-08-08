import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-protocol',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>The protocol</h2>

    <p>
      Two frames go up, three come down. Everything else — how a source is woken, what a query means,
      where the rows come from — is deliberately outside the contract. The full normative text lives in
      <a href="https://github.com/softwarity/livewire/blob/main/packages/protocol/SPEC.md" target="_blank" rel="noopener">SPEC.md</a>;
      this page is the readable version.
    </p>

    <h3>Why not just push changes?</h3>

    <p>
      Because the obvious design is the wrong one. Pushing <code>insert</code> / <code>update</code> /
      <code>delete</code> and letting the client keep its own list means writing, in the browser, a
      predicate deciding whether a row belongs to the current filter and a comparator deciding where it
      goes — two copies of what the SQL query already says, free to drift from it. The drift is invisible
      until somebody is reading a list nobody can reproduce.
    </p>

    <p>
      Livewire pushes <strong>the result of the query</strong>. The window is part of the subscription,
      so the sort order stays in the database where it was written.
    </p>

    <h3>The connection</h3>

    <p>
      One WebSocket per tab, carrying every subscription. There is no handshake and no authentication
      frame: whatever identifies the caller is in the upgrade request, and the server decides from that
      request alone whether the socket may be used.
    </p>

    <div class="callout">
      A refused socket gets an <code>error</code> frame <strong>first</strong>, then a close with code
      <code>1008</code>. In that order, and the frame is not optional: a refusal arriving as a bare
      disconnection cannot be told from a network fault, and a gateway that swallows the close code
      would leave the screen empty with nothing to show for it.
    </div>

    <h3>Frames</h3>

    <p>
      Every frame, both ways, is <code>&#123; "event": string, "data": object &#125;</code>. A frame that
      is not valid JSON, or whose <code>data</code> is not an object, is ignored — and the socket stays
      up.
    </p>

    <h4>Client → server</h4>

    <table>
      <thead>
        <tr><th><code>event</code></th><th><code>data</code></th><th></th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>subscribe</code></td>
          <td><code>&#123; id, topic, query? &#125;</code></td>
          <td>Opens a subscription — or <strong>replaces</strong> one already open under that id.</td>
        </tr>
        <tr>
          <td><code>unsubscribe</code></td>
          <td><code>&#123; id &#125;</code></td>
          <td>Closes it. The socket and the other subscriptions are untouched.</td>
        </tr>
      </tbody>
    </table>

    <app-code lang="json" [code]="subscribe" />

    <h4>Server → client</h4>

    <p>All three carry <code>event: "update"</code>.</p>

    <table>
      <thead>
        <tr><th><code>data.type</code></th><th>Fields</th></tr>
      </thead>
      <tbody>
        <tr><td><code>snapshot</code></td><td><code>id</code>, <code>rows</code>, <code>sequence</code>, optionally <code>total</code>, <code>pivot</code></td></tr>
        <tr><td><code>patch</code></td><td><code>id</code>, <code>upserted</code>, <code>removed</code>, <code>order</code>, <code>sequence</code>, optionally <code>total</code>, <code>pivot</code></td></tr>
        <tr><td><code>error</code></td><td><code>id</code>, <code>reason</code></td></tr>
      </tbody>
    </table>

    <app-code lang="json" [code]="patch" />

    <h3>Sequence</h3>

    <p>
      <code>sequence</code> starts at 1 for each subscription and increments by one per frame sent under
      that id. <code>error</code> frames do not consume a number.
    </p>

    <p>
      A client that receives anything other than the number it expects <em>resubscribes</em> rather than
      applying the frame. On one socket nothing is lost and nothing overtakes, so a gap means the two
      sides disagree about what was sent — and a list nobody can reproduce is worse than one that
      flickers.
    </p>

    <h3>Windows</h3>

    <p>
      A source answers with a <strong>whole window</strong>, never a delta. Turning that window into a
      patch is the server's business, <strong>per subscription</strong>, because only it knows what that
      particular client received: someone subscribing mid-stream gets a snapshot, and their patches are
      computed against the rows they actually hold.
    </p>

    <h4>Versions</h4>

    <div class="callout warn">
      <code>updatedAt</code> is the version of a row, and it is what the diff compares.
      <strong>Everything a row shows must be in it</strong> — not only what a write touched. A version
      may be anything a string can hold; it must never be reused for a different state of the same row.
    </div>

    <h4>Diff</h4>

    <p>Given <code>before</code> (what this client last received) and <code>after</code> (the window now):</p>

    <ul>
      <li><code>upserted</code> — every row of <code>after</code> whose id is absent from <code>before</code>, or whose version differs;</li>
      <li><code>removed</code> — every id of <code>before</code> absent from <code>after</code>;</li>
      <li><code>order</code> — the ids of <code>after</code>, in order.</li>
    </ul>

    <p>
      A row that merely <em>moved</em> — same id, same version, different position — is not in
      <code>upserted</code>. It is in <code>order</code>, which is enough. Three arrivals at the top of a
      list therefore cost three rows on the wire, not a page.
    </p>

    <h4>Silence</h4>

    <p>
      A read whose window is identical to the one last published produces <strong>no frame at all</strong>
      — same <code>total</code>, same <code>pivot</code>, same ids in the same order with the same
      versions. This is not an optimisation: a source woken by a busy feed re-reads constantly, and a
      screen repainting on every read is a screen nobody can use.
    </p>

    <h4>Sharing</h4>

    <p>
      Two subscriptions whose queries produce the same key share one read. The key is the source's
      business; the transport never computes it.
    </p>

    <h3>What is <em>not</em> in the contract</h3>

    <table>
      <tbody>
        <tr>
          <td><strong>How a source is woken</strong></td>
          <td>Timers, database triggers, a broker. The contract says what a window looks like, not what causes one to be read.</td>
        </tr>
        <tr>
          <td><strong>Authorisation beyond the socket</strong></td>
          <td>No per-topic or per-row model. A caller who may open the socket may subscribe to any topic the server exposes; finer control goes inside the source.</td>
        </tr>
        <tr>
          <td><strong>Frame size</strong></td>
          <td>WebSocket sets no useful limit, but proxies do — one of them silently drops frames over ~64&nbsp;kB. Sizing a window is the source's responsibility.</td>
        </tr>
        <tr>
          <td><strong>Reconnection</strong></td>
          <td>A client that loses the socket resubscribes. The server remembers nothing across connections.</td>
        </tr>
        <tr>
          <td><strong>Ordering between subscriptions</strong></td>
          <td>Frames for two different ids may interleave in any order.</td>
        </tr>
      </tbody>
    </table>

    <div class="callout">
      A rule that is not written in the spec is not part of the contract — and every rule that is, has a
      scenario in the <a routerLink="/conformance">conformance suite</a>. That is what makes "we also
      have a Go server" true rather than hopeful.
    </div>
  `,
})
export class ProtocolComponent {
  protected readonly subscribe = `{ "event": "subscribe",
  "data": { "id": "messages:3", "topic": "messages",
            "query": { "search": "delay", "offset": 100, "limit": 50 } } }`;

  protected readonly patch = `{ "event": "update",
  "data": { "id": "messages:3", "type": "patch",
            "upserted": [ { "id": "m-901", "updatedAt": "v7", "text": "…" } ],
            "removed": [ "m-850" ],
            "order": [ "m-901", "m-899", "m-898" ],
            "total": 13001, "sequence": 42 } }`;
}
