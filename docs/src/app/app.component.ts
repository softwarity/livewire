import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

interface DocLink {
  path: string;
  label: string;
  icon: string;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  protected readonly links: DocLink[] = [
    { path: '/', label: 'Getting started', icon: 'rocket_launch' },
    { path: '/configuration', label: 'Configuration', icon: 'settings' },
    { path: '/securing-endpoints', label: 'Securing endpoints', icon: 'lock' },
    { path: '/ownership', label: 'Resource ownership', icon: 'verified_user' },
    { path: '/boolean-specs', label: 'Boolean specifications', icon: 'rule' },
    { path: '/parameter-decorators', label: 'Parameter decorators', icon: 'tune' },
    { path: '/info-providers', label: 'Principal providers', icon: 'badge' },
  ];
}
