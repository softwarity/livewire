package io.softwarity.livewire;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** The frames of the protocol (SPEC §2.2), and the diff between two windows (SPEC §5.2). */
final class Frames {

    static final String SUBSCRIBE = "subscribe";
    static final String UNSUBSCRIBE = "unsubscribe";
    static final String COMMAND = "command";
    static final String UPDATE = "update";
    static final String ACK = "ack";
    static final String NOTIFY = "notify";

    /** RFC 6455 policy violation: the socket opened, the caller may not use it. */
    static final short NOT_AUTHORISED = 1008;

    private final ObjectMapper json;

    Frames(ObjectMapper json) {
        this.json = json;
    }

    /** The first frame on a subscription: the window as it stands. */
    ObjectNode snapshotOf(String id, Window window, int sequence) {
        ObjectNode data = json.createObjectNode();
        data.put("id", id);
        data.put("type", "snapshot");
        data.set("rows", rows(window.rows()));
        extent(data, window);
        data.put("sequence", sequence);
        return data;
    }

    /**
     * What one client has not seen yet. {@code updatedAt} is the version: a row whose version
     * is unchanged is the same row, whatever moved around it, so it is not re-sent because the
     * one above it left the window. It is in {@code order}, which is enough to place it.
     */
    ObjectNode patchOf(String id, List<Row> before, Window after, int sequence) {
        Map<String, String> held = new HashMap<>();
        for (Row row : before) {
            held.put(row.id(), row.updatedAt());
        }
        Set<String> kept = new HashSet<>();
        List<Row> upserted = new ArrayList<>();
        ArrayNode order = json.createArrayNode();
        for (Row row : after.rows()) {
            kept.add(row.id());
            if (!row.updatedAt().equals(held.get(row.id()))) {
                upserted.add(row);
            }
            order.add(row.id());
        }
        ArrayNode removed = json.createArrayNode();
        for (Row row : before) {
            if (!kept.contains(row.id())) {
                removed.add(row.id());
            }
        }
        ObjectNode data = json.createObjectNode();
        data.put("id", id);
        data.put("type", "patch");
        data.set("upserted", rows(upserted));
        data.set("removed", removed);
        data.set("order", order);
        extent(data, after);
        data.put("sequence", sequence);
        return data;
    }

    /** Sent when a subscription names a topic nothing answers, or a query is refused. */
    ObjectNode errorOf(String id, String reason) {
        ObjectNode data = json.createObjectNode();
        data.put("id", id);
        data.put("type", "error");
        data.put("reason", reason);
        return data;
    }

    /** The one answer a command gets, whatever happened — SPEC §6.1. */
    ObjectNode ackOf(String id, Object result) {
        ObjectNode data = json.createObjectNode();
        data.put("id", id);
        data.put("ok", true);
        if (result != null) {
            data.set("result", json.valueToTree(result));
        }
        return data;
    }

    ObjectNode refusedOf(String id, String reason) {
        ObjectNode data = json.createObjectNode();
        data.put("id", id);
        data.put("ok", false);
        data.put("reason", reason);
        return data;
    }

    /** An event, not a window — SPEC §6.2. Nothing to apply. */
    ObjectNode notifyOf(String topic, Object payload) {
        ObjectNode data = json.createObjectNode();
        data.put("topic", topic);
        if (payload != null) {
            data.set("payload", json.valueToTree(payload));
        }
        return data;
    }

    /** {@code {"event": …, "data": …}}: how every frame travels, both ways. */
    String envelope(String event, ObjectNode data) {
        ObjectNode envelope = json.createObjectNode();
        envelope.put("event", event);
        envelope.set("data", data);
        return envelope.toString();
    }

    /**
     * Same rows, same order, same versions, same length, same pivot — or the window moved.
     * Used to stay silent on a read that changed nothing (SPEC §5.3).
     */
    static String signatureOf(Window window) {
        StringBuilder signature = new StringBuilder();
        signature.append(window.total() == null ? "-" : window.total()).append(':');
        signature.append(window.pivot() == null ? "-" : window.pivot()).append(':');
        for (int i = 0; i < window.rows().size(); i++) {
            Row row = window.rows().get(i);
            if (i > 0) {
                signature.append(',');
            }
            signature.append(row.id()).append('@').append(row.updatedAt());
        }
        return signature.toString();
    }

    /** One object per row: what it shows, flat beside {@code id} and {@code updatedAt}. */
    private ArrayNode rows(List<Row> rows) {
        ArrayNode array = json.createArrayNode();
        for (Row row : rows) {
            ObjectNode flat = json.valueToTree(row.data());
            flat.put("id", row.id());
            flat.put("updatedAt", row.updatedAt());
            array.add(flat);
        }
        return array;
    }

    private static void extent(ObjectNode data, Window window) {
        if (window.total() != null) {
            data.put("total", window.total());
        }
        if (window.pivot() != null) {
            data.put("pivot", window.pivot());
        }
    }
}
