# LeadFlow API — Deploy na Vercel (grátis)

Este pacote é o **backend** do LeadFlow (Express + Supabase + Mercado Pago PIX).
O frontend (console) continua hospedado no pplx.app; a API roda na Vercel.

São 5 passos. Tempo estimado: ~20 min.

---

## 1. Criar conta/repositório no GitHub

1. Se não tiver conta no [github.com](https://github.com), crie (grátis).
2. Crie um **novo repositório** (ex.: `leadflow-api`), **público ou privado**.
3. Faça upload de **todos os arquivos deste pacote**:
   - `server.js`
   - `api/index.js`
   - `vercel.json`
   - `package.json`
   - `package-lock.json`
   - `.gitignore`
   - (NÃO suba `.env` nem `node_modules` — o `.gitignore` já bloqueia)

> No GitHub: botão **Add file → Upload files** e arraste os arquivos.
> IMPORTANTE: a pasta `api/` precisa virar uma pasta `api/` no repo (o `index.js` fica dentro dela).

---

## 2. Importar na Vercel

1. Acesse [vercel.com](https://vercel.com) e entre com sua conta GitHub.
2. Clique **Add New → Project**.
3. Escolha o repositório `leadflow-api` → **Import**.
4. A Vercel detecta o framework automaticamente (Node). **Não mude nada** nas configurações de build.
5. **NÃO clique em Deploy ainda** — primeiro adicione as variáveis de ambiente (passo 3).

---

## 3. Adicionar variáveis de ambiente

Em **Environment Variables** (na mesma tela de import), adicione cada uma (tipo: **Plain Text**, ambiente: **Production + Preview**):

| Nome | Valor |
|---|---|
| `SUPABASE_URL` | `https://akgngkiocpkuzsftygpz.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `sb_secret_m2OFOtUgkToce8osa7mNZQ_dfnkJ-n1` |
| `SUPABASE_ANON_KEY` | `sb_publishable_PWJGwKCMUINemDy611aWWw_q4Hr24Mn` |
| `MP_ACCESS_TOKEN` | `APP_USR-2902403865168379-071022-90f8fbb786b6f8e253b6ad426aae41fd-1079933240` |
| `MP_PUBLIC_KEY` | `APP_USR-850f1bfe-d640-4502-b9f4-1f48dea10d3f` |
| `MP_WEBHOOK_URL` | (deixe vazio por enquanto — vamos preencher no passo 5) |
| `PORT` | `8000` |

> ⚠️ Depois de colar tudo, **clique Deploy**.

---

## 4. Pegar a URL da API

Quando o deploy terminar, a Vercel mostra uma URL tipo:

```
https://leadflow-api-xxxx.vercel.app
```

(teste abrindo `https://SUA-URL.vercel.app/api/health` no navegador — deve retornar `{"ok":true,...}`)

**Me envie essa URL** (ex.: `https://leadflow-api-abc.vercel.app`).
Eu atualizo o frontend pra apontar pra ela e republico no pplx.app.

---

## 5. Configurar o webhook do Mercado Pago

Depois que eu confirmar que o frontend está apontando pra sua URL da Vercel:

1. A URL do webhook será: `https://SUA-URL.vercel.app/api/mp/webhook`
2. Volte na Vercel → Settings → Environment Variables → edite `MP_WEBHOOK_URL` com essa URL completa → **Redeploy**.
3. No [Mercado Pago](https://www.mercadopago.com.br/developers/panel/app): sua aplicação → **Notificações/Webhooks** → adicione a URL acima, marque evento **Pagamento (payment)**.
4. Avise-me que configurou. Vou fazer um pagamento de teste pra validar o fluxo completo.

---

## Segurança (recomendado antes de lançar pra clientes)

As chaves do Supabase e do Mercado Pago foram coladas neste chat.
Antes de abrir pra clientes de verdade, **regenere**:
- **Supabase service key**: Supabase → Settings → API → reset `service_role` key.
- **MP Access Token**: Mercado Pago → suas credenciais → regenerar.
Depois atualize as variáveis na Vercel e me avise pra eu atualizar onde precisar.
