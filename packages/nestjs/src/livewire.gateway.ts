import { Inject, Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect, WsResponse } from '@nestjs/websockets';
import { EMPTY, Observable, Subject, defer, of } from 'rxjs';
import { map, takeUntil } from 'rxjs/operators';
import type { IncomingMessage } from 'http';
import { NOT_AUTHORISED, UPDATE_EVENT } from '@softwarity/livewire-protocol';
import type { LiveRow, LiveWindow, SubscribeFrame, UnsubscribeFrame, UpdateFrame } from '@softwarity/livewire-protocol';
import { LIVEWIRE_OPTIONS } from './livewire.options';
import type { LivewireOptions } from './livewire.options';
import { LivewireRegistry } from './livewire.registry';
import { patchOf, snapshotOf } from './patch';

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

  constructor(
    private readonly registry: LivewireRegistry,
    @Inject(LIVEWIRE_OPTIONS) private readonly options: LivewireOptions,
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
  }

  handleDisconnect(client: Socket): void {
    for (const closing of this.sockets.get(client)?.values() ?? []) {
      closing.next();
      closing.complete();
    }
    this.sockets.delete(client);
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
