# Jitsi upstream PR — OLM jako ogólny E2EE transport (propozycja)

> Kontynuacja `Jitsi-changes.md`. Tamte PRy (B1/B2/B3, OLM channel, External API)
> naprawiają istniejące mechanizmy. Te PRy rozszerzają OLM channel do zastosowań
> ogólnych — E2EE dla danych poza media.

---

## Problem statement

Jitsi E2EE chroni dziś **wyłącznie media** (audio/video/screen) przez SFrame.
Pozostałe kanały komunikacji — chat, reakcje, raise hand — idą przez XMPP MUC
lub data channels i są widoczne dla serwera.

Jednocześnie Jitsi ma już gotową infrastrukturę E2EE transportu: **OLM Double
Ratchet** (X25519, forward secrecy), który do tej pory był używany wyłącznie do
dystrybucji kluczy sesji między uczestnikami. Nigdy nie był wystawiony jako
ogólny kanał do własnych danych.

Wynik: integratorzy budujący na Jitsi (przez External API) nie mają żadnego
sposobu na E2EE komunikację poza mediami. Każda alternatywa wymaga własnej
infrastruktury klucza publicznego.

---

## Propozycja: OLM jako ogólny E2EE side-channel

Commit `28beab91` w `lib-jitsi-meet` (nasz fork) już dodał:
```
OlmAdapter.sendCustomMessage(participantId, type, payload)
event: CUSTOM_MESSAGE_RECEIVED
```

Ten prymityw jest **generyczny** — `type` to dowolny string, `payload` to dowolny
obiekt. Nie jest powiązany z Encedo ani ML-KEM. To brakujący element ekosystemu
Jitsi dla każdego integratora chcącego E2EE side-channel.

Proponujemy wystawić go w trzech warstwach:

---

## PR #1 — `lib-jitsi-meet`: OlmAdapter generic custom message channel

**Już zaimplementowane w naszym forku (commit `28beab91`).
Docelowo: upstream PR do `jitsi/lib-jitsi-meet`.**

### Co robi

```javascript
// Wysyłanie — przez istniejącą OLM session, E2EE
conference.sendOlmMessage(participantId, type, payload)
// participantId = '' → broadcast do wszystkich uczestników

// Odbieranie
conference.on(JitsiConferenceEvents.OLM_MESSAGE_RECEIVED,
    (from, type, payload) => { ... })
```

### Diff (skrót)

**`modules/e2ee/OlmAdapter.js`** (~25 linii):
```javascript
OLM_MESSAGE_TYPES = { ..., CUSTOM: 'custom' }
OlmAdapterEvents = { ..., CUSTOM_MESSAGE_RECEIVED: 'olm.custom_message_received' }

sendCustomMessage(participantId, type, payload) {
    // szyfruje przez istniejącą OLM session
    // wysyła przez XMPP private json-message
    // participantId='' → broadcast (pętla po wszystkich sesjach)
}

// w _onEndpointMessageReceived:
case CUSTOM:
    this.emit(CUSTOM_MESSAGE_RECEIVED, participantId, content.type, content.payload)
```

**`JitsiConference.ts`** (~10 linii):
```typescript
sendOlmMessage(participantId: string, type: string, payload: object): void
// deleguje przez E2EEncryption → ExternallyManagedKeyHandler → OlmAdapter
```

### Uzasadnienie dla Jitsi team

- Zero breaking changes — nowe metody, nic nie ruszamy
- OLM session jest już ustanowiona przy E2EE — zero overhead
- Otwiera możliwości dla każdego integratora (nie tylko Encedo)
- Naturalne rozwinięcie istniejącej architektury

---

## PR #2 — `jitsi-meet`: External API exposure

**Już zaimplementowane (commit `ac2a039` w naszym forku).
Docelowo: upstream PR do `jitsi/jitsi-meet`.**

### Co robi

Wystawia `sendOlmMessage` i `olmMessageReceived` przez oficjalny External API,
żeby integratorzy embeddujący Jitsi przez iframe mieli dostęp do E2EE channel
bez modyfikacji kodu Jitsi.

```javascript
// host-app (poza iframe)
api.executeCommand('sendOlmMessage', participantId, type, JSON.stringify(payload))
api.addListener('olmMessageReceived', ({ from, type, payload }) => { ... })
```

### Diff

**`modules/API/API.js`** (~15 linii):
```javascript
'send-olm-message': (participantId, type, payload) =>
    APP.conference.sendOlmMessage(participantId, type, payload),

notifyOlmMessageReceived(from, type, payload) {
    this._sendEvent({ name: 'olm-message-received', from, payload, type });
}
```

