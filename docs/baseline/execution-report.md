# M1.01 — relatório de baseline e execução

Data: 2026-10-28. Base e HEAD observados: `7b3b38b0581928a18d14dd5fdb75ee020498241a`. Árvore rastreada: `a1d7b5168bfa99badab1e1f7ee71f9e6dfbd718c`. SHA-256 de `package-lock.json`: `aaa2c07882c01ed5f500be876efa55e7defb7a03fcf0449d9d4c4fe2a4c857d5`.

O primeiro `git status --short` desta revisão já continha `?? docs/baseline/` e `?? experiments/`; portanto não se declara o worktree fornecido limpo. Os arquivos versionados permanecem na árvore do SHA de base. Nenhum commit ou staging foi feito.

## Ambiente observado

- WSL2 Linux x86_64; kernel `6.6.87.2-microsoft-standard-WSL2`; bash.
- Node `v24.22.1`, npm `11.19.1`, Python `3.12.16`. `package.json` declara `npm@10.9.2`; o npm executado é diferente e foi registrado.
- `npx ng version`: Angular CLI `21.0.5`, Angular `21.0.8`, TypeScript `5.9.3`, RxJS `7.8.2`, Vitest `4.0.16`, `@angular/build` `21.0.5`.
- `php --version`: exit 127, `/bin/bash: php: command not found`. PHP lint/runtime e harness HTTP não foram executados.
- `backend/connect.php`, `backend/connect_old.php` e `.htaccess` não estão na árvore commitada desta baseline. Nenhum conteúdo local sensível ou operacional foi copiado ou alterado.

## Validação

Saídas resumidas abaixo; sem valores de configuração, payloads reais ou credenciais.

| Comando/verificação | Proveniência | Resultado |
|---|---|---|
| `npm ci --ignore-scripts` | Informado pelo operador como executado nesta worktree; não repetido nesta revisão porque `node_modules` já estava disponível | Exit 0 reportado. Stdout e duração não fornecidos; não tratado como saída capturada pelo agente. |
| `npm run build` | Executado nesta revisão | Exit 0. Angular build concluído; geração informada pelo CLI em 16.623 s. Bundle em `dist/meta-integration`. |
| `npm test -- --watch=false` | Executado nesta revisão | Exit 0. 2 arquivos aprovados, 5 testes aprovados, 0 falhas. Duração Vitest 11.72 s. |
| `npx ng version` | Executado nesta revisão | Exit 0; versões listadas acima. |
| `python3 experiments/baseline/trace_routes.py` | Executado nesta revisão | Exit 0; 10 fixtures sanitizadas. Sete rotas do dispatcher selecionaram handler; URI direta `connect_whatsapp.php` e método DELETE caíram no fallback 404. Nenhum PHP, HTTP, SQL ou Meta foi executado. |
| Auditoria CSV/fonte/telas | Executada após corrigir uma linha sem destino no CSV e completar o mapeamento de função | Verifica 17 IDs únicos E01–E15/X01–X02, destino não vazio em cada linha, 20 funções nomeadas cobertas e presença das rotas `/setup`, `/channels`, `/templates` em `src/app/app.routes.ts`. |
| `php --version` | Executado nesta revisão | Exit 127; `php: command not found`. Lint e comportamento runtime indisponíveis neste ambiente. |

As suítes Angular presentes cobrem dois arquivos e cinco testes; não há neste resultado cobertura executada de browser para Setup/Templates, integração PHP, SQL ou provedor. O trace é validação estática offline, não prova HTTP.

### Histórico de tentativas registrado antes desta revisão

O relatório anterior registrava um `npm ci` sem `--ignore-scripts` que falhou com `EAI_AGAIN` ao baixar `zod-to-json-schema-3.25.1.tgz`, e tentativas posteriores de build/teste que falharam ao resolver `@esbuild/win32-x64` de `../node_modules`. Esse ambiente e esses resultados não são os usados nas execuções aprovadas acima. O mesmo relatório anterior registrava depois build e cinco testes aprovados e `npm ci --ignore-scripts` reportado pelo operador. Esses registros históricos foram preservados para distinguir a sequência; os passes atuais de build e teste foram reproduzidos nesta revisão. `npm ls --depth=0` também constava como aprovado naquele relatório anterior.

