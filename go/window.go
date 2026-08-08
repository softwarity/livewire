package livewire

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// CoalesceDefault is how long a burst of changes gathers before a window is
// read again.
//
// A feed that fires several times a second would otherwise spend itself
// re-running the same query. Long enough to turn a salvo into one read, short
// enough that nobody notices the wait.
const CoalesceDefault = 300 * time.Millisecond

// MaxLimit is the widest window a client may ask for.
//
// Wider than a screen, narrower than a scan. The real ceiling is the wire, and
// it is not this: some proxies silently drop frames over ~64 kB, so what fits
// depends on the size of a row and is the source's business.
const MaxLimit = 200

// Source is one live list.
//
// Read returns the whole window, never a delta. Turning it into a patch is the
// server's business, per subscription, because only it knows what that client
// actually received.
type Source interface {
	// ReadQuery is the trust boundary: what arrives is JSON off a socket.
	// Clamp it, whitelist it, default it, and hand back something Read can act
	// on without checking again.
	ReadQuery(raw json.RawMessage) (any, error)

	// Key answers what two identical questions share. Two queries with the
	// same key share one read.
	Key(query any) string

	// Wake fires whenever this source may have something new to say. Only the
	// fact of a send is read, never its value.
	//
	// It must not be closed while the source is in use; a source with nothing
	// to follow returns a channel that never sends.
	Wake() <-chan struct{}

	// Read is the window as it stands.
	Read(ctx context.Context, query any) (Window, error)
}

// window is one shared read: whoever asks the same question watches this.
type window struct {
	mutex     sync.Mutex
	watchers  map[int]chan Window
	next      int
	last      *Window
	signature string
	stop      context.CancelFunc
}

// Registry holds the sources this server publishes, and the reads they share.
//
// Explicit registration rather than discovery: Go has no annotations, and a
// list of what a server serves is worth reading anyway.
// Command is something a client can ask the server to do — SPEC §6.1.
//
// Answer what the caller should get back, or nil. Return an error to refuse:
// its message becomes the reason the client is given, rather than silence.
//
// What the command changed is not returned here. It reaches the screens through
// whatever subscriptions were watching it, on their own schedule.
type Command func(ctx context.Context, payload json.RawMessage) (any, error)

type Registry struct {
	mutex    sync.RWMutex
	sources  map[string]Source
	commands map[string]Command
	windows  map[string]*window
	coalesce time.Duration
}

// NewRegistry builds an empty registry. `coalesce` is how long a burst gathers
// before a read; zero means CoalesceDefault.
func NewRegistry(coalesce time.Duration) *Registry {
	if coalesce <= 0 {
		coalesce = CoalesceDefault
	}
	return &Registry{
		sources:  map[string]Source{},
		commands: map[string]Command{},
		windows:  map[string]*window{},
		coalesce: coalesce,
	}
}

// Register adds a source under a topic. Registering twice replaces.
func (r *Registry) Register(topic string, source Source) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	r.sources[topic] = source
}

// Handle adds something the server can be asked to do. Registering the same
// name twice replaces it.
func (r *Registry) Handle(name string, command Command) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	if r.commands == nil {
		r.commands = map[string]Command{}
	}
	r.commands[name] = command
}

// Command answers the handler behind a name, or nil — the caller says so on the
// socket rather than staying quiet.
func (r *Registry) Command(name string) Command {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	return r.commands[name]
}

// Find answers the source behind a topic, or nil.
func (r *Registry) Find(topic string) Source {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	return r.sources[topic]
}

// Topics answers what this server publishes, in no particular order.
func (r *Registry) Topics() []string {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	topics := make([]string, 0, len(r.sources))
	for topic := range r.sources {
		topics = append(topics, topic)
	}
	return topics
}

