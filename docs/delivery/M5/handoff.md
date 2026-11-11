# Handoff — M5

## Posição verificada

- Objetivo: concluir M5 e entregar PR consolidado para revisão/aceite; não fazer merge desse PR em `develop` nem fechar issues antes da autorização final.
- `develop`/`origin/develop` inicial: `c3e9baa75ea793d74292e62038e0d8d11bb61295`.
- `desktop/milestone-m5` foi criada/publicada a partir desse SHA.
- M3 PR #127 e M4 PR #151 estão realmente merged; M4 #151 merge commit = SHA inicial M5. Cross-milestone prerequisites foram verificadas fechadas. M4.14/#57 ainda tem gates externos Not confirmed.

## Escritores e worktrees

| Pacote | Branch | Worktree | Estado inicial |
|---|---|---|---|
| M5.01 / #43 | `desktop/m5-01` | `C:\Users\user\.codex\worktrees\m5-01-portal\ca_meta_app` | SHA base `389317a99932050112a31d002da565431003a943`; implementador executa follow-up de cookie stale no POST magic-link (sem enfraquecer Origin/Fetch Metadata) e remoção do `tenantRef` bruto do rótulo da empresa. Não rebasear sobre #62 até o integrador autorizar após gate. |
| M5.07 / #62 | `desktop/m5-07` | `C:\Users\user\.codex\worktrees\m5-07-service-bridge\ca_meta_app` | PR #152 em `9314a002707d29e98dd343b9cb8775fa5a7edcce`; reviews funcional/security PASS. Build API, compile TS, middleware/migration 16/16, harness M5.07 32/32 e harness M2.03/MariaDB 11.8.8 PASS no SHA atual; migrações 1–21 e backup/restore verificados. GitHub Actions foi bloqueado antes do runner por billing/spending limit; não squash. A rota v2 ainda requer aceite final; consumers PHP permanecem `NOT_MIGRATED`. |

Os dois branches começaram em `c3e9baa`. Um escritor por worktree. O coordenador é o único responsável por push/PR/CI/squash e commits na integração. Junctions `node_modules` reutilizam o install do checkout base, com symlinks `@ca-meta/*` direcionados a cada worktree.

## Ambiente

- Host Windows/PowerShell; Node global v22.17.0/npm 10.9.2 não satisfazem o pin.
- Node 24.22.2 e npm 11.19.1 estão no cache npm local do host; executar os checks com esses binários e registrar versões.
- O harness M2.03 requer `node.exe` e `npm.cmd` no mesmo diretório; a execução local usou o runtime temporário `C:\Users\user\AppData\Local\Temp\ca-meta-m5-node-runtime-20261111`, com Node 24.22.2 e shim npm 11.19.1.
- `npm ci --ignore-scripts` já passou no checkout base uma vez; 674 pacotes instalados, 47 advisories reportados. Não repetir em cada worktree sem necessidade.
- Docker Desktop foi iniciado para esta tarefa. MariaDB 11.8.8 descartável está saudável em porta local `127.0.0.1:13307`; container e volume são os identificados no progresso. Não remover antes do pacote final que precisar de teste integrado.
- `gh` CLI não está instalado; usar o conector GitHub e Git SSH. GitHub profile `eduardomatuella-costaapps`, permissão `admin`; Project #12 e proteção/ruleset não são visíveis pelo conector.

## Etapa e próxima ação

- Onda 1: PR #152 aberto, mas CI do SHA `9314a00` não iniciou jobs por bloqueio de billing/spending limit da conta GitHub Actions. Localmente passaram build/API, 16 testes focados e harness M2.03 completo com MariaDB 11.8.8 e backup/restore 1–21. Não integrar enquanto checks/proteções estiverem bloqueados.
- Próximo: receber follow-up M5.01, validar e abrir PR; preparar integração depois que #152 puder passar nos gates. Manter #62 aberta/parcial, com aceite v2 e migração dos callers reais pendentes.
- Onda 2: implementar M5.02 sobre M5.01 estabilizada. O recon identificou ausência de labels de asset/filtro server-side `flowVariant` e adapter de refresh; respeitar UNKNOWN/stale, requestId apenas para suporte e nunca mostrar `tenantRef` como nome da empresa.
- Continuar pelas waves do prompt em frentes independentes; não fechar issues. Atualizar comentários/status sem alegar rollout real.
- Antes de qualquer interrupção futura, atualizar este handoff, estados e checks observados.

