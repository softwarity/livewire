package io.softwarity.livewire;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.jboss.logging.Logger;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import io.vertx.core.Context;
import io.vertx.core.http.ServerWebSocket;
import io.vertx.ext.web.RoutingContext;

/**
 * One socket and the subscriptions open on it.
 *
 * Everything that touches the subscriptions runs on the socket's own context: frames arrive
 * there, and the windows the registry publishes from its workers are handed over to it. So no
 * lock is needed here, and frames leave the socket in the order they were decided.
 */
final class Connection {

    private static final Logger LOG = Logger.getLogger(Connection.class);

    private final Livewire server;
    private final ServerWebSocket socket;
    private final Context context;
    /** The request that opened the socket: who is asking, for a {@link SourceWithContext}. */
    private final RoutingContext opening;
    private final Map<String, Subscription> subscriptions = new HashMap<>();

    Connection(Livewire server, ServerWebSocket socket, Context context, RoutingContext opening) {
        this.server = server;
        this.socket = socket;
        this.context = context;
        this.opening = opening;
        socket.textMessageHandler(this::onFrame);
    }

    /** One subscription: what this client has received under one id. */
    private static final class Subscription {

        final String id;
        Runnable leave;
        List<Row> sent = List.of();
        int sequence;
        boolean first = true;
        boolean closed;

        Subscription(String id) {
            this.id = id;
        }
    }

    private void onFrame(String text) {
        JsonNode envelope;
        try {
            envelope = server.json().readTree(text);
        } catch (Exception unreadable) {
            // Unreadable: ignored, and the socket stays up (SPEC §2).
            return;
        }
        if (envelope == null || !envelope.isObject() || !envelope.path("data").isObject()) {
            return;
        }
        JsonNode data = envelope.get("data");
        switch (envelope.path("event").asText("")) {
            case Frames.SUBSCRIBE -> onSubscribe(data);
            case Frames.UNSUBSCRIBE -> onUnsubscribe(data);
            case Frames.COMMAND -> onCommand(data);
            default -> {
                // Nothing else is part of the protocol.
            }
        }
    }

    @SuppressWarnings("rawtypes")
    private void onSubscribe(JsonNode data) {
        String id = text(data, "id");
        if (id == null) {
            // No id, nothing to answer under: ignored in silence (SPEC §2.1).
            return;
        }
        String topic = data.path("topic").asText("");
        Source source = server.source(topic);
        if (source == null) {
            write(server.frames().errorOf(id, "No topic '" + topic + "'"));
            return;
        }
        Object query;
        try {
            JsonNode raw = data.get("query");
            JsonNode given = raw == null || raw.isNull() ? null : raw;
            query = source instanceof Contextual<?> contextual ? contextual.readQuery(given, opening) : source.readQuery(given);
        } catch (RuntimeException refused) {
            write(server.frames().errorOf(id, refused.getMessage() == null ? "Query refused" : refused.getMessage()));
            return;
        }
        // The same id twice is a window that moved: the previous one ends before the new one
        // starts, and its sequence restarts at 1 (SPEC §3.2).
        close(id);
        Subscription subscription = new Subscription(id);
        subscriptions.put(id, subscription);
        subscription.leave = server.registry().watch(topic, source, query,
                window -> context.runOnContext(ignored -> publish(subscription, window)));
    }

    /**
     * What this one subscription has not seen. Per subscription rather than per window, because
     * only here is it known what actually went down the socket: a screen that joins mid-stream
     * gets a snapshot, and its patches are computed against the rows it holds.
     */
    private void publish(Subscription subscription, Window window) {
        if (subscription.closed) {
            return;
        }
        subscription.sequence++;
        if (subscription.first) {
            write(server.frames().snapshotOf(subscription.id, window, subscription.sequence));
            subscription.first = false;
        } else {
            write(server.frames().patchOf(subscription.id, subscription.sent, window, subscription.sequence));
        }
        subscription.sent = window.rows();
    }

    private void onUnsubscribe(JsonNode data) {
        String id = text(data, "id");
        if (id != null) {
            // An id nothing is open under is ignored (SPEC §3.3).
            close(id);
        }
    }

    /**
     * Does what was asked and answers exactly one ack — SPEC §6.1. Whatever happens: done,
     * refused, or a name nothing handles. On a worker: the command may write to a database.
     */
    private void onCommand(JsonNode data) {
        String id = text(data, "id");
        if (id == null) {
            return;
        }
        String name = data.path("name").asText("");
        Livewire.Command command = server.command(name);
        if (command == null) {
            send(server.frames().envelope(Frames.ACK, server.frames().refusedOf(id, "No command '" + name + "'")));
            return;
        }
        JsonNode payload = data.get("payload");
        server.vertx().executeBlocking(() -> server.run(command, payload), false).onComplete(done -> {
            ObjectNode ack;
            if (done.succeeded()) {
                ack = server.frames().ackOf(id, done.result());
            } else {
                Throwable cause = done.cause();
                LOG.warnf("livewire: command '%s' refused: %s", name, cause.toString());
                ack = server.frames().refusedOf(id, cause.getMessage() == null ? cause.toString() : cause.getMessage());
            }
            send(server.frames().envelope(Frames.ACK, ack));
        });
    }

    private void close(String id) {
        Subscription open = subscriptions.remove(id);
        if (open != null) {
            open.closed = true;
            open.leave.run();
        }
    }

    /** When the socket closes, every subscription on it closes. */
    void closeAll() {
        context.runOnContext(ignored -> {
            for (String id : new ArrayList<>(subscriptions.keySet())) {
                close(id);
            }
        });
    }

    private void write(ObjectNode update) {
        send(server.frames().envelope(Frames.UPDATE, update));
    }

    /**
     * The one place a frame reaches the socket: always through its context, whoever decided to
     * send it — a subscription publishing, an acknowledgement, a notification — so that frames
     * leave in the order they were decided.
     */
    void send(String frame) {
        context.runOnContext(ignored -> {
            if (!socket.isClosed()) {
                socket.writeTextMessage(frame);
            }
        });
    }

    private static String text(JsonNode data, String field) {
        JsonNode value = data.get(field);
        return value != null && value.isTextual() && !value.asText().isEmpty() ? value.asText() : null;
    }
}
