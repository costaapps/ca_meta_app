"""Render the planning catalog deterministically, without contacting GitHub."""
import json
from pathlib import Path
from catalog import ROOT, REPO, BASELINE, BRANCH, load_catalog

DOC_BASE = f"https://github.com/{REPO}/blob/{BRANCH}/docs/meta-v2"
ROLE = {
    "architecture": "Arquitetura / liderança técnica",
    "platform": "Backend / plataforma",
    "security": "Backend / segurança",
    "data": "Backend / dados / DBA",
    "meta": "Integração Meta / backend",
    "web": "Frontend / produto",
    "integration": "Integração Msg4/Suite4 / backend",
    "delivery": "DevOps / engenharia de entrega",
    "quality": "QA / engenharia de software",
    "operations": "Operação / SRE / suporte",
}
PROGRESS = {
"M1": [
 ("0%", "Código develop identificado; fontes operacionais, dados e premissas ainda precisam de prova."),
 ("25%", "Inventário de rotas/consumidores, DDL e paridade concluído; divergências separadas de hipóteses."),
 ("50%", "Matriz Meta, domínio/ERD, ameaça e ADRs têm decisões propostas e experimentos pendentes com dono."),
 ("75%", "Contratos OpenAPI/eventos, identidade, jornadas e metas operacionais revisados com cenários verificáveis."),
 ("100%", "Specs rastreáveis e critérios de Ready definidos; toda incerteza crítica resolvida ou bloqueando explicitamente sua implementação dependente."),
],
"M2": [
 ("0%", "Frontend Angular e PHP atual permanecem na baseline; nova plataforma ainda não implantada."),
 ("25%", "Monorepo e API modular compilam; contratos e migrations têm execução reproduzível."),
 ("50%", "Worker/inbox/outbox e imagens web/api independentes passam smoke e retomada básica."),
 ("75%", "Compose e CI validam integração, segurança, schema e builds; release manifest está disponível."),
 ("100%", "Staging isolado sobe por digests, com callbacks/TLS e gates de deploy/rollback comprovados."),
],
"M3": [
 ("0%", "UUID cliente ainda é contexto legado; nenhuma segurança nova é presumida pronta."),
 ("25%", "Tenant/membership/policies e sessão segura isolam empresas e rejeitam UUID como credencial."),
 ("50%", "Suite4/magic link/embed e domínio de ativos/grants têm provas e integração testada."),
 ("75%", "Cofre, resolver, ciclo de token, auditoria e importador dry-run passam cenários adversos."),
 ("100%", "Catálogo/read models operam sem segredo público e testes comprovam tenant/app/ambiente/operação com quatro números."),
],
"M4": [
 ("0%", "Configurações e evidências externas identificadas; novos adaptadores ainda não certificados."),
 ("25%", "Cliente Graph e saga correlacionam sessão/código/tenant com persistência segura."),
 ("50%", "WhatsApp exclusivo e Coexistence concluem provisionamento específico e subscriptions verificadas."),
 ("75%", "Facebook/Instagram, inbox assinada, sync/echo e ciclo de desconexão estão integrados."),
 ("100%", "Matriz dos quatro fluxos passa em CI e Sandbox, incluindo falhas, permissões, replay e quatro Coexistence."),
],
"M5": [
 ("0%", "Funções legadas mapeadas; nenhuma migração real é presumida concluída."),
 ("25%", "Portal e status por recurso operam com entrada segura e catálogo dos quatro fluxos."),
 ("50%", "Onboarding retomável e paridade de templates/respostas/notificações estão homologados."),
 ("75%", "Relay de operações e projeção outbox usam contexto correto, com importação/shadow verificados."),
 ("100%", "Piloto e diagnóstico permitem operação Msg4/Suite4 sem token global indevido, com rollback e paridade comprovados."),
],
"M6": [
 ("0%", "Release candidata preparada; nenhuma troca de produção foi autorizada pela existência do planejamento."),
 ("25%", "E2E, auditoria de segurança e capacidade/falhas têm evidências sem bloqueios críticos."),
 ("50%", "Observabilidade, restore e release/gates de produção demonstrados com permissões externas confirmadas."),
 ("75%", "Canário progressivo e rollback observados por empresa/canal com critérios de abortar."),
 ("100%", "Hypercare e operação aceitos; dependências PHP/Hostinger retiradas com evidência e sem excluir ativos Meta por acidente."),
],
}


def issue_link(key, mapping=None):
    item = (mapping or {}).get(key)
    if item:
        return f'[{key} · #{item["number"]}]({item["url"]})'
    return f'`{key}`'


