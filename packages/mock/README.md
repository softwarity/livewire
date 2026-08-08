# @softwarity/livewire-mock

A Livewire server with no socket under it — the same protocol, in memory.

```ts
const server = new MockServer()
  .register('messages', { windowFor: () => ({ rows: rows(), total: rows().length }) });

const socket = server.connect();   // shaped like a WebSocket
socket.onmessage = (frame) => …;

server.touched();                  // what a write announces on a real server
```

Three uses, and the third is the one that pays:

1. **A demo that works offline**, instantly, and lets a page provoke what a real
   backend will not produce on demand: a row arriving, a window sliding, a
   connection refused. `onTraffic` reports every frame both ways, so a page can
   show the protocol rather than only a list that moves.
2. **Testing a screen with no server yet.**
3. **Checking the specification.** It exports `SCENARIOS`, the conformance
   suite, and runs them against itself.

## The conformance suite

`SCENARIOS` is the list of rules from [SPEC.md](../protocol/SPEC.md) written as
runnable scenarios, driven over any `Wire` — an in-memory connection, a `ws`
socket to a NestJS server, a socket to a Go one:

```ts
for (const scenario of SCENARIOS) {
  it(`${scenario.spec} ${scenario.name}`, async () => {
    const wire = wireOf();
    await wire.ready;
    await scenario.run(new Conversation(wire));
  });
}
```

A conforming server exposes two sources for it: `rows` — a list whose newest row
arrives at the top — and `still`, a window that never changes whatever happens.

Two implementations of one protocol diverge within months, not through
carelessness but through the cases nobody wrote down. This is that list, and all
three implementations run it.
