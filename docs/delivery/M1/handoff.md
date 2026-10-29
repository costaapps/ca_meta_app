# M1 — handoff de execução

## Meta e base

Escopo atualizado pelo usuário: executar M1 e depois M2–M6 em ordem, lendo `docs/codex-desktop/prompts/M{N}.md`, preparando o ambiente e usando subagentes nativos para cada milestone; entregar um PR consolidado para `develop` e aguardar aceite antes do merge de cada uma. Não fazer merge nem fechar issues antes da autorização/aceite humano e verificação da integração. Respeitar dependências reais antes de implementar a milestone seguinte.

- Regra fundamental M1–M6 (também em `docs/codex-desktop/execution-contract.md` e `progress-and-handoff.md`): somente uma mensagem explícita de erro por limite de tokens excedido inicia timer de 45 minutos. Salvar handoff, preservar commits/arquivos, retomar a etapa exata e tentar novamente; repetir só os gates afetados. Não iniciar o timer para erro genérico, compactação, timeout ou rate limit com intervalo próprio.

- `develop` confirmado em `733e4a6dcccc93ee58a24958ed9830bfcc878e62` no início; `origin/develop` apontava ao mesmo SHA.
- Branch remota/local `desktop/milestone-m1`, baseada em `733e4a6d...`, recebeu os dez pacotes M1 por squash; o último é M1.10, commit `ddb92588855f5128f6a173291c581a547e7b5317`. A integração local foi fast-forwardada ao SHA remoto. O PR consolidado para `develop` ainda precisa ser preparado e validado.
- Worktree principal: `C:\Users\user\.codex\worktrees\m1-milestone\ca_meta_app`.
- Branch/worktree package #10: `desktop/m1-01` / `C:\Users\user\.codex\worktrees\m1-01\ca_meta_app`, base `733e4a6`, candidate `aa2639a7cece2233aee36939fd75bc5259ff505d`. Implementação entregue e commitada pelo principal; revisão/validação continuam em worktrees isolados. Não alterar o candidato salvo para corrigir um finding.

## Pacotes e dependências

Onda 1: M1.01/#10. Onda 2: M1.02/#11 e M1.03/#12. Onda 3: M1.04/#13. Onda 4: M1.05/#14. Onda 5: M1.06/#15 e M1.09/#16. Onda 6: M1.07/#17. Onda 7: M1.08/#18. Onda 8: M1.10/#19. Confirmar as dependências atuais de cada issue antes de delegar.

## Checks já executados na base

No worktree isolado de #10, antes da implementação:
- `npm ci`: sucesso; 505 pacotes, 46 alertas de auditoria.
- `npm run build`: sucesso.
- `npm test -- --watch=false`: 2 arquivos e 5 testes passaram.
- `php -l` nos quatro PHP versionados: sem erro de sintaxe.
- Ambiente: Windows 10 x64, PowerShell 7.6.5, Node 22.17.0, npm 10.9.2, PHP 8.3.30, Angular 21.0.8.

## Ambiente externo e recursos locais

- GitHub via conector está autenticado como a identidade da conta usuária e tem permissão push. `gh` CLI ausente; não bloquear.
- Docker Engine 28.3.0 e Compose 2.38.1 funcionam. Imagens MariaDB 11.8.x e Redis 8 já estão em cache. Nenhum container da milestone está ativo; os projetos Compose UUID de M1.04/M1.05 foram removidos. Um MariaDB antigo parado foi deixado intacto.
- Nenhum volume/network/processo da PoC permanece e os bancos não publicam porta no host. Para novos ensaios, usar projeto Compose exclusivo, credenciais sintéticas, healthcheck e cleanup restrito aos recursos do próprio projeto.
- A API Projects v2 do GitHub não aparece nas ferramentas instaladas; usar tabela e comentários de issue, sem afirmar atualização de Project #12.
- Meta developer docs retornaram 429 em 2026-10-28; usar fontes oficiais alternativas e deixar grants/eligibilidade atuais como Not confirmed.

## Próximas ações exatas

