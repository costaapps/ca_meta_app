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

- **Contexto:** M5.07 exige API de serviço tipada e migração de consumidores; fontes operacionais e `GeneralSettings` não estão disponíveis no checkout. Os PHP versionados são evidência funcional distinta.
- **Decisão:** implementar apenas a fronteira tenant-scoped demonstrável com os contratos e ativos versionados; enumerar consumidores visíveis e separar os desconhecidos. Não abrir nem alterar `backend/connect.php` ou `backend/connect_old.php`, não alegar migração de consumidores ausentes e não adicionar fallback de token global.
- **Consequência:** testes sintéticos podem demonstrar isolamento, redaction e idempotência local; equivalência Msg4/Suite4 e execução real permanecem **Not confirmed** até o código/contrato operacional autorizado estar disponível.

## D-M5-04 — Evidência local versus efeitos externos

- **Contexto:** as decisões de escopo M1–M4 autorizam implementação local enquanto preservam gates de provider, dados e operação.
- **Decisão:** testes e ferramentas M5 usam somente fixtures e serviços descartáveis. Nenhuma chamada Meta, envio de mensagem, subscription, importação de credencial, migração de produção ou corte do legado é inferido de testes locais.
- **Consequência:** piloto, shadow e migração real só serão marcados concluídos se exercitados no escopo autorizado e com evidência correspondente.

