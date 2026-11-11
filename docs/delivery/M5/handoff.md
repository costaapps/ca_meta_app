# Handoff — M5

## Posição verificada

- Objetivo: concluir M5 e entregar PR consolidado para revisão/aceite; não fazer merge desse PR em `develop` nem fechar issues antes da autorização final.
- `develop`/`origin/develop` inicial: `c3e9baa75ea793d74292e62038e0d8d11bb61295`.
- `desktop/milestone-m5` foi criada/publicada a partir desse SHA.
- M3 PR #127 e M4 PR #151 estão realmente merged; M4 #151 merge commit = SHA inicial M5. Cross-milestone prerequisites foram verificadas fechadas. M4.14/#57 ainda tem gates externos Not confirmed.

## Escritores e worktrees

| Pacote | Branch | Worktree | Estado inicial |
|---|---|---|---|
| M5.01 / #43 | `desktop/m5-01` | `C:\Users\user\.codex\worktrees\m5-01-portal\ca_meta_app` | Candidate `0f65c512959f93d97924a850764f50640a10f5d9`; funcional review encontrou blocker M1.08: sem label segura de empresa, warning exato, switcher oculto e todas as mutações tenant-scoped bloqueadas. Implementador está centralizando o gate e adicionando specs focadas. Preservar o fix anterior de magic-link com cookie stale e as proteções Origin/Fetch Metadata. |
| M5.02 / #56 | `desktop/m5-02` | `C:\Users\user\.codex\worktrees\m5-02-connections\ca_meta_app` | Implementação ativa a partir de `f6bf73e`; lista/detail, filtros server-side e safe labels. Manter somente leitura até identidade empresarial confirmada e alinhar a barreira M1.08 final de M5.01 antes da PR. |
| M5.03 / #60 | `desktop/m5-03` | `C:\Users\user\.codex\worktrees\m5-03-onboarding\ca_meta_app` | Implementação inicial baseada em recon do onboarding API; reserva novos arquivos `core/onboarding/**` e `features/portal/onboarding/**`, sem tocar nos arquivos M5.01/.02. Worktree partiu de `83d5485`; rota/detail serão conectados após dependências. |
| M5.07 / #62 | `desktop/m5-07` | `C:\Users\user\.codex\worktrees\m5-07-service-bridge\ca_meta_app` | PR #152 em `9314a002707d29e98dd343b9cb8775fa5a7edcce`; reviews funcional/security PASS. Build API, compile TS, middleware/migration 16/16, harness M5.07 32/32 e harness M2.03/MariaDB 11.8.8 PASS no SHA atual; migrações 1–21 e backup/restore verificados. GitHub Actions foi bloqueado antes do runner por billing/spending limit; não squash. A rota v2 ainda requer aceite final; consumers PHP permanecem `NOT_MIGRATED`. |

M5.01 e M5.07 começaram em `c3e9baa`; M5.02 foi criada a partir do candidato M5.01 `f6bf73e`. Um escritor por worktree. O coordenador é o único responsável por push/PR/CI/squash e commits na integração. Junctions `node_modules` reutilizam o install do checkout base, com symlinks `@ca-meta/*` direcionados a cada worktree.

## Ambiente

- Host Windows/PowerShell; Node global v22.17.0/npm 10.9.2 não satisfazem o pin.
- Node 24.22.2 e npm 11.19.1 estão no cache npm local do host; executar os checks com esses binários e registrar versões.
- O harness M2.03 requer `node.exe` e `npm.cmd` no mesmo diretório; a execução local usou o runtime temporário `C:\Users\user\AppData\Local\Temp\ca-meta-m5-node-runtime-20261111`, com Node 24.22.2 e shim npm 11.19.1.
- `npm ci --ignore-scripts` já passou no checkout base uma vez; 674 pacotes instalados, 47 advisories reportados. Não repetir em cada worktree sem necessidade.
- Docker Desktop foi iniciado para esta tarefa. MariaDB 11.8.8 descartável está saudável em porta local `127.0.0.1:13307`; container e volume são os identificados no progresso. Não remover antes do pacote final que precisar de teste integrado.
- `gh` CLI não está instalado; usar o conector GitHub e Git SSH. GitHub profile `eduardomatuella-costaapps`, permissão `admin`; Project #12 e proteção/ruleset não são visíveis pelo conector.

## Etapa e próxima ação

- Onda 1: PR #152 aberto, mas CI do SHA `9314a00` não iniciou jobs por bloqueio de billing/spending limit da conta GitHub Actions. Localmente passaram build/API, 16 testes focados e harness M2.03 completo com MariaDB 11.8.8 e backup/restore 1–21. Não integrar enquanto checks/proteções estiverem bloqueados.
- Próximo: concluir follow-up M5.01, validar com revisão funcional/security e abrir PR. A M1.08 bloqueia mutações tenant-scoped enquanto não houver `tenantDisplayName` seguro ou host autenticado confirmado; manter leituras e magic-link público.
- Onda 2: M5.02 está em implementação contra a API existente, com labels seguras e filtro server-side. Refresh sem adapter deve mostrar indisponibilidade; respeitar UNKNOWN/stale e nunca mostrar `tenantRef` como nome da empresa.
- Onda 3: M5.03 está fazendo trabalho independente contra os contratos M3.05/M4.14, sem integrar mudanças de M5.01/.02 ainda. O recon observou que não há endpoint de cancelamento de sessão de onboarding nem listagem de sessões ativas; a retomada desta aba usará refs opacas em `sessionStorage` e somente `GET` após reload. Rotas serão conectadas após integração das dependências.
- Continuar pelas waves do prompt em frentes independentes; não fechar issues. Atualizar comentários/status sem alegar rollout real.
- Antes de qualquer interrupção futura, atualizar este handoff, estados e checks observados.

