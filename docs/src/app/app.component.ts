import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { BrandComponent } from './brand/brand.component';
import type { Brand } from './brand/brand.component';

interface DocLink {
  path: string;
  label: string;
  /** A Material icon, unless the page is about a framework - see `brand`. */
  icon?: string;
  /** The framework's own mark, for the three pages that document one. */
  brand?: Brand;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule, BrandComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  protected readonly links: DocLink[] = [
    { path: '/', label: 'Getting started', icon: 'rocket_launch' },
    { path: '/demo', label: 'Live demo', icon: 'bolt' },
    { path: '/protocol', label: 'The protocol', icon: 'swap_horiz' },
    { path: '/nestjs', label: 'NestJS server', brand: 'nestjs' },
    { path: '/go', label: 'Go server', brand: 'go' },
    { path: '/angular', label: 'Angular client', brand: 'angular' },
    { path: '/conformance', label: 'Conformance', icon: 'fact_check' },
  ];
}
