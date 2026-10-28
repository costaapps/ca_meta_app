# SPEC · <domínio>/<feature>

Status: proposed | ready | implemented | verified. Issue: <URL>. ADRs: <links>. Contrato/version: <link>. Responsável funcional: <função>. Data/commit de evidência: <valor>.

## Problema e comportamento pretendido

Descrever gatilho e resultado observável, público/tenant e motivo. Delimitar escopo e efeitos externos. Referenciar comportamento atual comprovado e paridade exigida.

## Invariantes e autorização

Registrar ator, membership/scopes, recurso, tenant/app/ambiente e regras imutáveis. Segredos não aparecem no contrato público. Explicitar estados desconhecidos, revogação e concorrência.

## Contrato e dados

Endpoints, schemas de request/success/error, eventos, IDs, versionamento, índices/constraints e dono por campo. Indicar origin/source de dados, retenção e projeção empresarial quando aplicável.

## Cenários verificáveis

| ID | Dado | Quando | Então | Evidência/teste |
|---|---|---|---|---|
| AC-01 | Tenant e grant válidos | Operação permitida | Efeito/status correto e auditado | Contrato/integration/E2E |
| AC-02 | Outro tenant/asset | Tenta acessar | Erro seguro, zero efeito | Adversarial |
| AC-03 | Retry/duplicata | Repete request/evento | Idempotência ou UNKNOWN explícito | Integração/fault |
| AC-04 | Dependência indisponível | Efeito interrompe | Estado parcial, retomada e diagnóstico | Fault/recovery |

## Implementação em fatias

Listar passos e PRs, portas/adaptadores e mudanças de contrato. Trabalho dependente exige evidência externa; não preencher lacuna com hipótese não marcada.

## Migração, rollout e recuperação

Flags, escritor por fase, compatibilidade N/N-1, backfill, checkpoint, critérios de abortar e rollback. Distinguir estado local e efeito externo irreversível/ambíguo.

## Validação e evidência

Comandos, ambiente, versões, fixtures sintéticas e resultados. Informar claramente planejado/executado/bloqueado. Critérios só são marcados atendidos com prova vinculada.

## Alterações de escopo

Atualizar contrato, consumidores, testes e ADR quando necessário. Descrever estado final para revisor sem depender do chat; guardar histórico em Git.
