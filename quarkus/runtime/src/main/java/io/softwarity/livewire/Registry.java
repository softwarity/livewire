package io.softwarity.livewire;

import java.time.Duration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import org.jboss.logging.Logger;

import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.subscription.Cancellable;
import io.vertx.core.Vertx;

/**
 * The reads the sources share: whoever asks the same question watches one window.
 *
 * Two watchers of the same key share one read; a late one is handed what the window already
 * holds. A burst of wakes becomes one read, a read that changed nothing publishes nothing, and
 * when the last watcher leaves the read stops and the entry is dropped — otherwise the map is a
 * leak the size of every filter ever typed.
 *
 * Plain Java over Vert.x, so that it can be checked without an application around it.
 */
final class Registry {

    /**
     * How long a burst of changes gathers before a window is read again. Long enough to turn a
     * salvo into one read, short enough that nobody notices the wait.
     */
    static final Duration COALESCE_DEFAULT = Duration.ofMillis(300);

    private static final Logger LOG = Logger.getLogger(Registry.class);

    private final Vertx vertx;
    private final long coalesce;
    private final Map<String, Shared> windows = new HashMap<>();

    Registry(Vertx vertx, Duration coalesce) {
        this.vertx = vertx;
        this.coalesce = Math.max(1, coalesce.toMillis());
    }

    /**
     * Watches the window a question answers: {@code watcher} receives it now if it is already
     * known, then every time it moves. Answers how to stop watching.
     */
    @SuppressWarnings({ "rawtypes", "unchecked" })
    Runnable watch(String topic, Source source, Object query, Consumer<Window> watcher) {
        String key = topic + '\u0000' + source.key(query);
        Shared shared;
        long id;
        boolean fresh = false;
        synchronized (this) {
            shared = windows.get(key);
            if (shared == null) {
                shared = new Shared(key, source, query);
                windows.put(key, shared);
                fresh = true;
            }
            id = shared.next++;
            shared.watchers.put(id, watcher);
            // What the window already holds, so a late watcher is not left waiting for the next
            // change to see anything at all. Under the lock a publication takes: it cannot be
            // handed this window after a newer one.
            if (!fresh && shared.last != null) {
                watcher.accept(shared.last);
            }
        }
        if (fresh) {
            start(shared);
        }
        Shared watched = shared;
        return () -> leave(watched, id);
    }

    /** How many distinct questions are being watched: what the tests check the cleanup by. */
    synchronized int size() {
        return windows.size();
    }

    private void leave(Shared shared, long id) {
        synchronized (this) {
            shared.watchers.remove(id);
            if (!shared.watchers.isEmpty()) {
                return;
            }
            windows.remove(shared.key);
        }
        synchronized (shared) {
            shared.stopped = true;
            if (shared.timer >= 0) {
                vertx.cancelTimer(shared.timer);
                shared.timer = -1;
            }
        }
        if (shared.wake != null) {
            shared.wake.cancel();
        }
    }

    private void start(Shared shared) {
        read(shared);
        Multi<?> wake = shared.source.wake();
        shared.wake = wake.subscribe().with(
                woken -> gather(shared),
                failure -> LOG.warnf(failure, "livewire: the wake of %s failed, it reads no more", shared.key));
    }

    /** A wake: read once the burst it starts has gathered, however many follow it. */
    private void gather(Shared shared) {
        synchronized (shared) {
            if (shared.stopped || shared.timer >= 0) {
                return;
            }
            shared.timer = vertx.setTimer(coalesce, timer -> {
                synchronized (shared) {
                    shared.timer = -1;
                }
                read(shared);
            });
        }
    }

    /** Reads on a worker, one at a time per window; a wake during a read reads again after it. */
    @SuppressWarnings("unchecked")
    private void read(Shared shared) {
        synchronized (shared) {
            if (shared.stopped) {
                return;
            }
            if (shared.reading) {
                shared.again = true;
                return;
            }
            shared.reading = true;
        }
        vertx.<Window>executeBlocking(() -> shared.source.read(shared.query), false).onComplete(done -> {
            if (done.succeeded() && done.result() != null) {
                publish(shared, done.result());
            } else if (done.failed()) {
                // A read that failed is not a window that emptied: saying nothing leaves the
                // screen on what it had, the truthful answer until the next read succeeds.
                LOG.warnf(done.cause(), "livewire: a read of %s failed", shared.key);
            }
            boolean again;
            synchronized (shared) {
                shared.reading = false;
                again = shared.again;
                shared.again = false;
            }
            if (again) {
                gather(shared);
            }
        });
    }

    /** Publishes the window, unless it did not move (SPEC §5.3). */
    private void publish(Shared shared, Window next) {
        String signature = Frames.signatureOf(next);
        synchronized (this) {
            if (shared.last != null && signature.equals(shared.signature)) {
                return;
            }
            shared.last = next;
            shared.signature = signature;
            // A watcher only hands the window to its connection's thread: cheap enough to do here,
            // and in order with what a late watcher is handed in watch().
            for (Consumer<Window> watcher : List.copyOf(shared.watchers.values())) {
                watcher.accept(next);
            }
        }
    }

    /** One shared read, and everyone watching it. */
    private static final class Shared {

        final String key;
        @SuppressWarnings("rawtypes")
        final Source source;
        final Object query;
        final Map<Long, Consumer<Window>> watchers = new LinkedHashMap<>();
        long next;
        Window last;
        String signature;
        Cancellable wake;
        long timer = -1;
        boolean reading;
        boolean again;
        boolean stopped;

        @SuppressWarnings("rawtypes")
        Shared(String key, Source source, Object query) {
            this.key = key;
            this.source = source;
            this.query = query;
        }
    }
}
