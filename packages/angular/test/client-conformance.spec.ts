import { ChangeDetectorRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { clientScenariosFor } from '@softwarity/livewire-mock';
import { Subscription, firstValueFrom } from 'rxjs';
import { LiveList } from '../src/lib/live-list';
import { LiveTopic } from '../src/lib/live-topic';
import { LivewireClient } from '../src/lib/livewire.client';
import { provideLivewire } from '../src/lib/provide-livewire';
import type { Consumer } from '@softwarity/livewire-mock';
import type { Envelope, JsonValue, LiveRow, UpdateFrame } from '@softwarity/livewire-protocol';
import type { LivewireSocket } from '../src/lib/livewire.client';

/** The topic the level 2 scenarios announce on, as `rows` is for windows. */
const ANNOUNCEMENTS = 'announcements';

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
 * with them. It answers commands the way a conforming server would, because a
 * command with no answer is the one thing the contract forbids.
 */
describe('conformance: the Angular client', () => {
  /** A socket that behaves like a real one: it refuses to send until it opens. */
  class Wire {
    open = false;
    readonly sent: Envelope<unknown>[] = [];

    onopen: (() => void) | null = null;
    onmessage: ((frame: string) => void) | null = null;
    onclose: ((code: number, reason: string) => void) | null = null;

    constructor(private readonly watching: (envelope: Envelope<unknown>, wire: Wire) => void) {}

    readonly socket: LivewireSocket = {
      send: (frame: string) => {
        if (!this.open) {
          throw new Error('InvalidStateError: still CONNECTING');
        }
        const envelope = JSON.parse(frame) as Envelope<unknown>;
        this.sent.push(envelope);
        this.watching(envelope, this);
      },
      close: () => this.drop(),
      set onopen(listener: (() => void) | null) {
        current!.onopen = listener;
      },
      set onmessage(listener: ((frame: string) => void) | null) {
        current!.onmessage = listener;
      },
      set onclose(listener: ((code: number, reason: string) => void) | null) {
        current!.onclose = listener;
      },
    };

    /** Opened on a later tick, as a real socket is. */
    start(): void {
      setTimeout(() => {
        this.open = true;
        this.onopen?.();
      }, 0);
    }

    deliver(envelope: object): void {
      this.onmessage?.(JSON.stringify(envelope));
    }

    drop(): void {
      this.open = false;
      this.onclose?.(1006, 'gone');
    }
  }

  let wires: Wire[] = [];
  let current: Wire | null = null;

  function consumerOf(): Consumer {
    wires = [];
    current = null;

    /**
     * What a conforming server does with a command - SPEC §6.1.
     *
     * `touch` and `announce` succeed, anything else is refused with a reason,
     * and everything is answered exactly once. `announce` also sends one
     * notification, which is what the level 2 scenarios read back.
     */
    function answer(envelope: Envelope<unknown>, wire: Wire): void {
      if (envelope.event !== 'command') {
        return;
      }
      const asked = envelope.data as { id: string; name: string };
      if (asked.name === 'announce') {
        wire.deliver({ event: 'notify', data: { topic: ANNOUNCEMENTS, payload: { said: 'something happened' } } });
      }
      const known = asked.name === 'touch' || asked.name === 'announce';
      wire.deliver({
        event: 'ack',
        data: known ? { id: asked.id, ok: true } : { id: asked.id, ok: false, reason: `No command '${asked.name}'` },
      });
    }

    TestBed.configureTestingModule({
      providers: [
        provideLivewire({
          path: '',
          reconnectMs: 1,
          connect: () => {
            const wire = new Wire(answer);
            wires.push(wire);
            current = wire;
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

    // Listened for the way a screen would: through the client's own API, under
    // the topic. What is asserted is that it arrives there, not that a frame
    // went past.
    const seen: JsonValue[] = [];
    client.notifications(ANNOUNCEMENTS).subscribe((payload) => seen.push(payload ?? null));

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
        current?.deliver({ event: 'update', data: { ...frame, id } });
      },
      drop() {
        current?.drop();
      },
      async command(name: string, payload?: JsonValue) {
        const ack = await firstValueFrom(client.command(name, payload));
        return { ok: ack.ok, result: ack.result, reason: ack.reason };
      },
      notified: (asked: string) => (asked === ANNOUNCEMENTS ? [...seen] : []),
      settle: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
      sent: () => wires.flatMap((wire) => wire.sent),
      rows: () => list.rows(),
      total: () => list.total(),
      pivot: () => list.pivot(),
      resyncs: () => resyncs,
    };
  }

  for (const scenario of clientScenariosFor(2)) {
    it(`${scenario.spec} ${scenario.name}`, async () => {
      await scenario.run(consumerOf());
    });
  }
});
