import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

interface Scenario {
  spec: string;
  name: string;
}

@Component({
  selector: 'app-conformance',
  imports: [CodeComponent, RouterLink],
  styles: [
    `
      .spec-cell {
        white-space: nowrap;
        color: var(--accent-purple);
        font-weight: 600;
      }
      .servers {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 12px;
        margin: 16px 0 28px 0;
      }
      .server-card {
        padding: 14px 16px;
        background-color: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
      }
      .server-name {
        font-weight: 600;
        color: var(--text-primary);
        display: block;
        margin-bottom: 4px;
      }
      .server-desc {
        color: var(--text-secondary);
        font-size: 0.85rem;
        line-height: 1.45;
      }
    `,
  ],
  template: `
    <h2>Conformance</h2>

    <p>
      Two implementations of one protocol diverge within months — not through carelessness, but through
      the cases nobody wrote down. So the cases are written down, once, as a list of scenarios driven
      over an abstract wire. Every server runs them.
    </p>

    <div class="servers">
      <div class="server-card">
        <span class="server-name">In-memory</span>
        <span class="server-desc">The mock. No socket, no clock, no database — and the one that powers the demo on this site.</span>
      </div>
      <div class="server-card">
        <span class="server-name">NestJS</span>
        <span class="server-desc">Over a real <code>ws</code> socket, against a booted Nest application.</span>
      </div>
      <div class="server-card">
        <span class="server-name">Go</span>
        <span class="server-desc">Over a real socket, against a compiled binary, under <code>-race</code>.</span>
      </div>
    </div>

    <h3>The scenarios</h3>

    <p>Each names the clause it defends. A rule with no scenario is a rule that will be broken quietly.</p>

    <table>
      <thead>
        <tr><th>Spec</th><th>Scenario</th></tr>
      </thead>
      <tbody>
        @for (scenario of scenarios; track scenario.name) {
          <tr>
            <td class="spec-cell">{{ scenario.spec }}</td>
            <td>{{ scenario.name }}</td>
          </tr>
        }
      </tbody>
    </table>

    <h3>Running them against your own server</h3>

    <p>
      A <code>Wire</code> is the whole adaptation layer: send a frame, receive frames, make the data
      change. Anything that can do those three can be put through the suite.
    </p>

    <app-code lang="ts" [code]="harness" />

    <div class="callout">
      A conforming server exposes two topics for the suite to drive: <code>rows</code>, where a new row
      arrives at the <em>top</em>, and <code>still</code>, which never changes. Between them they cover
      arrival, movement, and silence.
    </div>

    <h3>What it caught</h3>

    <p>
      Writing the suite was not a formality. It found three real defects the same evening, none of them
      exotic:
    </p>

    <ul>
      <li>
        The in-memory server compared windows <em>by hand</em> and ignored <code>total</code> and
        <code>pivot</code> — so a list whose count changed with no row changing published nothing.
      </li>
      <li>
        It opened its connection <strong>synchronously</strong>, so a refusal frame was sent before the
        caller could listen for it. A real socket is not open the instant it is asked for, and the
        scenario that checks the refusal order was passing on a tautology.
      </li>
      <li>
        It never called <code>onopen</code>. A client that waits for that signal before sending its
        subscriptions — which is exactly what reconnection needs — looked connected and received nothing.
      </li>
    </ul>

    <div class="callout warn">
      All three were in the mock, not in the servers. That is the argument for keeping the fake server in
      the tested set rather than beside them: a demo that lies is worse than no demo, and only the suite
      says which one it is.
    </div>

    <h3>The rule this repository follows</h3>

    <p>
      A second implementation is not started until the suite passes on the first. The
      <a routerLink="/go">Go server</a> was written against a list of scenarios that already ran green
      against <a routerLink="/nestjs">NestJS</a> — which turns "does it behave the same?" from a
      judgement call into a test run.
    </p>

    <app-code lang="bash" [code]="run" />
  `,
})
export class ConformanceComponent {
  protected readonly harness = `import { Conversation, SCENARIOS } from '@softwarity/livewire-mock';

for (const scenario of SCENARIOS) {
  it(\`\${scenario.spec} \${scenario.name}\`, async () => {
    const socket = new WebSocket(\`ws://localhost:\${port}/ws\`);
    const wire: Wire = {
      ready: opened(socket),
      send: (frame) => socket.send(frame),
      onFrame: (listener) => socket.on('message', (data) => listener(String(data))),
      touch: () => fetch(\`http://localhost:\${port}/touch\`, { method: 'POST' }),
    };
    await wire.ready;
    await scenario.run(new Conversation(wire));
  });
}`;

  protected readonly run = `npm test          # protocol, mock, nestjs, angular
cd go && go test -race ./...`;

  /**
   * Mirrors `SCENARIOS` from the mock package.
   *
   * Listed rather than imported: the suite is a set of live sockets and timers,
   * and pulling it into the doc bundle to render twelve strings would ship the
   * whole harness to every reader.
   */
  protected readonly scenarios: Scenario[] = [
    { spec: '§3.1', name: 'answers a snapshot first, numbered one' },
    { spec: '§4', name: 'answers patches after it, numbering up' },
    { spec: '§5.2', name: 'a row that only moved is not upserted' },
    { spec: '§5.3', name: 'a window that did not change publishes nothing' },
    { spec: '§3.1', name: 'an unknown topic answers an error and opens nothing' },
    { spec: '§2.1', name: 'a subscribe with no id is ignored' },
    { spec: '§2', name: 'an unreadable frame is ignored, and the connection stays up' },
    { spec: '§3.2', name: 'resubscribing under an open id replaces it and restarts the sequence' },
    { spec: '§3.3', name: 'unsubscribing stops the frames' },
    { spec: '§3.3', name: 'unsubscribing an unknown id is ignored' },
    { spec: '§3.3', name: 'unsubscribing one subscription leaves the others alone' },
    { spec: '§5', name: 'a late subscription gets a snapshot of where things are' },
  ];
}
