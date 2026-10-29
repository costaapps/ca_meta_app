# M1.06 — Cruzamento de segurança da matriz de endpoints

Este cruzamento cobre, uma vez cada, as **53 linhas de dados** em [`docs/baseline/endpoint-matrix.csv`](../baseline/endpoint-matrix.csv), incluindo rotas Angular, entradas/rotas/funções PHP versionadas, requests do frontend e a linha de drift documental. A tabela linha-a-linha está em [`endpoint-security-crosswalk.csv`](endpoint-security-crosswalk.csv). `tools/m1-06/src/run.mjs` compara a chave de cada linha (`kind`, `method`, `path_or_symbol`, `source_file`, `source_symbol`) por posição, exige 53 correspondências únicas e rejeita dimensão ou gate vazio. Uma mudança na matriz exige reconciliar o cruzamento antes de o harness passar.

Os códigos a seguir descrevem o **controle de destino proposto**; não reescrevem o que a matriz observou no legado. As lacunas de autenticação, rewrite, ambiente, deploy e efeitos externos existentes continuam como evidência e não como controles já implantados.

## Identidade e tenant

| Código | Regra de destino |
|---|---|
| `I0` | Rota/bootstrap público de transporte ou UI. Não estabelece principal; toda leitura/ação de dados é autorizada pela API. |
| `I1` | API protegida por `PortalSession`, criada somente pelo exchange de ticket com contexto de origem/fluxo confiável ou pelo consumo explícito de magic link. |
| `I2` | Callback OAuth público como transporte; só recupera principal/tenant/config do `AuthorizationSession` e `state` server-side, com uso único e validade. |
| `I3` | Helper interno. Herda autorização do controller validado ou usa identidade de serviço dedicada; não constitui endpoint nem bypass. |
| `I4` | Leitura de configuração do processo. Segredos permanecem server-side e nunca são resposta ao browser. |
| `I5` | Redirect ou 404 sem identidade ou efeito de negócio. |
| `I9` | Linha de drift histórico, não um endpoint executável. Relação do `backend/connect.php` com deploy fica **Not confirmed**. |
| `T0` | Página/redirect não decide tenant. `cUUID`/`company_uuid` é dica/identificador não confiável. |
| `T1` | Tenant vem da sessão, membership `ACTIVE` e tenant `ACTIVE`; query/policy exige também tenant do recurso. |
| `T2` | Fluxo OAuth usa tenant/principal/config vinculados no servidor; UUID/client state não prova membership. |
| `T3` | Helper/service recebe tenant já validado e mantém escopo/relações pai-filho desse tenant. |
| `T4` | Configuração global do servidor; não representa um tenant. |
| `T9` | Não aplicável à linha de drift; não foi inspecionado como endpoint. |

## Origem, CSRF e papéis

| Código | Regra de destino |
|---|---|
| `O0` | Navegação/leitura não mutável. A rota UI não concede acesso; request API de dados aplica sessão/origin e tenant. |
| `O1` | Mutação exige `POST`/`PUT`/`PATCH`/`DELETE`, Origin exata, CSRF vinculado à sessão e Fetch Metadata. Entry GET antigo não deve criar efeito sem fluxo protegido. |
| `O2` | Callback GET só dispensa token CSRF se valida `state` opaco server-side, purpose, TTL, redirect URI/flow, tenant e consumo único; efeitos usam saga/idempotência. |
| `O3` | OPTIONS é preflight limitado a origens/métodos/headers exatos; sem `*` com credentials. Configuração operacional continua **Not confirmed** até M3.04. |
| `O4` | Helper não recebe HTTP diretamente; só é chamado após política do controller/callback. |
| `O5` | Chamada service-to-service não usa CSRF de browser; usa identidade de workload e escopo tipado. Transporte/credencial reais são **Not confirmed**. |
| `O6` | Configuração server-side, sem request de browser. |
| `O9` | Não aplicável à linha de drift. |
| `R0` | Nenhum papel é conferido no frontend; a API é a autoridade. |
| `R1` | Leitura de recurso do tenant ativo para owner/admin/operator/viewer, com policy por recurso; DTO não expõe segredo. |
| `R2` | Conectar/editar/criar requer owner/admin/operator e capability da operação; viewer não muta. Templates ainda exigem `MANAGE_TEMPLATES`. |
| `R4` | Ação tipada por tipo: retry de evento pode ser owner/admin/operator; envio exige capability própria; validar recurso e idempotência. |
| `R5` | Callback usa o ator e capabilities registrados na sessão/state de início e revalida membership; claims/UUID do callback não promovem papel. |
| `R6` | Serviço só executa `(tenant, asset, operation)` incluídos no scope; sem sessão humana, token Meta ou endpoint Graph livre. |
| `R7` | Acesso a configuração é de runtime/segredo do servidor, não papel de cliente. |
| `R8` | 404 não expõe identidade ou recurso. |
| `R9` | Autorização vem do caller protegido; o helper não amplia role/scope. |
| `R10` | Não aplicável à linha de drift. |

