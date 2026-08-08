import { Inject, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { WebSocketGateway } from '@nestjs/websockets';
import type { DynamicModule } from '@nestjs/common';
import { LivewireGateway } from './livewire.gateway';
import { LivewireNotifier } from './livewire.notifier';
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
      // Named rather than inferred: `design:paramtypes` is emitted for a class
      // declared inside a function, but what it holds for a parameter is
      // whatever the type resolves to at that moment - and here the second one
      // came out undefined, which Nest injects rather than refuses.
      constructor(
        @Inject(LivewireRegistry) registry: LivewireRegistry,
        @Inject(LivewireNotifier) notifier: LivewireNotifier,
      ) {
        super(registry, options, notifier);
      }
    }

    return {
      module: LivewireModule,
      // Global, and for the same reason sources are found rather than listed:
      // `forRoot` is called once at the root, so a feature module that wants to
      // announce something has no second chance to import this. Nothing here
      // holds application state - a registry and a subject - so there is
      // nothing a wider scope can spoil.
      global: true,
      imports: [DiscoveryModule],
      providers: [
        LivewireRegistry,
        LivewireNotifier,
        { provide: LIVEWIRE_OPTIONS, useValue: options },
        ConfiguredLivewireGateway,
      ],
      // The notifier is exported because the application calls it: it is how a
      // service says something happened - SPEC §6.2.
      exports: [LivewireRegistry, LivewireNotifier],
    };
  }
}
