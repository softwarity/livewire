package livewire

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Mirrors packages/nestjs/test/windowed-source.spec.ts.

// counting is a source whose reads are counted, so sharing and silence can be
// observed.
type counting struct {
	reads atomic.Int32
	wake  chan struct{}

	mutex  sync.Mutex
	window Window
}

func newCounting() *counting {
	return &counting{wake: make(chan struct{}, 16), window: Window{Rows: []Row{row("a")}}}
}

func (c *counting) ReadQuery(raw json.RawMessage) (any, error) {
	asked := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &asked)
	}
	return Text(asked, "key"), nil
}

func (c *counting) Key(query any) string { return query.(string) }

func (c *counting) Wake() <-chan struct{} { return c.wake }

func (c *counting) Read(context.Context, any) (Window, error) {
	c.reads.Add(1)
	c.mutex.Lock()
	defer c.mutex.Unlock()
	return c.window, nil
}

func (c *counting) moveTo(window Window) {
	c.mutex.Lock()
	c.window = window
	c.mutex.Unlock()
}

/** Reads settle asynchronously; this waits for one rather than sleeping blind. */
func awaitWindow(t *testing.T, windows <-chan Window) Window {
	t.Helper()
	select {
	case window := <-windows:
		return window
	case <-time.After(2 * time.Second):
		t.Fatal("no window arrived")
		return Window{}
	}
}

func awaitReads(t *testing.T, source *counting, want int32) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if source.reads.Load() == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("reads = %d, want %d", source.reads.Load(), want)
}

func registryOf() *Registry {
	// A short coalescing window: these tests are about what is read, not about
	// how long a burst gathers.
	return NewRegistry(20 * time.Millisecond)
}

func TestOneReadForTwoSubscriptionsAskingTheSameQuestion(t *testing.T) {
	registry, source := registryOf(), newCounting()

	first, leaveFirst := registry.Watch("rows", source, "a")
	awaitWindow(t, first)
	second, leaveSecond := registry.Watch("rows", source, "a")
	defer leaveFirst()
	defer leaveSecond()

	awaitWindow(t, second)
	if source.reads.Load() != 1 {
		t.Fatalf("reads = %d, want 1", source.reads.Load())
	}
}

func TestTwoReadsForTwoDifferentQuestions(t *testing.T) {
	registry, source := registryOf(), newCounting()

	one, leaveOne := registry.Watch("rows", source, "a")
	two, leaveTwo := registry.Watch("rows", source, "b")
	defer leaveOne()
	defer leaveTwo()

	awaitWindow(t, one)
	awaitWindow(t, two)
	awaitReads(t, source, 2)
}

func TestALateWatcherGetsWhatTheWindowAlreadyHolds(t *testing.T) {
	registry, source := registryOf(), newCounting()

	first, leaveFirst := registry.Watch("rows", source, "a")
	defer leaveFirst()
	awaitWindow(t, first)

	second, leaveSecond := registry.Watch("rows", source, "a")
	defer leaveSecond()

	window := awaitWindow(t, second)
	if len(window.Rows) != 1 || window.Rows[0].ID != "a" {
		t.Fatalf("window = %+v", window)
	}
	if source.reads.Load() != 1 {
		t.Fatalf("reads = %d, want 1", source.reads.Load())
	}
}

// The leak this guards against: one entry per filter ever typed, held for the
// life of the process.
func TestTheQuestionIsForgottenWhenTheLastWatcherLeaves(t *testing.T) {
	registry, source := registryOf(), newCounting()

	first, leaveFirst := registry.Watch("rows", source, "a")
	awaitWindow(t, first)
	second, leaveSecond := registry.Watch("rows", source, "a")
	awaitWindow(t, second)

	leaveFirst()
	leaveSecond()

	registry.mutex.RLock()
	held := len(registry.windows)
	registry.mutex.RUnlock()
	if held != 0 {
		t.Fatalf("%d window(s) still held", held)
	}

	third, leaveThird := registry.Watch("rows", source, "a")
	defer leaveThird()
	awaitWindow(t, third)
	awaitReads(t, source, 2)
}

