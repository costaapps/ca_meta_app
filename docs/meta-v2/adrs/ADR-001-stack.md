# ADR-001 · Stack web e API

Status: aceita como direção inicial de implementação, condicionada aos gatilhos abaixo. Issues: [M1.04 / #13](https://github.com/costaapps/ca_meta_app/issues/13). Data: 2026-10-28.

## Contexto comprovado

- A baseline versionada é uma aplicação Angular standalone; ainda não existe o monorepo `apps/web` + `apps/api`. A implementação de M1 não reorganiza o frontend.
- A versão instalada no ambiente de trabalho é Node 22.17.0. A matriz publicada pelo Angular 21 aceita Node `^20.19.0 || ^22.12.0 || ^24.0.0` e TypeScript `>=5.9.0 <6.0.0`.
- Na data da pesquisa, Node 26.13.0 havia passado a LTS; porém a linha Node 26 não está na faixa de compatibilidade publicada pelo Angular 21. Node 24.22.2 é LTS, atende a faixa publicada do Angular e excede os mínimos publicados para a aplicação Nest 12 e seus schematics/CLI.
- Nest 12 requer Node `>=20.19` ou `>=22.12` para executar a aplicação; `@nestjs/schematics` 12 requer Node `^22.22.3 || ^24.15.0 || >=26.0.0` e TypeScript `>=6.0.0`. Angular 21 exige TypeScript abaixo da versão 6.
- O experimento em [tools/m1-04](../../../tools/m1-04/README.md) instala um pacote workspace Angular com TypeScript 5.9.3 e um pacote Nest com TypeScript 6.0.3 no mesmo lockfile npm, ambos em Node 24.22.2. O Nest compila com CLI 12.0.11. Isso comprova a configuração mínima da prova, não o build de uma futura aplicação Angular completa no monorepo.

Fontes primárias consultadas em 2026-10-28: [Node 26.13.0](https://nodejs.org/en/blog/release/v26.13.0), [Node 24.22.2](https://nodejs.org/en/blog/release/v24.22.2), [compatibilidade Angular](https://angular.dev/reference/versions), [migração Nest](https://docs.nestjs.com/migration-guide), [Nest core 12.3.2](https://www.npmjs.com/package/@nestjs/core/v/12.3.2), [Nest CLI 12.0.11](https://www.npmjs.com/package/@nestjs/cli/v/12.0.11), [Nest Schematics 12.0.12](https://www.npmjs.com/package/@nestjs/schematics/v/12.0.12).

## Opções

| Opção | Benefício | Custo/risco | Evidência/experimento |
|---|---|---|---|
| Angular existente + NestJS 12 em TypeScript | Preserva a UI e cria uma API tipada com módulos e limites próprios | Dois pacotes de compilação TypeScript: 5.9 para Angular e 6 para Nest CLI/schematics | Compatibilidade oficial e build Nest executado no Node 24.22.2; a instalação dos workspaces fica no lockfile M1.04 |
| Modernizar PHP versionado | Menor mudança inicial para consumidores e código PHP existente | Mantém o backend legado e não resolve sozinho jobs duráveis, isolamento de credenciais e evolução independente | O inventário M1.01 identifica o comportamento PHP versionado; deployment e paridade operacional continuam não confirmados |
| Next.js para web + servidor | Um framework para UI e rotas web | Reescreveria a UI sem requisito comprovado de SSR/SEO e acoplaria ciclo web ao ciclo de API | Nenhum requisito M1 exige SSR, SEO ou renderização de portal no servidor |

## Decisão e consequência

Preservar Angular em `apps/web` e adotar NestJS 12 em `apps/api`, como monólito modular sem SSR obrigatório. O contrato HTTP versionado e o build da API não dependem do ciclo de build da UI. Fixar a linha Node 24 LTS como runtime comum inicial e fixar patches por imagem/lockfile; a PoC fixa Node 24.22.2. Manter toolchains TypeScript isoladas por workspace: Angular usa versão suportada menor que 6; API usa TypeScript 6 para satisfazer Nest 12 schematics. Não forçar uma única instalação física de TypeScript.

O pacote M1.04 fixa versões somente no harness: Nest core 12.3.2, CLI 12.0.11, schematics 12.0.12, TypeORM 1.1.2, `mysql2` 3.24.6, Angular compiler 21.0.8, TypeScript 5.9.3/6.0.3. São versões consultadas no registro npm em 2026-10-28, sem compromisso de que continuarão mais recentes. `package-lock.json` captura a resolução testada.

## Prova, implantação e recuperação

Comando reproduzível: `docker compose --project-name m104-local-poc up --build --abort-on-container-exit --exit-code-from poc`. A imagem do Node é `node:24.22.2-bookworm-slim` (`sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`). A imagem do banco é `mariadb:11.8.8` (`sha256:d9f7eb2637296652f24b484afd5d246f759f49f5babcadc6a9e344c9acb75fbf`). O setup destrutivo limitado ao próprio namespace é `docker compose --project-name m104-local-poc down --volumes --remove-orphans`.

A prova compila o Nest CLI no TypeScript 6, instala ambos os workspaces, aplica e reexecuta uma migration TypeORM, valida JSON, índice de coluna gerada via EXPLAIN, rollback DML e cenários de jobs descritos no README. Não prova o build de todos os apps planejados, benchmark, dependências de produção, nem compatibilidade de integrações externas.

## Revisão futura

Revisar quando Angular suportar a mesma major de TypeScript do CLI Nest, Node 24 sair de suporte, Nest 12 sair de manutenção, ou os custos reais de build/workspace justificarem outra ferramenta. Next.js só volta à comparação se produto confirmar um requisito de SSR/SEO que não possa ser satisfeito mantendo o portal Angular.
