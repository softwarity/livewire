import { Injectable, Logger } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { OnModuleInit } from '@nestjs/common';
import { LIVE_COMMAND } from './live-command';
import type { LiveCommandHandler } from './live-command';
import { LIVE_TOPIC } from './live-source';
import type { LiveSource } from './live-source';

/** The topics this application publishes, found at boot rather than listed. */
@Injectable()
export class LivewireRegistry implements OnModuleInit {
  private readonly logger = new Logger('livewire');

  private readonly sources = new Map<string, LiveSource>();
  private readonly commands = new Map<string, LiveCommandHandler>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly methods: MetadataScanner,
  ) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (typeof instance !== 'object' || instance === null) {
        continue;
      }
      const topic = Reflect.getMetadata(LIVE_TOPIC, instance.constructor) as string | undefined;
      if (topic) {
        this.sources.set(topic, instance as LiveSource);
      }
      this.scanCommands(instance);
    }
    this.logger.log(`${this.sources.size} topic(s): ${[...this.sources.keys()].join(', ')}`);
    if (this.commands.size > 0) {
      this.logger.log(`${this.commands.size} command(s): ${[...this.commands.keys()].join(', ')}`);
    }
  }

  /** Null for a topic nothing answers - the caller says so on the socket. */
  find(topic: string): LiveSource | null {
    return this.sources.get(topic) ?? null;
  }

  /** For tests and for a source registered outside Nest's container. */
  register(topic: string, source: LiveSource): void {
    this.sources.set(topic, source);
  }

  /** Null for a command nothing handles - the caller answers `ok: false`. */
  command(name: string): LiveCommandHandler | null {
    return this.commands.get(name) ?? null;
  }

  /** For tests, and for a command registered outside Nest's container. */
  handle(name: string, handler: LiveCommandHandler): void {
    this.commands.set(name, handler);
  }

  /**
   * Commands are marked on methods, so the prototype is what carries them.
   *
   * Bound to their provider on the way in: what the registry holds is something
   * callable, not a name to look up again later against an instance it would
   * have to keep beside it.
   */
  private scanCommands(instance: object): void {
    const prototype = Object.getPrototypeOf(instance) as object | null;
    if (!prototype) {
      return;
    }
    for (const method of this.methods.getAllMethodNames(prototype)) {
      const handler = (instance as Record<string, unknown>)[method];
      if (typeof handler !== 'function') {
        continue;
      }
      const name = Reflect.getMetadata(LIVE_COMMAND, handler) as string | undefined;
      if (name) {
        this.commands.set(name, (payload) => (handler as LiveCommandHandler).call(instance, payload));
      }
    }
  }
}
