package io.softwarity.livewire;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.operators.multi.processors.BroadcastProcessor;
import io.vertx.core.Vertx;

/** The sharing, the silence, the coalescing and the cleanup — the twin of go/window_test.go. */
class RegistryTest {

    private final Vertx vertx = Vertx.vertx();

    @AfterEach
    void close() throws Exception {
        vertx.close().toCompletionStage().toCompletableFuture().get(5, TimeUnit.SECONDS);
    }

    /** A source counting its reads, its version moved by hand, woken by hand. */
    static final class Counted implements Source<String> {

        final AtomicInteger reads = new AtomicInteger();
        final AtomicInteger version = new AtomicInteger(1);
        final BroadcastProcessor<Object> changes = BroadcastProcessor.create();

        @Override
        public String readQuery(JsonNode raw) {
            return "";
        }

        @Override
        public String key(String query) {
            return query;
        }

        @Override
        public Multi<?> wake() {
            return changes;
        }

        @Override
        public Window read(String query) {
            reads.incrementAndGet();
            return Window.of(List.of(Row.of("r1", "v" + version.get())));
        }
    }

    private static void eventually(Runnable check) throws InterruptedException {
        AssertionError last = null;
        for (int i = 0; i < 100; i++) {
            try {
                check.run();
                return;
            } catch (AssertionError failed) {
                last = failed;
                Thread.sleep(20);
            }
        }
        throw last;
    }

    @Test
    void twoWatchersOfOneQuestionShareOneRead() throws Exception {
        Registry registry = new Registry(vertx, Duration.ofMillis(1));
        Counted source = new Counted();
        List<Window> first = new CopyOnWriteArrayList<>();
        List<Window> second = new CopyOnWriteArrayList<>();
        registry.watch("t", source, "q", first::add);
        eventually(() -> assertEquals(1, first.size()));
        registry.watch("t", source, "q", second::add);
        // The late watcher is handed what the window holds; nothing is read again.
        eventually(() -> assertEquals(1, second.size()));
        assertEquals(1, source.reads.get());
        assertEquals(1, registry.size());
    }

    @Test
    void aReadThatChangedNothingPublishesNothing() throws Exception {
        Registry registry = new Registry(vertx, Duration.ofMillis(1));
        Counted source = new Counted();
        List<Window> seen = new CopyOnWriteArrayList<>();
        registry.watch("t", source, "q", seen::add);
        eventually(() -> assertEquals(1, seen.size()));
        source.changes.onNext("tick");
        eventually(() -> assertEquals(2, source.reads.get()));
        Thread.sleep(50);
        assertEquals(1, seen.size(), "an unchanged read was published");
        source.version.set(2);
        source.changes.onNext("tick");
        eventually(() -> assertEquals(2, seen.size()));
    }

    @Test
    void aBurstOfWakesIsGatheredIntoOneRead() throws Exception {
        Registry registry = new Registry(vertx, Duration.ofMillis(100));
        Counted source = new Counted();
        registry.watch("t", source, "q", window -> {
        });
        eventually(() -> assertEquals(1, source.reads.get()));
        for (int i = 0; i < 20; i++) {
            source.changes.onNext(i);
        }
        Thread.sleep(300);
        assertEquals(2, source.reads.get(), "twenty wakes in a burst read more than once");
    }

    @Test
    void theLastWatcherLeavingStopsTheReadsAndDropsTheEntry() throws Exception {
        Registry registry = new Registry(vertx, Duration.ofMillis(1));
        Counted source = new Counted();
        Runnable first = registry.watch("t", source, "q", window -> {
        });
        Runnable second = registry.watch("t", source, "q", window -> {
        });
        eventually(() -> assertEquals(1, source.reads.get()));
        first.run();
        assertEquals(1, registry.size(), "one watcher left, the entry went");
        second.run();
        assertEquals(0, registry.size());
        source.changes.onNext("tick");
        Thread.sleep(50);
        assertEquals(1, source.reads.get(), "a window nobody watches was read");
    }

    @Test
    void twoQuestionsAreTwoReads() throws Exception {
        Registry registry = new Registry(vertx, Duration.ofMillis(1));
        Counted source = new Counted();
        registry.watch("t", source, "q1", window -> {
        });
        registry.watch("t", source, "q2", window -> {
        });
        eventually(() -> assertEquals(2, source.reads.get()));
        assertTrue(registry.size() == 2);
    }
}
