# Experimento offline de compatibilidade M1.03

## Setup e execução

Requer Python 3.10 ou posterior. Foi executado neste pacote com Python 3.13.7. Usa somente a biblioteca padrão; não exige instalação de pacotes, serviço externo ou lockfile.

Na raiz do repositório:

```powershell
python --version
python tools/m1-03/validate_capabilities.py
```

## Dados, isolamento e cleanup

`fixtures/capability-profiles.json` contém apenas IDs de app, ambientes, rótulos de versões Graph/Embedded Signup, variantes de login e capacidades **sintéticos**. Esses valores não nomeiam versões Meta atuais, permissões grantable ou configurações elegíveis. O runner não faz chamadas de rede, não lê variáveis de ambiente e não trata credenciais. Ele só lê o fixture versionado e imprime resultados; não cria banco, arquivos temporários ou estado persistente. Não há cleanup externo necessário.

Os cenários verificam seleção explícita do perfil por app e ambiente, versões Graph e Embedded Signup em campos separados, rejeição de mismatches, operação ausente no perfil, variante de auth pertencente a outro fluxo e registro convencional de telefone no adapter Coexistence. Os nomes de capacidade são operações internas do produto, não scopes Meta.

A saída esperada termina com `12/12 compatibility cases passed; all profiles are synthetic and offline.` O experimento cobre o guard de configuração local. Não certifica comportamento da API, App Review, grants, elegibilidade, Sandbox ou produção.
