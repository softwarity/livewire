import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-quarkus',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>Quarkus server</h2>

    <app-code lang="xml" [code]="install" />

    <p>
      A plain library, not an extension: it needs a route on the application's router and CDI to find
      the sources, both of which a Quarkus application already has (<code>quarkus-vertx-http</code>,
      <code>quarkus-jackson</code>). Built against Quarkus 3.40, Java 21. Its version is the one every
      other package of this repository carries.
    </p>

    <h3>A server</h3>

    <p>There is no server to write. Two properties say where the socket opens and how long a burst gathers.</p>

    <app-code lang="properties" [code]="properties" />

    <p>
      The sources are the beans annotated <code>&#64;LiveTopic</code>. Who may open the socket is a
      <code>LivewireAuthorizer</code> bean, if the application has one — the only place the library
      touches its idea of identity.
    </p>

    <app-code lang="java" [code]="authorizer" />

    <div class="callout">
      Without an authorizer, every upgrade is accepted: right behind a gateway that has already
      authenticated, wrong on the open internet. A refusal is an <code>error</code> frame followed by a
      close <code>1008</code>, as the <a routerLink="/protocol">specification</a> says.
    </div>

    <h3>A source</h3>

    <app-code lang="java" [code]="source" />

    <p>
      <code>read</code> runs on a worker, so a Panache or JDBC read is fine there. A source with nothing to
      follow answers <code>Multi.createFrom().nothing()</code>; throw <code>LivewireRefusal</code> from
      <code>readQuery</code> to refuse a question, its message being the reason.
    </p>

    <div class="callout warn">
      A source reached through a CDI proxy reads its collaborators through <strong>methods</strong>: a
      field read on a client proxy is the proxy's own field, not the bean's.
    </div>

    <h3>A source that depends on who is asking</h3>

    <p>
      A tenant's own rows, a user's own tasks: implement <code>SourceWithContext&lt;Q&gt;</code> instead of
      <code>Source&lt;Q&gt;</code>. Same four methods, but <code>readQuery</code> is also given the request
      that opened the socket, the same for every subscription of that socket.
    </p>

    <app-code lang="java" [code]="contextual" />

    <p>
      Who is asking comes from the opening request, never from the query, and it is part of the key: two
      callers asking the same query never share a window. A <code>Source</code> is untouched.
    </p>

    <h3>Rows</h3>

    <p>
      A <code>Row</code> carries an id, a version and whatever else the screen shows. It is written
      <strong>flat</strong>: the fields sit beside <code>id</code> and <code>updatedAt</code>, exactly as
      they do on the TypeScript and Go sides.
    </p>

    <app-code lang="java" [code]="row" />

    <h3>What the registry does for you</h3>

    <ul>
      <li><strong>One read per question.</strong> Ten clients asking the same thing share one query.</li>
      <li><strong>Silence on an unchanged read.</strong> The window is compared by signature, not by hand.</li>
      <li><strong>Bursts gathered.</strong> A salvo of wakes becomes one read — <code>livewire.coalesce</code>, 300&nbsp;ms.</li>
      <li><strong>The diff, per subscription.</strong> Computed against the rows that client actually received.</li>
      <li><strong>Cleanup.</strong> The last watcher leaves, the wake is cancelled and the entry is dropped.</li>
      <li><strong>A failed read publishes nothing.</strong> It is logged; the subscription stays open and the next wake tries again.</li>
    </ul>

    <h3>Commands and notifications</h3>

    <p>
      Level 2, and optional. Commands are <code>&#64;LiveCommand</code> methods of a bean that implements
      <code>LiveCommands</code> — the marker keeps the bean in the application, which Quarkus would
      otherwise remove at build since nothing injects it.
    </p>

    <app-code lang="java" [code]="commands" />

    <p>
      A command takes nothing or one parameter (a <code>JsonNode</code> gets the payload as it is), runs
      on a worker through the bean's proxy, and what it returns is the ack's <code>result</code>. What it
      throws refuses it, the message becoming the reason. Every command is answered exactly once —
      including one naming something nothing handles.
    </p>

    <div class="callout warn">
      <strong>What a command changed does not go in its answer.</strong> A list it touched is republished
      by its own subscription. Two answers to one question is what this protocol exists to avoid.
    </div>

    <h3>The one rule to remember</h3>

    <div class="callout warn">
      <code>updatedAt</code> is the version of a row, and <strong>everything the row shows has to be in
      it</strong>. It is the same rule as on the NestJS and Go sides, for the same reason, and it is the
      one the <a routerLink="/protocol">specification</a> writes in bold.
    </div>

    <h3>Tests</h3>

    <p>
      The unit tests cover the diff, the signature and the registry. The shared
      <a routerLink="/conformance">conformance scenarios</a> are driven against a packaged fixture over a
      real socket — the same list the other servers answer, level 2 included.
    </p>

    <app-code lang="bash" [code]="tests" />
  `,
})
export class QuarkusComponent {
  protected readonly install = `<dependency>
    <groupId>io.softwarity</groupId>
    <artifactId>quarkus-livewire</artifactId>
    <version>0.4.0</version>
