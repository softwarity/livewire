package io.softwarity.livewire;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Something a client can ask the server to do — SPEC §6.1. On a public method of a bean that
 * implements {@link LiveCommands}.
 *
 * <p>The method takes nothing, or one parameter the payload is converted to (a
 * {@code JsonNode} receives it as it is). What it returns is the acknowledgement's
 * {@code result}; what it throws refuses the command, its message being the reason. It runs on
 * a worker thread, through the bean's proxy, so {@code @Transactional} and the like apply.
 *
 * <p><b>What the command changed is not returned here.</b> A list it touched is republished by
 * its own subscription; two answers to one question is what this protocol exists to avoid.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface LiveCommand {

    String value();
}
