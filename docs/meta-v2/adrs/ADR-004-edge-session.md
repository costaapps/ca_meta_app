# ADR-004 · Edge, origin e sessão

Status: aceita como direção inicial de implementação. Issues: [M1.04 / #13](https://github.com/costaapps/ca_meta_app/issues/13), [M1.06 / #15](https://github.com/costaapps/ca_meta_app/issues/15). Data: 2026-10-28.

## Contexto comprovado

O frontend atual é um Angular standalone servido separadamente dos endpoints PHP consumidos. O futuro emissor Suite4, domínio público, proxy, callback Meta e política de cookies de produção não foram comprovados nesta M1. Uma URL com `cUUID` não é autenticação. As decisões de identidade detalhadas e os cenários de ticket/CSRF pertencem à M1.06; aqui são limites de infraestrutura para eles.

## Opções

| Opção | Benefício | Custo/risco | Evidência/experimento |
|---|---|---|---|
| Mesmo origin HTTPS: `/` no web, `/api` no Nest | Reduz CORS e simplifica cookies host-only e callbacks | Proxy e TLS são dependências que precisam de dono e configuração explícita | Preferido pelo blueprint; ainda sem deploy/ingress real |
| Web e API em origins distintos | Deploy DNS independente | CORS, cookie cross-site, CSRF e callback mais complexos; iframe ainda pode bloquear storage | Nenhum requisito funcional M1 exige origin separado |
| API acoplada ao framework web/SSR | Um servidor entrega tudo | API compartilha build/release e impõe runtime web sem requisito de SEO | Nenhum requisito funcional requer SSR ou SEO |

## Decisão e consequência

Preferir um único origin público com TLS terminando no ingress/reverse proxy. Roteamento: `/` para container estático Angular com fallback SPA; `/api/` e callbacks para Nest; endpoints health não expõem diagnóstico público sensível. Web, API e worker são containers separados. A API valida `Host`, limites de body, Origin/CSRF, e usa cabeçalhos `Forwarded`/`X-Forwarded-*` somente quando o endereço remetente é proxy confiável configurado; não confiar indiscriminadamente em cabeçalho enviado pela internet. DNS, provedor, domínio, TLS termination e lista de proxies por ambiente são **Not confirmed**.

API emite sessão opaca server-side e cookie host-only `HttpOnly; Secure`; `SameSite` é escolhido após prova dos fluxos top-level/embed reais. Mutação exige token/estratégia CSRF, Origin/Fetch Metadata conforme contrato e revalidação de membership. O client Angular consulta a API e mantém contexto/ticket apenas na memória; tokens Meta e segredo de app nunca chegam ao browser. Logout/revogação e troca de tenant são compartilhados entre réplicas em storage central, não memória local.

Suite4 embed precisa de postMessage com `origin`, `source`, versão, schema e nonce estritamente validados; a política de storage de terceiros exige caminho retomável top-level. As origens permitidas e assinatura/formato/TTL real do ticket dependem do contrato do emissor e da homologação; não são codificados nesta decisão.

## Prova, implantação e recuperação

Local/CI usa origin e configuração isolados para web/api; staging e produção têm `APP_ENV`, callbacks, configuração Meta, segredo de sessão, chaveamento e recursos separados. Config não secreta do web é allowlist; segredo não entra em imagem, bundle, build arg, query string ou log. Ingress tem health/readiness sem expor versões detalhadas. A prova M1.04 compila a API e ilustra containers; não executa browser E2E, TLS real ou Suite4.

## Revisão futura

Revisar se Suite4 exigir domínio cross-site de embed, se callbacks de Meta não puderem compartilhar origin ou se a hospedagem impor topologia diferente. A revisão depende de teste de browser em contexto third-party, ameaça CSRF, DNS/TLS real e contrato Suite4 ratificado; nenhum é inferido aqui.
