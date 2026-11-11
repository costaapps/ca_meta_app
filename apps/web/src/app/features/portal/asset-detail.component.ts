import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-asset-detail',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <section class="asset-page" aria-labelledby="asset-title">
      <a routerLink="/connections">← Voltar às conexões</a>
      <h1 id="asset-title">Detalhes do recurso</h1>
      <p>Os detalhes serão exibidos após a verificação do ativo e da autorização pelo servidor.</p>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .asset-page { max-width: 720px; padding: 1.5rem; border: 1px solid #e1e6ea; border-radius: 8px; background: #fff; }
    h1 { margin: 1rem 0 .35rem; font-size: 1.65rem; }
    p { color: #63717c; line-height: 1.55; }
    a { color: #0067d8; text-decoration: none; }
    a:hover { text-decoration: underline; }
  `],
})
export class AssetDetailComponent {}
