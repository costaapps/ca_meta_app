# Revisão, evidência e integração squash

## Condições obrigatórias de aceite

Cada pacote é avaliado contra o contrato original e o commit exato. A decisão exige resultado estruturado válido, paths autorizados, critérios de aceite cobertos, validação determinística e revisão independente. Registros de execução devem distinguir êxito, falha, bloqueio e cenário não executado.

O CI exigido para integração automática inclui o check de nome **`orchestrator`**. O nome é contrato do workflow `meta-v2-orchestrator-ci.yml`. A política deve listar checks adicionais quando o pacote alterar aplicação, contratos, banco ou infraestrutura. O check de ferramentas do supervisor não substitui build, testes e provas funcionais do produto.

Revisões devem responder:

- A implementação atende o contrato e preserva as funções existentes?
- Há teste ou evidência observável para cada critério obrigatório?
- O comportamento em falha, replay, concorrência e isolamento foi considerado?
- Contratos, documentos e código descrevem o mesmo comportamento?
- Os resultados pertencem ao head atual e ao ambiente informado?
- Existem ações externas ou suposições apresentadas como comprovadas sem validação?

## Achados

| Severidade | Exemplo | Tratamento |
|---|---|---|
| Crítica | Segredo exposto, acesso cruzado de empresa, efeito externo destrutivo indevido | Bloqueia integração; conter e revisar alcance |
| Alta | Contrato incompatível, fluxo errado de token, replay com efeito duplicado | Bloqueia até correção e nova prova |
| Média | Cenário obrigatório falha, inconsistência recuperável ou validação relevante ausente | Bloqueia quando viola aceite; justificar classificação |
| Baixa | Melhoria localizada sem violação de comportamento/aceite | Registrar e priorizar; evitar bloqueio meramente estético |

Cada achado deve apontar localização, comportamento esperado/observado, impacto e prova ou reprodução. O executor recebe os achados e pode corrigir ou apresentar evidência contrária. O principal resolve divergências com base no contrato; não descarta achados apenas para liberar a fila.

## Revisão de segurança

É obrigatória para mudanças em identidade, tenants, credenciais, OAuth, webhooks, APIs internas, migrations de dados sensíveis, CI/CD, permissões e o próprio controle de execução. Para a M1, revisar os contratos e modelos de ameaça correspondentes.

Revisão estática ou teste com fixture não é auditoria abrangente nem teste real do provedor. Consentimento, QR, App Review, dados operacionais e aprovações externas permanecem evidências específicas.

## Política de squash

Todo PR integrado pelo controlador deve usar `merge_method=squash`. Não há fallback para merge commit ou rebase merge. A restrição vale também para correções e retomadas. O PR final para `develop` é entregue ao responsável humano com recomendação de squash.

Antes de integrar um pacote, o controlador deve conferir repositório, branches, estado aberto/não-draft, head esperado, base esperada, checks exigidos, reviews bloqueantes e possibilidade de merge. Depois da chamada, deve verificar o resultado remoto e guardar o commit squash. Uma resposta ambígua exige reconciliação antes de tentar outro efeito.

O endpoint REST de merge oferece comparação do head (`sha`), mas não uma transação de compare-and-swap do head e da base juntos. O controlador relê a base imediatamente antes da operação e serializa os merges sob seu controle. Alteração concorrente por outro ator continua sendo um limite que deve ser observado e conciliado.

Nunca usar `--admin`, alterar regras do repositório, ampliar credenciais ou remover check para contornar rejeição. Um agente autenticado como o autor do PR não pode se tornar um revisor humano independente. Proteções que exigem aprovação de outra pessoa continuam válidas e podem impedir integração sem intervenção.

## Controles que os agentes não podem alterar sozinhos

Arquivos de política, supervisor, agentes e workflows são controles de execução. Uma tarefa de produto não pode modificar esses arquivos para tornar seu próprio resultado aceitável. Mudanças legítimas nesses controles devem ser propostas em escopo específico e passar por revisão humana antes de serem usadas como nova política confiável.

O processo deve usar a política confiável carregada no início da execução, e não adotar silenciosamente uma política modificada no worktree de um executor.

