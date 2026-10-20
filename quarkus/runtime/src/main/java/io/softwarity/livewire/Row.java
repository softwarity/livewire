package io.softwarity.livewire;

import java.util.Map;
import java.util.Objects;

/**
 * What every row a source publishes must carry.
 *
 * @param id        the row's identity in the list
 * @param updatedAt the version of this row. It changes whenever anything the row shows
 *                  changes — not only what a write touched. Not necessarily a timestamp: a
 *                  row carrying a value derived from the clock has to fold that value in,
 *                  otherwise the server believes the row unchanged and never sends it again
 *                  (SPEC §5.1).
 * @param data      what the row shows, written flat beside {@code id} and {@code updatedAt}:
 *                  the wire carries one object per row, not a nested one
 */
public record Row(String id, String updatedAt, Map<String, Object> data) {

    public Row {
        Objects.requireNonNull(id, "a row needs an id");
        Objects.requireNonNull(updatedAt, "a row needs a version (updatedAt)");
        data = data == null ? Map.of() : data;
    }

    public static Row of(String id, String updatedAt) {
        return new Row(id, updatedAt, Map.of());
    }
}
