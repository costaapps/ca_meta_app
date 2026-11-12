# M5 — decisões da execução Desktop

## D-M5-01 — Base confirmada por GitHub

- **Contexto:** o handoff local de M4 é anterior ao aceite remoto e diz que #57 permanece aberta.
- **Decisão:** usar `develop@c3e9baa75ea793d74292e62038e0d8d11bb61295` e o PR #151 realmente merged como evidência de integração; consultar o tracker atual para o status das issues.
- **Consequência:** #57 está fechada no GitHub, mas fechamento não prova certificação externa. Os 28 cenários M4.14 continuam `PARTIAL_LOCAL`; não presumir autorização Meta.

## D-M5-02 — Sessão e entrada no portal

- **Contexto:** M5.01 deve abandonar `cUUID` como autoridade e oferecer entrada direta/Suite4, mas o emissor real Suite4 não está confirmado.
- **Decisão:** usar os contratos existentes de sessão, preauth, exchange, troca de tenant e capabilities server-side; contexto do cliente só pode referenciar uma sessão válida. Não inventar um emissor Suite4 nem persistir ticket/token em `localStorage`.
- **Consequência:** o shell e o caminho local de entrada podem ser testados com fixtures sintéticas. Cookie/iframe, emissão Suite4, identidade/membership reais e comportamento de produção permanecem **Not confirmed**.

## D-M5-03 — Operações internas e consumidores Msg4

- **Contexto:** M5.07 exige API de serviço tipada e migração de consumidores. As fontes PHP versionadas incluem list/create de templates, notificações, respostas a comentários e subscriptions de WABA/Page; GeneralSettings, jobs e equivalência implantada não estão confirmados. Os handlers versionados selecionam contexto via IDs legados e não mostram vínculo verificável entre membership, tenant e asset UUID.
- **Decisão:** implementar a fronteira de serviço tenant-scoped, inventariar cada caller versionado e manter todos como `NOT_MIGRATED` até existir principal autenticado, membership validada, resolução tenant→asset UUID e provisionamento seguro de service proof. Não modificar os handlers para escolher prova por `company_uuid` ou ID da request, pois isso permitiria IDOR; não adicionar fallback de token global. Nunca abrir ou alterar `backend/connect.php` nem `backend/connect_old.php`.
- **Consequência:** o harness sintético demonstra isolamento, redaction e idempotência da API, mas não comprova equivalência PHP, cutover sem double-send, credenciais Meta, Suite4 ou operação implantada. O pacote/issue #62 permanece parcial até esses vínculos e testes serem fornecidos e exercitados.

## D-M5-04 — Evidência local versus efeitos externos

- **Contexto:** as decisões de escopo M1–M4 autorizam implementação local enquanto preservam gates de provider, dados e operação.
- **Decisão:** testes e ferramentas M5 usam somente fixtures e serviços descartáveis. Nenhuma chamada Meta, envio de mensagem, subscription, importação de credencial, migração de produção ou corte do legado é inferido de testes locais.
- **Consequência:** piloto, shadow e migração real só serão marcados concluídos se exercitados no escopo autorizado e com evidência correspondente.

## D-M5-05 — Identidade empresarial sem rótulo confirmado

- **Contexto:** a regra M1.08 em `docs/meta-v2/experience/journey-spec.md` e CTX-01 de `screen-api-permission-test.csv` exigem rótulo `tenantDisplayName` ou host autenticado confirmado antes de exibir uma empresa ativa ou habilitar escritas. O `SessionContext` entregue atualmente contém `tenantRef`, mas não fornece essa evidência; `cUUID` também não é autoridade.
- **Decisão:** enquanto essa lacuna existir, o portal mostra “Identidade da empresa não confirmada”, oculta o seletor empresarial e falha fechado para toda mutação tenant-scoped. Leituras server-scoped e emissão pública de magic-link continuam disponíveis. Não derivar nome de `tenantRef`/`cUUID`, não inventar endpoint de rótulo e não liberar chamadas legadas externas quando um rótulo seguro for adicionado depois.
- **Consequência:** M5.01–M5.03 exercitam o fluxo de gravação apenas com capability confirmada sintética em testes. Em produção, ações permanecem indisponíveis até uma alteração revisada do contrato que forneça contexto de empresa confiável; identidade visível por si só nunca autoriza consumidores Msg4/PHP.

## D-M5-06 — Configuração por canal em rota aditiva

- **Critério da issue #59:** oferecer leitura e atualização PATCH da representação de mensagens/respostas por canal em `/api/v1/assets/{assetId}/automation-config`.
- **Motivo:** essa rota e os schemas `AutomationConfig`/`AutomationConfigUpdate` já pertencem ao contrato v1 congelado e são usados por consumidores existentes. Substituí-los pela nova representação de M5.05 faz `check:breaking` falhar e remove os campos `enabled`/`replyText` legados.
- **Decisão:** manter inalterados o GET/PUT e os schemas v1 na rota base. Publicar a representação M5.05 com `GET/PATCH /api/v1/assets/{assetId}/automation-config/channels` e schemas `AutomationChannelConfig`/`AutomationChannelConfigUpdate`.
- **Consequência:** os consumidores M5.05 usam explicitamente a rota `/channels`; consumidores v1 continuam podendo usar seu contrato original. A issue diverge do caminho base pedido para manter compatibilidade binária de contrato.
- **Gate:** aceitar a rota após revisão do diff de contrato e `check:breaking`; qualquer consolidação futura na rota base requer uma versão compatível, migração dos consumidores identificados e gate próprio de breaking-change.