def list_md(items, checks=False):
    return "\n".join(("- [ ] " if checks else "- ") + x for x in items)


def task_body(t, mapping=None):
    deps = ", ".join(issue_link(x, mapping) for x in t["deps"]) or "Nenhuma dependência técnica anterior; primeiro pacote executável do programa."
    refs = "\n".join(f'- [{p}](https://github.com/{REPO}/blob/{BASELINE}/{p})' for p in t["refs"])
    return f'''<!-- meta-v2-key: {t["key"]} -->
**Objetivo:** {t["goal"]}

| Campo | Definição |
|---|---|
| Milestone | [{t["milestone"]}](https://github.com/{REPO}/milestone/{t["milestone"][1:]}) · {issue_link(t["milestone"], mapping)} |
| Prioridade / área | {t["priority"]} / {t["area"]} |
| Tamanho relativo inicial | {t["effort"]} pontos; hipótese de complexidade, sem equivalência a horas/prazo |
| Responsabilidade funcional | {ROLE[t["area"]]}; pessoa a designar na execução |
| Evidência externa | {"Obrigatória antes de liberar o cenário dependente" if t["external"] else "Conforme contratos e critérios abaixo"} |
| Estado | Planejado; implementação e validações ainda pendentes |

### Dependências e condição de entrada

{deps}

Iniciar execução dependente após contratos/evidências necessários estarem disponíveis. Trabalho independente de descoberta pode avançar com a lacuna identificada. Índice: {issue_link("PROGRAM", mapping)}.

### Construção de 0% a 100%

{list_md(t["steps"], True)}

### Contratos, dados e entregáveis

{t["contract"]}

### Critérios de aceite

{list_md(t["acceptance"], True)}

### Validação planejada e evidências exigidas

{list_md(t["tests"])}

Anexar comandos/ambiente/versão/resultados e links de CI/PR. Teste planejado não significa teste executado; conta real/Sandbox e mock são evidências distintas.

### Risco, recuperação e limites

{t["risk"]}

Antes de fechar: registrar comportamento final, critérios atendidos, migração/rollback quando aplicável, documentação e ausência de segredos. Mudança de contrato deve atualizar specs e consumidores afetados.

### Referência concreta da baseline

{refs}

Blueprint: [arquitetura]({DOC_BASE}/02-architecture-and-adrs.md), [dados e credenciais]({DOC_BASE}/03-domain-data-and-credentials.md), [identidade e API]({DOC_BASE}/04-identity-api-and-security.md), [fluxos Meta]({DOC_BASE}/05-meta-flows-and-webhooks.md), [entrega e migração]({DOC_BASE}/06-delivery-migration-and-operations.md).
'''


def epic_body(key, config, tasks, mapping=None):
    children = [x for x in tasks if x["milestone"] == key]
    progress = "\n".join(f"| {pct} | {state} |" for pct, state in PROGRESS[key])
    checklist = "\n".join(f'- [ ] {issue_link(x["key"], mapping)} — {x["title"]}' for x in children)
    points = sum(x["effort"] for x in children)
    return f'''<!-- meta-v2-key: {key} -->
**Resultado da etapa:** {config["description"]}

Milestone nativa: [{config["title"]}](https://github.com/{REPO}/milestone/{key[1:]}). Programa: {issue_link("PROGRAM", mapping)}.

### Ponto de entrada e resultado verificável

Esta é uma etapa da implantação da nova plataforma. Os pacotes abaixo podem ser preparados conforme o grafo de dependências; a passagem de etapa exige os critérios de saída. O planejamento foi produzido, mas não representa código, migração ou go-live concluídos.

{len(children)} pacotes de trabalho, {points} pontos relativos iniciais. Pontos servem para reestimar complexidade; não são prazo ou capacidade da equipe. Datas e assignees serão definidos na execução com disponibilidade real.

### Progressão da milestone

| Marco de progresso | Evidência necessária |
|---|---|
{progress}

Os marcos são condições de maturidade, não uma conversão automática da contagem de issues. O progresso ponderado de execução considera somente pacotes aceitos; a epic permanece aberta até o gate.

### Pacotes de implementação

{checklist}

### Critérios de saída da etapa

- [ ] Todos os pacotes obrigatórios possuem PR/spec/contrato/teste e evidência correspondente, ou bloqueio formal que impede liberar o cenário dependente.
- [ ] Nenhuma vulnerabilidade crítica, acesso cruzado de tenant, segredo exposto, sucesso fictício ou operação duplicada pendente.
- [ ] Contratos e documentação refletem o comportamento implementado e o esquema de dados real.
- [ ] Decisões externas Meta/Suite4/infraestrutura exigidas pela etapa têm evidência e responsável funcional.
- [ ] Migração/compatibilidade/rollback/recovery aplicáveis foram ensaiados e registrados.
- [ ] Revisão técnica e aceite de produto/operação necessários foram vinculados antes do fechamento.

### Sequência, revisão e bloqueios

Usar as dependências dos pacotes, não a ordem numérica de criação das issues. Se o contrato mudar, revisar downstream antes de avançar. Bloqueio externo recebe razão, dono funcional, evidência faltante e próximo experimento. Não encerrar pacote apenas por concluir a escrita da especificação.

### Referências e gestão

[Blueprint e índice]({DOC_BASE}/README.md) · [Riscos, critérios e governança]({DOC_BASE}/07-acceptance-risk-and-governance.md) · [Configuração do Project]({DOC_BASE}/08-project-configuration.md).
'''


