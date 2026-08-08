import type { IncomingMessage } from 'http';

export const LIVEWIRE_OPTIONS = 'LIVEWIRE_OPTIONS';

export interface LivewireOptions {
  /** Where the socket answers, e.g. `/my-service/ws`. */
  path: string;

  /**
   * Whether this caller may use the socket at all, from the upgrade request.
   *
   * The only place the library touches your application's idea of identity. A
   * gateway is not an HTTP route, so a global guard never sees it - whatever
   * the guard reads, read it here too. Absent, every upgrade is accepted, which
   * is right behind a gateway that has already authenticated and wrong on the
   * open internet.
   */
  authorize?: (request: IncomingMessage) => boolean;

  /**
   * What to say before closing a socket that was refused.
   *
   * Said on the socket and not only in a close code: a refusal arriving as a
   * bare disconnection is indistinguishable from a network fault, and a proxy
   * that drops the close code - which an upgrade through a gateway often does -
   * leaves the screen showing nothing with no way to tell why.
   */
  refusal?: (request: IncomingMessage) => string;
}