// Watch answers a channel of windows, and a function to stop watching.
//
// Two callers asking the same question share one read: the second is handed
// what the window already holds, and no query is run. The read stops and the
// entry is dropped when the last of them leaves — otherwise the map is a leak
// the size of every filter ever typed.
func (r *Registry) Watch(topic string, source Source, query any) (<-chan Window, func()) {
	key := topic + "\x00" + source.Key(query)

	r.mutex.Lock()
	shared, running := r.windows[key]
	if !running {
		ctx, stop := context.WithCancel(context.Background())
		shared = &window{watchers: map[int]chan Window{}, stop: stop}
		r.windows[key] = shared
		go r.pump(ctx, shared, source, query)
	}

	shared.mutex.Lock()
	id := shared.next
	shared.next++
	// Buffered by one: a watcher that has not read its last window yet must not
	// hold the pump, and a window it missed is superseded by the next anyway.
	updates := make(chan Window, 1)
	shared.watchers[id] = updates
	last := shared.last
	shared.mutex.Unlock()
	r.mutex.Unlock()

	// What the window already holds, so a late watcher is not left waiting for
	// the next change to see anything at all.
	if last != nil {
		updates <- *last
	}

	return updates, func() { r.leave(key, shared, id) }
}

func (r *Registry) leave(key string, shared *window, id int) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	shared.mutex.Lock()
	if updates, watching := shared.watchers[id]; watching {
		delete(shared.watchers, id)
		close(updates)
	}
	empty := len(shared.watchers) == 0
	shared.mutex.Unlock()

	if empty {
		shared.stop()
		delete(r.windows, key)
	}
}

// pump reads once, then on every gathered burst, and publishes what changed.
func (r *Registry) pump(ctx context.Context, shared *window, source Source, query any) {
	r.readInto(ctx, shared, source, query)

	wake := source.Wake()
	for {
		select {
		case <-ctx.Done():
			return
		case _, open := <-wake:
			if !open {
				return
			}
			// Gather the rest of the burst, then read once for all of it.
			if !drain(ctx, wake, r.coalesce) {
				return
			}
			r.readInto(ctx, shared, source, query)
		}
	}
}

// drain swallows whatever else arrives during the coalescing window. It
// answers false when the context ended while waiting.
func drain(ctx context.Context, wake <-chan struct{}, window time.Duration) bool {
	timer := time.NewTimer(window)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case _, open := <-wake:
			if !open {
				return false
			}
		case <-timer.C:
			return true
		}
	}
}

// readInto reads the window and publishes it, unless it did not move.
func (r *Registry) readInto(ctx context.Context, shared *window, source Source, query any) {
	next, err := source.Read(ctx, query)
	if err != nil {
		// A read that failed is not a window that emptied: saying nothing
		// leaves the screen on what it had, which is the truthful answer until
		// the next read succeeds.
		return
	}

	signature := signatureOf(next)

	shared.mutex.Lock()
	if shared.last != nil && signature == shared.signature {
		shared.mutex.Unlock()
		return
	}
	shared.last = &next
	shared.signature = signature
	watchers := make([]chan Window, 0, len(shared.watchers))
	for _, updates := range shared.watchers {
		watchers = append(watchers, updates)
	}
	shared.mutex.Unlock()

	for _, updates := range watchers {
		select {
		case updates <- next:
		default:
			// Full: this watcher has an older window still unread, and the one
			// it holds is about to be superseded. Dropping is right; blocking
			// the pump on a slow reader is not.
		}
	}
}

// Text answers a non-empty trimmed string, or "".
func Text(raw map[string]any, field string) string {
	if value, ok := raw[field].(string); ok {
		return trim(value)
	}
	return ""
}

// Whole answers a whole number, at least zero, or the fallback.
func Whole(raw map[string]any, field string, fallback int) int {
	value, ok := raw[field].(float64)
	if !ok || value < 0 {
		return fallback
	}
	return int(value)
}

// LimitOf keeps whatever was asked for inside what this server will send.
func LimitOf(raw map[string]any, field string, fallback int) int {
	limit := Whole(raw, field, fallback)
	if limit < 1 {
		return 1
	}
	if limit > MaxLimit {
		return MaxLimit
	}
	return limit
}

func trim(value string) string {
	start, end := 0, len(value)
	for start < end && isSpace(value[start]) {
		start++
	}
	for end > start && isSpace(value[end-1]) {
		end--
	}
	return value[start:end]
}

func isSpace(char byte) bool {
	return char == ' ' || char == '\t' || char == '\n' || char == '\r'
}
