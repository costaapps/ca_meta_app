# M1.01 — relatório de baseline e execução

Data: 2026-10-28. Baseline funcional autorizada e testada: commit `7b3b38b0581928a18d14dd5fdb75ee020498241a`, árvore `a1d7b5168bfa99badab1e1f7ee71f9e6dfbd718c`. Os snapshots de pacote `2bc3beef9e7455dc0b16657214d53bdb0cf69840` (árvore `ba60bfcffb107f1e22c8706ca71b29d91f3a52a7`, pai igual à baseline), `3aef01f90163cde6602fdb638fb6a5c17acec2ea` (árvore `953c134d8a99ee7359fe1b6047b2bde0d6aa9827`) e `96231050488a3afcab5046d58460b966b93ab23a` (árvore `fe6abe745f8474a1a1a79347e42e908f016b9e69`) são **históricos**. Esta correção começou no último desses snapshots; ele identifica apenas o estado predecessor desta edição, não a revisão final. O supervisor registra a proveniência da revisão após gravar as alterações no checkpoint/PR. SHA-256 de `package-lock.json`: `aaa2c07882c01ed5f500be876efa55e7defb7a03fcf0449d9d4c4fe2a4c857d5`.

O primeiro status da tentativa anterior continha `?? docs/baseline/` e `?? experiments/`. O snapshot predecessor desta correção já continha os quatro documentos do pacote e o trace offline; entre a baseline e esse snapshot, `src/`, `backend/`, `package.json` e `package-lock.json` não mudaram. Nenhum commit ou staging foi feito nesta execução.

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
| `npm ci --ignore-scripts --offline` | Executado em `/tmp/m101-baseline.VicfcV`, extraído com `git archive` do commit exato `7b3b38b0581928a18d14dd5fdb75ee020498241a` | Exit 0 em 13 s; 504 pacotes adicionados, zero vulnerabilidades reportadas. Scripts de instalação foram ignorados; sem acesso à rede. |
| `npm run build` | Executado no mesmo archive isolado | Exit 0; Angular build concluído em 7.300 s; saída em `dist/meta-integration`. |
| `npm test -- --watch=false` | Executado no mesmo archive isolado | Exit 0; 2 arquivos aprovados, 5 testes aprovados, zero falhas; duração Vitest 1.74 s. |
| `npx ng version` | Executado no mesmo archive isolado | Exit 0: Angular CLI `21.0.5`, Angular `21.0.8`, TypeScript `5.9.3`, RxJS `7.8.2`, Vitest `4.0.16`, `@angular/build` `21.0.5`. |
| `python3 experiments/baseline/trace_routes.py` | Executado nesta retomada com git HEAD predecessor `96231050488a3afcab5046d58460b966b93ab23a`; worktree contém apenas esta correção documental e fonte PHP/trace sem alterações | Exit 0; 10 fixtures sanitizadas: oito selecionaram handler (login, callback, channels, save, notifications read/action e templates GET/POST); duas sem correspondência (URI direta `connect_whatsapp.php` e método DELETE) caíram no fallback 404. Nenhum PHP, HTTP, SQL ou Meta foi executado. |
| Auditoria CSV/fonte/telas | Revisão estática registrada no snapshot histórico `96231050488a3afcab5046d58460b966b93ab23a` | 17 IDs únicos E01–E15/X01–X02; destinos presentes; 20 funções nomeadas das quatro fontes PHP mapeadas; as rotas `/setup`, `/channels`, `/templates` existem em `src/app/app.routes.ts`. |
| Tentativa histórica de build no worktree do agente | `node node_modules/@angular/cli/bin/ng.js build` | Exit 1: `@esbuild/win32-x64` estava presente, mas Linux requer `@esbuild/linux-x64`. Tentativas de instalar dependências naquele diretório foram interrompidas sem resultado. Esta falha histórica não substitui o build aprovado no archive isolado da baseline. |
| `php --version` | Executado no mesmo archive isolado da baseline | Exit 127; `/bin/bash: php: command not found`. PHP lint/runtime indisponíveis neste ambiente. |

As suítes Angular presentes cobrem dois arquivos e cinco testes; não há neste resultado cobertura executada de browser para Setup/Templates, integração PHP, SQL ou provedor. O trace é validação estática offline, não prova HTTP.