**`modules/API/external/external_api.js`** (~3 linie):
```javascript
sendOlmMessage: 'send-olm-message',         // komenda
'olm-message-received': 'olmMessageReceived' // event
```

**`react/features/e2ee/middleware.ts`** (~5 linii):
```typescript
case JitsiConferenceEvents.OLM_MESSAGE_RECEIVED:
    APP.API.notifyOlmMessageReceived(from, type, payload)
```

---

## PR #3 — `jitsi-meet`: E2EE chat przez OLM (nowy)

**Do zaimplementowania. Opcja na osobny PR lub jako showcase użycia PR #1/#2.**

### Problem

Wbudowany chat Jitsi idzie przez XMPP MUC — serwer widzi każdą wiadomość.
Przy włączonym E2EE użytkownicy słusznie oczekują że chat też jest szyfrowany.
Obecny UI nie daje żadnego ostrzeżenia że chat jest nieszyfrowany mimo że
kłódka E2EE świeci.

### Propozycja

Nowy przełącznik konfiguracyjny `e2ee.encryptChat: true`:
- Ukrywa wbudowany panel czatu
- Dodaje własny panel czatu routowany przez OLM channel
- UI analogiczny do obecnego (ta sama pozycja, ten sam styl)

```
Jitsi chat (XMPP) → wyłączony gdy e2ee.encryptChat=true
OLM chat panel    → nowy komponent, wiadomości przez sendCustomMessage
```

Lub alternatywnie: **interceptor** — wbudowany chat nadal widoczny, ale
wiadomości są szyfrowane/deszyfrowane transparentnie zanim trafią do XMPP.
Wymaga więcej zmian w `ChatRoom.js`.

### Prostszy wariant (dla PR)

Dodanie opcji `toolbarConfig.alwaysVisibleButtons` + ostrzeżenia w UI chatu gdy
E2EE jest włączone ale chat jest nieszyfrowany:

```
⚠️ Chat messages are not end-to-end encrypted
```

To minimalna zmiana (~10 linii) którą Jitsi team prawie na pewno zaakceptuje
jako poprawkę UX, niezależnie od reszty.

---

## Potencjalne zastosowania (dla PR description)

Przykłady które warto wymienić żeby pokazać szerszy ekosystem:

| Use case | type | payload |
|---|---|---|
| E2EE chat | `app:chat` | `{ text, displayName, ts }` |
| Custom key exchange (dowolny algorytm) | `app:key-exchange` | `{ ... }` |
| E2EE reactions | `app:reaction` | `{ emoji, ts }` |
| HSM attestation (Encedo) | `encedo:attest` | `{ sig, kid }` |
| Shared document pointer | `app:doc-sync` | `{ url, cursor }` |
| Voting / polling | `app:poll` | `{ question, choices }` |

Każdy z tych przypadków dziś wymaga własnej infrastruktury lub idzie przez
niezabezpieczony kanał. Z OLM custom channel — zero overhead, E2EE gratis.

---

## Kolejność zgłaszania

1. **PR #1** (`lib-jitsi-meet`) — fundament, bez niego reszta nie ma sensu
2. **PR #2** (`jitsi-meet`) — companion PR, zgłosić razem z #1
3. **PR #3** (`jitsi-meet`) — osobny PR, showcase + UX fix, można zgłosić niezależnie

PR #1 i #2 są gotowe w naszym forku — wymagają tylko rebase na aktualny upstream
i napisania opisu dla Jitsi team. PR #3 do zaimplementowania.

---

## Uwagi implementacyjne

**OLM session availability**: `sendCustomMessage` może być wywołany tylko gdy
OLM session jest ustanowiona (po `e2ee.enabled=true` i wymianie prekey).
Przed ustanowieniem sesji wiadomości powinny być kolejkowane lub rzucać błąd.
Obecna implementacja loguje "No OLM session, skipping" — do poprawy na queue.

**Broadcast vs. unicast**: `participantId=''` to broadcast przez iterację
po wszystkich sesjach. Przy dużych konferencjach (>20 uczestników) może to
generować dużo wiadomości. Dla chatu broadcast jest OK; dla key exchange
unicast jest preferowany.

**Payload size**: OLM szyfruje per-wiadomość przez XMPP. Duże payloady
(>10kB) będą fragmentowane przez XMPP. Dla chatu i reakcji nie ma problemu;
dla ML-KEM pubkey (1184B) + ciphertext (1088B) — mieści się bez problemu.
