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
| M5.01 / #43 | correção de review | `6eaad93a94b3e79fb8f46726a946e4d627599586` | Review funcional independente FAIL: parser rejeita campos públicos opcionais do perfil M4; magic-link pode falhar com cookie HttpOnly expirado; pré-requisitos têm texto genérico e retorno pode consumir tentativa não aceita. Implementador está corrigindo parser/reasons/retorno/same-origin em uma rodada. Após integrar #62, ainda exige correção middleware de cookie stale. Walkthrough browser não concluído: helper CUA bloqueou ao não confirmar URL do Opera; não repetido. | não criado | obter novo SHA, validar uma vez e revisar; integrar #62 antes da correção middleware; então PR |
| M5.02 / #56 | aguardando M5.01 | — | análise de leitura: catálogo M3.12/M4.12 já tem `/connections`, `/assets` e refresh tenant-scoped; ainda não usa o novo portal | não criado | criar worktree após squash de M5.01 |
| M5.03 / #60 | aguardando M5.01/#56 | — | sem execução | não criado | iniciar após M5.02 integrado |
| M5.04 / #58 | aguardando M5.02 | — | sem execução | não criado | iniciar após M5.02 integrado |
| M5.05 / #59 | aguardando M5.02 | — | sem execução | não criado | iniciar após M5.02 integrado |
| M5.06 / #61 | aguardando M5.04/#59 | — | sem execução | não criado | iniciar após M5.04 e M5.05 integrados |
| M5.07 / #62 | correção de review | `9d9218a0e12861c050469df706cc8cad15fa9d9d` | Harness focado exato 20/20, API typecheck PASS, geração de contratos 12 artifacts PASS, OpenAPI lint exit 0 com 4 warnings preexistentes. Review funcional independente FAIL: M1.07 teste/gerador de compatibilidade não acompanha novo contrato; replay com mesma chave depende indevidamente de capability/adapter/resolver disponível. Revisão também encontrou schema de idioma divergente, falta de matriz sintética de 4 pares flow/auth e equivalência por consumidor. Schema 21 ainda precisa ser aplicado em MariaDB descartável. Correção concentrada em andamento. Consumidores operacionais/deployed e gates Meta/Suite4 seguem Not confirmed. | não criado | fechar bloqueios, validar API+M1.07+DB no SHA novo uma vez, revisão; depois PR |
| M5.08 / #63 | aguardando M5.05/#62 | — | sem execução | não criado | iniciar após M5.05 e M5.07 integrados |
| M5.09 / #64 | aguardando M5.04–.08 | — | sem execução; migração real/piloto requer gate autorizado | não criado | construir e exercitar dry-run/shadow sintético; preservar gate real |
| M5.10 / #65 | aguardando M5.02/.03/.08 | — | sem execução | não criado | iniciar após dependências integradas |

## Limitações externas confirmadas

- M4.14/#57 está fechada no tracker, mas o handoff M4 registra 28/28 cenários `PARTIAL_LOCAL` e nenhuma certificação de fluxo completo. Grants, elegibilidade, Sandbox, app review e comportamento real do provedor permanecem **Not confirmed**.
- Código de consumidores Msg4/rotina `GeneralSettings` em operação não está disponível nesta árvore; `backend/connect.php` e `backend/connect_old.php` são referências locais sensíveis e permanecem intocados.
- Não foram usados contas/ativos Meta reais, credenciais reais, dados de cliente, envios, mudanças de subscription ou produção.
- Walkthrough visual/teclado M5.01 não foi concluído: o helper de Computer Use encerrou a sessão porque não conseguiu confirmar com segurança a URL atual da janela Opera. Não repetir a automação nessa sessão; build e testes não substituem a evidência visual/acessibilidade.

