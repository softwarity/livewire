# livewire (Quarkus)

Live query synchronisation: a client subscribes to a question, receives its
answer, then every answer after it.

```xml
<dependency>
    <groupId>io.softwarity</groupId>
    <artifactId>quarkus-livewire</artifactId>
    <version>0.4.0</version>
</dependency>
```

A plain library, not an extension: it needs a route on the application's router
and CDI to find the sources, both of which a Quarkus application already has
(`quarkus-vertx-http`, `quarkus-jackson`). Built against Quarkus 3.40, Java 21.

## A server

```properties
livewire.path=/live          # where the socket is opened, under quarkus.http.root-path (default /livewire)
livewire.coalesce=300ms      # how long a burst of changes gathers before a read
```

The sources are the beans annotated `@LiveTopic`. Who may open the socket is a
`LivewireAuthorizer` bean, if the application has one — the only place the
library touches its idea of identity:

```java
@ApplicationScoped
public class RolesOnly implements LivewireAuthorizer {
    public boolean authorize(RoutingContext upgrade) {
        return upgrade.user() != null;            // the upgrade request is all there is
    }
    public String refusal(RoutingContext upgrade) {
        return "no role reached this service";
    }
}
```

Without one, every upgrade is accepted: right behind a gateway that has already
authenticated, wrong on the open internet.

## A source

```java
@LiveTopic("messages")
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
}
```

`read` runs on a worker, so a Panache or JDBC read is fine there. A source with
nothing to follow answers `Multi.createFrom().nothing()`; throw `LivewireRefusal`
from `readQuery` to refuse a question, its message being the reason.

A source reached through a CDI proxy reads its collaborators through **methods**:
a field read on a client proxy is the proxy's own field, not the bean's.

## A source that depends on who is asking

A tenant's own rows, a user's own tasks: implement `SourceWithContext<Q>` instead
of `Source<Q>`. Same four methods, but `readQuery` is also given the request that
opened the socket, the same for every subscription of that socket (SPEC §5.5):

```java
@LiveTopic("tasks")
@ApplicationScoped
public class TasksSource implements SourceWithContext<TaskQuery> {

    public TaskQuery readQuery(JsonNode raw, RoutingContext opening) {
        String owner = opening.user().subject();                  // who opened the socket
        return new TaskQuery(owner, Queries.text(raw, "search"));  // never from raw
    }

    // Who is asking is part of the key: two callers never share a window.
    public String key(TaskQuery q) {
        return q.owner() + "|" + q.search();
    }
    …
}
```

Who is asking comes from the opening request, never from the query: the client
writes the query, and could put someone else there. A `Source` is untouched.

## What the registry does for you

- **One read per question.** Ten clients asking the same thing share one query.
- **Silence on an unchanged read.** The window is compared by signature (SPEC §5.3).
- **Bursts gathered.** A salvo of wakes becomes one read — `livewire.coalesce`, 300 ms.
- **The diff, per subscription.** A client that joins mid-stream gets a snapshot,
  and its patches are computed against the rows it actually holds.
- **Cleanup.** The last watcher leaves, the wake is cancelled and the entry dropped.
- **A failed read publishes nothing.** It is logged; the next wake tries again.

## Commands and notifications

Level 2, and optional. Commands are `@LiveCommand` methods of a bean that
implements `LiveCommands` — the marker keeps the bean in the application, which
Quarkus would otherwise remove at build since nothing injects it.

```java
@ApplicationScoped
public class FlightCommands implements LiveCommands {

    @LiveCommand("flight.acknowledge")
    @Transactional
    public void acknowledge(Acknowledgement asked) {     // the payload, converted by Jackson
        flights.acknowledge(asked.id());
    }
}

// Something that happened, told once, outside any window.
@Inject Livewire livewire;
livewire.notify("import.finished", Map.of("count", 412));
```

A command takes nothing or one parameter (a `JsonNode` gets the payload as it
is), runs on a worker through the bean's proxy, and what it returns is the ack's
`result`. What it throws refuses it, the message becoming the reason. Every
command is answered exactly once, including one naming something nothing handles.

**What a command changed does not go in its answer.** A list it touched is
republished by its own subscription. Two answers to one question is what this
protocol exists to avoid.

## The one rule to remember

`updatedAt` is the version of a row, and **everything the row shows has to be in
it** — not only what a write touched. A value read from the clock changes with no
write behind it, and a version that ignores it makes the server believe the row
unchanged: nothing is published and the client keeps a value that stopped being
true.

## Tests

```bash
cd quarkus && ./mvnw verify                     # the diff, the signature, the registry
npx jest packages/mock/test/quarkus-server.spec.ts   # the shared conformance scenarios, level 2 included
```

The conformance suite packages `conformance/` (a fixture, never published) and
drives it over a real socket — the same scenarios the in-memory, NestJS and Go
servers answer.

See [SPEC.md](../packages/protocol/SPEC.md) for the contract in full. Where this
implementation and the specification disagree, the specification is right.
