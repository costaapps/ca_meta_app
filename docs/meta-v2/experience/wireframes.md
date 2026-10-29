# Text wireframes for M1.08 states

These low-fidelity layouts reuse the baseline's centered white panels, restrained borders, current headings, platform accents, and card structure. They show the intended hierarchy and actions, not a claim that the current Angular implementation has these states. Responsive order is top-to-bottom as drawn.

## Shared shell

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Msg4  > Canais              Identidade da empresa não confirmada      │
│ Alterações indisponíveis até identificar a empresa com segurança.      │
├────────────────────────────────────────────────────────────────────────┤
│ [Resumo]   [Canais]   [Templates]                         [Notificações]│
│                                                                        │
│ Conteúdo da tela                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

The tenant display label is supplied by an authenticated server context; it is **Not confirmed** by the current SessionContext schema. Until that gap is closed, hide/disable the company switcher, block every tenant-scoped mutation (company switch, onboarding start, refresh job, reauthorization, disconnect, template create, automation save, and notification action), show this identity warning, and keep only server-scoped reads available. Never expose a UUID as a company name.

## Setup / catalog

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Conecte canais Meta ao Msg4 e ao Agent4                                │
│ [existing introduction and product summary preserved]                 │
├────────────────────────────────────────────────────────────────────────┤
│ Inteligência e operação trabalhando juntas [Ver canais conectados]     │
├────────────────────────────────────────────────────────────────────────┤
│ Identidade: [nome seguro] ou aviso acima; sem nome, todos os envios    │
│                                                                        │
│ ┌WhatsApp API────────┐ ┌WhatsApp + aplicativo┐ ┌Instagram───────┐ ┌Facebook────┐
│ │ Explicação breve   │ │ Explicação breve    │ │ Login path*   │ │ Explicação │
│ │ Status/limite claro│ │ Elegibilidade não   │ │ Variante explícita│ │ clara      │
│ │ [Conectar disabled: identifique a empresa com segurança]            │
│ └───────────────────┘ └──────────────────────┘ └───────────────┘ └────────────┘
│ *If both Instagram variants are enabled, show an explicit choice before launch.
└────────────────────────────────────────────────────────────────────────┘
```

On small/embedded width, the cards stack in that order and buttons remain full-width. Disabled choices show a short textual reason next to the disabled control.

## Connection list: loading, empty, error, partial and stale

```text
┌Canais da empresa ativa─────────────────────────────────────────────────┐
│ [status da sessão/contexto] [Adicionar conexão disabled: identidade]  │
│ Loading: “Carregando conexões...” + skeleton rows; no empty message.    │
│ Empty: “Nenhuma conexão nesta empresa.” [Escolher um canal]            │
│ Error: “Não foi possível carregar os canais.” [Tentar novamente]       │
│ Stale: “Última confirmação 09:15. Os dados podem ter mudado.”          │
│                                                                        │
│ ┌WhatsApp + aplicativo · ref. …01─── PARTIAL · status de 09:15───────┐ │
│ │ 2 ativos · Número ••• 0101 [only if a safe masked label exists]     │ │
│ │ Conta: ativo / autorização confirmada                               │ │
│ │ Eventos: status não disponível      [Detalhes] [Atualizar disabled]│ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ ┌WhatsApp + aplicativo · ref. …02─── ATIVO · status de 09:16─────────┐ │
│ │ …                                                                    │ │
│ └────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

Use exact states from `status-copy-matrix.csv`; a banner does not make an asset, connection, and subscription appear to share one state. All pointer targets must be specified and checked at 24×24 CSS px minimum, or a formally applicable SC 2.5.8 exception (spacing, inline, user-agent control, or essential) must be documented and verified; this wireframe is not a conformance result.

## Detail, reauthorization and disconnect

