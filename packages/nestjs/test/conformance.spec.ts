import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { Observable, Subject, of } from 'rxjs';
import { WebSocket } from 'ws';
import { Conversation, SCENARIOS } from '@softwarity/livewire-mock';
import type { Wire } from '@softwarity/livewire-mock';
import type { INestApplication } from '@nestjs/common';
import type { LiveWindow } from '@softwarity/livewire-protocol';
import { LiveTopic } from '../src/live-source';
import { LivewireModule } from '../src/livewire.module';
import { SingleWindowSource, onChanges } from '../src/windowed-source';

/**
 * The NestJS server, put through the scenarios every implementation must pass -
 * the same list the in-memory server runs, and the one a Go server will.
 *
 * This is what makes "we also have another implementation" true rather than
 * hopeful: a rule only two of the three obey fails here, today, instead of
 * surfacing on somebody's screen in six months.
 */

/** The feed both sources follow, so a test can make the data change. */
@Injectable()
class Feed {
  readonly changes = new Subject<void>();
  arrivals = 0;

  touch(): void {
    this.arrivals += 1;
    this.changes.next();
  }
}

@Injectable()
@LiveTopic('rows')
class RowsSource extends SingleWindowSource {
  constructor(private readonly feed: Feed) {
    super();
  }

  protected wake(): Observable<unknown> {
    // No coalescing here: these scenarios are about the protocol, not about how
    // long a burst gathers.
    return onChanges(this.feed.changes, 0, 0);
  }

  protected read(): Observable<LiveWindow> {
    // Newest first, so an arrival pushes the others down without changing
    // them - which is what checks that a row that only moved is not re-sent.
    return of({
      rows: [
        ...Array.from({ length: this.feed.arrivals }, (_, index) => ({
          id: `new-${this.feed.arrivals - index}`,
          updatedAt: 'v1',
        })),
        { id: 'r1', updatedAt: 'v1' },
        { id: 'r2', updatedAt: 'v1' },
      ],
      total: 2 + this.feed.arrivals,
    });
  }
}

@Injectable()
@LiveTopic('still')
class StillSource extends SingleWindowSource {
  constructor(private readonly feed: Feed) {
    super();
  }

  protected wake(): Observable<unknown> {
    return onChanges(this.feed.changes, 0, 0);
  }

  protected read(): Observable<LiveWindow> {
    return of({ rows: [{ id: 'always', updatedAt: 'v1' }], total: 1 });
  }
}

@Module({ providers: [Feed, RowsSource, StillSource], exports: [Feed] })
class FixtureModule {}

describe('conformance: the NestJS server', () => {
  let app: INestApplication;
  let feed: Feed;
  let address: string;

  beforeAll(async () => {
    app = (
      await Test.createTestingModule({
        imports: [LivewireModule.forRoot({ path: '/ws' }), FixtureModule],
      }).compile()
    ).createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    feed = app.get(Feed);
    const port = (app.getHttpServer().address() as { port: number }).port;
    address = `ws://127.0.0.1:${port}/ws`;
  });

  afterAll(async () => {
    await app?.close();
  });

  function wireOf(): Wire {
    const socket = new WebSocket(address);
    return {
      ready: new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      }),
      send: (frame) => socket.send(frame),
      onFrame: (listener) => socket.on('message', (data: Buffer) => listener(data.toString())),
      touch: async () => {
        feed.touch();
        // Long enough for a frame to make it back over a loopback socket.
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
      quiet: 250,
      close: () => socket.close(),
    };
  }

  for (const scenario of SCENARIOS) {
    it(`${scenario.spec} ${scenario.name}`, async () => {
      const wire = wireOf();
      const conversation = new Conversation(wire);
      await wire.ready;
      try {
        await scenario.run(conversation);
      } finally {
        wire.close?.();
      }
    });
  }
});
