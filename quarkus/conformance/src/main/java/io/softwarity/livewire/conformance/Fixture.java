package io.softwarity.livewire.conformance;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import jakarta.inject.Inject;

import com.fasterxml.jackson.databind.JsonNode;

import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.operators.multi.processors.BroadcastProcessor;
import io.softwarity.livewire.LiveCommand;
import io.softwarity.livewire.LiveCommands;
import io.softwarity.livewire.LiveTopic;
import io.softwarity.livewire.Livewire;
import io.softwarity.livewire.Row;
import io.softwarity.livewire.Source;
import io.softwarity.livewire.SourceWithContext;
import io.softwarity.livewire.Window;
import io.vertx.ext.web.Router;
import io.vertx.ext.web.RoutingContext;

/**
 * What the shared scenarios expect, and nothing else — the twin of go/cmd/conformance.
 *
 * <ul>
 * <li>{@code rows}: a list whose newest row arrives at the top;</li>
 * <li>{@code still}: a window that never changes;</li>
 * <li>{@code mine}: one row, who opened the socket ({@code ?caller=} of its URL);</li>
 * <li>commands {@code touch} (an arrival) and {@code announce} (a notification);</li>
 * <li>{@code POST /touch}: an arrival, outside the socket.</li>
 * </ul>
 */
public class Fixture {

    /**
     * The data the two sources read, and what wakes them. Reached through methods only: the
     * sources hold a client proxy, and a field read through it is the proxy's own field.
     */
    @ApplicationScoped
    public static class Feed {

        private final AtomicInteger arrivals = new AtomicInteger();
        private final BroadcastProcessor<Integer> changes = BroadcastProcessor.create();

        void touch() {
            changes.onNext(arrivals.incrementAndGet());
        }

        int arrivals() {
            return arrivals.get();
        }

        Multi<Integer> changes() {
            return changes;
        }

        void routes(@Observes Router router) {
            router.post("/touch").handler(context -> {
                touch();
                context.response().setStatusCode(204).end();
            });
        }
    }

    @LiveTopic("rows")
    @ApplicationScoped
    public static class Rows implements Source<String> {

        @Inject
        Feed feed;

        @Override
        public String readQuery(JsonNode raw) {
            return "";
        }

        @Override
        public String key(String query) {
            return "";
        }

        @Override
        public Multi<?> wake() {
            return feed.changes();
        }

        /**
         * Newest first, so an arrival pushes the others down without changing them — which is
         * what checks that a row that only moved is not re-sent.
         */
        @Override
        public Window read(String query) {
            int arrivals = feed.arrivals();
            List<Row> rows = new ArrayList<>();
            for (int index = arrivals; index > 0; index--) {
                rows.add(Row.of("new-" + index, "v1"));
            }
            rows.add(Row.of("r1", "v1"));
            rows.add(Row.of("r2", "v1"));
            return Window.page(rows, arrivals + 2);
        }
    }

    @LiveTopic("still")
    @ApplicationScoped
    public static class Still implements Source<String> {

        @Inject
        Feed feed;

        @Override
        public String readQuery(JsonNode raw) {
            return "";
        }

        @Override
        public String key(String query) {
            return "";
        }

        @Override
        public Multi<?> wake() {
            return feed.changes();
        }

        @Override
        public Window read(String query) {
            return Window.page(List.of(Row.of("always", "v1")), 1);
        }
    }

    /** Who opened the socket, whatever the query claims — SPEC §5.5. */
    @LiveTopic("mine")
    @ApplicationScoped
    public static class Mine implements SourceWithContext<String> {

        @Inject
        Feed feed;

        @Override
        public String readQuery(JsonNode raw, RoutingContext opening) {
            String caller = opening.request().getParam("caller");
            return caller == null || caller.isBlank() ? "anonymous" : caller;
        }

        @Override
        public String key(String caller) {
            return caller;
        }

        @Override
        public Multi<?> wake() {
            return feed.changes();
        }

        @Override
        public Window read(String caller) {
            return Window.page(List.of(Row.of(caller, "v1")), 1);
        }
    }

    /** What a level 2 server must expose for the suite — SPEC §6. */
    @ApplicationScoped
    public static class Commands implements LiveCommands {

        @Inject
        Feed feed;

        @Inject
        Livewire livewire;

        @LiveCommand("touch")
        public void touch() {
            feed.touch();
        }

        @LiveCommand("announce")
        public void announce() {
            livewire.notify("announcements", java.util.Map.of("said", "something happened"));
        }
    }
}
