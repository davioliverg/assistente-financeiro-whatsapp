# Assistente financeiro no WhatsApp

Bot que anota gastos e ganhos enviados por WhatsApp (texto, áudio ou foto de recibo),
categoriza com IA e responde a perguntas como "quanto gastei este mês?".

```
WhatsApp ──► Meta Cloud API ──► POST /webhook (este servidor)
                                   │
                                   ├─ IA (Gemini): interpreta texto / áudio / recibo → JSON
                                   ├─ Postgres: guarda lançamentos por utilizador
                                   └─ responde no WhatsApp (confirmação ou resumo)
```

## O que já faz

- **Texto**: `mercado 120`, `uber 8,50 ontem`, `recebi 900 do cliente` (vários na mesma mensagem).
- **Áudio**: nota de voz a dizer o gasto.
- **Foto / PDF de recibo**: regista o total, a loja e a data.
- **Resumos**: `quanto gastei este mês?`, `resumo da semana`, `quanto gastei em transporte em outubro?`.
- **Ver, apagar e corrigir**: `mostra os últimos gastos`, `apagar último`, `apagar o uber`, `corrige o mercado para 110`.
- **Gastos fixos**: `netflix 13,99 todo mês dia 5`, `renda 450 dia 1`, `salário 1200 todo dia 28`. São anotados
  sozinhos no dia marcado, todos os meses. `meus gastos fixos` lista-os; `cancela o fixo da netflix` cancela.
- **Painel web**: envie `painel` e o bot responde com um link pessoal (válido 15 minutos) para ver gráficos
  por categoria, por dia e dos últimos 6 meses, mais a lista de lançamentos. Sem palavra-passe.
- **Pronto para vários utilizadores**: cada número de telefone tem os seus dados separados.
  Enquanto for só seu, `ALLOWED_NUMBERS` bloqueia todos os outros números.

As somas são sempre feitas na base de dados; a IA só interpreta a mensagem.

## Do que precisa

1. **Node.js 20+**
2. **Conta Meta for Developers** com uma app que tenha o produto WhatsApp
3. **Chave da API Gemini** (Google AI Studio)
4. **Postgres** (Render, Supabase, Neon ou local)
5. **Um endereço público HTTPS** para o webhook (deploy no Render, ou ngrok/cloudflared para testar no PC)

## Configuração passo a passo

### 1. Projeto

```bash
npm install
cp .env.example .env      # no Windows: copy .env.example .env
npm test                  # 7 testes com a Meta e a IA simuladas; não precisa de chaves
```

### 2. WhatsApp (Meta)

1. Em https://developers.facebook.com crie uma app do tipo **Business** e adicione o produto **WhatsApp**.
2. Em **WhatsApp > Configuração da API** a Meta dá um **número de teste** gratuito. Copie:
   - o **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - o **token de acesso temporário** → `WHATSAPP_TOKEN` (expira em ~24 h; ver "Token permanente")
3. Na mesma página, adicione o seu número pessoal à lista de destinatários do número de teste.
4. Em **Configurações da app > Básico**, copie a **Chave secreta da app** → `META_APP_SECRET`.
5. Invente um texto para `WEBHOOK_VERIFY_TOKEN`.
6. Coloque o seu número em `ALLOWED_NUMBERS`, só dígitos com o código do país (ex.: `351912345678`).

### 3. IA e base de dados

- Crie a chave em https://aistudio.google.com/apikey → `GEMINI_API_KEY`.
- Confirme o nome do modelo Flash estável em https://ai.google.dev/gemini-api/docs/models
  e ajuste `GEMINI_MODEL` se for diferente.
- Coloque a ligação do Postgres em `DATABASE_URL`. As tabelas são criadas sozinhas no arranque.

### 4. Pôr no ar

**Render** (o `render.yaml` cria o serviço e a base de dados): suba o projeto para um
repositório no GitHub, crie um Blueprint no Render a partir dele e preencha as variáveis.

**No PC, para testar**: `npm start` e, noutro terminal, `ngrok http 3000` (ou `cloudflared tunnel --url http://localhost:3000`).

### 5. Ligar o webhook

Em **WhatsApp > Configuração > Webhook** no painel da Meta:

- URL de retorno: `https://SEU-ENDERECO/webhook`
- Token de verificação: o mesmo de `WEBHOOK_VERIFY_TOKEN`
- Depois de verificar, subscreva o campo **messages**.

Mande `ajuda` do seu WhatsApp para o número de teste. Se responder, está a funcionar.

## Token permanente

O token do painel expira. Para uso contínuo, crie um **System User** no Meta Business
(Configurações do negócio > Utilizadores do sistema), atribua-lhe a app e a conta WhatsApp,
e gere um token com as permissões `whatsapp_business_messaging` e `whatsapp_business_management`.

## Limites a conhecer

- **Só responde, não inicia conversas.** O WhatsApp só permite mensagens livres até 24 h depois
  da última mensagem do utilizador. Lembretes ("não anotou nada hoje") exigem modelos de
  mensagem aprovados pela Meta, que são pagos.
- **Planos gratuitos**: no Render, o serviço gratuito adormece sem tráfego e a primeira mensagem
  demora; a Meta reenvia e o bot ignora duplicados. Confirme os limites atuais do Postgres gratuito.
- **Não testado contra as APIs reais.** Os testes automáticos simulam a Meta e o Gemini; o primeiro
  teste real é o passo 5. Se a IA devolver erro 400/404, o motivo mais provável é o nome do modelo.

## Antes de vender

- **Número próprio e verificação do negócio** na Meta (o número de teste só fala com números autorizados).
- **Privacidade (RGPD/LGPD)**: são dados financeiros. Precisa de política de privacidade, consentimento,
  forma de exportar/apagar dados, e de usar a API de IA num plano pago cujos termos não usem os dados
  dos clientes para treino (confirme os termos do plano gratuito do Gemini).
- **Marca própria**: escolha um nome e identidade seus (`BOT_NAME`); não use o nome nem a imagem de produtos existentes.
- **Ainda por construir**: pagamentos/assinaturas, limites por utilizador,
  parcelas, esvaziar `ALLOWED_NUMBERS` e criar um fluxo de registo.

## Estrutura

| Ficheiro | Função |
|---|---|
| `src/server.js` | Servidor, verificação e assinatura do webhook |
| `src/handler.js` | Decide o que fazer com cada mensagem |
| `src/ai.js` | Prompt, chamada ao Gemini e validação da resposta |
| `src/whatsapp.js` | Enviar mensagens e descarregar áudio/fotos |
| `src/db.js` | Tabelas e consultas (Postgres) |
| `src/format.js` | Textos das respostas |
| `src/recurring.js` | Gastos fixos: datas e lançamento mensal |
| `src/auth.js` | Links e sessões assinados do painel |
| `src/painel.js` | Rotas e dados do painel web |
| `public/` | Página do painel (CSS e JavaScript) |
| `src/config.js` | Variáveis de ambiente e lista de categorias |
