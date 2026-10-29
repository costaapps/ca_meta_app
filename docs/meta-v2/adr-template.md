# ADR-<número> · <decisão>

Status: proposed | accepted | superseded. Issue/spec: <links>. Functional owner role: <role; no invented assignee>. Evidence SHA/date: <recorded value or Not confirmed>.

## Contexto comprovado

Problema, restrições e evidências reais. Marcar inferências e dados não confirmados.

## Opções

| Opção | Benefício | Custo/risco | Evidência/experimento |
|---|---|---|---|
| A | | | |
| B | | | |

## Decisão e consequência

O que será adotado, onde se aplica e como afeta domínio, segurança, consumidores e operação. Não deixar dependência de runtime/serviço escondida.

## Segurança, efeitos e reversibilidade

- Tenant and authorization boundary, including a negative cross-tenant case:
- Secret and credential custody/rotation boundary:
- Async or external side effects, duplicate/retry and unknown-outcome handling:
- Reversible switch, migration writer/checkpoint, abort and rollback:
- Bounded decision scope and explicit non-goals:

## Prova, implantação e recuperação

Critérios objetivos, testes, rollback e dados/efeitos externos. Condição de aceitar ou abandonar a opção. List exact commands, environment, fixture provenance and SHA for executed evidence. Keep provider grants, Suite4 behavior, production DDL/deployment, permissions and approval gates `Not confirmed` until a direct authorized proof exists.

## Revisão futura

Gatilho concreto de revisão e relação com ADR substituto. Atualizar specs/contratos quando a decisão mudar.
