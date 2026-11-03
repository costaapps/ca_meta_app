import { Component, OnInit } from '@angular/core';
import { oauthReturnSignalFromSearch } from '../../core/embed/embed-contract';

@Component({
  selector: 'app-oauth-return',
  standalone: true,
  template: '<main aria-live="polite"><h1>Retorno recebido</h1><p>{{ message }}</p></main>',
})
export class OAuthReturnComponent implements OnInit {
  message = 'O resultado será confirmado pelo servidor.';

  ngOnInit(): void {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const signal = oauthReturnSignalFromSearch(url.search);
    // Remove callback parameters, including any unexpected provider code or state, from history first.
    window.history.replaceState(null, '', url.pathname);
    const opener = window.opener;
    if (!signal || !opener || opener.closed) {
      this.message = 'Retorne ao portal e consulte o estado da conexão.';
      return;
    }
    try {
      opener.postMessage(signal, window.location.origin);
      window.close();
    } catch {
      this.message = 'Retorne ao portal e consulte o estado da conexão.';
    }
  }
}
