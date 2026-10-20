package io.softwarity.livewire;

import com.fasterxml.jackson.databind.JsonNode;

/** Reading a query off the socket, field by field, without trusting it. */
public final class Queries {

    /**
     * The widest window a client may ask for. Wider than a screen, narrower than a scan. The
     * real ceiling is the wire, and it is not this: some proxies silently drop frames over
     * ~64 kB, so what fits depends on the size of a row and is the source's business.
     */
    public static final int MAX_LIMIT = 200;

    private Queries() {
    }

    /** A non-empty trimmed string, or {@code null}. */
    public static String text(JsonNode raw, String field) {
        JsonNode value = raw == null ? null : raw.get(field);
        if (value == null || !value.isTextual()) {
            return null;
        }
        String text = value.asText().strip();
        return text.isEmpty() ? null : text;
    }

    /** A whole number, at least zero, or the fallback. */
    public static int whole(JsonNode raw, String field, int fallback) {
        JsonNode value = raw == null ? null : raw.get(field);
        if (value == null || !value.isNumber() || value.asDouble() < 0) {
            return fallback;
        }
        return (int) value.asDouble();
    }

    /** Whatever was asked for, kept inside what this server will send: 1 to {@link #MAX_LIMIT}. */
    public static int limitOf(JsonNode raw, String field, int fallback) {
        return Math.max(1, Math.min(MAX_LIMIT, whole(raw, field, fallback)));
    }
}
