import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { JsonValue, NotifyFrame } from '@softwarity/livewire-protocol';
import type { Observable } from 'rxjs';

/**
 * How the application tells the screens that something happened - SPEC §6.2.
 *
 * An event, not a window. Nothing here is applied to a list, nothing is
 * remembered, and a client that does not know the topic ignores it. What it is
 * for is what has no state: an import finished, a job failed, a circuit came
 * back.
 *
 * ```ts
 * constructor(private readonly livewire: LivewireNotifier) {}
 *
 * finished(count: number): void {
 *   this.livewire.notify('import.finished', { count });
 * }
 * ```
 *
 * Anything a screen has to hold, show or reconcile is a window and belongs in a
 * source. The give-away is a reader arriving late: they missed the
 * notification, and if that matters, it was never one.
 */
@Injectable()
export class LivewireNotifier {
  private readonly notices = new Subject<NotifyFrame>();

  /** What the gateway sends on, and nothing else subscribes to. */
  readonly notifications: Observable<NotifyFrame> = this.notices.asObservable();

  /**
   * Tells every open socket.
   *
   * Who receives one is deliberately not configurable here: the contract says
   * nothing about per-topic authorisation, and a server needing an audience
   * decides it before calling this.
   */
  notify(topic: string, payload?: JsonValue): void {
    this.notices.next(payload === undefined ? { topic } : { topic, payload });
  }
}
