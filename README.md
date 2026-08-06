# WABot

Bot de WhatsApp com IA (Google Gemini), ranking de mensagens, futebol em tempo real e dashboard web com analytics.

## Estrutura

```
bot/          # Processo principal — WhatsApp + comandos
server/       # Dashboard web — ranking + gráficos analytics
```

## Setup

### 1. Criar `.env` na raiz (copiar do exemplo)

```bash
cp .env.example .env
```

Editar com as tuas chaves:

```env
GEMINI_API_KEY=sua_chave_gemini
FOOTBALL_API_KEY=sua_chave_api_football
```

### 2. Configurar `bot/config.json`

```json
{
  "groups": [],
  "disabledCommands": [],
  "groupDisabledCommands": {},
  "trollMode": [],
  "botAliases": ["bot"],
  "rateLimit": {
    "userMaxPerMinute": 3,
    "groupMaxPerMinute": 15
  }
}
```

### 3. Criar diretórios de dados

```bash
mkdir -p data/auth_info data/pgdata
```

### 4. Build com Earthly

```bash
earthly +build
```

Isto cria duas imagens:
- `wabot-bot:latest` — bot WhatsApp + comandos
- `wabot-server:latest` — dashboard web + analytics

### 5. Run

```bash
docker compose up -d
```

Na primeira execução, ver os logs para escanear o QR code:

```bash
docker compose logs -f bot
```

Escaneia com WhatsApp > Aparelhos Conectados.

### 6. Descobrir IDs dos grupos

Deixa `"groups": []` no `config.json` e inicia o bot. Após conectar, o bot lista todos os grupos com ID e nome nos logs. Copia os IDs desejados para o `config.json` e reinicia:

```bash
docker compose restart bot
```

## Dev local (sem Docker para bot/server)

### 1. Iniciar TimescaleDB

```bash
mkdir -p data/pgdata
docker compose up timescaledb -d
```

### 2. Configurar `.env`

```env
DATABASE_URL=postgres://wabot:wabot@localhost:5432/wabot
GEMINI_API_KEY=sua_chave
FOOTBALL_API_KEY=sua_chave
```

### 3. Instalar dependências

```bash
cd bot && npm install && cd ..
cd server && npm install && cd ..
```

### 4. Iniciar bot e server

```bash
# Terminal 1 — bot
cd bot && node wa.js

# Terminal 2 — server
cd server && node server.js
```

O bot corre as migrations automaticamente ao arrancar (cria tabelas, hypertable e continuous aggregates no TimescaleDB).

## Serviços

| Serviço | Porta | Descrição |
|---------|-------|-----------|
| `timescaledb` | `5432` | PostgreSQL + TimescaleDB |
| `bot` | — | WhatsApp bot + comandos |
| `server` | `3000` | Dashboard web + analytics |

### Dashboard

| Página | URL | Descrição |
|--------|-----|-----------|
| Grupos | `/` | Lista de grupos monitorizados |
| Ranking | `/group.html?id=<uuid>` | Ranking + drilldowns (manhã/noite) |
| Analytics | `/charts.html?id=<uuid>` | 6 gráficos interativos |
| Calendário | `/calendar.html?id=<uuid>` | Calendário de atividade |
| Admin | `/admin/` | Gestão de grupos e comandos |

## Variáveis de ambiente

Ver `.env.example` para o template completo.

| Variável | Obrigatório | Default | Descrição |
|----------|:-----------:|---------|-----------|
| `DATABASE_URL` | sim | `postgres://wabot:wabot@localhost:5432/wabot` | Connection string PostgreSQL |
| `GEMINI_API_KEY` | sim | — | Chave da API Google Gemini |
| `FOOTBALL_API_KEY` | sim | — | Chave da API-Football (api-football.com) |
| `GEMINI_MODEL` | | `gemini-2.5-flash` | Modelo Gemini |
| `PORT` | | `3000` | Porta do dashboard |
| `TZ` | | `Europe/Lisbon` | Timezone para período manhã/noite |
| `LOG_LEVEL` | | `info` | Nível de log (debug, info, warn, error) |
| `VERBOSE` | | `false` | Loga prompts e respostas do Gemini |
| `MONITOR_INTERVAL` | | `30000` | Intervalo do monitor de métricas (ms) |
| `LIVE_DOMAIN` | | `http://localhost:3000` | Domínio para links do `!live` |
| `JWT_SECRET` | | auto-generated | Secret para assinar JWTs |
| `AUTH_DIR` | | `auth_info` | Diretório da sessão WhatsApp |
| `ADMIN_EMAIL` | | — | Email do admin para login no dashboard |
| `ADMIN_PASSWORD` | | — | Password do admin |

