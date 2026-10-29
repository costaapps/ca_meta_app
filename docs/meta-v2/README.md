# Meta Platform v2 · plano de implantação

Planejamento do `costaapps/ca_meta_app`, preparado em 28/10/2026 a partir de `develop@7062247a15d15b1b1a5213353517bdc1596a1d38`. A referência é o código dessa revisão, não as afirmações históricas dos documentos. O programa contempla construção e transição completa; sua publicação não significa implementação ou migração concluídas.

O resultado desejado é um portal recorrente de gerenciamento de conexões Meta para clientes do Msg4/Suite4: quatro fluxos, acesso sem senha adicional, status por recurso, credenciais corretas por operação, automação do onboarding, API independente e operação por containers com SDD, CI/CD e recuperação.

## Navegação

| Documento | Perguntas respondidas |
|---|---|
| [01 · Baseline e evidências](01-baseline-evidence.md) | O que existe? O que está comprovado? Onde os documentos divergem? |
| [02 · Arquitetura e ADRs](02-architecture-and-adrs.md) | Quais limites, stack, módulos e decisões orientam a construção? |
| [03 · Dados e credenciais](03-domain-data-and-credentials.md) | Como autorizações, tokens, números, contas e empresas se relacionam? |
| [04 · Identidade, API e segurança](04-identity-api-and-security.md) | Como entrar, autorizar ações e proteger callbacks/segredos? |
| [05 · Quatro fluxos Meta](05-meta-flows-and-webhooks.md) | Como cada login conclui, assina eventos e recupera falhas? |
| [06 · Entrega e migração](06-delivery-migration-and-operations.md) | Como desenvolver, empacotar, publicar, migrar, operar e voltar? |
| [M1.09 · SLO](m1-09/nfr.md), [carga](m1-09/workload-model.csv), [capacidade](m1-09/capacity-model.csv), [controles operacionais](m1-09/capacity-controls.md), [retenção](m1-09/retention-policy.md), [transição/tabletop](m1-09/transition-strategy.md), [budget](m1-09/cost-budget.csv), [riscos](m1-09/risk-register.md) | Quais hipóteses operacionais observar, dimensionar cenários sintéticos, definir gates de custo, reter dados e transicionar com um writer? |
| [07 · Aceite e governança](07-acceptance-risk-and-governance.md) | Qual sequência, responsáveis funcionais, riscos e provas de 100%? |
| [08 · Project e provisionamento](08-project-configuration.md) | Como organizar campos, visões, issues, hierarquia e dependências? |
| [Catálogo navegável](work-packages.md) | Onde está cada um dos 66 pacotes e seu vínculo no GitHub? |
| [OpenAPI 3.1 canônico](contracts/openapi.yaml), [eventos inbox/outbox](contracts/events/) e [catálogo seguro de erros](contracts/error-catalog.md) | Qual contrato M1.07 deve orientar consumidores e validações? |
| [Matriz de compatibilidade](contracts/compatibility.md) | Como cada linha da baseline mapeia para uma operação proposta ou uma exceção explícita? |
| [Formatos e validadores](contracts/standards.md) | Quais formatos e fontes primárias sustentam os arquivos de contrato? |
| [JSON OpenAPI legado](contracts/openapi.proposed.json) e [evento genérico legado](contracts/internal-event.proposed.schema.json) | Artefatos históricos do planejador; não são fonte de verdade para consumidores M1.07. |
| [Matriz de aceite](acceptance-matrix.csv) | Quais 330 critérios ligam requisitos, issues e validações planejadas? |
| [Especificações de feature](specs/README.md), [playbook SDD](sdd-playbook.md), [ADR template](adr-template.md), [issue template](../../.github/ISSUE_TEMPLATE/work-package.md) e [PR template](../../.github/PULL_REQUEST_TEMPLATE.md) | Como manter estado, Ready/Done, segurança, bloqueios e decisões verificáveis? |
| [Rastreabilidade executável](traceability.csv), [responsabilidade funcional](responsibility-matrix.csv) e [validator M1.10](../../tools/m1-10/README.md) | Como verificar dependências, artefatos, PRs de milestone e gates de release sem escrever nos geradores `.planning`? |

