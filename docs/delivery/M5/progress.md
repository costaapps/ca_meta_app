# M5 — progresso da execução Desktop

## Base e ambiente

- Base verificada: `develop@c3e9baa75ea793d74292e62038e0d8d11bb61295`, igual a `origin/develop` em 2026-11-11.
- PR consolidado M4 #151 está `closed/merged` no GitHub; merge commit `c3e9baa75ea793d74292e62038e0d8d11bb61295`.
- Branch de integração `desktop/milestone-m5` foi criada e publicada a partir dessa base. Não existe PR consolidado M5 ainda.
- Identidade Git local: `Eduardo Matuella <eduardo.matuella@costaapps.com.br>`. GitHub connector autenticado como `eduardomatuella-costaapps`, permissão `admin`; `gh` CLI ausente.
- Node/npm global inicialmente eram v22.17.0/10.9.2. Ambiente M5 preparado com Node v24.22.2/npm 11.19.1 isolados no cache; `npm ci --ignore-scripts` executado uma vez no checkout base (674 pacotes, 47 advisories reportados; sem auto-fix). Worktrees de implementação reutilizam as dependências sem repetir instalação.
- Docker Desktop 28.3.0/Compose 2.38.1 foi iniciado. MariaDB 11.8.8 sintético e descartável está saudável em `127.0.0.1:13307`, container `ca-meta-m5-db-20261111`, volume `ca_meta_m5_data_20261111`. Nenhuma validação de produto foi executada até agora.
- GitHub Projects API #12 e branch protection/rulesets não estão acessíveis pelo conector; campos, opções e checks obrigatórios são **Not confirmed**. Não afirmar atualização do Project.

## Tabela de pacotes

| Pacote / issue | Etapa atual | Candidato | Última evidência | PR | Próxima ação |
|---|---|---|---|---|---|
| M5.01 / #43 | follow-up em implementação | `389317a99932050112a31d002da565431003a943` + working changes | Review funcional independente PASS no candidato anterior. O implementador está corrigindo cookie stale em POST público de magic-link com Origin/Fetch Metadata preservados e retirando `tenantRef` bruto do rótulo de empresa conforme M1.08. Testes anteriores no candidato: coordenador detached 5/5; typecheck/catalog pass. Walkthrough browser segue não concluído: helper CUA não confirmou URL do Opera; não repetido. | não criado | receber follow-up, rebasear na base M5 atual quando #62 puder integrar, validar só arquivos afetados e abrir PR |
| M5.02 / #56 | recon concluída; aguardando M5.01 | — | O catálogo tenant-scoped existe em `/connections`, `/assets`, detail e refresh, mas o portal não o usa. API ainda não fornece rótulo humano seguro do asset nem filtro `flowVariant`; refresh está sem adapter e deve mostrar indisponibilidade. `/session` só tem `tenantRef`, que não pode ser rotulado como nome da empresa. | não criado | implementar lista/detail/status usando a API, adicionar as extensões server-side necessárias e preservar limites/UNKNOWN/stale; iniciar depois de estabilizar M5.01 |
| M5.03 / #60 | aguardando M5.01/#56 | — | sem execução | não criado | iniciar após M5.02 integrado |
| M5.04 / #58 | aguardando M5.02 | — | sem execução | não criado | iniciar após M5.02 integrado |
| M5.05 / #59 | aguardando M5.02 | — | sem execução | não criado | iniciar após M5.02 integrado |
| M5.06 / #61 | aguardando M5.04/#59 | — | sem execução | não criado | iniciar após M5.04 e M5.05 integrados |
| M5.07 / #62 | PR #152 aberto; integração aguardando CI externo | `9314a002707d29e98dd343b9cb8775fa5a7edcce` | v1 preservado; bridge tipada publicada em v2 com ADR-021. Re-review funcional e de segurança no SHA atual PASS; bypass de Origin limitado ao POST exato, com casos negativos. Local no SHA atual: API build/TS de testes e 16/16 focados; M2.03 full API + MariaDB 11.8.8 PASS, 21 migrations com checksums, backup/restore 10.005 assets/UTF-8/DATETIME(6). CI em 987c passou desktop-candidate, imagens, segurança, M1.07, planning e orchestrator; MariaDB revelou expectativas antigas de v20 corrigidas em 9314. Workflows 9314 não iniciaram porque GitHub reportou falha de billing/spending limit; sem bypass. O harness M5.07 32/32 e shape 12 colunas/5 índices foram validados em SHAs anteriores, migration SQL não mudou. Advisories P2 seguem; rota v2 aguarda aceite final. PHP consumers seguem NOT_MIGRATED, issue continua aberta/parcial. | [#152](https://github.com/costaapps/ca_meta_app/pull/152) | manter aberto; não squash até checks/proteções reais liberarem; seguir M5.01 e demais frentes independentes |
| M5.08 / #63 | aguardando M5.05/#62 | — | sem execução | não criado | iniciar após M5.05 e M5.07 integrados |
| M5.09 / #64 | aguardando M5.04–.08 | — | sem execução; migração real/piloto requer gate autorizado | não criado | construir e exercitar dry-run/shadow sintético; preservar gate real |
| M5.10 / #65 | aguardando M5.02/.03/.08 | — | sem execução | não criado | iniciar após dependências integradas |

## Limitações externas confirmadas

- M4.14/#57 está fechada no tracker, mas o handoff M4 registra 28/28 cenários `PARTIAL_LOCAL` e nenhuma certificação de fluxo completo. Grants, elegibilidade, Sandbox, app review e comportamento real do provedor permanecem **Not confirmed**.
- Código de consumidores Msg4/rotina `GeneralSettings` em operação não está disponível nesta árvore; `backend/connect.php` e `backend/connect_old.php` são referências locais sensíveis e permanecem intocados.
- Não foram usados contas/ativos Meta reais, credenciais reais, dados de cliente, envios, mudanças de subscription ou produção.
- Walkthrough visual/teclado M5.01 não foi concluído: o helper de Computer Use encerrou a sessão porque não conseguiu confirmar com segurança a URL atual da janela Opera. Não repetir a automação nessa sessão; build e testes não substituem a evidência visual/acessibilidade.
- Os checks da Actions no SHA `9314a00` foram marcados como falha antes de iniciar qualquer job: a anotação do GitHub diz que pagamentos recentes falharam ou que o limite de gastos precisa ser aumentado. É um gate externo; a execução local de build, suíte e MariaDB passou, mas não substitui as proteções do PR.

