import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LivewireClient } from './livewire.client';

/** How long the indicator acknowledges a click before going back to its state. */
const ACKNOWLEDGE_MS = 700;

/**
 * Whether the socket is up, and the one thing to do about it when it is not.
 *
 * That and nothing else - not whether anything is arriving on it, which is a
 * different question and one this would answer badly: a quiet feed at three in
 * the morning is not a fault.
 *
 * Clicking it retries. Down, that opens the socket now instead of waiting out
 * the reconnection delay; up, it asks every open window for a fresh snapshot.
 * It is deliberately not a refresh button on the list: on a live screen a
 * control offering to fetch it again implies that the rest of the time you are
 * looking at something stale.
 *
 * Colours come from CSS custom properties, so a host theme dresses it without
 * this package knowing anything about the theme:
 *
 * ```css
 * lw-live-indicator { --lw-live: #1b7f3b; --lw-down: #b26a00; }
 * ```
 */
@Component({
  selector: 'lw-live-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  template: `
    <button type="button" class="lw-indicator" [class.lw-down]="!live()" [attr.aria-label]="label()" [title]="label()" (click)="retry()">
      <span class="lw-dot" [class.lw-beat]="live() && !asked()" [class.lw-turn]="asked()"></span>
    </button>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        /* Centred on its own line and beside whatever it sits next to. A dot is
           small enough that a row aligning its children to the top leaves it
           stranded above the text it belongs to. */
        align-items: center;
        align-self: center;
        vertical-align: middle;
      }
      .lw-indicator {
        display: inline-flex;
        align-items: center;
        padding: 0;
        border: none;
        background: none;
        cursor: pointer;
        color: var(--lw-live, currentColor);
      }
      .lw-indicator.lw-down {
        color: var(--lw-down, #b26a00);
      }
      .lw-indicator:focus-visible {
        outline: 2px solid currentColor;
        outline-offset: 2px;
        border-radius: 50%;
      }
      /* A lit dot, not a printed one: the disc, and a soft halo of the same
         colour behind it. The halo is what makes it read as a state rather
         than as punctuation. */
      .lw-dot {
        position: relative;
        display: block;
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 50%;
        background: currentColor;
        box-shadow: 0 0 0 0.18rem color-mix(in srgb, currentColor 20%, transparent);
      }
      /* The flare. A ring that leaves the dot and fades, rather than the dot
         itself moving: the state is steady, and what says "live" is around it. */
      .lw-dot::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: currentColor;
        opacity: 0;
      }
      .lw-dot.lw-beat::after {
        animation: lw-flare 2.4s cubic-bezier(0, 0, 0.2, 1) infinite;
      }
      .lw-dot.lw-turn {
        animation: lw-turn 0.5s ease-out;
      }
      @keyframes lw-flare {
        0% {
          opacity: 0.5;
          transform: scale(1);
        }
        70%,
        100% {
          opacity: 0;
          transform: scale(2.8);
        }
      }
      /* One turn on click, so the gesture is acknowledged: a resync on a list
         that has not moved changes no pixel otherwise. */
      @keyframes lw-turn {
        from {
          transform: scale(1.7);
          opacity: 0.4;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        /* The halo stays - it is not motion, and it is what makes the state
           legible at a glance. */
        .lw-dot.lw-beat::after,
        .lw-dot.lw-turn {
          animation: none;
        }
      }
    `,
  ],
})
export class LiveIndicatorComponent {
  private readonly client = inject(LivewireClient);

  readonly live = this.client.live;

  /**
   * Set for a moment after a click, and read for nothing but the animation.
   *
   * A resync on a list that has not moved changes no pixel, so without this the
   * gesture looks like it did nothing at all.
   */
  readonly asked = signal(false);

  readonly label = computed(() => (this.live() ? LIVE : DOWN));

  retry(): void {
    this.client.retry();
    this.asked.set(true);
    setTimeout(() => this.asked.set(false), ACKNOWLEDGE_MS);
  }
}

const LIVE = 'Live - click to ask for the data again';
const DOWN = 'Disconnected - reconnecting. Click to try now';
