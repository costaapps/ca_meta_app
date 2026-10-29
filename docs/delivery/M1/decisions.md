# M1 — decisões e interpretações registradas

Data do registro: 2026-10-28 (America/Sao_Paulo).

## Base e execução

- A execução reinicia no `develop@733e4a6dcccc93ee58a24958ed9830bfcc878e62`, confirmado como cabeça de `origin/develop`. A baseline histórica `7062247a15d15b1b1a5213353517bdc1596a1d38`, branches antigas e PRs #80–#82 não são aceite desta execução.
- Os comentários históricos de #10–#12 que dizem “accepted” apontam para tentativas antigas e PRs #80–#82; não são evidência desta execução e serão preservados sem reutilizar seu aceite.
- `desktop/milestone-m1` e as branches `desktop/m1-XX` são novas. Integrações de pacote serão squash, após validação e revisão independentes; o PR consolidado apontará para `develop` e aguardará aceite humano.
- A identidade Git já configurada foi validada sem expor nome/email. O conector GitHub autenticado reporta permissão de push no repositório; `gh` CLI não está instalado e não é necessário para as ferramentas disponíveis.
- Não usar o controlador/SQLite legado. O diretório de fontes sensíveis locais `backend/connect.php` e `backend/connect_old.php` continua fora do escopo.

## Diferenças entre issue e adendo autorizado

- M1.01/#10 pede inventário operacional/rewrite da Hostinger. O prompt M1 e `scope-decisions.md` autorizam concluir o inventário independente dos quatro PHP versionados, frontend, consumidores versionados e trace sintético; código/rewrite/consumidores em produção ficam Not confirmed e são gate antes de corte. Não se presume acesso ao PHP local sensível.
- M1.02/#11 descreve DDL físico e duplicidades reais. Para M1, o adendo autoriza schema sintético, mapeamento de campos observáveis no PHP, isolamento/quarentena/expiração e dry-run executado. DDL/índices/dados reais continuam gate anterior à importação.
- M1.03/#12 pede prova Sandbox de tokens/ativos antes do desenvolvimento dependente. O adendo autoriza pesquisa pública e experimento local de seleção/configuração; Meta app grants, App Review, elegibilidade e Coexistence real ficam Not confirmed e são gates antes de certificar/ativar.
- M1.06/#15 pede concordância/evidência do emissor Suite4 real. O adendo autoriza contrato tipado proposto e ensaios adversos com emissor fake explícito; acordo/chaves reais são gate de integração M3.02.
- Essas interpretações não alteram os corpos históricos das issues nem certificam integrações externas.

## Evidências de ambiente e pesquisa

- Baseline no worktree isolado em `733e4a6dcccc93ee58a24958ed9830bfcc878e62`: Node 22.17.0, npm 10.9.2, Angular 21.0.8, CLI 21.0.5, TypeScript 5.9.3; `npm ci`, `npm run build`, `npm test -- --watch=false` passaram. O npm reportou 46 vulnerabilidades (1 low, 11 moderate, 30 high, 4 critical); nenhuma correção automática foi aplicada.
- PHP CLI 8.3.30 passou `php -l` nos quatro PHP versionados; isso não reproduz PHP/Hostinger.
- Docker Engine 28.3.0 e Compose 2.38.1 estão acessíveis. Subagente de ambiente confirmou imagens MariaDB 11.8.x e Redis 8 em cache. Nenhum serviço desta milestone foi iniciado. Um container MariaDB preexistente parado foi preservado.
- Em pesquisa oficial Meta em 2026-10-28, páginas de developers.facebook.com responderam HTTP 429. O status permanece Not confirmed; fontes documentais oficiais disponíveis não comprovam grant, elegibilidade ou comportamento de conta real.
