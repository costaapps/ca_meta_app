# Contexto, resultados e provas

## Pacote de contexto

O supervisor monta o contexto por issue a partir do catálogo. O agente recebe o necessário para a entrega, evitando copiar todo o histórico do chat ou dados operacionais sensíveis.

| Campo conceitual | Conteúdo |
|---|---|
| Identidade | Repositório fixo, Milestone, chave e número real da issue |
| Base | SHA da fonte e checkout/branch atribuídos |
| Objetivo | Resultado e entregáveis do pacote |
| Contrato | Critérios de aceite, passos e limites |
| Pré-requisitos | Entregas e commits aceitos dos quais depende |
| Referências | Arquivos fonte, ADRs, contratos e fontes primárias pertinentes |
| Escrita | Paths permitidos e controles protegidos |
| Validação | Comandos/cenários autorizados e provas externas necessárias |
| Resultado | Schema JSON e localização de saída atribuídos pelo supervisor |

Os critérios vêm do catálogo; o executor não pode editá-los nem declarar satisfação apenas porque criou um documento com o título solicitado.

## Resultado estruturado

O schema usado pelo executor é a autoridade dos nomes/campos. Seu propósito é registrar resultado, arquivos/evidências, validações e bloqueios de maneira verificável. JSON válido apenas prova formato; o supervisor e os revisores ainda precisam comprovar o conteúdo.

O transporte atual exige os campos definidos em `tools/orchestrator/agents.py`:

| Campo | Regra |
|---|---|
| `task`, `role`, `revision` | Correspondem exatamente à chave, papel e SHA fornecidos |
| `outcome` | `pass`, `fail` ou `blocked` |
| `summary` | Resumo factual da entrega/revisão |
| `criteria` | Um registro por critério, índice completo iniciado em 1, status e referências de evidência |
| `findings` | Achados com `severity` (`blocking`/`advisory`), `location` e `description` |
| `blockers` | Impedimentos que ainda precisam de resolução |

Não é permitido retornar `pass` com critério incompleto, bloqueio ou achado `blocking`. Um parecer se torna antigo quando o SHA muda. A classificação de risco técnica descrita na política de revisão deve ser traduzida para `blocking` ou `advisory` no contrato do transporte.

Uma prova útil informa commit, ambiente, comando ou cenário, resultado observado, referência de artefato e limites. Evidência de CI precisa pertencer ao mesmo head revisado. Output de baseline antiga não valida uma nova entrega.

## Evidência externa

Para PHP/rewrite, DDL, identidade Suite4 e Meta, registrar origem, data e contexto sanitizado. Não versionar o arquivo de produção cru nem colar segredos em comentários. Uma síntese sanitizada pode descrever comportamento, índices, escopos e relações sem expor tokens, strings de conexão ou dados pessoais desnecessários.

Quando a prova estiver ausente, indicar: o que falta, por que impede o aceite, quem pode fornecê-la e o menor experimento autorizado que resolve a incerteza. Mocks e relato histórico devem ser identificados como tal.

## Proteção de saídas

`.orchestrator/` contém material operacional local e não vai para o Git. Revisar/redigir qualquer relatório antes de publicá-lo no GitHub. Não encaminhar stdout bruto de um provedor, token, código OAuth, segredo de app ou DDL com valores sensíveis a agentes ou comments.

O controlador registra metadados e referências de evidência. Nenhum mecanismo de redaction deve ser tratado como garantia de remover todos os segredos possíveis. O controle principal é não fornecer dados secretos ao processo de trabalho.

Os resultados estruturados ficam em `.orchestrator/agents/` e o ledger em `.orchestrator/state.sqlite3`; o relatório legível é gerado por `report`. A saída JSONL completa de raciocínio/comandos do Codex não é persistida nem publicada pelo transporte. Os IDs de sessão e o consumo observado são registrados para rastrear a execução. A retomada usa o checkpoint e novos contextos do controlador; ela não depende de manter uma conversa nativa do Codex aberta para sempre.

