# Fonte e manutenção do planejamento Meta v2

Estes scripts mantêm documentação e metadados de planejamento, sem implementar a aplicação. Repo fixo `costaapps/ca_meta_app`; baseline e branch em `catalog.py`.

## Arquivos

- `m1.py`…`m6.py` e `catalog.py`: 66 pacotes estruturados.
- `render.py`: índice, epics e corpos de issues gerados deterministicamente.
- `issues-map.json`: números/URLs reais; não adivinhar IDs.
- `bootstrap.json` / `bootstrap.py`: criação idempotente de labels/milestones ausentes.
- `manifest.json`: conteúdo renderizado e relações esperadas.
- `contracts.py`: rascunhos OpenAPI/event schema para ratificação; endpoints não implementados.
- `validate.py`: validação de conteúdo, DAG, mapping, links e geração de catálogo/matriz.
- `sync_relationships.py`: add/re-read de hierarquia e blocked-by, sem editar issues.
- `project-config.json` / `project.py`: Project privado, campos/visões/importação com acesso organizacional já autorizado.
- `project_attempt.py`: tenta com autoridade existente e registra bloqueio de acesso claramente.
- `github_api.py`: transporte com segredo só em memória, paginação e throttle.
- `test_planning.py`: provas de idempotência, segurança de escopo, contrato e rejeição de estado divergente.
- `delivery-evidence.json`: evidências de publicação/CI e bloqueio real de Projects, sem segredos.

## Atualizar e revisar

Editar catálogo/specs, depois executar:

```bash
python3 .planning/render.py
python3 .planning/contracts.py
python3 .planning/validate.py
python3 -m unittest discover -s .planning -p test_planning.py -v
```

Versionar fontes e derivados juntos. Revisar diferenças do manifesto e atualizar os corpos das issues correspondentes por operação autorizada no GitHub. Não sobrescrever progresso escrito por pessoas sem reconciliar; renderização não faz essa atualização automaticamente. Relações são aditivas e idempotentes; remoção de dependência requer decisão/revisão explícita, pois o sincronizador preserva relações existentes.

Scripts sem `--apply` não precisam de autenticação e não fazem mutação. `GH_TOKEN` só é consumido em runtime; não inserir valor em argumentos, arquivos, issue ou chat. `project.py --apply` exige Projects organizacional write previamente autorizado. Não alterar/grantar permissões para contornar erro de acesso.

Relatórios do workflow são evidência do plano/estrutura ou da baseline identificada; não certificam implementação da nova plataforma. O código de app não muda neste material.
