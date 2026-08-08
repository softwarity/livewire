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
    { path: '/demo', label: 'Live demo', icon: 'bolt' },
    { path: '/protocol', label: 'The protocol', icon: 'swap_horiz' },
    { path: '/nestjs', label: 'NestJS server', icon: 'dns' },
    { path: '/go', label: 'Go server', icon: 'terminal' },
    { path: '/angular', label: 'Angular client', icon: 'web' },
    { path: '/conformance', label: 'Conformance', icon: 'fact_check' },
  ];
}
