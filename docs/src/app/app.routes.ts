import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./pages/getting-started.component').then((m) => m.GettingStartedComponent),
  },
  {
    path: 'configuration',
    loadComponent: () => import('./pages/configuration.component').then((m) => m.ConfigurationComponent),
  },
  {
    path: 'securing-endpoints',
    loadComponent: () => import('./pages/securing-endpoints.component').then((m) => m.SecuringEndpointsComponent),
  },
  {
    path: 'ownership',
    loadComponent: () => import('./pages/ownership.component').then((m) => m.OwnershipComponent),
  },
  {
    path: 'boolean-specs',
    loadComponent: () => import('./pages/boolean-specs.component').then((m) => m.BooleanSpecsComponent),
  },
  {
    path: 'parameter-decorators',
    loadComponent: () => import('./pages/parameter-decorators.component').then((m) => m.ParameterDecoratorsComponent),
  },
  {
    path: 'info-providers',
    loadComponent: () => import('./pages/info-providers.component').then((m) => m.PrincipalProvidersComponent),
  },
  { path: '**', redirectTo: '' },
];
