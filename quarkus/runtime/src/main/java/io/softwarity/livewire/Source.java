package io.softwarity.livewire;

import com.fasterxml.jackson.databind.JsonNode;

import io.smallrye.mutiny.Multi;

/**
 * One live list, published under the topic its {@link LiveTopic} names.
 *
 * <pre>{@code
 * @LiveTopic("messages")
 * @ApplicationScoped
 * public class MessagesSource implements Source<MessageQuery> {
 *     public MessageQuery readQuery(JsonNode raw) { … }  // the trust boundary
 *     public String key(MessageQuery query) { … }        // what two identical questions share
 *     public Multi<?> wake() { … }                       // what makes it read again
 *     public Window read(MessageQuery query) { … }       // the window as it stands
 * }
 * }</pre>
 *
 * The sharing, the coalescing, the silence on an unchanged read and the cleanup are the
 * registry's, once; nothing here knows what a row means, and it must stay that way.
 *
 * @param <Q> the question this source answers, as {@link #readQuery} makes it
 */
public interface Source<Q> {

    /**
     * The trust boundary: what arrives is JSON off a socket, {@code null} when the client sent
     * no query. Clamp it, whitelist it, default it, and hand back something {@link #read} can act
     * on without checking again. Throw {@link LivewireRefusal} to refuse it: its message is the
     * reason the client is given.
     */
    Q readQuery(JsonNode raw);

    /** What two identical questions share: two queries with the same key share one read. */
    String key(Q query);

    /**
     * Emits whenever this source may have something new to say. Only the fact of an item is
     * read, never its value, and a burst is gathered into one read. A source with nothing to
     * follow answers {@code Multi.createFrom().nothing()}.
     */
    Multi<?> wake();

    /**
     * The window as it stands. Run on a worker thread, so it may block — a database read
     * takes as long as it takes. An exception is not a window that emptied: nothing is
     * published, and the screen keeps what it had until a read succeeds.
     */
    Window read(Q query);
}
