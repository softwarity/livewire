package livewire

import (
	"reflect"
	"testing"
)

// The scenarios here mirror packages/nestjs/test/patch.spec.ts, name for name.
// Two implementations of one protocol diverge through the cases nobody wrote
// down; writing the same ones twice is what keeps them together.

func row(id string, version ...string) Row {
	stamp := "v1"
	if len(version) > 0 {
		stamp = version[0]
	}
	return Row{ID: id, UpdatedAt: stamp}
}

func ids(rows []Row) []string {
	out := make([]string, 0, len(rows))
	for _, one := range rows {
		out = append(out, one.ID)
	}
	return out
}

func number(value int) *int { return &value }

func TestSnapshotCarriesTheWindowWhole(t *testing.T) {
	frame := snapshotOf("w", Window{Rows: []Row{row("a"), row("b")}, Total: number(42), Pivot: number(7)}, 1)

	if frame.Type != "snapshot" || frame.ID != "w" || frame.Sequence != 1 {
		t.Fatalf("unexpected envelope: %+v", frame)
	}
	if !reflect.DeepEqual(ids(frame.Rows), []string{"a", "b"}) {
		t.Fatalf("rows = %v", ids(frame.Rows))
	}
	if *frame.Total != 42 || *frame.Pivot != 7 {
		t.Fatalf("total/pivot = %v/%v", frame.Total, frame.Pivot)
	}
}

func TestSnapshotLeavesTotalAndPivotUnset(t *testing.T) {
	frame := snapshotOf("w", Window{Rows: []Row{row("a")}}, 1)

	if frame.Total != nil || frame.Pivot != nil {
		t.Fatalf("total/pivot should be absent, got %v/%v", frame.Total, frame.Pivot)
	}
}

func TestPatchUpsertsARowThatWasNotThere(t *testing.T) {
	frame := patchOf("w", []Row{row("a")}, Window{Rows: []Row{row("a"), row("b")}}, 2)

	if !reflect.DeepEqual(ids(frame.Upserted), []string{"b"}) {
		t.Fatalf("upserted = %v", ids(frame.Upserted))
	}
	if len(frame.Removed) != 0 {
		t.Fatalf("removed = %v", frame.Removed)
	}
	if !reflect.DeepEqual(frame.Order, []string{"a", "b"}) {
		t.Fatalf("order = %v", frame.Order)
	}
}

func TestPatchUpsertsARowWhoseVersionChanged(t *testing.T) {
	frame := patchOf("w", []Row{row("a", "v1")}, Window{Rows: []Row{row("a", "v2")}}, 2)

	if len(frame.Upserted) != 1 || frame.Upserted[0].UpdatedAt != "v2" {
		t.Fatalf("upserted = %+v", frame.Upserted)
	}
}

// The rule an implementation gets wrong first: a row that only moved is in
// Order and nowhere else. Re-sending it would double the size of every patch on
// a list where anything is inserted at the top.
func TestPatchDoesNotUpsertARowThatOnlyMoved(t *testing.T) {
	frame := patchOf("w", []Row{row("a"), row("b")}, Window{Rows: []Row{row("b"), row("a")}}, 2)

	if len(frame.Upserted) != 0 {
		t.Fatalf("upserted = %v", ids(frame.Upserted))
	}
	if len(frame.Removed) != 0 {
		t.Fatalf("removed = %v", frame.Removed)
	}
	if !reflect.DeepEqual(frame.Order, []string{"b", "a"}) {
		t.Fatalf("order = %v", frame.Order)
	}
}

func TestPatchRemovesWhatLeftTheWindow(t *testing.T) {
	frame := patchOf("w", []Row{row("a"), row("b")}, Window{Rows: []Row{row("a")}}, 2)

	if !reflect.DeepEqual(frame.Removed, []string{"b"}) {
		t.Fatalf("removed = %v", frame.Removed)
	}
	if len(frame.Upserted) != 0 {
		t.Fatalf("upserted = %v", ids(frame.Upserted))
	}
}

func TestPatchEmptiesTheWindow(t *testing.T) {
	frame := patchOf("w", []Row{row("a"), row("b")}, Window{Rows: []Row{}}, 2)

	if !reflect.DeepEqual(frame.Removed, []string{"a", "b"}) {
		t.Fatalf("removed = %v", frame.Removed)
	}
	if len(frame.Order) != 0 {
		t.Fatalf("order = %v", frame.Order)
	}
}

func TestPatchSaysNothingWhenNothingChanged(t *testing.T) {
	frame := patchOf("w", []Row{row("a"), row("b")}, Window{Rows: []Row{row("a"), row("b")}}, 2)

	if len(frame.Upserted) != 0 || len(frame.Removed) != 0 {
		t.Fatalf("upserted=%v removed=%v", ids(frame.Upserted), frame.Removed)
	}
}

func TestPatchCarriesTotalAndPivot(t *testing.T) {
	frame := patchOf("w", nil, Window{Rows: []Row{row("a")}, Total: number(9), Pivot: number(3)}, 2)

	if *frame.Total != 9 || *frame.Pivot != 3 {
		t.Fatalf("total/pivot = %v/%v", frame.Total, frame.Pivot)
	}
}

func TestPatchHandlesAWindowSliding(t *testing.T) {
	before := []Row{row("c"), row("d"), row("e")}
	frame := patchOf("w", before, Window{Rows: []Row{row("a"), row("b"), row("c")}}, 2)

	if !reflect.DeepEqual(ids(frame.Upserted), []string{"a", "b"}) {
		t.Fatalf("upserted = %v", ids(frame.Upserted))
	}
	if !reflect.DeepEqual(frame.Removed, []string{"d", "e"}) {
		t.Fatalf("removed = %v", frame.Removed)
	}
}

func TestSignatureIsTheSameForTwoIdenticalWindows(t *testing.T) {
	one := Window{Rows: []Row{row("a"), row("b")}, Total: number(2)}
	two := Window{Rows: []Row{row("a"), row("b")}, Total: number(2)}

	if signatureOf(one) != signatureOf(two) {
		t.Fatalf("%q != %q", signatureOf(one), signatureOf(two))
	}
}

func TestSignatureDiffersOnVersionOrderTotalAndPivot(t *testing.T) {
	base := Window{Rows: []Row{row("a", "v1"), row("b")}, Total: number(10), Pivot: number(1)}

	for name, other := range map[string]Window{
		"version": {Rows: []Row{row("a", "v2"), row("b")}, Total: number(10), Pivot: number(1)},
		"order":   {Rows: []Row{row("b"), row("a", "v1")}, Total: number(10), Pivot: number(1)},
		"total":   {Rows: []Row{row("a", "v1"), row("b")}, Total: number(11), Pivot: number(1)},
		// Read from the clock on some sources, and moving with no row being
		// written: a signature that ignored it would publish nothing.
		"pivot": {Rows: []Row{row("a", "v1"), row("b")}, Total: number(10), Pivot: number(2)},
	} {
		if signatureOf(base) == signatureOf(other) {
			t.Errorf("%s: signature did not change", name)
		}
	}
}
