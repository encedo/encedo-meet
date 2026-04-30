# Deploy plan — encedo-meet na serwerze (HSM testing)

## Cel

Wdrożyć encedo-meet na zdalnym serwerze żeby testować HSM attestation
z 2-3 urządzeniami Encedo USB na różnych komputerach.

## Architektura

```
Internet (HTTPS)
      │
      ▼
  Caddy (reverse proxy) — Let's Encrypt automatycznie
      ├── meet.domain.com  →  jitsi-meet (nasz fork, web container)
      └── app.domain.com   →  encedo-meet-host (static Vite build, nginx)

  JVB: UDP 10000 (media, bezpośrednio do klientów)
```

Dwie subdomeny — Jitsi musi siedzieć na root path (nie działa na `/subpath/`).

## Struktura plików

```
encedo-meet/
├── docker-compose.yml          ← główny plik
├── Caddyfile                   ← reverse proxy + SSL
├── .env                        ← sekrety (XMPP passwords, domain)
├── docker-jitsi-meet/          ← official Jitsi stack (prosody/jicofo/jvb configs)
├── jitsi-meet/                 ← nasz fork → własny Dockerfile
├── encedo-meet-host/           ← Vite build → nginx container
└── nginx/                      ← (opcjonalnie zamiast Caddy)
    └── conf.d/
```

## Serwisy docker-compose

| Serwis | Obraz | Rola |
|---|---|---|
| `proxy` | caddy:2 | Reverse proxy + Let's Encrypt |
| `prosody` | jitsi/prosody | XMPP server |
| `jicofo` | jitsi/jicofo | Conference focus |
| `jvb` | jitsi/jvb | Media bridge (UDP 10000) |
| `web` | build: ./jitsi-meet | Nasz fork jitsi-meet |
| `encedo-host` | build: ./encedo-meet-host | encedo-meet-host (static + nginx) |

## Caddyfile

```
meet.domain.com {
    reverse_proxy web:80
}

app.domain.com {
    reverse_proxy encedo-host:80
}
```

Caddy sam obsługuje Let's Encrypt — zero ręcznej konfiguracji SSL.

## Dockerfile — jitsi-meet (nasz fork)

```dockerfile
FROM node:20 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN make compile

FROM nginx:alpine
COPY --from=build /app/libs /usr/share/nginx/html/libs
COPY --from=build /app/css /usr/share/nginx/html/css
COPY --from=build /app/index.html /usr/share/nginx/html/
COPY --from=build /app/static /usr/share/nginx/html/static
```

(Do doprecyzowania — Makefile jitsi-meet kopiuje pliki do `libs/`)

## Dockerfile — encedo-meet-host

```dockerfile
FROM node:20 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
```

## Porty

| Port | Protokół | Serwis |
|---|---|---|
| 80 | TCP | Caddy (redirect → 443) |
| 443 | TCP | Caddy (HTTPS) |
| 10000 | UDP | JVB (media) |
| 4443 | TCP | JVB (fallback TCP) |

## .env (szablon)

```
PUBLIC_URL=meet.domain.com
ENCEDO_HOST_URL=app.domain.com
JICOFO_AUTH_PASSWORD=<random>
JVB_AUTH_PASSWORD=<random>
JIBRI_RECORDER_PASSWORD=<random>
PROSODY_ADMIN_PASSWORD=<random>
```

## Kolejność wdrożenia

1. Skonfigurować DNS: `meet.domain.com` i `app.domain.com` → IP serwera
2. Wypełnić `.env`
3. `docker compose build`
4. `docker compose up -d`
5. Sprawdzić logi: `docker compose logs -f web`
6. Test: dwie karty z różnych komputerów z Encedo USB

## Szacowany czas

2-3h żeby docker-compose działał end-to-end na serwerze.
Główny koszt: Dockerfile dla jitsi-meet (webpack build jest długi ~5min).

## Status plików

- [x] `docker-compose.yml` — gotowy
- [x] `jitsi-meet/Dockerfile` — multi-stage: lib-jitsi-meet → jitsi-meet → jitsi/web
- [x] `encedo-meet-host/Dockerfile` — Vite build → nginx
- [x] `Caddyfile` — reverse proxy + auto TLS
- [x] `.env.example` — szablon konfiguracji
- [x] `.dockerignore` — wyklucza node_modules z build context

## Uruchomienie na serwerze

```bash
# 1. Sklonuj repo
git clone ... encedo-meet && cd encedo-meet

# 2. Konfiguracja
cp .env.example .env
nano .env  # uzupełnij: domeny, IP, hasła

# 3. Wygeneruj hasła
openssl rand -hex 16  # JICOFO_AUTH_PASSWORD
openssl rand -hex 16  # JVB_AUTH_PASSWORD

# 4. Przygotuj katalogi konfiguracji Jitsi
mkdir -p ~/.jitsi-meet-cfg/{web,prosody,jicofo,jvb}

# 5. Build i uruchomienie (build jitsi-meet zajmuje ~10 min)
docker compose build
docker compose up -d

# 6. Sprawdź logi
docker compose logs -f web
docker compose logs -f jvb
```

## Weryfikacja działania

```bash
# JVB musi dostać z XMPP (pojawia się w logach prosody)
docker compose logs prosody | grep "jvb"

# JVB musi znać swój publiczny IP (pojawia się przy starcie)
docker compose logs jvb | grep "Advertised"

# Test połączenia UDP z klienta:
# nc -u <IP_serwera> 10000
```

## TODO

- [ ] Przetestować build lokalnie przed wdrożeniem na serwer
- [ ] Upewnić się że `libs/olm.wasm` trafia do obrazu (deploy-olm w Makefile)
- [ ] Zweryfikować czy config.js generowany przez jitsi/web działa z DISABLE_HTTPS=1
