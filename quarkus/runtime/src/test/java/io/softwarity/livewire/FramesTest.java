package io.softwarity.livewire;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/** The diff of SPEC §5.2 and the signature of §5.3 — the twin of go/patch_test.go. */
class FramesTest {

    private final Frames frames = new Frames(new ObjectMapper());

    private static List<String> ids(JsonNode array) {
        List<String> ids = new ArrayList<>();
        array.forEach(node -> ids.add(node.isTextual() ? node.asText() : node.get("id").asText()));
        return ids;
    }

    @Test
    void anAddedRowIsUpserted() {
        JsonNode patch = frames.patchOf("a", List.of(Row.of("r1", "v1")), Window.of(List.of(Row.of("r0", "v1"), Row.of("r1", "v1"))), 2);
        assertEquals(List.of("r0"), ids(patch.get("upserted")));
        assertEquals(List.of(), ids(patch.get("removed")));
        assertEquals(List.of("r0", "r1"), ids(patch.get("order")));
        assertEquals(2, patch.get("sequence").asInt());
    }

    @Test
    void aRemovedRowIsNamed() {
        JsonNode patch = frames.patchOf("a", List.of(Row.of("r1", "v1"), Row.of("r2", "v1")), Window.of(List.of(Row.of("r2", "v1"))), 2);
        assertEquals(List.of(), ids(patch.get("upserted")));
        assertEquals(List.of("r1"), ids(patch.get("removed")));
    }

    @Test
    void aRowWhoseVersionChangedIsUpserted() {
        JsonNode patch = frames.patchOf("a", List.of(Row.of("r1", "v1")), Window.of(List.of(Row.of("r1", "v2"))), 2);
        assertEquals(List.of("r1"), ids(patch.get("upserted")));
    }

    @Test
    void aRowThatOnlyMovedIsNotUpserted() {
        JsonNode patch = frames.patchOf("a", List.of(Row.of("r1", "v1"), Row.of("r2", "v1")),
                Window.of(List.of(Row.of("r2", "v1"), Row.of("r1", "v1"))), 2);
        assertEquals(List.of(), ids(patch.get("upserted")));
        assertEquals(List.of("r2", "r1"), ids(patch.get("order")));
    }

    @Test
    void aWindowEmptiedRemovesEverything() {
        JsonNode patch = frames.patchOf("a", List.of(Row.of("r1", "v1")), Window.of(List.of()), 2);
        assertEquals(List.of("r1"), ids(patch.get("removed")));
        assertEquals(List.of(), ids(patch.get("order")));
    }

    @Test
    void aRowIsWrittenFlatWithItsIdAndVersion() {
        JsonNode snapshot = frames.snapshotOf("a", new Window(List.of(new Row("r1", "v1", Map.of("title", "Payerne"))), 1, null), 1);
        JsonNode row = snapshot.get("rows").get(0);
        assertEquals("r1", row.get("id").asText());
        assertEquals("v1", row.get("updatedAt").asText());
        assertEquals("Payerne", row.get("title").asText());
        assertEquals(1, snapshot.get("total").asInt());
        // No pivot said, none written: absent rather than null on the wire.
        assertFalse(snapshot.has("pivot"));
    }

    @Test
    void theSignatureFollowsRowsVersionsOrderTotalAndPivot() {
        Window window = new Window(List.of(Row.of("r1", "v1"), Row.of("r2", "v1")), 2, null);
        assertEquals(Frames.signatureOf(window), Frames.signatureOf(new Window(window.rows(), 2, null)));
        assertNotEquals(Frames.signatureOf(window), Frames.signatureOf(new Window(List.of(Row.of("r2", "v1"), Row.of("r1", "v1")), 2, null)));
        assertNotEquals(Frames.signatureOf(window), Frames.signatureOf(new Window(List.of(Row.of("r1", "v2"), Row.of("r2", "v1")), 2, null)));
        assertNotEquals(Frames.signatureOf(window), Frames.signatureOf(new Window(window.rows(), 3, null)));
        assertNotEquals(Frames.signatureOf(window), Frames.signatureOf(new Window(window.rows(), 2, 1)));
        assertTrue(Frames.signatureOf(Window.of(List.of())).endsWith(":"));
    }
}
