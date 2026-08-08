import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./pages/getting-started.component').then((m) => m.GettingStartedComponent),
  },
  {
    path: 'demo',
    loadComponent: () => import('./pages/demo.component').then((m) => m.DemoComponent),
  },
  {
    path: 'protocol',
    loadComponent: () => import('./pages/protocol.component').then((m) => m.ProtocolComponent),
  },
  {
    path: 'nestjs',
    loadComponent: () => import('./pages/nestjs.component').then((m) => m.NestjsComponent),
  },
  {
    path: 'go',
    loadComponent: () => import('./pages/go.component').then((m) => m.GoComponent),
  },
  {
    path: 'angular',
    loadComponent: () => import('./pages/angular.component').then((m) => m.AngularComponent),
  },
  {
    path: 'conformance',
    loadComponent: () => import('./pages/conformance.component').then((m) => m.ConformanceComponent),
  },
  { path: '**', redirectTo: '' },
];