1. Os PRs de pacote #84–#93 foram integrados por squash à `desktop/milestone-m1`. O último squash é M1.10 em `ddb92588855f5128f6a173291c581a547e7b5317`; issues #10–#19 continuam abertas até aceite final em develop.
2. M1.04/#13 PR #87 está integrado em `5b11671f431fe75030c63c7a5ba52d36fcb95fa0`, checks `success`, reviews funcional/segurança PASS e PoC exata validada; detalhes no progresso. Issue #13 permanece aberta até aceite humano.
3. M1.05/#14 PR #88 está squash-integrado; candidato `3ee2eafb67c2e4b0a5b2528021a564a223b1fc38`, commit integrado `8d18d6c389d0411397fc3ee8c5b68e5a4499b398`. Checks/reviews e validator 13/13 passaram no candidato exato. Limites: a consulta comprova associação, não elegibilidade operacional; grants reais, política de writer e retenção permanecem gates.
4. M1.06/#15 integrado por squash via PR [#90](https://github.com/costaapps/ca_meta_app/pull/90): candidato `2078e2b482a11cfcb16332b9dadd95d87985c69c`, commit remoto/local `88a8eaaa04ff8853edbf46378cad54ec0d57f532`; branch base de PR `desktop/milestone-m1` estava em `69cdc9f`. Checks baseline/plan/orchestrator/desktop-candidate success, `structure` skipped, annotations só notice `ubuntu-latest`; validator + functional/security PASS no SHA exato. Issue #15 comentada e permanece aberta até aceite final. Continuam Not confirmed: Suite4 real, browser/iframe/cookie, email e rate limits.
5. M1.09/#16 integrado: PR [#89](https://github.com/costaapps/ca_meta_app/pull/89), candidato `432397eed0f78516f3925ff095adb02aef474ab4`, squash remoto/local `69cdc9f13612f0d12429c08077549c93dfdee592`. Validação detached, reviews funcional/segurança PASS; checks baseline/plan/orchestrator/desktop-candidate success, `structure` skipped. Annotations examinadas: apenas notice de migração futura de `ubuntu-latest`. Issue #16 recebeu comentário e permanece aberta até aceite final em develop. Nova base remota/local `desktop/milestone-m1` = `69cdc9f`. SLI reauth p95 ≤120s rolling 15m callback→projeção versionada confirmada; espera pré-callback usuário/Meta UNBOUNDED/Not confirmed; carga pré-produção. Valores reais de tráfego, custo/owner, quotas, termos, infra e retenção legal seguem Not confirmed.
6. M1.07/#17: PR [#91](https://github.com/costaapps/ca_meta_app/pull/91) merged by squash into `desktop/milestone-m1`; candidate `fef8d4eb7961299a042be34428ac1dffe5ffd0d9`, base `88a8eaaa04ff8853edbf46378cad54ec0d57f532`, squash `083f918deefc3b783da7076d46f3647473889234`. Remote metadata confirms merged; branch fetched and fast-forwarded locally to the same SHA. Checks `orchestrator`, `M1.07 API contract`, `baseline`, `plan`, `desktop-candidate` success; `structure` skipped. Functional/security review and detached validator PASS on exact candidate; no pending review threads. Issue #17 remains open pending final M1 acceptance in develop. Behavior of PHP/deployment, Meta/Suite4/grants, provider idempotency, cookies/ingress and production remain Not confirmed.
7. M1.08/#18 integrated by squash PR #92; candidate 06435a25e3d1c256ec8992fe032debaa68d227fe; base 083f918deefc3b783da7076d46f3647473889234; squash 22c43ed8e2d1ca375ccad2a69d840ba1c5807039 verified remote and local. Walkthrough and detached validator 31/31; CSV 47/19 aligned, links/diff/secret scan PASS; functional/security review PASS exact SHA. Checks orchestrator/baseline/plan/desktop-candidate success, structure skipped; notices only ubuntu-latest migration. Issue #18 commented, remains open pending M1 acceptance. No browser/reader, Suite4/Meta/provider runtime or WCAG certification. See PR https://github.com/costaapps/ca_meta_app/pull/92.
8. M1.10/#19: package PR [#93](https://github.com/costaapps/ca_meta_app/pull/93) foi integrado por squash em `desktop/milestone-m1`; candidato `b344f707671216eb6185cc9a0de50b693f28c069`, squash `ddb92588855f5128f6a173291c581a547e7b5317`. Validação detached: 17/17 testes; checker PASS (66 pacotes, 330 critérios, 7 specs, 19 Markdown); traceability atual; diff-check PASS. Revisões funcional e segurança PASS no SHA exato. Checks baseline/plan/desktop-candidate/orchestrator success, structure skipped; annotations somente notice de migração `ubuntu-latest`. P2 de guardrails e dois P2 do checker foram corrigidos e revalidados. A regra fundamental de tokens exige erro explícito, espera 45 minutos e repetição da etapa após salvar handoff. Issue #19 permanece aberta até aceite final; release segue NOT_RELEASED.
9. PR consolidado [#94](https://github.com/costaapps/ca_meta_app/pull/94) está aberto em draft de `desktop/milestone-m1` para `develop`, com a tabela das dez issues e limitações. Revalidar o head após qualquer alteração, aguardar reviews/checks, então deixar pronto para aceite humano. Não fazer merge nem fechar issues #10–#19 antes do aceite explícito.
