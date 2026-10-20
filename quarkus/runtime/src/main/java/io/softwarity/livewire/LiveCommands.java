package io.softwarity.livewire;

/**
 * Marks a bean holding {@link LiveCommand} methods.
 *
 * Commands come in families sharing their dependencies, so they are methods rather than one
 * class each. The marker is what keeps such a bean in the application: Quarkus removes at build
 * the beans nothing injects, and the registry finds these by injecting
 * {@code Instance<LiveCommands>}.
 */
public interface LiveCommands {
}
