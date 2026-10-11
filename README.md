# Origem do cadastro no app

[![ci](https://github.com/rodrigoserraotrafegopago-netizen/conty-origem-cadastro/actions/workflows/ci.yml/badge.svg)](https://github.com/rodrigoserraotrafegopago-netizen/conty-origem-cadastro/actions/workflows/ci.yml)

Contrato e API para saber se o criador chegou por campanha, indicação, comunidade ou se é orgânico, mesmo quando o link abre no navegador interno do Instagram ou do WhatsApp, que não manda referrer.

Node 22.13+ · TypeScript · Hono · SQLite (`node:sqlite`) · Vitest

```bash
npm install
npm test            # 34 testes
npm run dev         # http://127.0.0.1:3006, com três links de exemplo
```

`npm run lint` e `npm run typecheck` também rodam no CI. Variáveis (em `.env.example`; o `.env` é lido se existir): `ATTRIBUTION_WINDOW_DAYS` (janela, padrão `7`, validada na subida) e `APP_OPEN_URL` (destino do redirecionador, padrão `https://conty.app/abrir`).

## Contrato

Nada depende de referrer. O que importa vai na URL e no `device_id` que o app guarda.

**1. O link.** O link público é estático, pode ir na bio, no anúncio ou num grupo: `https://conty.app/l/{código}`. O código aponta para o tipo e a referência (`POST /links`).

| Tipo | Link | Aponta para |
| --- | --- | --- |
| Campanha | `https://conty.app/l/cmp-verao26-ig` | `campaign` / `cmp_verao26` |
| Indicação | `https://conty.app/l/ind-ana` | `referral` / `crt_ana`, quem convidou |
| Comunidade | `https://conty.app/l/com-ugc-sp` | `community` / `grp_ugc_sp` |

O redirecionador (`GET /l/:code`) gera um `click_id` novo a cada clique e manda para o app com os dois na URL:

```
https://conty.app/l/cmp-verao26-ig
  → 302 https://conty.app/abrir?link=cmp-verao26-ig&click=9c0bdb15-5a31-4779-b28b-b5d57e40ee87
```

**2. A primeira abertura.** Na primeira vez que abre, o app gera um `device_id` e o guarda (localStorage na web, keychain no nativo). Em toda abertura, chama `POST /app/opens` com `{ device_id, link?, click? }`, lidos da URL.

- A API grava a primeira abertura do aparelho uma vez só, no relógio do servidor. É dela que conta a janela.
- Se a abertura veio de um link, vira um toque. O mesmo clique no mesmo aparelho (recarregar a página, retry do app) é um toque só.
- O clique só vale se o redirecionador o gerou para aquele link. Sem clique (URL copiada), conta no máximo um toque por link e aparelho. Com um clique inventado ou de outro link, também, e a resposta traz `click_warning`.
- O clique fica com o primeiro aparelho que abre o app com ele, e um índice único no banco garante isso. A mesma URL aberta em outro aparelho (um convite repassado num grupo, por exemplo) vale como link copiado: um toque por link e aparelho, com `click_id_source: "derived"` e `click_warning`. Assim um clique nunca vira duas origens, e a resposta deixa claro quando o toque não veio de um clique verificado.

**3. O cadastro.** O backend do cadastro chama `POST /signups` com `{ user_id, device_id }`. A origem é decidida uma vez e a decisão inteira fica guardada. Chamar de novo devolve a mesma decisão, então um link aberto depois não muda nada. O mesmo usuário com outro aparelho devolve `409`.

## Qual toque vence

A regra é uma função pura em `src/attribution.ts`:

1. **Janela:** 7 dias a partir da primeira abertura do app no aparelho, inclusive. Toque depois disso não conta, e cadastro depois disso é orgânico.
2. Toque aberto depois do cadastro não conta.
3. **Vence o primeiro toque válido:** o link que trouxe a pessoa ou, se a primeira abertura foi orgânica, o primeiro link que ela abriu depois. Um link aberto depois não tira a origem de quem trouxe a pessoa: o convite de uma criadora não é sobrescrito por um anúncio visto na véspera do cadastro.
4. **Empate no mesmo instante:** indicação > comunidade > campanha. Indicação é convite pessoal, o sinal mais forte de intenção. Mesmo tipo no mesmo instante: ordem de chegada.
5. Sem toque válido, o cadastro fica `organic` com o motivo gravado (nenhum link, cadastro fora da janela, aparelho sem primeira abertura), nunca como dado faltando.

Num celular compartilhado, os toques até cada cadastro anterior já foram usados por ele, e o motivo diz qual cadastro os usou.

## Exemplo de cadastro

A pessoa abriu o app pela primeira vez pelo link da campanha, recarregou a página (mesmo clique) e depois abriu o convite da Ana. Resposta real de `POST /signups`:

```json
{
  "user_id": "usr_ana_maria",
  "device_id": "dev-7f3a9c",
  "signed_up_at": "2026-10-11T04:04:38.696Z",
  "origin": { "type": "campaign", "ref": "cmp_verao26", "link": "cmp-verao26-ig", "touch_id": 1 },
  "reason": "campanha: primeiro toque válido, link cmp-verao26-ig aberto em 2026-10-11T04:04:38.633Z",
  "rule": "vence o primeiro toque aberto entre a primeira abertura do app e o cadastro, dentro de 7 dias a partir da primeira abertura; empate no mesmo instante: indicação > comunidade > campanha",
  "window": {
    "days": 7,
    "starts_at": "2026-10-11T04:04:38.633Z",
    "ends_at": "2026-10-18T04:04:38.633Z",
    "signup_inside": true
  },
  "touches": [
    {
      "touch_id": 1, "link": "cmp-verao26-ig", "type": "campaign", "ref": "cmp_verao26",
      "click_id": "a01e0d2a-8aee-444d-8029-64c0fee3dca5", "click_id_source": "link",
      "recorded_at": "2026-10-11T04:04:38.633Z", "outcome": "won", "reason": "primeiro toque válido"
    },
    {
      "touch_id": 2, "link": "ind-ana", "type": "referral", "ref": "crt_ana",
      "click_id": "908953bd-e034-4f7e-97ef-0287bc89de42", "click_id_source": "link",
      "recorded_at": "2026-10-11T04:04:38.685Z", "outcome": "lost", "reason": "um toque válido anterior venceu (vale o primeiro)"
    }
  ]
}
```

O mesmo convite (com o mesmo `click`) aberto depois em outro aparelho. Resposta de `POST /app/opens`:

```json
{
  "device_id": "dev-b21e04",
  "first_open": true,
  "touch": {
    "touch_id": 3, "link": "ind-ana", "type": "referral",
    "click_id": "derived-61323a15321f7b12", "click_id_source": "derived", "duplicate": false, "…": "…"
  },
  "click_warning": "clique já usado em outro aparelho; contado como um toque por link e aparelho",
  "…": "…"
}
```

Cadastro sem link:

```json
{
  "origin": { "type": "organic", "ref": null, "link": null, "touch_id": null },
  "reason": "orgânico: nenhum link aberto antes do cadastro",
  "touches": [],
  "…": "…"
}
```

Outros motivos por toque: `mesmo instante; indicação tem prioridade sobre campanha`, `mesmo instante e mesmo tipo; vale a ordem de chegada`, `clique repetido do mesmo link; vale o primeiro`, `aberto depois do cadastro`, `aberto depois do fim da janela (…)`, `cadastro feito depois do fim da janela (…)`, `já usado pelo cadastro … neste aparelho`.

## Endpoints

| Método | Rota | Quem chama | |
| --- | --- | --- | --- |
| `POST` | `/links` | marketing | `{ code, type, ref, label? }` |
| `GET` | `/l/:code` | quem clica | gera o clique e redireciona para o app |
| `POST` | `/app/opens` | app, em toda abertura | `{ device_id, link?, click? }` |
| `POST` | `/signups` | backend do cadastro | `{ user_id, device_id }`: `201` nova decisão, `200` já decidida |
| `GET` | `/signups/:userId` | auditoria | a decisão guardada |
| `GET` | `/devices/:deviceId` | auditoria | primeira abertura, janela, toques e cadastros |

## Testes

- `attribution.test.ts` (regra pura): dois links, empate de horário (inclusive do mesmo tipo), clique repetido, toque depois do cadastro e antes da primeira abertura, limite da janela (inclusive e 1 ms depois), horários com offset, toques já usados por cadastros anteriores, orgânico com motivo.
- `flow.test.ts` (API): redirecionador, primeira abertura gravada uma vez, mesmo clique sem toque duplicado, clique inválido ou sem link, clique já usado em outro aparelho (inclusive o índice no banco), resposta completa do cadastro, empate, orgânico gravado no banco, link depois do cadastro, janela, janela inválida.

## Decisões

- **Primeiro toque, não último.** Responde "o que trouxe a pessoa", que é a pergunta de quem decide onde investir. Se a Conty quiser medir o que fechou o cadastro, a troca é toda em `src/attribution.ts`, e dá para guardar os dois.
- **Relógio do servidor.** O do aparelho pode estar errado. Com app offline mandando eventos atrasados, seria preciso aceitar o horário do aparelho com correção de desvio.
- **Sem fingerprint.** Não guardo IP nem user agent.
- **Sem migrations.** O schema tem versão (`PRAGMA user_version`), e um banco criado por uma versão anterior é recusado na subida, com a instrução de apagar o arquivo.

## Com mais tempo

- **Instalação pela loja:** no app nativo, o clique se perde até a loja. No Android, o Play Install Referrer devolve `link` e `click` na primeira abertura, e o app chama o mesmo `POST /app/opens`. No iOS não há equivalente confiável; um "código de convite" digitado no cadastro, tratado como toque no momento do cadastro, resolve boa parte dos casos.
- **Celular compartilhado:** a janela conta da primeira abertura do aparelho, então um segundo usuário num aparelho antigo tende a ficar orgânico. A janela poderia recomeçar a cada cadastro.
- Links com validade própria, relatório por origem e limite de taxa no redirecionador.

## Uso de IA

O código, os testes e esta documentação foram escritos com o Claude (Anthropic), a partir das minhas instruções. Acompanhei a sessão, defini o escopo e aprovei a publicação. Não revisei o código linha a linha.