### Histórico de tentativas registrado antes desta revisão

O relatório anterior registrava `npm ci` sem `--ignore-scripts` falhando com `EAI_AGAIN` ao baixar `zod-to-json-schema-3.25.1.tgz`, além de tentativas com erro de esbuild. O operador também informou instalação, build e cinco testes aprovados. Esses registros foram preservados como histórico/proveniência distinta. Nesta retomada, os passos foram reproduzidos em snapshot limpo da árvore funcional exata da baseline; o mismatch de esbuild do worktree não foi usado para substituir nem ocultar falha. `npm ls --depth=0` constava como aprovado em relatório anterior.

## Roteamento, implantação relatada e documentação Meta

O experimento aplica fixtures ao dispatcher versionado em `backend/connect_whatsapp.php`. A URL direta `/meta/auth/connect_whatsapp.php?company_uuid=tenant-fixture` não corresponde a nenhum predicado de rota e chega ao fallback 404, se o bootstrap completar e `REQUEST_URI` chegar sem transformação. `/login-url`, `/facebook/callback`, `/channels`, `/save_auto_reply`, `/notifications`, `/notifications/action` e os endpoints de templates selecionam seus handlers. O experimento não executa rewrite.

O issue packet relata implantação compartilhada Hostinger sob `public_html/meta/auth`, `connect.php` e `connect_old.php` presentes, rewrite de caminhos inexistentes para `connect.php` e um fluxo unificado implantado. O supervisor também informa que `connect.php` não está nesta worktree e que `connect_old.php` é referência local não copiável/versionável. Nenhum arquivo implantado, hash ou regra efetiva de rewrite foi fornecido. Assim, o relato está registrado com sua proveniência, mas presença/versão operacional, destino real, equivalência com `connect_whatsapp.php` e diferenças entre fluxos permanecem **Not confirmed**. O comportamento do PHP versionado e o relato do fluxo unificado são mantidos como evidências distintas.

Em 2026-10-28, a consulta das páginas oficiais [Meta manual login flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/), [WhatsApp Cloud API messages](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages/) e [WhatsApp Embedded Signup](https://developers.facebook.com/docs/whatsapp/embedded-signup/) retornou HTTP 429 em todas. Requisitos atuais, versões, formato de cancelamento e permissões Meta permanecem **Not confirmed** e são gate da decisão específica M1.03. Nenhum requisito atual do provedor foi inferido.

## Segurança e limites

Fixtures usam somente nomes sintéticos `tenant-fixture`, `phone-fixture`, `fixture-code` e `fixture-state`. Não houve chamada de produção, envio, alteração de inscrição, callback real, acesso a banco ou instalação de credenciais. Os documentos contêm nomes de campos/tabelas e caminhos de fonte; não contêm tokens, app secrets, UUIDs operacionais, dados de cliente ou payloads reais. Nenhuma implementação PHP, DDL, consumer externo, regra de rewrite ou permissão Meta foi inventada.

## Critérios da issue

1. Cobertura versionada e destinos funcionais propostos dos quatro arquivos PHP e das três telas estão em `endpoint-matrix.csv` e `parity-matrix.md`; consumidores operacionais ausentes ficam **Not confirmed** com cenários/gates em `inventory.md`.
2. Rotas frontend e entradas/handlers PHP têm arquivo/linha. O rewrite e o fluxo unificado Hostinger constam apenas como relato do issue packet; não se apresentam como comportamento reproduzido. O trace reproduz somente os predicados do dispatcher versionado. Nenhuma paridade implantada é certificada.
3. `npm ci --ignore-scripts --offline`, build e testes aprovados no archive isolado do commit baseline e ambiente identificado. Uma tentativa histórica no worktree falhou pelo mismatch `@esbuild/win32-x64`; PHP runtime está bloqueado pelo comando/causa exatos acima.
4. Revisão dos artefatos e fixtures não encontrou segredos ou identificadores operacionais desnecessários.
5. Cada lacuna externa tem status **Not confirmed**, cenário afetado e gate antes do cutover dependente. A ausência de inventário operacional completo não impede esta descoberta versionada, mas impede alegações de paridade e o corte correspondente.

Resultado: baseline versionada inventariada e build/testes Angular aprovados. **Paridade operacional não confirmada; este relatório não autoriza migração, deploy ou corte do PHP.**
