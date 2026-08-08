import { DOCUMENT } from '@angular/common';
import { Inject, Injectable, InjectionToken, Optional, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';
import { SUBSCRIBE_EVENT, UNSUBSCRIBE_EVENT, UPDATE_EVENT } from '@softwarity/livewire-protocol';
import type { Envelope, JsonValue, LiveRow, UpdateFrame } from '@softwarity/livewire-protocol';

export interface LivewireConfig {
  /** Where the socket answers. Root-relative, so a gateway can route it. */
  path: string;

  /** How long a dropped socket waits before trying again. */
  reconnectMs?: number;

  /**
   * How to open the connection.
   *
   * Absent, a real `WebSocket` against `path` on the page's own host. Supplied,
   * anything of that shape - which is how the in-memory server is dropped in
   * for a demo or a test with no backend at all.
   */
  connect?: () => LivewireSocket;
}

/** The little of a `WebSocket` this client uses. */
export interface LivewireSocket {
  send(frame: string): void;
  close(code?: number, reason?: string): void;
  onmessage?: ((frame: string) => void) | null;
  onclose?: ((code: number, reason: string) => void) | null;
  onopen?: (() => void) | null;
}

export const LIVEWIRE_CONFIG = new InjectionToken<LivewireConfig>('LIVEWIRE_CONFIG');

const DEFAULT_RECONNECT_MS = 3000;

/**
 * The one socket, shared by every live list.
 *
 * One connection per tab, not one per screen: one handshake, one place where
 * authorisation happens, one reconnection to get right. Subscriptions are told
 * apart by an id the caller picks, so several lists can be open at once.
 */
@Injectable({ providedIn: 'root' })
export class LivewireClient {
  /** Whether the socket is currently carrying anything. */
  readonly live = signal(false);

  private socket: LivewireSocket | null = null;

  /** The wait before the next attempt, held so `retry` can cut it short. */
  private retrying: ReturnType<typeof setTimeout> | null = null;

  /**
   * Everything the socket delivers, for the watchers to filter.
   *
   * A plain Subject between the socket and the screens, and that indirection is
   * the whole point. `rxjs/webSocket` ties the connection to its subscriber
   * count: it closes when the last one leaves and reopens on the next, so a
   * list scrolling out of view took the connection down with it and the next
   * one opened another - nine sockets for one list, each losing the snapshot
   * sent to the one before.
   */
  private readonly incoming = new Subject<Envelope<unknown>>();

  /**
   * What to re-send when a socket comes back.
   *
   * A reconnected socket knows nothing about what the screens were watching a
   * second ago, and the screens have no reason to find out that it dropped.
   */
  private readonly open = new Map<string, unknown>();

  constructor(
    @Inject(LIVEWIRE_CONFIG) private readonly config: LivewireConfig,
    @Optional() @Inject(DOCUMENT) private readonly document: Document | null,
  ) {}

  /**
   * Watches one topic, and keeps watching it across reconnections.
   *
   * The returned stream starts with a snapshot and continues with patches -
   * applying them is `LiveList`'s job. Unsubscribing closes the subscription
   * server-side; the socket itself stays up for the other lists.
   */
  watch<Row extends LiveRow>(id: string, topic: string, query: JsonValue | null): Observable<UpdateFrame<Row>> {
    return new Observable<UpdateFrame<Row>>((subscriber) => {
      this.connect();
      const asked = { id, topic, query: query ?? undefined };
      this.open.set(id, asked);
      this.send(SUBSCRIBE_EVENT, asked);

      const frames = this.incoming
        .pipe(
          filter((envelope): envelope is Envelope<UpdateFrame<Row>> => {
            return envelope.event === UPDATE_EVENT && (envelope.data as UpdateFrame<Row>)?.id === id;
          }),
        )
        .subscribe((envelope) => subscriber.next(envelope.data));

      return () => {
        frames.unsubscribe();
        // The socket stays up for the other lists; only this window closes.
        this.open.delete(id);
        this.send(UNSUBSCRIBE_EVENT, { id });
      };
    });
  }

  /**
   * Asks for a window again, and gets a snapshot back.
   *
   * A gap in the sequence means the two sides disagree about what was sent.
   * Asking again is cheap; carrying on would show a list nobody can trust.
   */
  resync(id: string): void {
    const asked = this.open.get(id);
    if (asked) {
      this.send(SUBSCRIBE_EVENT, asked);
    }
  }

  /**
   * What a reader can do about it when something looks off.
   *
   * Two situations, one gesture, because from their side they are the same
   * complaint - the screen may not be showing what is true. Down: the
   * reconnection delay is skipped and the socket is opened now. Up: every open
   * window is asked for again, and each answers with a snapshot.
   */
  retry(): void {
    if (this.socket) {
      for (const asked of this.open.values()) {
        this.send(SUBSCRIBE_EVENT, asked);
      }
      return;
    }
    if (this.retrying !== null) {
      clearTimeout(this.retrying);
      this.retrying = null;
    }
    this.connect();
  }

  /**
   * Opens the one socket, once, and keeps it open.
   *
   * A plain `WebSocket` rather than `rxjs/webSocket`, deliberately - see the
   * note on `incoming`. What this needs is one socket for as long as the tab
   * lives, which is easier to write outright than to talk an operator chain
   * into.
   */
  private connect(): void {
    if (this.socket) {
      return;
    }
    const socket = this.config.connect ? this.config.connect() : this.openWebSocket();
    this.socket = socket;

    socket.onopen = (): void => {
      this.live.set(true);
      // Whatever the screens were watching, asked for again. A reconnected
      // socket knows nothing about them, and on the first open this is what
      // sends the subscriptions queued before it came up.
      for (const asked of this.open.values()) {
        this.send(SUBSCRIBE_EVENT, asked);
      }
    };

    socket.onmessage = (frame: string): void => {
      try {
        this.incoming.next(JSON.parse(frame) as Envelope<unknown>);
      } catch (error) {
        console.error('[livewire] unreadable frame', error);
      }
    };

    // A dropped socket is the normal case, not a fault: a gateway restart, a
    // laptop that slept. Reconnecting is this client's job so no screen has to
    // know it happened.
    socket.onclose = (): void => {
      this.live.set(false);
      this.socket = null;
      this.retrying = setTimeout(() => {
        this.retrying = null;
        this.connect();
      }, this.config.reconnectMs ?? DEFAULT_RECONNECT_MS);
    };
  }

  private openWebSocket(): LivewireSocket {
    const location = this.document?.location;
    const scheme = location?.protocol === 'https:' ? 'wss:' : 'ws:';
    const native = new WebSocket(`${scheme}//${location?.host ?? ''}${this.config.path}`);
    // Adapted rather than used directly: a `MessageEvent` is the browser's
    // shape, and everything else here - the in-memory server, the tests -
    // speaks in frames.
    const socket: LivewireSocket = {
      send: (frame) => native.send(frame),
      close: (code, reason) => native.close(code, reason),
    };
    native.onopen = () => socket.onopen?.();
    native.onmessage = (event: MessageEvent) => socket.onmessage?.(String(event.data));
    native.onclose = (event: CloseEvent) => socket.onclose?.(event.code, event.reason);
    native.onerror = () => console.error('[livewire] socket error');
    return socket;
  }

  private send(event: string, data: unknown): void {
    // Nothing is sent before the socket is up, and this is not an optimisation.
    // A `WebSocket` still connecting *throws* on `send` rather than ignoring
    // it, and that exception comes straight back out of `watch`'s subscribe
    // function - killing the very subscription being opened. On a cold load
    // that is every list a screen asks for before the handshake completes, and
    // they never come back, because the error tears the observable down.
    //
    // Nothing is lost by waiting: `onopen` sends every open subscription, which
    // is the same set and a shorter path. An `unsubscribe` that does not go out
    // is not lost either - the id is already gone from `open`, so it is not
    // among what gets re-sent.
    if (!this.live()) {
      return;
    }
    this.socket?.send(JSON.stringify({ event, data }));
  }
}
