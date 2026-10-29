# Ambiente e validação sem intervenção rotineira

## Preparação pelo agente principal

Executar no ambiente real do chat. Descobrir sistema, shell, arquitetura, diretório, permissões e ferramentas; não assumir que o Desktop Windows usa o Ubuntu já configurado. Instalar dependências de projeto em escopo local, com versões compatíveis/lockfiles, usando os privilégios já autorizados. Não solicitar a senha do usuário. Se uma instalação de sistema exigir intervenção que o cliente não pode conceder, agrupar uma solicitação mínima e executar trabalho independente enquanto isso.

Verificações iniciais, adaptadas ao shell:

- Git: status/branch/diff, remote get-url origin, git var GIT_AUTHOR_IDENT e GIT_COMMITTER_IDENT. Usar nome/e-mail já configurados; nunca escrever uma identidade fictícia ou automation@users.noreply.github.com.
- GitHub: conexão disponível no Desktop ou `gh auth status`; leitura de costaapps/ca_meta_app; acesso de escrita necessário para branches/PRs; Project #12 somente se disponível. Não imprimir tokens ou alterar scopes/proteções sem necessidade e autorização.
- Node/npm: versões compatíveis com Angular/Nest das escolhas atuais; usar um único runtime por checkout, sem misturar npm Windows com node Linux. Reinstalar node_modules em cada plataforma/worktree necessária.
- Python: apenas quando scripts/validações usados o exigirem; scripts com tomllib precisam de 3.11+. UTF-8 explícito. No Windows selecionar o interpretador correto, não assumir o python3 do WSL.
- Docker/Compose ou runtime local equivalente: client e daemon acessíveis do ambiente que executará os testes, não só docker --version. Em WSL, integração Docker Desktop deve estar habilitada para a distribuição. Um subagente pode ter menos acesso; coordenador/validador podem executar o harness pelo canal autorizado sem liberar produção.
- MariaDB e fila: subir instâncias descartáveis com projeto/namespaces/volumes identificados; usar portas locais livres e credenciais de teste. Não operar banco ou containers preexistentes de outro projeto.

Não reutilizar o serviço meta-orchestrator nem rodar o CLI do controlador antigo. O login Codex do usuário e a permissão da sessão vêm do Desktop.

## Protocolo para experimentos e testes novos

Ao criar qualquer PoC, entregar um harness reproduzível, não somente um relatório:

1. README com objetivo, pré-requisitos, versões, entrada sintética, comando de setup, comandos de teste, resultado esperado e cleanup limitado aos recursos criados.
2. Código/fixtures e manifest/lockfile de dependências quando aplicáveis.
3. Setup automatizado de serviço local ou Compose, healthcheck com prazo e teardown por namespace; não depende de uma senha de produção.
4. Asserções de comportamento, incluindo falhas/recuperação necessárias ao critério. Imprimir counts e status observáveis, sem credenciais.
5. Coordenador/validador executa no SHA candidato ou em snapshot identificado e grava evidência de execução. Não esperar que alguém fora da sessão registre a execução.

O implementador pode testar antes do commit e informar evidência local. Depois das edições, o coordenador cria o candidato e executa os checks; o revisor não deve exigir prova pós-commit que o implementador só poderia obter depois da própria entrega. O coordenador fornece essa prova. Relatórios rastreados usam o commit-fonte testado ou um snapshot claramente identificado; o SHA final do próprio relatório fica no PR/checkpoint, sem uma autorreferência impossível.

## Matriz mínima de validação

| Área | O que executar |
|---|---|
| Angular atual | instalação do lockfile, build e testes sem watch; ensaio UI quando comportamento visual mudar |
| Experimentos M1 | todos os traces, dry-runs, testes de fixtures e PoCs entregues pelo pacote; Angular sozinho não os cobre |
| Nest/API | compilação/strict types, unidades, integração HTTP/DB e contratos, erros/autorização |
| Migrations | banco vazio e versão anterior, constraints/índices, rollback/recuperação e isolamento |
| Jobs/inbox/outbox | duplicata/replay, falha entre gravação/entrega, reentrega, desligamento e retomada |
| Segurança | tenant/app/ambiente/ativo/operação, CSRF/OAuth, assinatura, replay, segredo e redaction |
| Meta local | parsing, paginação, erros/quota, estado/saga, fixtures assinadas, quatro fluxos independentes |
| Meta real | apenas em ambiente autorizado; registrar ativos/configuração/versão sem valores secretos e distinguir provider de fixture |
| Containers/CI | build de imagens, health/readiness, usuário/permissões, config inválida, smoke e cadeia de release |
| Portal | navegação, formulários, retomada, estados de falha, paridade visual e acessibilidade |
| Migração/operação | dry-run, quarentena, contagens, shadow, rollback, carga, restore e retenção em ambiente permitido |

A baseline atual possui comandos `npm ci --ignore-scripts`, `npm run build`, `npm test -- --watch=false`. Se um pacote exige scripts de instalação legítimos, revisar e executá-los em ambiente isolado; não declarar tudo testado só porque ignore-scripts passou. Não executar npm audit fix indiscriminadamente. Na M2, root scripts/workspaces devem agregar os novos apps, packages e experimentos; atualizar CI no mesmo conjunto coerente de mudanças. Não manter uma lista congelada de comandos Angular quando a arquitetura mudar.

## Execução e revisão no SHA correto

Checks de integração usam worktree gravável descartável em detached HEAD no candidato revisado. Fontes revisadas não são alteradas pelo validador. Builds/temp/DB podem escrever em seus diretórios de teste. Um revisor somente leitura pode usar resultados reais do coordenador no mesmo SHA/ambiente, inspecionando independentemente scripts, cobertura e asserções; não tentar npm ci em checkout somente leitura e transformar EROFS em defeito do produto.

Fornecer a cada revisor uma lista concreta de **todos** os comandos necessários ao pacote, resultado, duração, ambiente, SHA e artefatos. Se ele pedir um check válido ainda não executado, o coordenador executa e devolve a evidência no mesmo ciclo, sem reabrir implementação. Um comando de unittest com glob mais abrangente satisfaz o requisito quando comprovadamente inclui os testes exigidos; não bloquear por diferença literal do argv.

Antes e depois dos checks, comparar status e diff. Geradores podem escrever arquivos rastreados: executar em snapshot descartável, comparar semanticamente quando apropriado e incorporar alterações intencionais antes de criar novo candidato. No CSV gerado pelo planejamento, diferença CRLF/LF não é mudança funcional; preservar bytes ou normalizar em commit específico. Não descartar mudanças reais para limpar uma worktree.

Os scripts `.planning/validate.py` geram artefatos. A verificação de planejamento pode ser feita em snapshot temporário que inclua `.planning/` e docs correspondentes; não deixá-la modificar a branch de entrega sem examinar o diff. O kit Desktop não depende de corrigir esse gerador nem de rodar tools.orchestrator. O CI legado pode continuar auditando o catálogo; não é o executor da milestone.

## Ambiente insuficiente

Diagnosticar comando/erro e distinguir dependência ausente, versão incompatível, restrição do cliente, rede e autorização. Usar alternativa equivalente local quando realmente prova o requisito (por exemplo, MariaDB nativo versus container MariaDB). SQLite não comprova compatibilidade específica MariaDB; fake de API não comprova grants Meta. Entregar scripts e resolver tudo permitido. Se todas as alternativas falharem por acesso externo, registrar uma solicitação única e executar outras frentes, sem repetir a mesma instalação em loop.
