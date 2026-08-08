import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { WebSocketGateway } from '@nestjs/websockets';
import type { DynamicModule } from '@nestjs/common';
import { LivewireGateway } from './livewire.gateway';
import { LIVEWIRE_OPTIONS } from './livewire.options';
import type { LivewireOptions } from './livewire.options';
import { LivewireRegistry } from './livewire.registry';

/**
 * The socket, and the registry that finds what to publish on it.
 *
 * Import it once, at the root. Sources are declared in their own modules and
 * found by their `@LiveTopic` - nothing has to be listed here.
 */
@Module({})
export class LivewireModule {
  static forRoot(options: LivewireOptions): DynamicModule {
    // The path is a decorator argument, and a decorator is evaluated when the
    // class is defined - so the configured gateway is defined here, once the
    // path is known, rather than fixed at import time. The subclass carries its
    // own constructor so Nest can read what to inject: `design:paramtypes` is
    // not inherited.
    @WebSocketGateway({ path: options.path })
    class ConfiguredLivewireGateway extends LivewireGateway {
      constructor(registry: LivewireRegistry) {
        super(registry, options);
      }
    }

    return {
      module: LivewireModule,
      imports: [DiscoveryModule],
      providers: [
        LivewireRegistry,
        { provide: LIVEWIRE_OPTIONS, useValue: options },
        ConfiguredLivewireGateway,
      ],
      exports: [LivewireRegistry],
    };
  }
}
