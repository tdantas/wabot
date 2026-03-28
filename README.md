# WABot

Bot de WhatsApp com IA (Google Gemini), ranking de mensagens e dashboard web.

## Estrutura

```
bot/          # Processo principal — WhatsApp + comandos
server/       # Dashboard web — ranking em tempo real
```

## Docker

### 1. Criar `.env` no diretório `bot/`

```env
GEMINI_API_KEY=sua_chave_aqui
GEMINI_MODEL=gemini-2.5-flash
VERBOSE=false
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

### 3. Build e run

```bash
docker compose up -d --build
```

Na primeira execução, ver os logs para escanear o QR code:

```bash
docker compose logs -f bot
```

Escaneia com WhatsApp > Aparelhos Conectados.

### 4. Descobrir IDs dos grupos

Deixa `"groups": []` no `config.json` e inicia o bot. Após conectar, o bot lista todos os grupos com ID e nome nos logs. Copia os IDs desejados para o `config.json` e reinicia:

```bash
docker compose restart bot
```

### Serviços

| Serviço | Porta | Descrição |
|---------|-------|-----------|
| `bot` | — | WhatsApp bot + comandos |
| `server` | `3000` | Dashboard web com ranking |

### Volumes persistentes

| Volume | Descrição |
|--------|-----------|
| `bot/auth_info/` | Sessão WhatsApp (não perder) |
| `bot/wabot.db` | Base de dados SQLite |

### Comandos úteis

```bash
# Ver logs do bot
docker compose logs -f bot

# Ver logs do dashboard
docker compose logs -f server

# Reiniciar tudo
docker compose restart

# Parar tudo
docker compose down

# Rebuild após alterações
docker compose up -d --build
```

## Variáveis de ambiente

| Variável | Default | Descrição |
|----------|---------|-----------|
| `GEMINI_API_KEY` | — | Chave da API Google Gemini (obrigatório) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Modelo Gemini a usar |
| `VERBOSE` | `false` | Loga prompts e respostas do Gemini |
| `LOG_LEVEL` | `info` | Nível de log (debug, info, warn, error) |
| `TZ` | `Europe/Lisbon` | Timezone para período manhã/noite |
| `AUTH_DIR` | `auth_info` | Diretório da sessão WhatsApp |
| `DB_PATH` | `bot/wabot.db` | Caminho do SQLite |
| `PORT` | `3000` | Porta do dashboard |

## Comandos do bot

| Comando | Aliases | Descrição |
|---------|---------|-----------|
| `/bot help` | `ajuda` | Lista comandos disponíveis |
| `/bot stats [hoje\|semana\|mes\|dia\|periodo]` | `rank`, `ranking`, `offline` | Ranking de mensagens |
| `/bot ai <pergunta>` | `ruru`, `lunga`, `tata` | Pergunta à IA (Google Search) |
| `/bot news <tema>` | `news`, `noticias` | Notícias recentes sobre um tema |
| `/bot versiculo [tema]` | `biblia`, `verso` | Versículo bíblico |
| `/bot parabens <nome>` | `felizaniversario` | Mensagem de parabéns |
| `/bot food <tipo>` | `food`, `rango`, `comida` | Restaurantes próximos (Google Maps) |
| `/bot profile` | `perfil` | Perfil dos integrantes |

Prefixos suportados: `/` e `!` (ex: `!news petróleo`)

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
  versiculo/command.md   # Prompt do comando versiculo
  parabens/command.md    # Prompt do comando parabens
  profile/command.md     # Prompt do comando profile
```

O sistema carrega: `RULES.md` + `<comando>/command.md` + `<comando>/<alias>.md` (se existir).

## Food — como funciona

1. Utilizador envia `!food marisqueira`
2. Bot pede para enviar localização como reply
3. Utilizador responde com localização do WhatsApp
4. Bot pesquisa via Google Maps e retorna resultados
