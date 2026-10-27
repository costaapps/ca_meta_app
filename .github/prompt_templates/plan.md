# Separação dos fluxos Meta
## 1. Resumo do que será alterado
- Nenhuma alteração foi aplicada ainda nesta iteração; este é o plano validado com a base atual.
- A refatoração vai sair de um “login Meta único” para 3 jornadas explícitas: WhatsApp Embedded Signup, Facebook e Instagram.
- O foco desta fase é preparar a arquitetura, os contratos e a UI para independência real entre fluxos, sem completar toda a regra de negócio final.

## 2. Arquitetura nova dos fluxos
- Introduzir tipos explícitos de domínio, como `MetaProductType` e um estado de fluxo por produto, para parar de usar um único estado OAuth compartilhado.
- Separar a camada de integração em responsabilidades menores: início de conexão/callback por produto, gestão de canais conectados e templates de WhatsApp.
- Manter `MetaIntegrationService` apenas como fachada de compatibilidade, se necessário, enquanto os consumidores migram para serviços focados.
- Reestruturar a setup page para exibir 3 cards independentes, cada um com CTA próprio, mensagem de sucesso/erro própria e callback tratado por produto.
- Tratar WhatsApp como jornada própria de Embedded Signup, sem depender do fluxo Facebook.
- Tratar Facebook e Instagram como jornadas separadas, mesmo que parte da persistência ou dos helpers de backend ainda possa ser compartilhada.

## 3. Arquivos previstos para alterar/criar
- Frontend base: [src/app/app.routes.ts](C:/VsCodeRepos/msg4_Meta_Application/src/app/app.routes.ts), [src/app/core/services/meta-integration.service.ts](C:/VsCodeRepos/msg4_Meta_Application/src/app/core/services/meta-integration.service.ts) e novos modelos em `src/app/core/models/*`.
- Setup UI: [src/app/features/channels/pages/channel-setup/channel-setup.component.ts](C:/VsCodeRepos/msg4_Meta_Application/src/app/features/channels/pages/channel-setup/channel-setup.component.ts), [src/app/features/channels/pages/channel-setup/channel-setup.component.html](C:/VsCodeRepos/msg4_Meta_Application/src/app/features/channels/pages/channel-setup/channel-setup.component.html), [src/app/features/channels/pages/channel-setup/channel-setup.component.scss](C:/VsCodeRepos/msg4_Meta_Application/src/app/features/channels/pages/channel-setup/channel-setup.component.scss).
- Backend local-only: renomear o atual `backend/connect.php` para um arquivo dedicado ao WhatsApp, criar `backend/connect_facebook.php`, `backend/connect_instagram.php` e extrair código comum para um helper compartilhado local.
- Documentação mínima: `.github/docs/agent-context/meta-integrations.md`, `.github/docs/agent-context/backend-contracts.md`, `.github/docs/agent-context/known-issues.md` e, se a validação mudar, `.github/docs/agent-context/testing-and-validation.md`.

## 4. Decisões importantes
- Assumi uma única página `/setup` com 3 cards separados, em vez de criar 3 rotas principais logo de início.
- Assumi compatibilidade temporária de backend, com aliases ou ponte de migração, para não quebrar o fluxo atual enquanto os novos endpoints amadurecem.
- Assumi que o WhatsApp Embedded Signup segue sem iframe nesta fase, então a separação será estrutural e contratual, não de embed.
- `connect_old.php` será mantido apenas como referência histórica local, sem virar alvo de refatoração nesta entrega.

## 5. Bloqueios ou dependências do backend
- A separação completa do backend depende dos novos `config_id` e da configuração específica da Meta para Facebook e Instagram, que você informou que ainda vai gerar.
- O backend atual é local-only e sensível; qualquer split real precisa respeitar esse limite e não expor segredos ou IDs permanentes em documentação versionada.
- Se os contratos novos ainda não existirem no backend, o frontend deve ficar isolado por tipo de fluxo e documentar o que continua pendente no servidor.
- A separação final de callback e scopes por produto precisa ser validada com os endpoints reais da Meta antes de remover o caminho unificado.

## 6. Comandos executados e resultados
- `npm run build` passou com sucesso.
- `npm test -- --watch=false` falhou por causa de teste legado/stale em `channel-list.component.spec.ts`, incluindo import path inválido para `src/app/...`, uso de namespace `jasmine` em setup Vitest e expectativas antigas como `pages`.
- `git status --short --branch` mostrou `## feat/separating-connect-meta-flows`, sem mudanças pendentes no workspace durante esta fase de planejamento.