## Etapas de implantação

| Milestone | Pacotes | Entrega ao atingir 100% |
|---|---:|---|
| [M1](https://github.com/costaapps/ca_meta_app/milestone/1) | 10 | Evidências, identidade, domínio, contratos, jornadas e SDD ratificados |
| [M2](https://github.com/costaapps/ca_meta_app/milestone/2) | 10 | Monorepo, API/worker, migrations, imagens, Compose, CI/release e staging |
| [M3](https://github.com/costaapps/ca_meta_app/milestone/3) | 12 | Sessões/tenants, cofre, grants, resolver e ciclo de credenciais |
| [M4](https://github.com/costaapps/ca_meta_app/milestone/4) | 14 | Quatro fluxos, inscrições, webhooks e reconciliação certificados |
| [M5](https://github.com/costaapps/ca_meta_app/milestone/5) | 10 | Portal, paridade, consumidores Msg4, projeções e piloto |
| [M6](https://github.com/costaapps/ca_meta_app/milestone/6) | 10 | Homologação, release, canário, estabilidade e retirada do legado |

Há 66 pacotes, seis epics de gate e uma issue índice. Os pacotes contêm passos de construção, contratos/entregáveis, cinco critérios de aceite específicos, validações planejadas, risco/recuperação e links para os arquivos da baseline. O grafo de dependências permite preparar trabalho independente antes do encerramento de uma milestone; uma etapa não deve ser considerada concluída por porcentagem de issues sem atender seu gate.

## Limites e decisões

- Preservar Angular e comportamento/layout útil. A API proposta é NestJS, separada da web; TypeScript compartilhado não significa compartilhar segredo ou modelo de banco com o navegador.
- WhatsApp exclusivo e Coexistence são fluxos distintos. Cada número Coexistence tem onboarding próprio; token pertence à autorização e pode conceder acesso a vários ativos.
- A sessão do portal identifica pessoa/empresa autorizada. UUID é identificador; não é credencial, mesmo que seja difícil de adivinhar.
- Segredos permanecem no backend. Msg4 usa operações de serviço autorizadas e bancos empresariais recebem projeções operacionais, com exceções transitórias explícitas se necessárias.
- Automação cobre os efeitos que a API permite: troca de código, descoberta verificada, persistência, subscription, sincronização e recuperação. Consentimento, QR, elegibilidade e App Review permanecem externos.
- Preservar templates, respostas e notificações. Não transportar sucesso falso, escopo frágil ou token global como compatibilidade permanente.
- Não excluir ativos Meta, mudar produção, revogar credenciais ou desligar Hostinger durante a etapa de planejamento.

## Como começar a execução

1. Abrir a issue índice e a epic M1; conferir a onda/estado da issue em `traceability.csv` e a dependência atual antes de escolher trabalho.
2. Reusar o inventário sanitizado e o contrato de identidade propostos; solicitar evidência operacional de PHP/rewrite, DDL e Suite4 somente para os cenários que dependem dela.
3. Confirmar em fonte primária e Sandbox as versões/permissões de cada fluxo. Conteúdo Meta inacessível ou retornando 429 continua sem validação; siga seu gate específico sem bloquear trabalho independente.
4. Manter contratos e ADRs na fonte canônica; designar função responsável, não nomes ou datas sem acordo real.
5. Construir em fatias revisáveis, mantendo um escritor por função durante a transição e evidências por critério de aceite.

## O que está entregue neste planejamento

Documentação aprofundada, backlog detalhado, milestones nativas e catálogo de dependências. Scripts de manutenção do plano ficam em `.planning/`: renderização determinística, validação, sincronização de relações e provisionamento do Project quando houver autenticação organizacional apropriada. O estado efetivamente publicado e os runs de verificação são registrados na issue índice e no documento 08.

Issues de implantação ficam abertas enquanto aceitas apenas na branch de milestone; fechar exige integração final verificada e aceite humano. O estado por pacote está na matriz de rastreabilidade e deve ser relido contra o GitHub antes de atualizar. Não foram criados prazos, assignees, aprovações Meta ou promessas de capacidade sem evidência. Pontos relativos iniciais servem para refinar estimativas; não equivalem a dias de trabalho.