## Roteamento, implantação relatada e documentação Meta

O experimento aplica fixtures ao dispatcher versionado em `backend/connect_whatsapp.php`. A URL direta `/meta/auth/connect_whatsapp.php?company_uuid=tenant-fixture` não corresponde a nenhum predicado de rota e chega ao fallback 404, se o bootstrap completar e `REQUEST_URI` chegar sem transformação. `/login-url`, `/facebook/callback`, `/channels`, `/save_auto_reply`, `/notifications`, `/notifications/action` e os endpoints de templates selecionam seus handlers. O experimento não executa rewrite.

O issue packet relata implantação compartilhada Hostinger sob `public_html/meta/auth`, `connect.php` e `connect_old.php` presentes, rewrite de caminhos inexistentes para `connect.php` e um fluxo unificado implantado. O supervisor também informa que `connect.php` não está nesta worktree e que `connect_old.php` é referência local não copiável/versionável. Nenhum arquivo implantado, hash ou regra efetiva de rewrite foi fornecido. Assim, o relato está registrado com sua proveniência, mas presença/versão operacional, destino real, equivalência com `connect_whatsapp.php` e diferenças entre fluxos permanecem **Not confirmed**. O comportamento do PHP versionado e o relato do fluxo unificado são mantidos como evidências distintas.

Em 2026-10-28, busca e abertura das páginas oficiais [Meta manual login flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/), [WhatsApp Cloud API messages](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages/) e [WhatsApp Embedded Signup](https://developers.facebook.com/docs/whatsapp/embedded-signup/) retornaram HTTP 429; a busca oficial não retornou resultados. Requisitos atuais, versões e permissões Meta permanecem **Not confirmed** e são gate da decisão específica M1.03. Nenhum requisito atual do provedor foi inferido.

## Segurança e limites

Fixtures usam somente nomes sintéticos `tenant-fixture`, `phone-fixture`, `fixture-code` e `fixture-state`. Não houve chamada de produção, envio, alteração de inscrição, callback real, acesso a banco ou instalação de credenciais. Os documentos contêm nomes de campos/tabelas e caminhos de fonte; não contêm tokens, app secrets, UUIDs operacionais, dados de cliente ou payloads reais. Nenhuma implementação PHP, DDL, consumer externo, regra de rewrite ou permissão Meta foi inventada.

## Critérios da issue

1. Cobertura versionada e destinos funcionais propostos dos quatro arquivos PHP e das três telas estão em `endpoint-matrix.csv` e `parity-matrix.md`; consumidores operacionais ausentes ficam **Not confirmed** com cenários/gates em `inventory.md`.
2. Rotas frontend e entradas/handlers PHP têm arquivo/linha. O rewrite e o fluxo unificado Hostinger constam apenas como relato do issue packet; não se apresentam como comportamento reproduzido. O trace reproduz somente os predicados do dispatcher versionado. Nenhuma paridade implantada é certificada.
3. Build/testes aprovados no ambiente identificado. Instalação `npm ci --ignore-scripts` consta como sucesso reportado pelo operador sem stdout; PHP runtime está bloqueado pelo comando/causa exatos acima.
4. Revisão dos artefatos e fixtures não encontrou segredos ou identificadores operacionais desnecessários.
5. Cada lacuna externa tem status **Not confirmed**, cenário afetado e gate antes do cutover dependente. A ausência de inventário operacional completo não impede esta descoberta versionada, mas impede alegações de paridade e o corte correspondente.

Resultado: baseline versionada inventariada e build/testes Angular aprovados. **Paridade operacional não confirmada; este relatório não autoriza migração, deploy ou corte do PHP.**
