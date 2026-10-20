package io.softwarity.livewire;

/** A question or a command refused, with the reason the client is given. */
public class LivewireRefusal extends RuntimeException {

    public LivewireRefusal(String reason) {
        super(reason);
    }
}
