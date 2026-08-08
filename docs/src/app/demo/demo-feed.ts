import { MockServer } from '@softwarity/livewire-mock';
import type { MockSocket } from '@softwarity/livewire-mock';
import type { Envelope, JsonValue, LiveRow, LiveWindow } from '@softwarity/livewire-protocol';

/** A row of the demo board. Whatever it shows is folded into `updatedAt`. */
export interface BoardRow extends LiveRow {
  flight: string;
  destination: string;
  time: string;
  status: Status;
}

export type Status = 'scheduled' | 'boarding' | 'departed' | 'delayed';

/** How long the list is before anything arrives. */
const ROWS = 4000;

/** What a client may ask for at once - the same clamp a real source applies. */
const MAX_LIMIT = 200;

const AIRPORTS = [
  'LFBO', 'EGLL', 'EDDF', 'LEMD', 'LIRF', 'EHAM', 'LSZH', 'LOWW',
  'EKCH', 'ESSA', 'LPPT', 'LGAV', 'LKPR', 'EPWA', 'LHBP', 'LROP',
];

const CARRIERS = ['AF', 'BA', 'LH', 'IB', 'AZ', 'KL', 'LX', 'OS'];

/**
 * The demo's server: a real Livewire server, in this page.
 *
 * It is the package the conformance suite runs against, not a sketch written
 * for the documentation. What you see here is what the NestJS and Go servers
 * are checked to do, which is the only reason a demo is worth showing at all.
 */
export class DemoFeed {
  readonly server: MockServer;

  /** Every frame, both ways, for the page to display. */
  onTraffic?: (direction: 'in' | 'out', frame: Envelope<unknown>) => void;

  private rows: BoardRow[] = [];
  private arrivals = 0;

  /** Set for one connection, so the demo can show a refusal and recover. */
  private refusing = false;

  private socket: MockSocket | null = null;
  private ticking: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.rows = Array.from({ length: ROWS }, (_, index) => this.make(ROWS - index));

    this.server = new MockServer({
      // Called per connection: the demo flips it for one attempt, then lets the
      // reconnection through - which is what the client does on its own.
      authorize: () => {
        if (!this.refusing) {
          return true;
        }
        this.refusing = false;
        return false;
      },
      refusal: () => 'no role reached this service',
      onTraffic: (direction, frame) => this.onTraffic?.(direction, frame),
    });

    this.server.register<Page>('board', {
      // The trust boundary, exactly as on a real server: what arrives is JSON
      // off a socket, and it is clamped here rather than trusted downstream.
      readQuery: (raw: JsonValue | undefined): Page => {
        const asked = (raw ?? {}) as { offset?: number; limit?: number };
        return {
          offset: Math.max(0, Math.trunc(Number(asked.offset ?? 0)) || 0),
          limit: Math.min(MAX_LIMIT, Math.max(1, Math.trunc(Number(asked.limit ?? 50)) || 50)),
        };
      },
      windowFor: (query: Page): LiveWindow => ({
        rows: this.rows.slice(query.offset, query.offset + query.limit),
        total: this.rows.length,
      }),
    });
  }

  /** Opens a connection. The page hands this to `provideLivewire`. */
  connect(): MockSocket {
    this.socket = this.server.connect();
    return this.socket;
  }

  /** A new row at the top. Everything below it moves down and nothing else changes. */
  arrive(): void {
    this.arrivals += 1;
    this.rows = [this.make(ROWS + this.arrivals), ...this.rows];
    this.server.touched('board');
  }

  /**
   * One row changes, somewhere near the top where it can be seen.
   *
   * Its version moves with it: a status written without a new version is the
   * one mistake this whole design is built to make impossible to hide.
   */
  change(): void {
    const index = Math.floor(Math.random() * Math.min(40, this.rows.length));
    const row = this.rows[index];
    const status = NEXT[row.status];
    const changed: BoardRow = { ...row, status, updatedAt: version(row.flight, row.time, status) };
    this.rows = [...this.rows.slice(0, index), changed, ...this.rows.slice(index + 1)];
    this.server.touched('board');
  }

  /**
   * A read that produces the window it produced last time.
   *
   * Nothing is published - SPEC §5.3 - and the point of the button is that the
   * traffic panel stays empty while the server is demonstrably working.
   */
  reread(): void {
    this.server.touched('board');
  }

  /** Drops the socket, as a gateway restart would. The client reconnects on its own. */
  drop(): void {
    this.socket?.close();
    this.socket = null;
  }

  /** Refuses the next connection, then drops the current one to provoke it. */
  refuseNext(): void {
    this.refusing = true;
    this.drop();
  }

  /** A feed that keeps moving, for reading the panel rather than clicking it. */
  start(everyMs = 1600): void {
    if (this.ticking !== null) {
      return;
    }
    this.ticking = setInterval(() => (Math.random() < 0.6 ? this.arrive() : this.change()), everyMs);
  }

  stop(): void {
    if (this.ticking !== null) {
      clearInterval(this.ticking);
      this.ticking = null;
    }
  }

  get running(): boolean {
    return this.ticking !== null;
  }

  private make(number: number): BoardRow {
    const carrier = CARRIERS[number % CARRIERS.length];
    const flight = `${carrier}${1000 + (number % 8999)}`;
    const destination = AIRPORTS[number % AIRPORTS.length];
    const time = clock(number);
    const status: Status = 'scheduled';
    return { id: `f-${number}`, updatedAt: version(flight, time, status), flight, destination, time, status };
  }
}

/** What a window of this board is: a page, and nothing else. */
interface Page {
  offset: number;
  limit: number;
}

const NEXT: Record<Status, Status> = {
  scheduled: 'boarding',
  boarding: 'departed',
  departed: 'delayed',
  delayed: 'scheduled',
};

/**
 * The version of a row: everything it shows, folded into one string.
 *
 * A version built from the write alone - a counter, a timestamp of the last
 * update - would leave a row that changed for any other reason looking
 * unchanged, and the diff would never send it again.
 */
function version(flight: string, time: string, status: Status): string {
  return `${flight}|${time}|${status}`;
}

function clock(number: number): string {
  const minutes = (number * 7) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * One feed for the page.
 *
 * Module-level because the providers of the demo component need it before an
 * instance of that component exists.
 */
export const feed = new DemoFeed();
