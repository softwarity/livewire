import { ApplicationConfig } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { provideLivewire } from '@softwarity/livewire';
import { routes } from './app.routes';
import { feed } from './demo/demo-feed';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes, withHashLocation()),
    // The demo runs the published client against a server living in this page.
    // `connect` is the whole of the difference: everything above it - the
    // subscriptions, the diff, the reconnection - is the code a real
    // application runs.
    provideLivewire({ path: '', reconnectMs: 1500, connect: () => feed.connect() }),
  ],
};
