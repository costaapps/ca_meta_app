import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

@Component({
  selector: 'app-portal-section',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <section class="section-page" [attr.aria-labelledby]="'section-title'">
      <p class="eyebrow">Portal de conexões</p>
      <h1 id="section-title">{{ title }}</h1>
      <p>{{ description }}</p>
      <a routerLink="/connections">Voltar às conexões</a>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .section-page { max-width: 720px; padding: 1.5rem; border: 1px solid #e1e6ea; border-radius: 8px; background: #fff; }
    .eyebrow { color: #0070f2; font-size: .76rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    h1 { margin: .35rem 0; font-size: 1.65rem; }
    p:not(.eyebrow) { margin-bottom: 1rem; color: #63717c; line-height: 1.55; }
    a { color: #0067d8; font-weight: 600; text-decoration: none; }
    a:hover { text-decoration: underline; }
  `],
})
export class PortalSectionComponent implements OnInit {
  title = 'Área do portal';
  description = '';

  constructor(private readonly route: ActivatedRoute) {}

  ngOnInit(): void {
    this.route.data.subscribe((data) => {
      this.title = typeof data['title'] === 'string' ? data['title'] : this.title;
      this.description = typeof data['description'] === 'string' ? data['description'] : '';
    });
  }
}
