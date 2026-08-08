import { Injectable, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Observable, of } from 'rxjs';
import { GATEWAY_OPTIONS } from '@nestjs/websockets/constants';
import { LiveTopic } from '../src/live-source';
import { LivewireGateway } from '../src/livewire.gateway';
import { LivewireModule } from '../src/livewire.module';
import { LivewireRegistry } from '../src/livewire.registry';
import { SingleWindowSource } from '../src/windowed-source';
import type { LiveWindow } from '@softwarity/livewire-protocol';

@Injectable()
@LiveTopic('kinds')
class KindsSource extends SingleWindowSource {
  protected wake(): Observable<unknown> {
    return of(null);
  }

  protected read(): Observable<LiveWindow> {
    return of({ rows: [{ id: 'FPL', updatedAt: 'FPL' }] });
  }
}

@Module({ providers: [KindsSource] })
class FeatureModule {}

/**
 * The wiring, end to end: a source declared in its own module, found by its
 * decorator, with nothing listed anywhere central.
 */
/** The gateway `forRoot` built, and the options Nest will mount it with. */
function gatewayOf(module: DynamicModule): unknown {
  const gateway = (module.providers ?? []).find(
    (provider) => typeof provider === 'function' && provider.prototype instanceof LivewireGateway,
  );
  return Reflect.getMetadata(GATEWAY_OPTIONS, gateway as object);
}

describe('LivewireModule', () => {
  it('finds a source by its topic, wherever it was declared', async () => {
    const app = await Test.createTestingModule({
      imports: [LivewireModule.forRoot({ path: '/ws' }), FeatureModule],
    }).compile();
    await app.init();

    const registry = app.get(LivewireRegistry);

    expect(registry.find('kinds')).toBeInstanceOf(KindsSource);
    expect(registry.find('nothing')).toBeNull();
    await app.close();
  });

  /**
   * The path is a decorator argument, so the configured gateway is defined
   * inside `forRoot` - once the path is known. Read back from the metadata Nest
   * itself uses to mount it.
   */
  it('gives the gateway the path it was configured with', () => {
    expect(gatewayOf(LivewireModule.forRoot({ path: '/somewhere/ws' }))).toEqual({ path: '/somewhere/ws' });
  });

  it('serves two applications on two different paths', () => {
    expect(gatewayOf(LivewireModule.forRoot({ path: '/one/ws' }))).toEqual({ path: '/one/ws' });
    expect(gatewayOf(LivewireModule.forRoot({ path: '/two/ws' }))).toEqual({ path: '/two/ws' });
  });
});
