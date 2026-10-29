# ADR-005 · Segredos, configurações e fronteira legado

Status: aceita como direção inicial de implementação, com deployment e custody externos pendentes. Issues: [M1.04 / #13](https://github.com/costaapps/ca_meta_app/issues/13), [M1.02 / #11](https://github.com/costaapps/ca_meta_app/issues/11). Data: 2026-10-28.

## Contexto comprovado

O código PHP versionado mostra contratos de API e consumidores. O operador descreveu uma instalação Hostinger compartilhada e rewrite, mas essa descrição não é reprodução/inspeção da infraestrutura. Os arquivos locais `backend/connect.php` e `backend/connect_old.php` são sensíveis e não foram lidos/copied. DDL, usuários DB, painel DNS, cofres, secret manager, credenciais e IDs do ambiente não são confirmados.

## Opções

| Opção | Benefício | Custo/risco | Evidência/experimento |
|---|---|---|---|
| Cofre do servidor com ciphertext autenticado e chaves versionadas fora do DB | Segredo nunca deixa contexto servidor; adapter inicial pode ser substituído por KMS | Backup/restore e rotação exigem procedimento de chave; não basta criptografar DB com chave no mesmo lugar | Alinhado ao blueprint; chave real não usada nem criada na PoC |
| KMS/secret manager gerenciado como primeiro adapter | Rotação e IAM delegadas ao provedor | Provedor/conta/custo/region e permissões ainda não foram selecionados | Não há serviço/conta confirmados; implementar após gate operacional |
| Guardar token no browser ou nas projeções empresariais | Menos salto para chamadas locais legadas | Amplia exposição, cópia por ambiente, sessão e logs; quebra fonte central | Rejeitado: frontend e projeções não são cofre de token |
| API/worker acessa PHP diretamente como fonte geral | Facilita transição inicial | Acoplamento ao rewrite/deployment e duplicação de efeitos/ownership | Bridge apenas por contrato tipado, escopo temporário e status por fase |

## Decisão e consequência

Segredos Meta permanentes ficam centrais sob serviço de credenciais. O banco armazena envelope/ciphertext, nonce, tag, key version e metadados necessários; chave de cifra fica fora do banco, imagem e Git. Adapter de KMS/secret manager pode substituir envelope local sem mudar domínio. Endpoint público de decrypt/export fica proibido. Resolução de segredo exige `tenantId`, `appConfigId`, ambiente, provider/variante, ativo e operação autorizada; nega se grant, membership ou estado não puder ser comprovado. Sem token root como fallback.

Ambiente dev, staging e prod recebe credenciais/callbacks/chaves independentes; configuração identifica app/env/flow/auth/Graph/Signup version, com segredo por referência e mudança auditada. Config do web é pública e allowlisted. Logs/errors/traces têm redaction e não exibem tokens, app secret, authorization code, cookie ou state. Rotação é aditiva por key version e mantém leitura de ciphertext anterior até migração verificável; backup deve incluir recuperação controlada de chaves, não a chave em texto plano junto do backup.

Central é dono eventual de integração e autorização; DB empresariais são projeções de metadata/referências sem token por padrão. A relação tenant a legacy DB usa o mapeamento validado do lado servidor `(IdDatabase, IdCompany)` da M1.02; nenhuma DSN ou UUID enviado pelo browser escolhe conexão. LegacyBridge pode ler/projetar contratos explícitos por fase e operação, com idempotência/auditoria e um único escritor por campo. PHP continua referência existente enquanto consumer/route não tiver gate de corte. Não carregar DDL/config operacional nas ADRs.

## Prova, implantação e recuperação

PoC é inteiramente sintética e não inclui qualquer token/chave real. O harness usa senha descartável gerada no shell para um MariaDB efêmero e não grava a senha nos arquivos/outputs. O pacote não implementa cofre, não importa credenciais, não altera o PHP e não valida um secret manager de produção. Restore de segredo criptografado precisa testar acesso à versão de chave e resolver revogação antes do uso; não reativa credencial antiga por importação.

## Revisão futura

Revisar quando ambiente autorizado de vault/KMS e dono de rotação forem escolhidos, quando o formato de bridge com consumidores legados for confirmado, ou quando evidência mostrar necessidade de projeção temporária de credential handle. Segredos de produção, endpoint real, ownership e deployment seguem **Not confirmed** e dependem de gates M6/rollout.
