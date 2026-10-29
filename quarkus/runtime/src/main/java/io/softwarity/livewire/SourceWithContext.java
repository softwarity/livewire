package io.softwarity.livewire;

import com.fasterxml.jackson.databind.JsonNode;

import io.smallrye.mutiny.Multi;
import io.vertx.ext.web.RoutingContext;

/**
 * A live list whose window depends on who is asking — SPEC §5.5: a tenant's own rows, a user's
 * own tasks. A {@link Source} in every other respect, published under the topic its
 * {@link LiveTopic} names; a source whose window is the same for everybody stays a {@link Source}.
 *
 * <pre>{@code
 * @LiveTopic("tasks")
 * @ApplicationScoped
 * public class TasksSource implements SourceWithContext<TaskQuery> {
 *     public TaskQuery readQuery(JsonNode raw, RoutingContext opening) {
 *         String owner = opening.user().subject();                  // who opened the socket
 *         return new TaskQuery(owner, Queries.text(raw, "search"));  // never from raw
 *     }
 *     public String key(TaskQuery query) { return query.owner() + "|" + query.search(); }
 *     …
 * }
 * }</pre>
 *
 * @param <Q> the question this source answers, as {@link #readQuery} makes it
 */
public interface SourceWithContext<Q> {

    /**
     * The trust boundary, as {@link Source#readQuery}, with the request that opened the socket
     * this subscription arrives on: the same for every subscription of that socket. Who is
     * asking is read there, never in {@code raw}, which the client writes and could fill with
     * someone else. Throw {@link LivewireRefusal} to refuse.
     */
    Q readQuery(JsonNode raw, RoutingContext opening);

    /**
     * What two identical questions share, as {@link Source#key}. Whatever {@link #readQuery}
     * took from the opening request is part of it: two callers asking the same query never
     * share a window.
     */
    String key(Q query);

    /** What makes it read again, as {@link Source#wake}. */
    Multi<?> wake();

    /** The window as it stands, as {@link Source#read}: on a worker thread, so it may block. */
    Window read(Q query);
}