</dependency>`;

  protected readonly properties = `# where the socket is opened, under quarkus.http.root-path (default /livewire)
livewire.path=/live
# how long a burst of changes gathers before a read
livewire.coalesce=300ms`;

  protected readonly authorizer = `@ApplicationScoped
public class RolesOnly implements LivewireAuthorizer {
    public boolean authorize(RoutingContext upgrade) {
        return upgrade.user() != null;            // the upgrade request is all there is
    }
    public String refusal(RoutingContext upgrade) {
        return "no role reached this service";
    }
}`;

  protected readonly source = `@LiveTopic("messages")
@ApplicationScoped
public class MessagesSource implements Source<MessageQuery> {

    // The trust boundary: what arrives is JSON off a socket (null when no query was sent).
    public MessageQuery readQuery(JsonNode raw) {
        return new MessageQuery(Queries.text(raw, "search"), Queries.whole(raw, "offset", 0),
                Queries.limitOf(raw, "limit", 50));
    }

    // What two identical questions share, so they share one read.
    public String key(MessageQuery q) {
        return q.search() + "|" + q.offset() + "|" + q.limit();
    }

    // What makes it read again. Only the fact of an item is read, never its value.
    public Multi<?> wake() {
        return changes;
    }

    // The window as it stands, whole, never a delta. On a worker thread: it may block.
    public Window read(MessageQuery q) {
        return Window.page(rows(q), count(q));
    }
}`;

  protected readonly contextual = `@LiveTopic("tasks")
@ApplicationScoped
public class TasksSource implements SourceWithContext<TaskQuery> {

    public TaskQuery readQuery(JsonNode raw, RoutingContext opening) {
        String owner = opening.user().subject();                  // who opened the socket
        return new TaskQuery(owner, Queries.text(raw, "search"));  // never from raw
    }

    public String key(TaskQuery q) {
        return q.owner() + "|" + q.search();                      // two callers never share
    }
    // wake() and read(q) as for a Source
}`;

  protected readonly row = `new Row("m-901", "v7",                         // the version - see the rule below
        Map.of("text", "…", "station", "LFPG"));`;

  protected readonly commands = `@ApplicationScoped
public class FlightCommands implements LiveCommands {

    @LiveCommand("flight.acknowledge")
    @Transactional
    public void acknowledge(Acknowledgement asked) {     // the payload, converted by Jackson
        flights.acknowledge(asked.id());
    }
}

// Something that happened, told once, outside any window.
@Inject Livewire livewire;
livewire.notify("import.finished", Map.of("count", 412));`;

  protected readonly tests = `cd quarkus && ./mvnw verify                          # the diff, the signature, the registry
npx jest packages/mock/test/quarkus-server.spec.ts   # the shared conformance scenarios`;
}
