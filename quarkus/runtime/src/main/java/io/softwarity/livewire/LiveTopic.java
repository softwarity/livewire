package io.softwarity.livewire;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * The topic a {@link Source} bean answers. One topic per class: a topic is a list, and a list
 * is one source. Registering two beans under the same topic stops the application at start.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
public @interface LiveTopic {

    String value();
}