def program_body(config, tasks, mapping=None):
    rows = "\n".join(f'| {m["key"]} | [{m["title"].split(" · ",1)[1]}](https://github.com/{REPO}/milestone/{m["key"][1:]}) | {issue_link(m["key"], mapping)} | {sum(t["milestone"]==m["key"] for t in tasks)} |' for m in config["milestones"])
    return f'''<!-- meta-v2-key: PROGRAM -->
**Programa de reconstrução do ca_meta_app: de frontend Angular + PHP externo para portal Meta seguro, multicliente, com API independente, quatro fluxos e entrega por containers.**

Baseline auditada: [`develop@{BASELINE[:12]}`](https://github.com/{REPO}/commit/{BASELINE}). Planejamento de 28/10/2026, horário de Brasília. A implementação continua pendente; nenhuma conexão Meta de produção deve ser tratada como alterada por este programa.

### Comece por aqui

1. Leia o [Blueprint completo]({DOC_BASE}/README.md), incluindo evidências, contratos e pendências.
2. Abra a milestone e sua epic; depois siga o grafo de dependências de cada pacote.
3. O primeiro pacote sem dependências é {issue_link("M1.01", mapping)}; evidências do PHP operacional, DDL e contrato Suite4 serão obtidas no início da execução.

### Milestones de 0% a 100%

| Etapa | Milestone nativa | Epic e gate | Pacotes |
|---|---|---|---:|
{rows}

**Escopo:** {len(tasks)} pacotes detalhados, seis epics e este índice. Cada pacote contém objetivo, passos, dados/contratos, critérios de aceite, testes planejados, risco/recuperação e referência ao código. Dependências e hierarquia são preservadas no manifesto versionado e sincronizadas com os recursos nativos disponíveis.

### Decisões que sustentam a construção

- Preservar Angular e o layout/comportamentos úteis; API NestJS separada no mesmo monorepo. Stack/versões e ORM/fila serão ratificados por ADR e provas curtas.
- Quatro jornadas: WhatsApp Cloud exclusivo, WhatsApp com Coexistence, Instagram e Facebook. Instagram mantém variante de login explícita; não se misturam permissões e tokens de famílias diferentes.
- UUID identifica empresa, mas não autentica. Entrada Suite4 por ticket curto de uso único emitido no servidor; acesso direto por link para membros previamente autorizados; sessão segura e autorização por recurso.
- Credencial pertence à autorização e seus grants. Resolver por tenant + app + ambiente + ativo + operação; tokens protegidos no backend, sem fallback root para operações de clientes.
- Automatizar troca de código, validação de ativos, persistência, subscriptions e projeção. Consentimento/QR/eligibilidade/App Review continuam decisões externas da Meta.
- Webhooks assinados, inbox durável, deduplicação por item e jobs recuperáveis. Não prometer exactly-once externo nem repetir envio ambíguo cegamente.
- Banco central como fonte de integrações; bancos empresariais recebem projeções idempotentes por outbox e referências operacionais. Migração tem um escritor por função e flags por empresa/canal.
- Manter templates, respostas e notificações. Corrigir erros de escopo, sucesso falso e ações incompletas, com testes de paridade.
- Imagens web/api separadas; worker independente usando imagem API; Compose e CI/CD com versões/digests, staging, observabilidade, restauração, canário e rollback.
- SDD rastreia requisito→issue→spec→contrato→teste→PR→release. Documento escrito não encerra implementação.

### Estrutura documental aprofundada

- [01 · Evidências e divergências da baseline]({DOC_BASE}/01-baseline-evidence.md)
- [02 · Arquitetura, limites e ADRs]({DOC_BASE}/02-architecture-and-adrs.md)
- [03 · Domínio, dados, credenciais e projeções]({DOC_BASE}/03-domain-data-and-credentials.md)
- [04 · Identidade, API e segurança]({DOC_BASE}/04-identity-api-and-security.md)
- [05 · Quatro fluxos Meta e webhooks]({DOC_BASE}/05-meta-flows-and-webhooks.md)
- [06 · Docker, CI/CD, SDD, migração e operação]({DOC_BASE}/06-delivery-migration-and-operations.md)
- [07 · Aceite, riscos, responsabilidades e sequência]({DOC_BASE}/07-acceptance-risk-and-governance.md)
- [08 · Project, campos, visões e provisionamento]({DOC_BASE}/08-project-configuration.md)

### Evidências ainda necessárias para implementação

PHP operacional e regras Hostinger; DDL e replicação reais; identidade/membership/emissor Suite4; permissões e versões atuais por fluxo Meta; elegibilidade e contas de teste; alvo de infraestrutura e namespace Docker Hub. Esses itens têm issues, experimentos e gates. Documentação Meta que respondeu 429 foi marcada como não validada, sem transformar suposição em fato.

### Progresso e governança

Todas as issues de execução começam abertas. Fechar exige evidência de critérios atendidos. Pontos são tamanho relativo inicial, sem compromisso de horas, datas ou equipe. O percentual de issues fechadas da milestone não substitui o gate técnico da epic.

**Project nativo:** configuração e importação estão preparadas em `.planning/project.py` e no documento 08. A criação depende de acesso organizacional Projects, não exposto pelo conector atual; o navegador está sem sessão autenticada. Essa limitação não impede issues, milestones, hierarquia e dependências do repositório. Registrar a URL nativa e a evidência aqui quando a autenticação/permissão estiver disponível; não declarar Project criado antecipadamente.

### Condição final de 100%

- [ ] Quatro fluxos operacionais e homologados, com quatro números Coexistence e isolamento multiempresa comprovados.
- [ ] Portal simples, acesso seguro, credenciais corretas e funções legadas preservadas/corrigidas.
- [ ] Msg4/Suite4 operam sem dependência indevida de token global e projeções recuperam falhas.
- [ ] Build/release Docker Hub, Compose, SDD, CI, observabilidade, restore e rollback comprovados.
- [ ] Produção estabilizada e legado retirado somente após evidência de não uso.
'''