## Comandos do bot

| Comando | Aliases | Descrição |
|---------|---------|-----------|
| `/bot help` | `ajuda` | Lista comandos disponíveis |
| `/bot stats` | `rank`, `ranking` | Ranking de mensagens |
| `/bot ai <pergunta>` | `ruru`, `lunga`, `tata` | Pergunta à IA (Google Search) |
| `/bot news <tema>` | `news`, `noticias`, `noticia` | Notícias recentes (últimos 4 dias) |
| `/bot fut <pergunta>` | `futebol`, `football`, `golo`, `bola` | Futebol — linguagem natural com API-Football |
| `/bot versiculo [tema]` | `biblia`, `verso` | Versículo bíblico |
| `/bot parabens <nome>` | `felizaniversario` | Mensagem de parabéns |
| `/bot food <tipo>` | `food`, `rango`, `comida` | Restaurantes próximos (Google Maps) |
| `/bot profile` | `perfil` | Perfil dos integrantes |
| `/bot live` | `aovivo`, `online`, `zaprats` | Link temporário para o dashboard |
| `/bot weather <cidade>` | `tempo`, `meteo`, `clima` | Previsão meteorológica |

Prefixos suportados: `/` e `!` (ex: `!news petróleo`, `!fut jogos do Benfica`)

### Comando !fut — exemplos

O Gemini decide automaticamente qual endpoint chamar via function calling:

```
!fut jogos do Benfica hoje
!fut classificação da Premier League
!fut melhores marcadores da Champions
!fut Benfica vs Porto últimos jogos
!fut lesões do Barcelona
```

## Configuração avançada

### Desabilitar comandos por grupo

```json
{
  "groupDisabledCommands": {
    "120363148177871914@g.us": ["news", "food"]
  }
}
```

### Troll mode por grupo

```json
{
  "trollMode": ["120363148177871914@g.us"]
}
```

### Rate limit

```json
{
  "rateLimit": {
    "userMaxPerMinute": 3,
    "groupMaxPerMinute": 15
  }
}
```

### Personalizar prompts

```
bot/prompts/
  RULES.md              # Regras globais (segurança, tom)
  ai/command.md          # Prompt do comando ai
  news/command.md        # Prompt do comando news
  news/noticias.md       # Fontes brasileiras (alias noticias)
  food/command.md        # Prompt do comando food
  fut/command.md         # Prompt do comando fut
  fut/context.md         # IDs de equipas/ligas conhecidos
  versiculo/command.md   # Prompt do comando versiculo
  parabens/command.md    # Prompt do comando parabens
  profile/command.md     # Prompt do comando profile
```

O sistema carrega: `RULES.md` + `<comando>/command.md` + `<comando>/<alias>.md` (se existir).

## Volumes persistentes

| Volume | Host path | Container path | Descrição |
|--------|-----------|----------------|-----------|
| `wabot-auth` | `./data/auth_info/` | `/app/auth_info` | Sessão WhatsApp (não perder) |
| `wabot-pgdata` | `./data/pgdata/` | `/var/lib/postgresql/data` | Dados PostgreSQL/TimescaleDB |

Para usar paths custom, defina `AUTH_PATH` e `PGDATA_PATH` no `.env`.

## Comandos úteis

```bash
# Build imagens
earthly +build

# Build só bot ou só server
earthly +bot-image
earthly +server-image

# Containers
docker compose up -d              # Start tudo
docker compose up timescaledb -d  # Só database (dev local)
docker compose logs -f bot        # Logs do bot
docker compose logs -f server     # Logs do dashboard
docker compose restart            # Reiniciar tudo
docker compose down               # Parar tudo
```
