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