def build(mapping=None):
    tasks = load_catalog()
    config = json.loads((ROOT / "bootstrap.json").read_text())
    items = [{"key": "PROGRAM", "title": "[META v2] Programa de reconstrução: arquitetura, implantação e operação", "body": program_body(config, tasks, mapping), "labels": ["program:meta-v2", "type:program", "priority:P0"]}]
    for m in config["milestones"]:
        items.append({"key": m["key"], "milestone": int(m["key"][1:]), "title": f'[{m["key"]}] {m["title"].split(" · ",1)[1]} — plano e gate de conclusão', "body": epic_body(m["key"], m, tasks, mapping), "labels": ["program:meta-v2", "type:epic", "priority:P0"], "parent": "PROGRAM"})
    done = set()
    ordered = []
    while len(ordered) < len(tasks):
        ready = [x for x in tasks if x["key"] not in done and all(d in done for d in x["deps"])]
        if not ready:
            raise ValueError("Dependency cycle in planning catalog")
        for t in ready:
            done.add(t["key"])
            ordered.append(t)
    for t in ordered:
        labels = ["program:meta-v2", "type:work-package", "priority:" + t["priority"], "area:" + t["area"]]
        if t["external"]:
            labels.append("evidence:external-required")
        items.append({**t, "title": f'[{t["key"]}] {t["title"]}', "body": task_body(t, mapping), "labels": labels, "milestone": int(t["milestone"][1:]), "parent": t["milestone"]})
    return {"repository": REPO, "baseline": BASELINE, "branch": BRANCH, "items": items}


if __name__ == "__main__":
    map_path = ROOT / "issues-map.json"
    mapping = json.loads(map_path.read_text()) if map_path.exists() else {}
    data = build(mapping)
    (ROOT / "manifest.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"items": len(data["items"]), "tasks": len(load_catalog()), "characters": sum(len(x["body"]) for x in data["items"])}))
