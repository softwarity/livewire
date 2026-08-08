# Release Notes

## NEXT RELEASE

---

## 0.1.1

### Features

- **`LiveWindowDataSource` can repaint a zoneless screen on its own.** Hand it a `ChangeDetectorRef` and it calls `markForCheck()` whenever it publishes — which marks the view dirty *and* notifies the zoneless scheduler — so the template no longer has to read `revision()` for the screen to move. `revision()` stays, for a source built outside an injection context. It asks for a pass only when something changed: not on a frame it had to reject, and not when the window moves — only when its answer lands.
- **An agent brief at the root**, [`llm-instructions.md`](./llm-instructions.md): the model, a recipe per backend and per screen, the rules that must not be broken with the failure each one prevents, a checklist, and a symptom → cause → fix table.
- The documented screen follows its viewport through an **`effect`** rather than `ngAfterViewInit`. The query is a signal, so a viewport that appears later — a tab, a panel, anything behind an `@if` — is picked up when it appears rather than never.
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
