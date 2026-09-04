# PEKSON WEZA — Bwin vs WezaBet

Merenje kašnjenja gola: **Bwin** protiv **WezaBet** (Node WS + Chrome).

Sokabet se ne koristi. Ako Bwin (3200) već radi, start ga ne dira.

| Servis | Port | Šta radi |
|---|---|---|
| `bwin-live.mjs` | 3200 | Bwin live (opciono — samo ako već ne radi) |
| `wezabet-live.mjs` | 3301 | WezaBet Node WebSocket |
| `wezabet-chrome-live.mjs` | 3303 | WezaBet Chrome / Puppeteer |
| `compare-wezabet.mjs` | 3302 | Uparivanje + GK/GG |

Merenje kreće samo kad je Bwin score ispred bar jednog WezaBet score-a. GK/GG uzima brži WezaBet izvor (Node ili Chrome).

## Preduslovi

- Windows 10/11 + PowerShell
- Node.js 18+ (`node -v`) — https://nodejs.org
- Google Chrome
- Internet

## Instalacija (prvi put)

```powershell
git clone https://github.com/genije1234-debug/PEKSON-WEZA.git
cd PEKSON-WEZA
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

## Pokretanje

Dupli klik na `POKRENI-WEZABET-KASNJENJE.bat`  
ili:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-wezabet.ps1
```

Start:

1. Gasi staro WezaBet merenje (Bwin ostaje).
2. Digne 3301, 3303, 3302.
3. Digne Bwin 3200 samo ako već ne sluša.
4. Otvara Chrome sa tabovima 3302 / 3301 / 3303 / 3200.

## Gašenje

Dupli klik na `STOP-WEZABET-KASNJENJE.bat`  
ili:

```powershell
powershell -ExecutionPolicy Bypass -File .\stop-wezabet.ps1
```

Gasi samo WezaBet servise (3301, 3302, 3303) i njihov Chrome. **Bwin 3200 ostaje.**

## Adrese

- http://localhost:3200/ — Bwin
- http://localhost:3301/ — WezaBet Node
- http://localhost:3303/ — WezaBet Chrome
- http://localhost:3302/ — compare

Health:

- 3200 → http://localhost:3200/data
- 3301 → http://localhost:3301/health
- 3303 → http://localhost:3303/health
- 3302 → http://localhost:3302/

## Telegram (opciono)

```powershell
$env:TG_TOKEN = "tvoj-bot-token"
$env:TG_CHAT_ID = "tvoj-chat-id"
```

Ako su prazne, program radi bez Telegrama.

## Konfig

- `package.json` — `puppeteer-core`
- `start-wezabet.ps1` / `stop-wezabet.ps1`
- `.gitignore` — `node_modules`, Chrome profili, logovi, `.pids-wezabet.json`
