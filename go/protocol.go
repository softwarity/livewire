// Package livewire synchronises the result of a query over one WebSocket: a
// client subscribes to a question, receives its answer, then every answer
// after it.
//
// This is the Go implementation of the contract in
// packages/protocol/SPEC.md. That document is normative — where this code and
// the specification disagree, the specification is right and this is a bug.
package livewire

import "encoding/json"

// Row is what every row a source publishes must carry.
type Row struct {
	ID string `json:"id"`

	// UpdatedAt is the version of this row. It changes whenever anything the
	// row shows changes.
	//
	// Not necessarily a timestamp: a filter entry whose only content is its
	// label uses the label, and a row carrying a value derived from the clock
	// has to fold that value in — otherwise the server believes the row
	// unchanged and never sends it again. See SPEC.md, "Versions".
	UpdatedAt string `json:"updatedAt"`

	// Data is what the row actually shows. Marshalled flat beside ID and
	// UpdatedAt, so the wire carries one object per row rather than a nested
	// one — see MarshalJSON.
	Data map[string]any `json:"-"`
}

// MarshalJSON writes id, updatedAt and the row's own fields as one object.
func (r Row) MarshalJSON() ([]byte, error) {
	flat := make(map[string]any, len(r.Data)+2)
	for key, value := range r.Data {
		flat[key] = value
	}
	flat["id"] = r.ID
	flat["updatedAt"] = r.UpdatedAt
	return json.Marshal(flat)
}

// Window is what a source answers with: a window of rows, and what it is a
// window of.
type Window struct {
	Rows []Row

	// Total is the length the window is a page of. Nil when the source does
	// not page.
	Total *int

	// Pivot is an index in the whole list the source points the client at.
	//
	// A number and nothing more — neither side interprets it. A departure
	// board uses it for the boundary between what has left and what has not: a
	// position in the list that a client holding one page of six hundred
	// cannot work out from the rows it happens to have.
	Pivot *int
}

// Frame names are the vocabulary of the protocol. There is no other.
const (
	SubscribeEvent   = "subscribe"
	UnsubscribeEvent = "unsubscribe"
	UpdateEvent      = "update"
)

// NotAuthorised is RFC 6455 policy violation: the socket opened, the caller
// may not use it.
const NotAuthorised = 1008

// Envelope is how every frame travels, both ways.
type Envelope struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

// subscribeFrame opens a subscription, or moves an open one.
type subscribeFrame struct {
	ID    string          `json:"id"`
	Topic string          `json:"topic"`
	Query json.RawMessage `json:"query"`
}

type unsubscribeFrame struct {
	ID string `json:"id"`
}

// snapshotFrame is the first frame on a subscription: the window as it stands.
type snapshotFrame struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Rows     []Row  `json:"rows"`
	Total    *int   `json:"total,omitempty"`
	Pivot    *int   `json:"pivot,omitempty"`
	Sequence int    `json:"sequence"`
}

// patchFrame is every frame after that.
//
// Order carries the whole window's ids, not only the changed ones: the sort
// key belongs to the source, and reproducing it client-side would be a second
// implementation free to disagree.
type patchFrame struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"`
	Upserted []Row    `json:"upserted"`
	Removed  []string `json:"removed"`
	Order    []string `json:"order"`
	Total    *int     `json:"total,omitempty"`
	Pivot    *int     `json:"pivot,omitempty"`
	Sequence int      `json:"sequence"`
}

// errorFrame is sent when a subscription names a topic nothing answers.
type errorFrame struct {
	ID     string `json:"id"`
	Type   string `json:"type"`
	Reason string `json:"reason"`
}
