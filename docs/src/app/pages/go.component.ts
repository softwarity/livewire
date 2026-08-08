import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-go',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>Go server</h2>

    <app-code lang="bash" [code]="install" />

    <p>
      There is no registry to publish a Go module to: the import path <em>is</em> the repository, and a
      version is a git tag. A release posts two tags at once — <code>v0.1.0</code> for the npm packages
      and <code>go/v0.1.0</code> for this module — so the two sides of one wire never carry different
      numbers.
    </p>

    <h3>A server</h3>

    <p>
      One <code>http.Handler</code>, mounted wherever the application wants it. No framework, no
      reflection, no init-time magic.
    </p>

    <app-code lang="go" [code]="server" />

    <p>
      Registration is explicit. Go has no annotations to discover — and a list of what a server serves is
      worth reading anyway.
    </p>

    <h3>A source</h3>

    <app-code lang="go" [code]="source" />

    <div class="callout">
      <code>Wake()</code> must not be closed while the source is in use. A source with nothing to follow
      returns a channel that never sends.
    </div>

    <h3>Rows</h3>

    <p>
      A <code>Row</code> carries an id, a version and whatever else the screen shows. It marshals
      <strong>flat</strong>: the fields sit beside <code>id</code> and <code>updatedAt</code>, exactly as
      they do on the TypeScript side, because the conformance suite compares frames and not structs.
    </p>

    <app-code lang="go" [code]="row" />

    <h3>What the registry does for you</h3>

    <ul>
      <li><strong>One read per question.</strong> Ten clients asking the same thing share one query.</li>
      <li><strong>Silence on an unchanged read.</strong> The window is compared by signature, not by hand.</li>
      <li><strong>Bursts gathered.</strong> A salvo of wakes becomes one read — <code>CoalesceDefault</code>, 300&nbsp;ms.</li>
      <li><strong>The diff, per subscription.</strong> Computed against the rows that client actually received.</li>
      <li><strong>Cleanup.</strong> The last watcher leaves, the pump stops and the entry is dropped.</li>
      <li><strong>A failed read publishes nothing.</strong> It is logged; the subscription stays open and the next wake tries again.</li>
    </ul>

    <h3>The one rule to remember</h3>

    <div class="callout warn">
      <code>UpdatedAt</code> is the version of a row, and <strong>everything the row shows has to be in
      it</strong>. It is the same rule as on the NestJS side, for the same reason, and it is the one the
      <a routerLink="/protocol">specification</a> writes in bold.
    </div>

    <h3>Tests</h3>

    <p>
      The Go suite runs under <code>-race</code> in CI, and eleven of its tests drive a real socket
      through the shared <a routerLink="/conformance">conformance scenarios</a> — the same twelve the
      TypeScript servers answer.
    </p>

    <app-code lang="bash" [code]="tests" />
  `,
})
export class GoComponent {
  protected readonly install = `go get github.com/softwarity/livewire/go`;

  protected readonly server = `registry := livewire.NewRegistry(0) // 0 = default coalescing window
registry.Register("messages", &MessagesSource{db: db})

mux.Handle("/my-service/ws", livewire.NewServer(registry, livewire.Options{
    Authorize: func(r *http.Request) bool { return rolesOf(r).Any(known) },
    Refusal:   func(r *http.Request) string { return "no role reached this service" },
    Origins:   []string{"app.example.com"}, // empty means same-origin only
}))`;

  protected readonly source = `type MessagesSource struct {
    db      *sql.DB
    changes chan struct{}
}

// The trust boundary: what arrives is JSON off a socket.
func (s *MessagesSource) ReadQuery(raw json.RawMessage) (any, error) {
    asked := map[string]any{}
    _ = json.Unmarshal(raw, &asked)
    return query{
        search: livewire.Text(asked, "search"),
        offset: livewire.Whole(asked, "offset", 0),
        limit:  livewire.LimitOf(asked, "limit", 50),
    }, nil
}

// What two identical questions share, so they share one read.
func (s *MessagesSource) Key(q any) string {
    asked := q.(query)
    return fmt.Sprintf("%s|%d|%d", asked.search, asked.offset, asked.limit)
}

// What makes it read again. Only the fact of a send is read, never its value.
func (s *MessagesSource) Wake() <-chan struct{} { return s.changes }

// The window as it stands. Whole, never a delta.
func (s *MessagesSource) Read(ctx context.Context, q any) (livewire.Window, error) {
    rows, total, err := s.page(ctx, q.(query))
    if err != nil {
        return livewire.Window{}, err
    }
    return livewire.Window{Rows: rows, Total: &total}, nil
}`;

  protected readonly row = `livewire.Row{
    ID:        "m-901",
    UpdatedAt: "v7", // the version - see the rule below
    Data:      map[string]any{"text": "…", "station": "LFPG"},
}`;

  protected readonly tests = `cd go && go vet ./... && go test -race ./...`;
}
