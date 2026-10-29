package io.softwarity.livewire;

import com.fasterxml.jackson.databind.JsonNode;

import io.smallrye.mutiny.Multi;
import io.vertx.ext.web.RoutingContext;

/**
 * A {@link SourceWithContext} as the registry knows sources: it shares, wakes and reads through
 * it like any other. Its query is made by {@link Connection}, with the request that opened the
 * socket; never without it.
 */
final class Contextual<Q> implements Source<Q> {

    private final SourceWithContext<Q> source;

    Contextual(SourceWithContext<Q> source) {
        this.source = source;
    }

    Q readQuery(JsonNode raw, RoutingContext opening) {
        return source.readQuery(raw, opening);
    }

    @Override
    public Q readQuery(JsonNode raw) {
        throw new IllegalStateException("a source with context reads its query with the request that opened the socket");
    }

    @Override
    public String key(Q query) {
        return source.key(query);
    }

    @Override
    public Multi<?> wake() {
        return source.wake();
    }

    @Override
    public Window read(Q query) {
        return source.read(query);
    }
}
