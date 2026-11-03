# ADR-008 · Cofre de credenciais com envelope autenticado

Status: aceita para implementação local da M3.07; key custody, deployment e restore operacional **Not confirmed**. Issue: [M3.07 / #32](https://github.com/costaapps/ca_meta_app/issues/32). Data: 2026-10-30.

## Contexto

M3.06 persiste metadados de credencial e grants com constraints de tenant, mas não contém segredo. Credenciais permanentes precisam ser recuperáveis no servidor para operações tipadas, sem serem copiadas ao browser, projeções empresariais ou logs. Nenhum KMS/secret manager, IAM, região, backup operacional ou chave real foi selecionado.

## Opções

| Opção | Benefício | Custo/risco | Evidência/experimento |
|---|---|---|---|
| AES-256-GCM via Node e chaveiro injetado em runtime, com porta substituível | Execução local e harnesses independentes de provedor; nonce/tag/AAD suportados pelo runtime | Owner deve proteger, versionar, reter e recuperar as chaves; essa implementação não fornece IAM/KMS | Experimentos sintéticos locais; SHA da validação final **Not confirmed** |
| KMS/secret manager como adapter inicial | Custody e IAM podem ser delegados a serviço gerenciado | Não há provedor, região, conta, custo ou role de workload confirmados | Sem conta/autorização para PoC de serviço; deployment **Not confirmed** |
| Cifra com chave incluída no banco, imagem ou Git | Configuração mais simples | Um dump/cópia de imagem/repositório revela tanto envelope quanto chave | Rejeitada; viola a fronteira de custody aceita em ADR-005 |

## Decisão

- Usar AES-256-GCM pelo runtime Node, nonce aleatório de 96 bits por envelope, tag de 128 bits e formato de ciphertext versionado.
- A implementação define explicitamente `authTagLength: 16` tanto no cipher quanto no decipher; `setAAD` ocorre antes de `update`, conforme a [documentação Node.js v24 Crypto](https://nodejs.org/download/release/v24.21.0/docs/api/crypto.html).
- Autenticar AAD canônica de formato, key version, tenant, credential, authorization, app configuration, provider, environment e credential family. Alterar qualquer vínculo ou versão invalida a autenticação.
- Persistir envelopes em `ca_meta_credential_secrets`, com FK composta para `ca_meta_credentials`; manter chaves fora do schema, imagem e Git. `API_CREDENTIAL_KEYRING_JSON` é entrada de runtime protegida com `activeVersion` e mapa de versões Base64 de 32 bytes. Chaves antigas ficam disponíveis somente pelo período necessário a rotação e recuperação autorizada.
- Manter `CredentialKeyProvider` como porta. KMS/secret manager pode substituí-la sem mudar o formato lógico do domínio, mas a implementação local não afirma validar um serviço gerenciado.
- Toda operação exige autorização backend-side. A aplicação entrega a chave a um callback interno e nunca tem controller/DTO de decrypt. A instalação padrão usa autorização fail-closed até a política de serviço confiável ser conectada.
- Rotação é um trabalho global auditado, aditivo e retomável. Lease com token de fencing impede processadores concorrentes; cada lote atualiza envelopes e cursor na mesma transação. Falha pausa sem avançar o checkpoint; chave antiga é necessária para retomar.
- O schema mantém uma versão de chave ativa persistida. Cada `store` confirma essa versão sob lock compartilhado; `beginRotation` avança a barreira na mesma transação em que registra o trabalho, de modo que réplicas antigas terminam antes da troca ou são recusadas depois dela.
- Auditoria guarda somente tenant, credential, ator opaco, ação, operação, versão da chave, correlação e horário. Retenção e exclusão seguem M3.10.

## Consequências e limites

O modelo criptografa em repouso e autentica o contexto, mas não substitui autorização, controle de acesso ao processo, proteção de memória, backup controlado, revogação Meta ou resposta operacional a incidente. Chaves de teste são efêmeras e sintéticas. Nenhuma chave/custody externa, backup real ou provider Meta foi exercitado; esses cenários permanecem **Not confirmed** até o gate operacional.

## Segurança, efeitos e reversibilidade

- Cada envelope e consulta são vinculados a tenant, credential, authorization, app, provider e environment; AAD adulterada ou chave desconhecida nega descriptografia.
- A interface de autorização é backend-only e nega por padrão. Nenhum endpoint público executa decrypt/export.
- Persistência e auditoria são locais; a operação não chama Meta, não revoga token e não envia mensagens.
- Rotação é aditiva, versionada, com lease/cursor e transação por lote. Falha preserva o último checkpoint; recovery requer reter uma chave autorizada compatível.
- A escolha limita-se ao adapter local criptográfico. KMS real, serviço operacional e incident response efetivo permanecem fora do escopo sem evidência de acesso.
