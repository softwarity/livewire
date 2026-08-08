package livewire

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"

	"github.com/coder/websocket"
)

// Options is how a server is configured.
type Options struct {
	// Authorize answers whether this caller may use the socket at all.
	//
	// The only place the library touches your application's idea of identity.
	// Nil accepts every upgrade, which is right behind a gateway that has
	// already authenticated and wrong on the open internet.
	Authorize func(request *http.Request) bool

	// Refusal is what to say before closing a socket that was refused. Said on
	// the socket and not only in a close code: a refusal arriving as a bare
	// disconnection is indistinguishable from a network fault.
	Refusal func(request *http.Request) string

	// Origins allowed to open a socket. Empty means same-origin only.
	Origins []string

	// Logger. Nil uses the default.
	Logger *slog.Logger
}

// Server is one endpoint: every subscription of every client passes through it.
//
// It implements http.Handler, so it is mounted wherever the application wants:
//
//	mux.Handle("/my-service/ws", livewire.NewServer(registry, livewire.Options{...}))
type Server struct {
	registry *Registry
	options  Options
	logger   *slog.Logger
}

func NewServer(registry *Registry, options Options) *Server {
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{registry: registry, options: options, logger: logger}
}

func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	socket, err := websocket.Accept(writer, request, &websocket.AcceptOptions{OriginPatterns: s.options.Origins})
	if err != nil {
		return
	}

	ctx := request.Context()
	if s.options.Authorize != nil && !s.options.Authorize(request) {
		reason := "Not authorised"
		if s.options.Refusal != nil {
			reason = s.options.Refusal(request)
		}
		s.logger.Warn("socket refused", "reason", reason)
		// The frame first, then the close - see SPEC §1. A proxy that drops
		// the close code would otherwise leave the client with nothing to
		// explain itself.
		_ = writeFrame(ctx, socket, errorFrame{ID: "connection", Type: "error", Reason: reason})
		_ = socket.Close(websocket.StatusCode(NotAuthorised), "Not authorised")
		return
	}

	newConnection(s, socket).serve(ctx)
}

// connection is one socket and the subscriptions open on it.
type connection struct {
	server *Server
	socket *websocket.Conn

	// Writes are serialised: several subscriptions publish from their own
	// goroutines, and a WebSocket has one frame at a time.
	writing sync.Mutex

	mutex         sync.Mutex
	subscriptions map[string]context.CancelFunc
}

func newConnection(server *Server, socket *websocket.Conn) *connection {
	return &connection{server: server, socket: socket, subscriptions: map[string]context.CancelFunc{}}
}

func (c *connection) serve(ctx context.Context) {
	defer c.closeAll()
	defer c.socket.CloseNow() //nolint:errcheck // nothing useful to do about it

	for {
		_, data, err := c.socket.Read(ctx)
		if err != nil {
			return
		}

		var envelope Envelope
		if json.Unmarshal(data, &envelope) != nil {
			// Unreadable: ignored, and the socket stays up (SPEC §2).
			continue
		}

		switch envelope.Event {
		case SubscribeEvent:
			c.onSubscribe(ctx, envelope.Data)
		case UnsubscribeEvent:
			c.onUnsubscribe(envelope.Data)
		}
	}
}

func (c *connection) onSubscribe(ctx context.Context, data json.RawMessage) {
	var frame subscribeFrame
	if json.Unmarshal(data, &frame) != nil || frame.ID == "" {
		// No id, nothing to answer under: ignored in silence.
		return
	}

	source := c.server.registry.Find(frame.Topic)
	if source == nil {
		_ = c.write(ctx, errorFrame{ID: frame.ID, Type: "error", Reason: "No topic '" + frame.Topic + "'"})
		return
	}

	query, err := source.ReadQuery(frame.Query)
	if err != nil {
		_ = c.write(ctx, errorFrame{ID: frame.ID, Type: "error", Reason: err.Error()})
		return
	}

	// Ends whatever was open under this id before building the new one: the
	// same id twice is a window that moved, and two live windows feeding one
	// list would interleave their frames into it.
	c.close(frame.ID)

	windows, leave := c.server.registry.Watch(frame.Topic, source, query)
	inner, cancel := context.WithCancel(ctx)

	c.mutex.Lock()
	c.subscriptions[frame.ID] = func() {
		cancel()
		leave()
	}
	c.mutex.Unlock()

	go c.publish(inner, frame.ID, windows)
}

// publish turns the source's windows into what this one subscription has not
// seen, and writes them.
//
// Per subscription rather than per window because only here is it known what
// actually went down the socket: a screen that joins mid-stream gets a
// snapshot, and its patches are computed against the rows it holds.
func (c *connection) publish(ctx context.Context, id string, windows <-chan Window) {
	var sent []Row
	first := true
	sequence := 0

	for {
		select {
		case <-ctx.Done():
			return
		case next, open := <-windows:
			if !open {
				return
			}
			sequence++
			var err error
			if first {
				err = c.write(ctx, snapshotOf(id, next, sequence))
				first = false
			} else {
				err = c.write(ctx, patchOf(id, sent, next, sequence))
			}
			if err != nil {
				return
			}
			sent = next.Rows
		}
	}
}

func (c *connection) onUnsubscribe(data json.RawMessage) {
	var frame unsubscribeFrame
	if json.Unmarshal(data, &frame) != nil || frame.ID == "" {
		return
	}
	c.close(frame.ID)
}

func (c *connection) close(id string) {
	c.mutex.Lock()
	stop, open := c.subscriptions[id]
	delete(c.subscriptions, id)
	c.mutex.Unlock()
	if open {
		stop()
	}
}

func (c *connection) closeAll() {
	c.mutex.Lock()
	stops := make([]context.CancelFunc, 0, len(c.subscriptions))
	for id, stop := range c.subscriptions {
		stops = append(stops, stop)
		delete(c.subscriptions, id)
	}
	c.mutex.Unlock()
	for _, stop := range stops {
		stop()
	}
}

func (c *connection) write(ctx context.Context, frame any) error {
	c.writing.Lock()
	defer c.writing.Unlock()
	return writeFrame(ctx, c.socket, frame)
}

func writeFrame(ctx context.Context, socket *websocket.Conn, frame any) error {
	payload, err := json.Marshal(Envelope{Event: UpdateEvent, Data: mustMarshal(frame)})
	if err != nil {
		return err
	}
	return socket.Write(ctx, websocket.MessageText, payload)
}

func mustMarshal(value any) json.RawMessage {
	payload, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return payload
}
