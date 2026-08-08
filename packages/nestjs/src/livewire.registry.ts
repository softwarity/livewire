import { Injectable, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { OnModuleInit } from '@nestjs/common';
import { LIVE_TOPIC } from './live-source';
import type { LiveSource } from './live-source';

/** The topics this application publishes, found at boot rather than listed. */
@Injectable()
export class LivewireRegistry implements OnModuleInit {
  private readonly logger = new Logger('livewire');

  private readonly sources = new Map<string, LiveSource>();

  constructor(private readonly discovery: DiscoveryService) {}

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
    }
    this.logger.log(`${this.sources.size} topic(s): ${[...this.sources.keys()].join(', ')}`);
  }

  /** Null for a topic nothing answers - the caller says so on the socket. */
  find(topic: string): LiveSource | null {
    return this.sources.get(topic) ?? null;
  }

  /** For tests and for a source registered outside Nest's container. */
  register(topic: string, source: LiveSource): void {
    this.sources.set(topic, source);
  }
}
