import { ChangeDetectorRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CLIENT_SCENARIOS } from '@softwarity/livewire-mock';
import { Subscription } from 'rxjs';
import { LiveList } from '../src/lib/live-list';
import { LiveTopic } from '../src/lib/live-topic';
import { LivewireClient } from '../src/lib/livewire.client';
import { provideLivewire } from '../src/lib/provide-livewire';
import type { Consumer } from '@softwarity/livewire-mock';
import type { Envelope, JsonValue, LiveRow, UpdateFrame } from '@softwarity/livewire-protocol';
import type { LivewireSocket } from '../src/lib/livewire.client';

/**
 * The Angular client, put through the scenarios every client must pass.
 *
 * The mirror of `conformance.spec.ts`, which drives servers. Both halves of the
 * client are under test: the transport, which decides what goes on the wire and
 * when, and `LiveList`, which decides what a frame does to the rows.
 *
 * The socket here is written by hand rather than taken from the mock server, so
 * a scenario can deliver exactly the frame it means to - including ones no
 * conforming server would send, which is the point of asking what a client does
 * with them.
 */
describe('conformance: the Angular client', () => {
  /** A socket that behaves like a real one: it refuses to send until it opens. */
  class Wire {
    open = false;
    readonly sent: Envelope<unknown>[] = [];

    onopen: (() => void) | null = null;
    onmessage: ((frame: string) => void) | null = null;
    onclose: ((code: number, reason: string) => void) | null = null;

    readonly socket: LivewireSocket = {
      send: (frame: string) => {
        if (!this.open) {
          throw new Error('InvalidStateError: still CONNECTING');
        }
        this.sent.push(JSON.parse(frame) as Envelope<unknown>);
      },
      close: () => this.drop(),
      set onopen(listener: (() => void) | null) {
        wires.at(-1)!.onopen = listener;
      },
      set onmessage(listener: ((frame: string) => void) | null) {
        wires.at(-1)!.onmessage = listener;
      },
      set onclose(listener: ((code: number, reason: string) => void) | null) {
        wires.at(-1)!.onclose = listener;
      },
    };

    /** Opened on a later tick, as a real socket is. */
    start(): void {
      setTimeout(() => {
        this.open = true;
        this.onopen?.();
      }, 0);
    }

    drop(): void {
      this.open = false;
      this.onclose?.(1006, 'gone');
    }
  }

  let wires: Wire[] = [];

  function consumerOf(): Consumer {
    wires = [];
    TestBed.configureTestingModule({
      providers: [
        provideLivewire({
          path: '',
          reconnectMs: 1,
          connect: () => {
            const wire = new Wire();
            wires.push(wire);
            wire.start();
            return wire.socket;
          },
        }),
        { provide: ChangeDetectorRef, useValue: { markForCheck: () => undefined } },
      ],
    });

    const client = TestBed.inject(LivewireClient);
    const list = new LiveList<LiveRow>();
    let topic: LiveTopic<LiveRow> | null = null;
    let watching: Subscription | null = null;
    let resyncs = 0;

    return {
      open(name: string, query?: JsonValue) {
        topic = new LiveTopic<LiveRow>(client, name);
        watching = topic.open(query ?? null).subscribe((update) => {
          // What a screen does with a frame, and the only thing it has to:
          // apply it, and ask again when it cannot.
          if (!list.apply(update)) {
            resyncs += 1;
            topic?.resync();
          }
        });
      },
      close() {
        watching?.unsubscribe();
        watching = null;
      },
      deliver(frame: UpdateFrame) {
        // Under whichever id the client actually opened - a scenario names
        // `ignored`, since the id is the client's to choose.
        const opened = wires.flatMap((wire) => wire.sent).filter((envelope) => envelope.event === 'subscribe');
        const id = frame.id === 'ignored' ? ((opened.at(-1)?.data as { id: string }).id ?? frame.id) : frame.id;
        const envelope: Envelope<UpdateFrame> = { event: 'update', data: { ...frame, id } };
        wires.at(-1)?.onmessage?.(JSON.stringify(envelope));
      },
      drop() {
        wires.at(-1)?.drop();
      },
      settle: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
      sent: () => wires.flatMap((wire) => wire.sent),
      rows: () => list.rows(),
      total: () => list.total(),
      pivot: () => list.pivot(),
      resyncs: () => resyncs,
    };
  }

  for (const scenario of CLIENT_SCENARIOS) {
    it(`${scenario.spec} ${scenario.name}`, async () => {
      await scenario.run(consumerOf());
    });
  }
});
