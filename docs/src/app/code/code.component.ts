import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  viewChild,
} from '@angular/core';
import Prism from 'prismjs';
// Side-effect imports register the languages on the global Prism instance.
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-go';

export type CodeLang = 'ts' | 'typescript' | 'bash' | 'shell' | 'json' | 'go' | 'html' | 'text';

/**
 * Renders a Prism-highlighted code block with the Catppuccin Mocha theme.
 *
 * Two ways in, and the first is the one to reach for:
 *
 * ```html
 * <app-code lang="ts" [code]="snippet" />   <!-- from a field: no escaping -->
 * <app-code lang="bash">npm install</app-code>
 * ```
 *
 * A snippet passed as content is template text, so every `{`, `@` and `<` in it
 * has to be escaped past the Angular parser - which is unreadable in the source
 * and easy to get subtly wrong. A snippet held in a field is a plain string:
 * what is written is what is shown.
 */
@Component({
  selector: 'app-code',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <pre class="code-block" [class]="'language-' + lang()"><code #codeEl [class]="'language-' + lang()">{{ code() }}<ng-content /></code></pre>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .code-block {
        margin: 0 0 16px 0;
      }
    `,
  ],
})
export class CodeComponent implements AfterViewInit {
  readonly lang = input<CodeLang>('ts');

  /** The snippet. Empty means it is being projected as content instead. */
  readonly code = input('');

  private readonly codeEl = viewChild.required<ElementRef<HTMLElement>>('codeEl');

  ngAfterViewInit(): void {
    Prism.highlightElement(this.codeEl().nativeElement);
  }
}