```text
┌Detalhe: WhatsApp + aplicativo · ref. …01───────────────────────────────┐
│ Empresa: [safe label; otherwise shell warning and no tenant writes]    │
│ Conexão: Parcial   Prontidão: Parcial   Confirmado em: 29/10 09:15     │
│                                                                        │
│ Ativos                                                                 │
│ Número ••• 0101   Ativo · autorização confirmada · confirmado 09:15   │
│ Eventos         Status não disponível                                 │
│                                                                        │
│ [Reautorizar disabled: etapa de autorização não disponível ainda]      │
│ [Atualizar disabled: solicitação] [Desconectar disabled: identidade] │
│ Reauth precisa retornar uma referência segura de sessão/abertura.       │
│ Atualização/desconexão retornam trabalho pendente, não sucesso.         │
└────────────────────────────────────────────────────────────────────────┘
```

Disconnect confirmation:

```text
┌Desconectar esta conexão?───────────────────────────────────────────────┐
│ WhatsApp + aplicativo · ref. …01                                       │
│ Isso registra a remoção deste vínculo no Msg4 e inicia uma verificação │
│ separada de limpeza/revogação no provedor. Outras conexões da empresa   │
│ permanecem. O resultado externo pode demorar ou precisar de verificação.│
│ [Cancelar]                    [Solicitar desconexão disabled: identidade]│
└────────────────────────────────────────────────────────────────────────┘
```

After `202`: replace the submit action with “Solicitação iniciada · verificando”; link to the job and offer a status read. Do not close the dialog as a success toast or change all related cards to disconnected.

## Onboarding: popup, return, failure and timeout

```text
┌Conectando Instagram · Empresa ativa: [label]───────────────────────────┐
│ Etapa 1 de N — aguardando autorização                                  │
│ Uma janela do provedor foi aberta. Conclua a etapa e volte a esta aba. │
│ [A janela foi fechada? Verificar status] [Cancelar disabled sem identidade]│
└────────────────────────────────────────────────────────────────────────┘
```

When the popup closes, focus returns to the opener and the current onboarding card stays visible. A status read maps to one of:

```text
Awaiting / Running  → “Aguardando confirmação.” [Verificar status]
Partial             → “Conexão parcial: [verified safe step summary].” [Ver detalhes]
Reauth required     → “A autorização precisa ser atualizada.” [Reautorizar disabled: abertura segura indisponível]
Expired / Cancelled → “Esta etapa terminou sem concluir.” [Iniciar novamente only with safe identity and confirmed no pending effect]
Unknown / timeout   → “Ainda não foi possível confirmar o resultado.” [Ver status]
API error           → “O status não carregou; nenhum novo envio foi iniciado.” [Tentar leitura]
```

The UI only offers “Iniciar novamente” after a current read proves no previous external effect is unresolved and a safe company identity is displayed. If `nextAction=RECONCILE`, state is `UNKNOWN`, or the company identity is unavailable, offer a read/status action and block the provider action.

## Templates, automation, notifications

```text
┌Templates WhatsApp─────────────────────────────────────────────────────┐
│ Número [selector, explicit label]  Status consultado [time]           │
│ [approved/pending/rejected/paused/unknown cards]                      │
│ [Existing form: name, category, language, body, example variables]     │
│ [Criar disabled: identidade não confirmada ou contrato incompleto]    │
│ If the API cannot preserve a current field, explain it is unavailable │
│ and do not silently save a reduced form.                               │
└────────────────────────────────────────────────────────────────────────┘

┌Automação───────────────────────────────────────────────────────────────┐
│ Boas-vindas privadas [read-only until full contract mapping]            │
│ Replies for Instagram/Facebook [read-only until field mapping]          │
│ [Salvar disabled + explanation] → 412 reload/review if later enabled   │
└────────────────────────────────────────────────────────────────────────┘

┌Notificações────────────────────────────────────────────────────────────┐
│ Atualizado 09:15 [Atualizar]                                           │
│ Loading / empty / error states remain visible and distinct             │
│ [safe summary, channel, date]                                          │
│ Mutation actions disabled until safe company identity is available      │
│ Reply disabled until authorized message context is available            │
│ If later enabled: “Solicitado · acompanhando entrega” + job/status link │
└────────────────────────────────────────────────────────────────────────┘
```

Keep notification controls keyboard reachable. A reply has external effect; after timeout or `UNKNOWN`, read the job/operation and do not render an immediate second-send CTA.
