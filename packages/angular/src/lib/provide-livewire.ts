import { LIVEWIRE_CONFIG } from './livewire.client';
import type { EnvironmentProviders, Provider } from '@angular/core';
import type { LivewireConfig } from './livewire.client';

/**
 * Wires the one socket into an application.
 *
 * ```ts
 * providers: [provideLivewire({ path: '/my-service/ws' })]
 * ```
 *
 * For a demo or a test with no backend, hand it a connection instead:
 *
 * ```ts
 * const server = new MockServer().register('rows', { windowFor: () => window });
 * provideLivewire({ path: '', connect: () => server.connect() });
 * ```
 */
export function provideLivewire(config: LivewireConfig): (Provider | EnvironmentProviders)[] {
  return [{ provide: LIVEWIRE_CONFIG, useValue: config }];
}
