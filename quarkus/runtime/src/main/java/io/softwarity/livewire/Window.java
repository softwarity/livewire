package io.softwarity.livewire;

import java.util.List;

/**
 * What a source answers with: a window of rows, and what it is a window of. Always whole,
 * never a delta — turning it into a patch is the server's business, per subscription.
 *
 * @param rows  the rows, in the order the list shows them
 * @param total the length the window is a page of; {@code null} when the source does not page
 * @param pivot an index in the whole list the source points the client at; {@code null} when
 *              it has none. A number and nothing more: neither side interprets it.
 */
public record Window(List<Row> rows, Integer total, Integer pivot) {

    public Window {
        rows = rows == null ? List.of() : List.copyOf(rows);
    }

    public static Window of(List<Row> rows) {
        return new Window(rows, null, null);
    }

    public static Window page(List<Row> rows, int total) {
        return new Window(rows, total, null);
    }
}
