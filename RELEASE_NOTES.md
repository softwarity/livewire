# Release Notes

## NEXT RELEASE

### Features

- **A conformance suite for clients**, `CLIENT_SCENARIOS`, beside the one for servers. Eleven scenarios that feed frames in and read what the screen would show and what the client sent back — the transport and the list, both halves. The asymmetry was expensive: two defects shipped in 0.2.x because thirty-two tests all pointed at servers. Driving it needs a `Consumer` — open, close, deliver, drop, settle, and what the list holds — which is what turns "we also have a React client" into a test run.

### Breaking

- **`length` and `pivot` are signals, and `onTotal` is gone.** They were getters, which a `computed` cannot follow: it reads the value once and never re-runs, because nothing tells it the value moved. A screen deriving from them — a counter, a divider drawn at `pivot` — had to watch `changes` and read the getter inside, which is exactly this signal written by hand and easy to forget. With `length()` a signal, the `onTotal` callback the constructor took is redundant, so it is removed.

  Migrating: `source.length` becomes `source.length()`, `source.pivot` becomes `source.pivot()`, and the constructor loses its first argument — `new LiveWindowDataSource(onDrift, window)`. Whatever `onTotal` was writing into, read `source.length` instead.

- **Angular 19 is the floor**, up from 18. The data source now writes signals when a frame lands, and a frame can land inside the `effect` that called `reset` — a synchronous server does exactly that — which Angular 18 refuses. 19 allows it.

---

## 0.2.4

### Fixes

- **A subscription opened before the socket finished connecting died there.** A `WebSocket` still in `CONNECTING` *throws* on `send` rather than ignoring it, and that exception came straight back out of `watch`'s subscribe function — tearing down the very subscription being opened. On a page refresh that is every list a screen asks for before the handshake completes, and none of them came back: the client's `onopen` re-sent them, but nobody was listening any more. Frames now wait for the handshake, which was always the intent. The in-memory server could not show this on its own — its socket accepts frames at any time — so the test drives one that refuses like a real one.
- The indicator says **"Live data"** rather than "Live": the dot is small, and the tooltip is where a reader finds out what it stands for.

---

## 0.2.3

### Fixes

- **`<lw-live-indicator>` is a lit dot now, and it sits where it belongs.** A disc with a soft halo of its own colour, and a flare that leaves it and fades — the state stays steady and what says "live" happens around it, instead of the dot jumping every second. The host also centres itself, so a row aligning its children to the top no longer strands it above the text beside it.
- **The component's styles were half-dropped by the browser.** They carried `//` comments, which are SCSS: in the plain CSS of an inline `styles` block that is an invalid selector, and it swallowed the rule after it — the dot had no size and no colour at all. Only visible on a real page, which is where it was found.

---

## 0.2.2

### Fixes

- The indicator's animation was softened. Superseded by the next release, which rebuilt it.

---

## 0.2.1

### Fixes

- **`@softwarity/livewire` shipped its sources instead of its build.** The Angular package was published from the workspace root, where there is no `main`, no typings and no bundle — ng-packagr writes all of that into `dist`, and that directory *is* the package. Installing 0.1.0, 0.1.1 or 0.2.0 gave you a folder of TypeScript that resolves to nothing. Now published from `packages/angular/dist`. The other three packages carry `main`/`types` of their own and were always fine.

---

## 0.2.0

### Breaking

- **`LiveWindowDataSource` injects the view it repaints, and `revision()` is gone.** Build it in a component field — where you were building it anyway — and it takes that view's `ChangeDetectorRef` and calls `markForCheck()` on every publication: the view is marked dirty *and* the zoneless scheduler is notified, which is the whole of what a screen used to have to arrange for itself. Built outside an injection context it now throws, which is the intended answer: a data source with no view to repaint has nobody to answer.

  Migrating: drop `source.revision()` from your templates — `[class.fresh]="source.fresh(row?.id)"` is the whole binding now — and make sure the source is built in the component that shows the list.

  Two ways of saying "something arrived" was one too many. The screens that picked the wrong one looked right in development and held stale rows in production.

---

## 0.1.1

### Features

- The data source asks for a pass only when there is something to show: not on a frame it had to reject, not when the window moves, once when its answer lands, and once more when the fresh marks come off. The tests count those calls.
- The documented screen follows its viewport through an **`effect`** rather than `ngAfterViewInit`. The query is a signal, so a viewport that appears later — a tab, a panel, anything behind an `@if` — is picked up when it appears rather than never.
- **An agent brief at the root**, [`llm-instructions.md`](./llm-instructions.md): the model, a recipe per backend and per screen, the rules that must not be broken with the failure each one prevents, a checklist, and a symptom → cause → fix table.
- The documentation carries the frameworks' own marks rather than emoji.

---

## 0.1.0

### Features

- **The wire contract, specified.** `@softwarity/livewire-protocol` carries the frame types and `SPEC.md`, which is the normative part — what TypeScript cannot say: that an unchanged window publishes nothing, that everything a row shows must be in its version, that resubscribing under an open id replaces it and restarts the sequence.
- **A NestJS server.** `@softwarity/nestjs-livewire`: `LivewireModule.forRoot({ path, authorize })`, sources found by their `@LiveTopic` decorator, and three bases to extend — `PagedSource`, `SingleWindowSource`, `WindowedSource`. One read per question, bursts coalesced, the diff computed per subscriber.
- **An Angular client.** `@softwarity/livewire`: one socket per tab, zoneless signals, `LiveWindowDataSource` for a virtually-scrolled list whose window *is* the subscription, and `<lw-live-indicator>` — which replaces the refresh button rather than joining it.
- **A Go server.** `github.com/softwarity/livewire/go`: one `http.Handler`, explicit registration, goroutines and channels where the TypeScript side has an operator chain. Tagged `go/vX.Y.Z` in the same release as the npm packages.
- **An in-memory server, and the conformance suite.** `@softwarity/livewire-mock` speaks the protocol with no socket under it — for a demo, for a screen with no backend yet, and above all as the third implementation the twelve scenarios run against. Writing them found three real defects the same evening.
- **Documentation on GitHub Pages**, with a live demo: the real client against a Livewire server running in the page, every frame shown both ways. The site compiles the library from source, so a divergence breaks its build instead of leaving a page that documents last month's behaviour.

---
