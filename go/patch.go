package livewire

import "strings"

// snapshotOf is the first frame on a subscription: the window as it stands.
func snapshotOf(id string, window Window, sequence int) snapshotFrame {
	return snapshotFrame{
		ID:       id,
		Type:     "snapshot",
		Rows:     rowsOrEmpty(window.Rows),
		Total:    window.Total,
		Pivot:    window.Pivot,
		Sequence: sequence,
	}
}

// patchOf is what one client has not seen yet.
//
// UpdatedAt is the version: a row whose stamp is unchanged is the same row,
// whatever moved around it, so an unchanged row is not re-sent because the one
// above it left the window. It is in Order, which is enough to place it.
//
// See SPEC §5.2. The rule that catches implementations out is the one about
// versions, not this function: a row carrying a value derived from the clock
// has to fold that value into UpdatedAt, or the comparison below calls it
// unchanged and it is never sent again.
func patchOf(id string, before []Row, after Window, sequence int) patchFrame {
	held := make(map[string]string, len(before))
	for _, row := range before {
		held[row.ID] = row.UpdatedAt
	}
	kept := make(map[string]struct{}, len(after.Rows))
	for _, row := range after.Rows {
		kept[row.ID] = struct{}{}
	}

	upserted := make([]Row, 0, len(after.Rows))
	order := make([]string, 0, len(after.Rows))
	for _, row := range after.Rows {
		if version, seen := held[row.ID]; !seen || version != row.UpdatedAt {
			upserted = append(upserted, row)
		}
		order = append(order, row.ID)
	}

	removed := make([]string, 0)
	for _, row := range before {
		if _, still := kept[row.ID]; !still {
			removed = append(removed, row.ID)
		}
	}

	return patchFrame{
		ID:       id,
		Type:     "patch",
		Upserted: upserted,
		Removed:  removed,
		Order:    order,
		Total:    after.Total,
		Pivot:    after.Pivot,
		Sequence: sequence,
	}
}

// signatureOf answers: same rows, same order, same versions, same length, same
// pivot — or the window moved.
//
// Used to stay silent on a read that changed nothing (SPEC §5.3). Not an
// optimisation: a source woken by a busy feed re-reads constantly, and a screen
// repainting on every read is a screen nobody can use.
func signatureOf(window Window) string {
	var builder strings.Builder
	builder.WriteString(numberOrNil(window.Total))
	builder.WriteByte(':')
	builder.WriteString(numberOrNil(window.Pivot))
	builder.WriteByte(':')
	for index, row := range window.Rows {
		if index > 0 {
			builder.WriteByte(',')
		}
		builder.WriteString(row.ID)
		builder.WriteByte('@')
		builder.WriteString(row.UpdatedAt)
	}
	return builder.String()
}

func numberOrNil(value *int) string {
	if value == nil {
		return "-"
	}
	return itoa(*value)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits [20]byte
	at := len(digits)
	for value > 0 {
		at--
		digits[at] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		at--
		digits[at] = '-'
	}
	return string(digits[at:])
}

// rowsOrEmpty keeps an empty window `[]` on the wire rather than `null`: a
// client applying a snapshot should not have to tell the two apart.
func rowsOrEmpty(rows []Row) []Row {
	if rows == nil {
		return []Row{}
	}
	return rows
}
