// Command conformance stands up a Livewire server exposing exactly what the
// shared scenarios expect, so the TypeScript conformance suite can drive this
// implementation over a real socket.
//
// It is a test fixture, not an example: two sources, one way to make the data
// change, and nothing else.
//
//	go run ./cmd/conformance -addr 127.0.0.1:8080
//
// Sources:
//
//   - `rows`  a list whose newest row arrives at the top
//   - `still` a window that never changes
//
// POST /touch makes an arrival happen.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sync"

	livewire "github.com/softwarity/livewire/go"
)

type feed struct {
	mutex    sync.Mutex
	arrivals int
	watchers []chan struct{}
}

func (f *feed) wake() <-chan struct{} {
	f.mutex.Lock()
	defer f.mutex.Unlock()
	watcher := make(chan struct{}, 8)
	f.watchers = append(f.watchers, watcher)
	return watcher
}

func (f *feed) touch() {
	f.mutex.Lock()
	f.arrivals++
	watchers := append([]chan struct{}(nil), f.watchers...)
	f.mutex.Unlock()
	for _, watcher := range watchers {
		select {
		case watcher <- struct{}{}:
		default:
		}
	}
}

func (f *feed) count() int {
	f.mutex.Lock()
	defer f.mutex.Unlock()
	return f.arrivals
}

type rows struct{ feed *feed }

func (r rows) ReadQuery(json.RawMessage) (any, error) { return "", nil }
func (r rows) Key(any) string                         { return "" }
func (r rows) Wake() <-chan struct{}                  { return r.feed.wake() }

func (r rows) Read(context.Context, any) (livewire.Window, error) {
	arrivals := r.feed.count()
	// Newest first, so an arrival pushes the others down without changing
	// them - which is what checks that a row that only moved is not re-sent.
	list := make([]livewire.Row, 0, arrivals+2)
	for index := arrivals; index > 0; index-- {
		list = append(list, livewire.Row{ID: fmt.Sprintf("new-%d", index), UpdatedAt: "v1"})
	}
	list = append(list, livewire.Row{ID: "r1", UpdatedAt: "v1"}, livewire.Row{ID: "r2", UpdatedAt: "v1"})
	total := arrivals + 2
	return livewire.Window{Rows: list, Total: &total}, nil
}

type still struct{ feed *feed }

func (s still) ReadQuery(json.RawMessage) (any, error) { return "", nil }
func (s still) Key(any) string                         { return "" }
func (s still) Wake() <-chan struct{}                  { return s.feed.wake() }

func (s still) Read(context.Context, any) (livewire.Window, error) {
	total := 1
	return livewire.Window{Rows: []livewire.Row{{ID: "always", UpdatedAt: "v1"}}, Total: &total}, nil
}

func main() {
	address := flag.String("addr", "127.0.0.1:0", "where to listen")
	flag.Parse()

	shared := &feed{}
	// No coalescing: these scenarios are about the protocol, not about how long
	// a burst gathers.
	registry := livewire.NewRegistry(1)
	registry.Register("rows", rows{feed: shared})
	registry.Register("still", still{feed: shared})

	mux := http.NewServeMux()
	mux.Handle("/ws", livewire.NewServer(registry, livewire.Options{
		Logger:  slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})),
		Origins: []string{"*"},
	}))
	mux.HandleFunc("/touch", func(writer http.ResponseWriter, _ *http.Request) {
		shared.touch()
		writer.WriteHeader(http.StatusNoContent)
	})

	server := &http.Server{Handler: mux}
	listener, err := listen(*address)
	if err != nil {
		panic(err)
	}
	// The port goes to stdout so a test runner that asked for :0 knows where to
	// connect.
	fmt.Printf("listening %s\n", listener.Addr().String())
	_ = server.Serve(listener)
}

func listen(address string) (net.Listener, error) {
	return net.Listen("tcp", address)
}
