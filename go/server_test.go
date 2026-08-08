package livewire

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Mirrors packages/nestjs/test/livewire.gateway.spec.ts - but over a real
// socket, which is what makes these the same tests the conformance suite will
// run against any implementation.

// manual is a source driven by hand, so a test decides when the window moves.
type manual struct {
	wake chan struct{}

	mutex   sync.Mutex
	window  Window
	queries []string
	closed  int
}

func newManual() *manual {
	return &manual{wake: make(chan struct{}, 16), window: Window{Rows: []Row{}}}
}

func (m *manual) ReadQuery(raw json.RawMessage) (any, error) {
	asked := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &asked)
	}
	return Text(asked, "q"), nil
}

func (m *manual) Key(query any) string { return query.(string) }

func (m *manual) Wake() <-chan struct{} { return m.wake }

func (m *manual) Read(_ context.Context, query any) (Window, error) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	m.queries = append(m.queries, query.(string))
	return m.window, nil
}

func (m *manual) moveTo(rows ...Row) {
	m.mutex.Lock()
	m.window = Window{Rows: rows}
	m.mutex.Unlock()
	m.wake <- struct{}{}
}

func (m *manual) asked() []string {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	return append([]string(nil), m.queries...)
}

// client is a socket that speaks the protocol, and nothing more.
type client struct {
	t      *testing.T
	socket *websocket.Conn
}

func serverOf(t *testing.T, options Options) (*Registry, *manual, *client) {
	t.Helper()
	registry := NewRegistry(10 * time.Millisecond)
	source := newManual()
	registry.Register("rows", source)

	http := httptest.NewServer(NewServer(registry, options))
	t.Cleanup(http.Close)

	socket, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(http.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = socket.CloseNow() })

	return registry, source, &client{t: t, socket: socket}
}