func TestNothingIsPublishedWhenAReadReturnsTheSameWindow(t *testing.T) {
	registry, source := registryOf(), newCounting()

	windows, leave := registry.Watch("rows", source, "a")
	defer leave()
	awaitWindow(t, windows)

	source.wake <- struct{}{}
	awaitReads(t, source, 2)

	select {
	case window := <-windows:
		t.Fatalf("published an unchanged window: %+v", window)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestItPublishesWhenTheWindowActuallyMoved(t *testing.T) {
	registry, source := registryOf(), newCounting()

	windows, leave := registry.Watch("rows", source, "a")
	defer leave()
	awaitWindow(t, windows)

	source.moveTo(Window{Rows: []Row{row("a", "v2")}})
	source.wake <- struct{}{}

	moved := awaitWindow(t, windows)
	if moved.Rows[0].UpdatedAt != "v2" {
		t.Fatalf("window = %+v", moved)
	}
}

func TestABurstBecomesOneRead(t *testing.T) {
	registry, source := registryOf(), newCounting()

	windows, leave := registry.Watch("rows", source, "a")
	defer leave()
	awaitWindow(t, windows)

	for i := 0; i < 50; i += 1 {
		source.wake <- struct{}{}
	}

	// One at subscription, one for the whole burst.
	awaitReads(t, source, 2)
	time.Sleep(80 * time.Millisecond)
	if source.reads.Load() != 2 {
		t.Fatalf("reads = %d, want 2 - the burst was not gathered", source.reads.Load())
	}
}

// A read that failed is not a window that emptied: saying nothing leaves the
// screen on what it had, which is the truthful answer until the next read.
func TestAFailedReadPublishesNothing(t *testing.T) {
	registry := registryOf()
	source := &failing{wake: make(chan struct{}, 4), window: Window{Rows: []Row{row("a")}}}

	windows, leave := registry.Watch("rows", source, "a")
	defer leave()
	awaitWindow(t, windows)

	source.broken.Store(true)
	source.wake <- struct{}{}

	select {
	case window := <-windows:
		t.Fatalf("published after a failed read: %+v", window)
	case <-time.After(100 * time.Millisecond):
	}
}

type failing struct {
	wake   chan struct{}
	window Window
	broken atomic.Bool
}

func (f *failing) ReadQuery(json.RawMessage) (any, error) { return "", nil }
func (f *failing) Key(any) string                         { return "" }
func (f *failing) Wake() <-chan struct{}                  { return f.wake }
func (f *failing) Read(context.Context, any) (Window, error) {
	if f.broken.Load() {
		return Window{}, context.DeadlineExceeded
	}
	return f.window, nil
}

func TestQueryHelpers(t *testing.T) {
	raw := map[string]any{"search": "  HVN ", "blank": "   ", "number": 42.0, "offset": 3.7, "negative": -1.0}

	if got := Text(raw, "search"); got != "HVN" {
		t.Errorf("Text(search) = %q", got)
	}
	if got := Text(raw, "blank"); got != "" {
		t.Errorf("Text(blank) = %q", got)
	}
	if got := Text(raw, "number"); got != "" {
		t.Errorf("Text(number) = %q", got)
	}
	if got := Whole(raw, "offset", 0); got != 3 {
		t.Errorf("Whole(offset) = %d", got)
	}
	if got := Whole(raw, "negative", 5); got != 5 {
		t.Errorf("Whole(negative) = %d", got)
	}
	if got := Whole(raw, "missing", 7); got != 7 {
		t.Errorf("Whole(missing) = %d", got)
	}
	if got := LimitOf(map[string]any{"limit": 9999.0}, "limit", 50); got != MaxLimit {
		t.Errorf("LimitOf(9999) = %d", got)
	}
	if got := LimitOf(map[string]any{"limit": 0.0}, "limit", 50); got != 1 {
		t.Errorf("LimitOf(0) = %d", got)
	}
	if got := LimitOf(map[string]any{}, "limit", 25); got != 25 {
		t.Errorf("LimitOf(absent) = %d", got)
	}
}
