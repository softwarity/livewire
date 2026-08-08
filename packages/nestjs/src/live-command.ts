import type { JsonValue } from '@softwarity/livewire-protocol';
import type { Observable } from 'rxjs';

export const LIVE_COMMAND = 'livewire:command';

/**
 * Marks a method as something a client may ask for - SPEC §6.1.
 *
 * ```ts
 * @Injectable()
 * export class FlightCommands {
 *   @LiveCommand('flight.acknowledge')
 *   acknowledge(payload: JsonObject): Observable<void> {
 *     return this.flights.acknowledge(text(payload['id']));
 *   }
 * }
 * ```
 *
 * On a method rather than on a class, unlike `@LiveTopic`: a topic is a list
 * and there is one per class, while commands come in families - a handful of
 * verbs about the same thing, sharing the same dependencies.
 *
 * What it answers becomes the `result` of the acknowledgement, and answering
 * nothing is the ordinary case. **What the command changed does not go there**:
 * a list it touched is republished by its own subscription, and putting the new
 * state in the answer would be a second version of it, free to disagree.
 *
 * Throwing - or an observable that errors - refuses the command: the message
 * becomes the reason the client is given.
 */
export function LiveCommand(name: string): MethodDecorator {
  return (target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(LIVE_COMMAND, name, descriptor.value as object);
    return descriptor;
  };
}

/** What a command answers with. Nothing is the ordinary case. */
export type CommandResult = Observable<JsonValue | void> | Promise<JsonValue | void> | JsonValue | void;

/** A command, as the registry holds it: bound to its provider. */
export type LiveCommandHandler = (payload: JsonValue | undefined) => CommandResult;