func (c *client) send(event string, data any) {
	c.t.Helper()
	payload, _ := json.Marshal(data)
	frame, _ := json.Marshal(Envelope{Event: event, Data: payload})
	if err := c.socket.Write(context.Background(), websocket.MessageText, frame); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *client) sendRaw(text string) {
	c.t.Helper()
	if err := c.socket.Write(context.Background(), websocket.MessageText, []byte(text)); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

// receive answers the next frame, or fails the test.
func (c *client) receive() map[string]any {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := c.socket.Read(ctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	var envelope struct {
		Event string         `json:"event"`
		Data  map[string]any `json:"data"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		c.t.Fatalf("unmarshal %q: %v", data, err)
	}
	if envelope.Event != UpdateEvent {
		c.t.Fatalf("event = %q, want %q", envelope.Event, UpdateEvent)
	}
	return envelope.Data
}

// nothing asserts that no frame arrives within a short window.
func (c *client) nothing(within time.Duration) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	if _, data, err := c.socket.Read(ctx); err == nil {
		c.t.Fatalf("expected silence, got %s", data)
	}
}

func TestSnapshotThenPatchesNumberedFromOne(t *testing.T) {
	_, source, socket := serverOf(t, Options{})

	socket.send(SubscribeEvent, map[string]any{"id": "a", "topic": "rows", "query": map[string]any{"q": "x"}})
	first := socket.receive()
	if first["type"] != "snapshot" || first["sequence"].(float64) != 1 {
		t.Fatalf("first frame = %+v", first)
	}

	source.moveTo(row("r1"))
	second := socket.receive()
	if second["type"] != "patch" || second["sequence"].(float64) != 2 {
		t.Fatalf("second frame = %+v", second)
	}
	upserted := second["upserted"].([]any)
	if len(upserted) != 1 || upserted[0].(map[string]any)["id"] != "r1" {
		t.Fatalf("upserted = %+v", upserted)
	}
}

func TestTheSourceIsHandedWhatTheClientAsked(t *testing.T) {
	_, source, socket := serverOf(t, Options{})

	socket.send(SubscribeEvent, map[string]any{"id": "a", "topic": "rows", "query": map[string]any{"q": "hello"}})
	socket.receive()

	if asked := source.asked(); len(asked) == 0 || asked[0] != "hello" {
		t.Fatalf("queries = %v", asked)
	}
}

func TestAnUnknownTopicAnswersAnErrorAndOpensNothing(t *testing.T) {
	_, _, socket := serverOf(t, Options{})

	socket.send(SubscribeEvent, map[string]any{"id": "a", "topic": "nope"})
	frame := socket.receive()

	if frame["type"] != "error" || frame["reason"] != "No topic 'nope'" {
		t.Fatalf("frame = %+v", frame)
	}
}

func TestASubscribeWithNoIdIsIgnored(t *testing.T) {
	_, _, socket := serverOf(t, Options{})

	socket.send(SubscribeEvent, map[string]any{"topic": "rows"})
	socket.send(SubscribeEvent, map[string]any{"id": "", "topic": "rows"})

	socket.nothing(200 * time.Millisecond)
}

// SPEC §2: unreadable frames are ignored, and the socket stays up.
func TestAnUnreadableFrameIsIgnoredWithoutClosing(t *testing.T) {
	_, _, socket := serverOf(t, Options{})

	socket.sendRaw("{not json at all")
	socket.sendRaw(`{"event":"subscribe","data":"a string, not an object"}`)
	socket.send(SubscribeEvent, map[string]any{"id": "a", "topic": "rows"})

	if frame := socket.receive(); frame["type"] != "snapshot" {
		t.Fatalf("socket did not survive: %+v", frame)
	}
}

// SPEC §3.2: subscribing under an open id replaces it, and the sequence
// restarts. Getting this wrong leaves two windows feeding one list.
func TestResubscribingUnderTheSameIdRestartsTheSequence(t *testing.T) {
	_, source, socket := serverOf(t, Options{})

	socket.send(SubscribeEvent, map[string]any{"id": "a", "topic": "rows", "query": map[string]any{"q": "1"}})
	socket.receive()
	source.moveTo(row("r1"))
	socket.receive()

	socket.send(SubscribeEvent, map[string]any{"id": "a", "topic": "rows", "query": map[string]any{"q": "2"}})
	frame := socket.receive()

	if frame["type"] != "snapshot" || frame["sequence"].(float64) != 1 {
		t.Fatalf("frame = %+v", frame)
	}
}

func TestUnsubscribeStopsTheFrames(t *testing.T) {
	_, source, socket := serverOf(t, Options{})

	socket.send(SubscribeEvent, map[string]any{"id": "a", "topic": "rows"})
	socket.receive()

	socket.send(UnsubscribeEvent, map[string]any{"id": "a"})
	time.Sleep(50 * time.Millisecond)
	source.moveTo(row("r1"))

	socket.nothing(200 * time.Millisecond)
}

func TestUnsubscribingAnUnknownIdIsIgnored(t *testing.T) {
	_, _, socket := serverOf(t, Options{})

	socket.send(UnsubscribeEvent, map[string]any{"id": "never"})
	socket.send(SubscribeEvent, map[string]any{"id": "a", "topic": "rows"})

	if frame := socket.receive(); frame["type"] != "snapshot" {
		t.Fatalf("socket did not survive: %+v", frame)
	}
}

func TestOtherSubscriptionsAreLeftAlone(t *testing.T) {
	_, source, socket := serverOf(t, Options{})

	socket.send(SubscribeEvent, map[string]any{"id": "a", "topic": "rows"})
	socket.receive()
	socket.send(SubscribeEvent, map[string]any{"id": "b", "topic": "rows"})
	socket.receive()

	socket.send(UnsubscribeEvent, map[string]any{"id": "a"})
	time.Sleep(50 * time.Millisecond)
	source.moveTo(row("r1"))

	// One patch, for `b` alone.
	frame := socket.receive()
	if frame["id"] != "b" || frame["type"] != "patch" {
		t.Fatalf("frame = %+v", frame)
	}
	socket.nothing(150 * time.Millisecond)
}

// SPEC §1: the frame first, then the close. A refusal arriving as a bare
// disconnection cannot be told from a network fault.
func TestARefusedSocketIsToldWhyBeforeItIsClosed(t *testing.T) {
	registry := NewRegistry(0)
	registry.Register("rows", newManual())
	server := httptest.NewServer(NewServer(registry, Options{
		Authorize: func(*http.Request) bool { return false },
		Refusal:   func(*http.Request) string { return "no role for you" },
	}))
	defer server.Close()

	socket, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer socket.CloseNow() //nolint:errcheck

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, data, err := socket.Read(ctx)
	if err != nil {
		t.Fatalf("no refusal frame: %v", err)
	}
	var envelope struct {
		Data map[string]any `json:"data"`
	}
	_ = json.Unmarshal(data, &envelope)
	if envelope.Data["type"] != "error" || envelope.Data["reason"] != "no role for you" {
		t.Fatalf("frame = %+v", envelope.Data)
	}

	if _, _, err = socket.Read(ctx); err == nil {
		t.Fatal("socket should have been closed")
	}
	if websocket.CloseStatus(err) != websocket.StatusCode(NotAuthorised) {
		t.Fatalf("close status = %v, want %d", websocket.CloseStatus(err), NotAuthorised)
	}
}

// A client that arrives mid-stream gets a snapshot, and its patches are
// computed against the rows it holds - not against a state the server assumed
// everybody shared.
func TestALateSubscriptionGetsASnapshotOfWhereThingsAre(t *testing.T) {
	_, source, socket := serverOf(t, Options{})

	socket.send(SubscribeEvent, map[string]any{"id": "early", "topic": "rows"})
	socket.receive()
	source.moveTo(row("r1"))
	socket.receive()

	socket.send(SubscribeEvent, map[string]any{"id": "late", "topic": "rows"})
	frame := socket.receive()

	if frame["type"] != "snapshot" || frame["id"] != "late" {
		t.Fatalf("frame = %+v", frame)
	}
	if rows := frame["rows"].([]any); len(rows) != 1 || rows[0].(map[string]any)["id"] != "r1" {
		t.Fatalf("rows = %+v", frame["rows"])
	}
}
