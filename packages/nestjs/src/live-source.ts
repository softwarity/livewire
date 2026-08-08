import { SetMetadata } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { JsonValue, LiveWindow } from '@softwarity/livewire-protocol';

export const LIVE_TOPIC = 'livewire:topic';

/**
 * Marks a provider as the source behind one topic.
 *
 * The registry finds them through Nest's `DiscoveryService`, so adding a live
 * list is a matter of writing its source and registering it in its own module -
 * there is no central table to edit.
 */
export function LiveTopic(topic: string): ClassDecorator {
  return SetMetadata(LIVE_TOPIC, topic);
}

/**
 * One live list.
 *
 * `watch` returns the window as it stands and again whenever it may have
 * changed - always the whole window, never a delta. The filter is the source's
 * query, and a parallel in-memory predicate deciding whether one row belongs
 * would be a second implementation of the same question, free to drift from the
 * first. Turning the window into a patch is the gateway's business, per client,
 * because only it knows what that client actually received.
 */
export interface LiveSource<Q = JsonValue> {
  /**
   * The query this source will act on, whatever the client sent.
   *
   * The trust boundary. What arrives is JSON and nothing more - clamp it,
   * whitelist it, default it, and hand back something the source can act on
   * without checking again.
   */
  readQuery(raw: JsonValue | undefined): Q;
  watch(query: Q): Observable<LiveWindow>;
}
