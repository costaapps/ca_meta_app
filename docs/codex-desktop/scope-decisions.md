# Decisões autorizadas para a execução Desktop

## Reinício e destino técnico

A nova execução começa na develop após integrar este kit. O objetivo é substituir o backend PHP por nova plataforma e preservar/evoluir o Angular, com Facebook, Instagram, WhatsApp exclusivo e Coexistence tratados como fluxos distintos. Os quatro PHP versionados em backend/ são referência funcional, não a arquitetura futura obrigatória. Não reconstruir integralmente a Hostinger como pré-requisito para escrever código novo.

O operador informou implantação compartilhada Hostinger em public_html/meta/auth, com connect.php, connect_old.php e rewrite de caminhos inexistentes para connect.php. É relato operacional, não reprodução ou auditoria. O fonte operacional enviado em chat anterior não está automaticamente disponível ao Desktop. Não solicitar novamente PHP completo para iniciar descoberta independente; não copiar connect_old.php, segredos ou IDs de configuração ao repositório.

## Interpretação de M1 (não confundir desenho e certificação)

| Pacote | Entrega executável agora | Evidência externa no cenário dependente |
|---|---|---|
| M1.01 | inventário dos quatro PHP, rotas/telas, destino funcional, trace offline e build/test | equivalência exata da implantação e consumidores antes do corte |
| M1.02 | mapeamento proposto, fixtures de isolamento/quarentena/expiração e dry-run executado | DDL/índices/dados reais antes de importar ou migrar |
| M1.03 | matriz de capacidades dos quatro fluxos, pesquisa oficial e experimento de compatibilidade | app/permissões/App Review/Sandbox antes de certificar/ativar o fluxo real |
| M1.04 | ADRs, topologia e PoCs locais reais de ORM/MariaDB e durabilidade; versões/lockfile | não aprovar ORM sem PoC executada; produção não é necessária para essa PoC |
| M1.05 | domínio, estados, constraints e cenários sintéticos verificáveis | confrontar dados/ativos reais antes de migração dependente |
| M1.06 | contrato Suite4 proposto, acesso direto e modelo de ameaças; replay/CSRF testados com emissor de teste | troca real com emissor Suite4 e chaves do ambiente antes de certificar integração |
| M1.07 | OpenAPI/eventos/erros, exemplos e validadores locais | capacidades reais dos consumidores quando usadas em rollout |
| M1.08 | jornadas, estados e paridade visual documentada/ensaiada | homologação dos responsáveis quando explicitamente requerida |
| M1.09 | SLOs, modelo de capacidade, ensaio local e plano de transição com hipóteses mensuráveis | tráfego/custo/retensão reais antes de dimensionar ou cortar produção |
| M1.10 | specs, ADRs e critérios de Ready rastreáveis; backlog de evidências por cenário | requisitos operacionais não resolvidos continuam gates do cenário afetado |

Registrar essas interpretações no relatório da milestone e nas issues afetadas, sem apagar seu texto histórico ou transformar hipótese em fato. São decisões de escopo do operador para trabalho independente. Um pacote cuja aceitação exige um efeito real continua pendente dessa parte; documentar o desenho não autoriza fechar uma issue de certificação.

## Meta e fontes oficiais

Pesquisar documentação oficial pública não requer conta de teste/Sandbox Meta. Implementar contratos, parsing, verificação criptográfica, paginação, retries, correlação e casos adversos com fixtures locais quando possível. Citar a fonte primária, versão e data consultada. Se uma página retornar 429, respeitar o prazo, pesquisar outra página oficial e continuar o trabalho que não dependa da resposta. Não interromper uma milestone só porque uma fonte está temporariamente indisponível.

Validar login/code exchange real, concessões, ativos, subscriptions, entrega real de webhook ou elegibilidade Coexistence requer ambiente/ativos/configuração autorizados. Não inventar tokens, aprovações ou comportamento observado; manter essas evidências no gate correto. A pesquisa orienta implementação, não comprova que uma conta recebeu permissão.

## Defaults e escolhas reversíveis

O agente pode escolher estrutura de pastas, libs compatíveis, formas de teste, ferramentas locais e estratégia de CI sustentadas por requisitos, registrando ADR e lockfile. Não pedir aprovação para decisões rotineiras reversíveis ou instalação local permitida pelo cliente. Não alterar requisitos essenciais, adotar token global como fallback, relaxar isolamento, remover testes ou mudar proteções para tornar o resultado verde.

Se faltar assinatura/TTL/formato real de um contrato Suite4, propor uma versão com contrato tipado e emissor fake claramente identificado; o adaptador real permanece condicionado à confirmação do emissor. Se faltar DDL real, comparar campos inferidos do PHP com um schema sintético explícito; não afirmar que migrou dados reais.

## Infraestrutura e operações reais

Usar bancos, fila, e-mail fake, chaves de teste, tenants e containers descartáveis identificados. Gerar/armazenar credenciais locais fora do Git e dos prompts. Construir scripts de setup/teste que o coordenador e validador consigam executar. Se o sandbox do subagente impedir uma operação local já autorizada, o coordenador executa pelo canal permitido; não repetir a mesma tentativa sem adaptar o plano. Uma restrição real do cliente ou falta de autenticação não pode ser contornada por instrução.

Produção, migração real, importação de credenciais reais, publicação de imagens/ambientes compartilhados, disparo de mensagens e mudanças na conta Meta exigem o escopo e autorização do ambiente correspondente. O padrão deste kit é implementar/testar localmente e preparar o gate; não publicar ou executar efeitos externos só porque um pacote contém a palavra deploy.
