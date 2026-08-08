import { Inject, Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect, WsResponse } from '@nestjs/websockets';
import { EMPTY, Observable, Subject, Subscription, defer, from, isObservable, of } from 'rxjs';
import { catchError, map, takeUntil } from 'rxjs/operators';
import type { IncomingMessage } from 'http';
import { ACK_EVENT, NOTIFY_EVENT, NOT_AUTHORISED, UPDATE_EVENT, patchOf, snapshotOf } from '@softwarity/livewire-protocol';
import type {
  AckFrame,
  CommandFrame,
  JsonValue,
  LiveRow,
  LiveWindow,
  SubscribeFrame,
  UnsubscribeFrame,
  UpdateFrame,
} from '@softwarity/livewire-protocol';
import { LIVEWIRE_OPTIONS } from './livewire.options';
import type { LivewireOptions } from './livewire.options';
import { LivewireNotifier } from './livewire.notifier';
import { LivewireRegistry } from './livewire.registry';

/** What a socket has to look like to be written to. Kept minimal on purpose. */
interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * One socket per client, every live list on it.
 *
 * A screen sends `subscribe` with an id of its own, a topic and a query, and
 * gets a snapshot then patches back under that id. Several subscriptions share
 * the socket: one connection per browser tab, not one per list.
 *
 * Reading and pushing travel the same way on purpose. A page fetched over HTTP
 * and a change pushed over a socket are two views of one list that can
 * disagree, and this leaves no room for them to.
 */
@WebSocketGateway()
export class LivewireGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('livewire');

  /**
   * Per socket, one closer per live subscription, and the proof the socket is
   * authorised at all.
   *
   * Firing one ends that subscription and nothing else - which is what a screen
   * changing its filters does, and what leaving a screen does, without
   * disturbing the lists still open beside it.
   */
  private readonly sockets = new Map<Socket, Map<string, Subject<void>>>();

  /** What each socket is listening to notifications with - SPEC §6.2. */
  private readonly listening = new Map<Socket, Subscription>();

  constructor(
    private readonly registry: LivewireRegistry,
    @Inject(LIVEWIRE_OPTIONS) private readonly options: LivewireOptions,
    private readonly notifier: LivewireNotifier,
  ) {}

  handleConnection(client: Socket, request: IncomingMessage): void {
    if (this.options.authorize && !this.options.authorize(request)) {
      const reason = this.options.refusal?.(request) ?? 'Not authorised';
      this.logger.warn(`socket refused: ${reason}`);
      // The frame first, then the close - see SPEC §1.
      client.send(JSON.stringify({ event: UPDATE_EVENT, data: { id: 'connection', type: 'error', reason } }));
      client.close(NOT_AUTHORISED, 'Not authorised');
      return;
    }
    this.sockets.set(client, new Map());
    // Notifications are not a subscription: every authorised socket gets them,
    // and a client that does not know the topic ignores it.
    this.listening.set(
      client,
      this.notifier.notifications.subscribe((notice) => {
        client.send(JSON.stringify({ event: NOTIFY_EVENT, data: notice }));
      }),
    );
  }

  handleDisconnect(client: Socket): void {
    for (const closing of this.sockets.get(client)?.values() ?? []) {
      closing.next();
      closing.complete();
    }
    this.sockets.delete(client);
    this.listening.get(client)?.unsubscribe();
    this.listening.delete(client);
  }

  @SubscribeMessage('subscribe')
  subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: SubscribeFrame): Observable<WsResponse<UpdateFrame>> {
    const open = this.sockets.get(client);
    // No id, nothing to answer under: ignored in silence, as the spec says.
    if (!open || typeof body?.id !== 'string' || body.id === '') {
      return EMPTY;
    }
    const source = this.registry.find(body.topic);
    if (!source) {
      return of({ event: UPDATE_EVENT, data: { id: body.id, type: 'error', reason: `No topic '${body.topic}'` } });
    }

    // Ends whatever was open under this id before building the new one: the
    // same id twice is a window that moved, and two live windows feeding one
    // list would interleave their frames into it.
    this.close(open, body.id);
    const closing = new Subject<void>();
    open.set(body.id, closing);

    const query = source.readQuery(body.query);
    return this.updates(body.id, () => source.watch(query)).pipe(
      takeUntil(closing),
      map((data) => ({ event: UPDATE_EVENT, data })),
    );
  }

  /**
   * Something to do, answered by exactly one ack - SPEC §6.1.
   *
   * Whatever happens: done, refused, or a name nothing handles. A client that
   * hears nothing back cannot tell a slow write from a lost frame.
   *
   * What the command changed is not in the answer. It reaches the screens
   * through whatever subscriptions were watching it, on their own schedule -
   * which is why nothing here orders the two.
   */
  @SubscribeMessage('command')
  command(@ConnectedSocket() client: Socket, @MessageBody() body: CommandFrame): Observable<WsResponse<AckFrame>> {
    // No id, nothing to answer under: ignored in silence, as for a subscribe.
    if (!this.sockets.has(client) || typeof body?.id !== 'string' || body.id === '') {
      return EMPTY;
    }
    const id = body.id;
    const handler = this.registry.command(body.name);
    if (!handler) {
      return of(ack({ id, ok: false, reason: `No command '${body.name}'` }));
    }
    return defer(() => {
      const answered = handler(body.payload);
      return isObservable(answered) ? answered : from(Promise.resolve(answered));
    }).pipe(
      map((result) => ack(result === undefined ? { id, ok: true } : { id, ok: true, result: result as JsonValue })),
      catchError((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`command '${body.name}' refused: ${reason}`);
        return of(ack({ id, ok: false, reason }));
      }),
    );
  }

  @SubscribeMessage('unsubscribe')
  unsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: UnsubscribeFrame): void {
    const open = this.sockets.get(client);
    if (open && typeof body?.id === 'string') {
      this.close(open, body.id);
    }
  }

  private close(open: Map<string, Subject<void>>, id: string): void {
    const closing = open.get(id);
    if (closing) {
      closing.next();
      closing.complete();
      open.delete(id);
    }
  }

  /**
   * The source's window, turned into what this one subscription has not seen.
   *
   * Per subscription rather than per window because only here is it known what
   * actually went down the socket: a screen that joins mid-stream gets a
   * snapshot, and its patches are computed against the rows it holds rather
   * than against a state the server assumed it had.
   */
  private updates(id: string, open: () => Observable<LiveWindow>): Observable<UpdateFrame> {
    return defer(() => {
      let sent: LiveRow[] | null = null;
      let sequence = 0;
      return open().pipe(
        map((window) => {
          sequence += 1;
          const update = sent === null ? snapshotOf(id, window, sequence) : patchOf(id, sent, window, sequence);
          sent = window.rows;
          return update;
        }),
      );
    });
  }
}

/** One acknowledgement, in the envelope Nest sends it in. */
function ack(frame: AckFrame): WsResponse<AckFrame> {
  return { event: ACK_EVENT, data: frame };
}