## Efeitos externos e gates

| Código | Regra de destino |
|---|---|
| `X0` | Navegação/UI sem efeito server-side. |
| `X1` | Início/redirecionamento OAuth. Criar onboarding/state vinculado com chamada mutável protegida; o provider é acionado no browser somente depois da validação local. |
| `X2` | Callback pode trocar código, consultar provider, persistir grants e criar subscriptions. Checkpoints, idempotência e outcome `UNKNOWN`; não inferir sucesso de redirect. |
| `X3` | Leitura local ou consulta provider sem mutação; sempre tenant-scoped, com freshness/origem de observação quando aplicável. |
| `X4` | Mutação de configuração local, tenant/resource-scoped, versionada e auditada. Não confundir com mutação de configuração Meta. |
| `X5` | Pode enviar mensagem/acionar provider. Capability e payload tipado, idempotency key e reconciliação de resultado ambíguo. |
| `X6` | Leitura/criação de template provider; `MANAGE_TEMPLATES`, grant por tenant/asset/operação; criação é efeito externo. |
| `X7` | Leitura interna de configuração; sem secret em DTO/log. |
| `X8` | Sem efeito externo nessa linha. |
| `X9` | Preflight CORS, sem chamada de negócio. |
| `X10` | Boundary Meta tipado, allowlist de host/operação, grant correto e redaction; resposta crua não sai do adapter. |
| `X11` | Redirect a rota allowlisted com resultado público mínimo; nunca open redirect ou segredo em query. |
| `G1` | Ratificar identity/exchange e API em M1.06/M1.07; issuer/JWKS/audience/flow Suite4 real é gate M3.02. |
| `G2` | Preservação/homologação das jornadas e roteamento em M1.08. |
| `G3` | Queries/FKs/policies de tenant pelo contrato M1.02/M1.05 antes do backend novo. |
| `G4` | Origin/CORS efetivos e configuração de deploy verificados em M3.04; estado atual **Not confirmed**. |
| `G5` | Contrato M1.07 e prova autorizada de grant/efeito Meta em M3.08; não presumir disponibilidade de provider. |
| `G6` | Rewrite/deploy e backend local-only requerem evidência sanitizada/autorizada M1.01; sem essa evidência, manter **Not confirmed**. |
| `G7` | Variante/capability real depende da pesquisa M1.03 e cenário Meta autorizado; não relabelar fluxo atual. |
| `G8` | Gestão de configuração/segredo e escopo operacional permanecem decisão M1.04/M2; valor/config real é **Not confirmed**. |

## Cobertura especial da M1.06

- Cada `GET` de callback e helper de callback aponta para `I2/T2/O2/R5/X2`; `cUUID` decodificado não é prova de sessão e os efeitos externos não são exatamente uma vez por apenas existir state.
- Cada `POST` de configuração/ação aponta para `O1`; os efeitos de mensagem e template apontam para `X5`/`X6` e outcome/idempotência. A política final por operação continua no contrato em [identity-contract.md](identity-contract.md).
- Toda leitura que leva `company_uuid` aponta para `T1`; não existe autoridade de tenant em URL/body. Tenant ou membership suspensos são negados no novo modelo.
- Requests Angular e PHP ficam ligados às funções de backend por `path_or_symbol` e `source_file`; o checker barra endpoint novo sem linha de cruzamento.
- A linha 53 é a única exceção explícita: documentação histórica de `backend/connect.php`, não endpoint; arquivo local-only sensível não foi lido, e sua equivalência com deploy exige prova sanitizada autorizada.

O harness testa os invariantes de exchange, tenant, CSRF/Origin, escopo e efeitos sintéticos. Ele não testa cookies do browser, APIs PHP, provider real nem Suite4.
