package io.softwarity.livewire;

import io.vertx.ext.web.RoutingContext;

/**
 * Whether a caller may use the socket at all — the only place the library touches the
 * application's idea of identity.
 *
 * A bean of the application implementing this is used; without one, every upgrade is accepted,
 * which is right behind a gateway that has already authenticated and wrong on the open internet.
 * The upgrade request is all there is to decide on: no frame is required before
 * {@code subscribe} (SPEC §1).
 */
public interface LivewireAuthorizer {

    boolean authorize(RoutingContext upgrade);

    /**
     * What to say before closing a refused socket. Said on the socket, not only in the close
     * code: a refusal arriving as a bare disconnection is indistinguishable from a network fault.
     */
    default String refusal(RoutingContext upgrade) {
        return "Not authorised";
    }
}
