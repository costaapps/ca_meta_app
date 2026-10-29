# ADR-002 · Limites do monorepo

Status: aceita como direção inicial de implementação. Issues: [M1.04 / #13](https://github.com/costaapps/ca_meta_app/issues/13). Data: 2026-10-28.

## Contexto comprovado

O checkout atual é o app Angular standalone consumindo PHP; os caminhos abaixo são uma organização alvo, não diretórios existentes. As issues M1 separam descoberta/especificação da implementação futura. A prova npm em [tools/m1-04](../../../tools/m1-04/README.md) demonstra dois workspaces TypeScript independentes sob um lockfile comum.

## Opções

| Opção | Benefício | Custo/risco | Evidência/experimento |
|---|---|---|---|
| npm workspaces | Uma resolução rastreável e dependências compartilhadas com limites por pacote | Scripts e toolchains devem declarar seus donos; hoisting não pode ser premissa de runtime | PoC instala workspaces web/API com TS 5.9.3 e 6.0.3 no mesmo lockfile |
| Nx/Turborepo desde o primeiro commit | Cache e grafo de tarefas mais expressivos | Nova ferramenta, convenções e configuração antes de haver tarefas suficientes | Não há ainda fan-out de apps ou tempos de CI medidos que justifiquem a camada |
| Repositórios separados | Isolamento de deploy e dependências | Mais versionamento de contratos e sincronização entre projetos | Contratos HTTP/eventos ainda estão em desenho M1 |

## Decisão e consequência

Adotar npm workspaces, iniciar com árvore lógica:

```text
apps/web/                    Angular existente, evoluído sem SSR obrigatório
apps/api/src/                Nest modular; controllers -> use cases -> ports
apps/api/src/modules/        Identity, Tenancy, Meta, Credentials, Assets,
                             Webhooks, Jobs, LegacyBridge, Audit
packages/contracts/          OpenAPI, schemas versionados e clientes
database/migrations/         migrations explícitas e ledger
specs/                       requisitos, cenários, contratos e evidência
docs/meta-v2/adrs/           ADRs versionados
docs/runbooks/               setup, restore, reauth, retries e incidentes
infra/                       imagens web/API e Compose local
```

Limites de importação: controllers não importam os adaptadores Graph/Meta; controllers chamam casos de uso e validação de policy. Casos de uso dependem do domínio/ports, não de Nest, HTTP da Meta ou tabelas legadas. Adaptadores implementam portas. Webhooks autenticam bytes e persistem inbox antes de enfileirar processamento pesado. API e worker compartilham módulos/casos de uso, mas têm inicializadores e comandos independentes. O frontend depende apenas de contracts/client gerado; nenhuma cifra, cofre ou token entra no bundle web. Migrations são executadas por processo de release controlado, não em cada réplica da API.

M1 não move nem reescreve arquivos da baseline. O primeiro PR de implementação deverá mover o Angular somente com validação de paridade e CI/workspaces funcionando. `Nx` ou `Turborepo` podem ser introduzidos quando cache, pipelines ou times separados demonstrarem custo mensurável.

## Prova, implantação e recuperação

O harness instala o package workspace `@m1-04/web-toolchain` com Angular compiler 21.0.8/TypeScript 5.9.3 e `@m1-04/api` com Nest CLI/schematics 12/TypeScript 6.0.3. O lockfile confirma dependências, porém a compilação integral Angular continua usando o app de baseline e permanece gate de implementação M2.

## Revisão futura

Revisar quando custos de instalação/CI, ownership de deploy, ou imports reais mostrarem que workspaces reduzem isolamento necessário. Toda movimentação de app deve incluir inventário de rotas, aliases, assets, build, testes e rollback de paths.
