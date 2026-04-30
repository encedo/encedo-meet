# Encedo — zmiany w Jitsi upstream

Wszystkie zmiany są kandydatami na upstream PR (lub już zgłoszone).
Plik opisuje baseline: co i dlaczego zmieniliśmy względem stock Jitsi.

---

## lib-jitsi-meet

Repo: `github.com/encedo/lib-jitsi-meet`
Upstream: `github.com/jitsi/lib-jitsi-meet`

### Commit `e4e6ca9c` — B1/B2/B3: ExternallyManagedKeyHandler fix
**PR upstream:** https://github.com/jitsi/lib-jitsi-meet/pull/3028

**Pliki:**
- `modules/e2ee/ExternallyManagedKeyHandler.js`
- `modules/e2ee/ExternallyManagedKeyHandler.spec.ts` (nowy — 9 testów)
- `JitsiConference.ts`

**Trzy bugi naprawione:**

**B1 — undefined participantId**
`setKey()` przekazywał `undefined` jako participantId do worker'a. Worker rzucał
`"Missing required data: participantId"` przy każdym wywołaniu.
Fix: `keyInfo.participantId ?? this.conference.myUserId()`.

**B2 — zły typ klucza**
Klucz był przekazywany jako `{ encryptionKey: CryptoKey }` (obiekt wrapper).
Worker oczekuje raw bytes (`Uint8Array | ArrayBuffer`) do HKDF-SHA-256.
`new Uint8Array(object)` → pusty bufor → brak szyfrowania.
Fix: przekazanie `keyInfo.encryptionKey` (raw bytes) bezpośrednio.

**B3 — hardcoded `sharedKey: true`**
Konstruktor zawsze inicjalizował jeden wspólny E2EEContext.
Fix: `e2ee.externallyManagedSharedKey !== false` (domyślnie `true` = backward compat).

**Dodatkowe:** poprawiona sygnatura TypeScript `setMediaEncryptionKey()` w `JitsiConference.ts`
(była `CryptoKey`, jest `{ encryptionKey, index, participantId? }`).

---

### Commit `28beab91` — OLM custom-message channel
**PR upstream:** (do zgłoszenia)

**Pliki:**
- `modules/e2ee/OlmAdapter.js`
- `modules/e2ee/ExternallyManagedKeyHandler.js`
- `modules/e2ee/E2EEncryption.js`
- `JitsiConference.ts`
- `JitsiConferenceEvents.ts`

**Co dodano:**

`OlmAdapter`:
- Nowy typ wiadomości `CUSTOM` w `OLM_MESSAGE_TYPES`
- Nowy event `CUSTOM_MESSAGE_RECEIVED` w `OlmAdapterEvents`
- `sendCustomMessage(participantId, type, payload)` — szyfruje payload przez OLM session
  i wysyła przez XMPP. Pusty `participantId` = broadcast do wszystkich.
- Handler `case CUSTOM` w `_onEndpointMessageReceived` — deszyfruje i emituje event.

`ExternallyManagedKeyHandler`:
- Tworzy `OlmAdapter` gdy OLM jest dostępny (do transportu wiadomości, bez dystrybucji kluczy)
- `_setEnabled(enabled)`: `initSessions()` przy włączeniu, `clearAllParticipantsSessions()` przy wyłączeniu
- `sendCustomMessage(participantId, type, payload)` — deleguje do OlmAdapter
- Przekazuje `CUSTOM_MESSAGE_RECEIVED` → `JitsiConferenceEvents.OLM_MESSAGE_RECEIVED`

`E2EEncryption`: `sendOlmMessage(participantId, type, payload)` — deleguje do key handlera.

`JitsiConference`: publiczna metoda `sendOlmMessage(participantId, type, payload)`.

`JitsiConferenceEvents`: nowy event `OLM_MESSAGE_RECEIVED = 'conference.olm_message_received'`.

**Po co:** transport E2EE dla wymiany kluczy ML-KEM i attestacji HSM w host-app,
bez dotykania pipeline'u dystrybucji kluczy Jitsi.

---

## jitsi-meet

Repo: `github.com/encedo/jitsi-meet`
Upstream: `github.com/jitsi/jitsi-meet`

### Commit `cd668b56b` — B2/B3: middleware + External API pipeline fix
**PR upstream:** https://github.com/jitsi/jitsi-meet/pull/17351

**Pliki:**
- `react/features/e2ee/middleware.ts`
- `modules/API/external/external_api.js`

**Dwa problemy naprawione:**

**Problem 1 — błędny importKey w middleware**
`middleware.ts` importował raw bytes jako `AES-GCM CryptoKey` przed przekazaniem do konferencji.
Worker oczekuje raw bytes (robi sam HKDF-SHA-256 → AES-GCM-128).
Fix: usunięcie `importKey`, przekazanie `new Uint8Array(exportedKey)` bezpośrednio.

**Problem 2 — brak participantId**
Ani middleware ani `setMediaEncryptionKey()` w External API nie propagowały `participantId`.
Fix: `participantId` wyciągany z `action.keyInfo` i przekazywany przez cały pipeline.

---

### Commit `514026e3b` — send-olm-message command + olmMessageReceived event
**PR upstream:** (do zgłoszenia, companion do lib-jitsi-meet `28beab91`)

**Pliki:**
- `modules/API/API.js`
- `modules/API/external/external_api.js`
- `react/features/e2ee/middleware.ts`

**Co dodano:**

`API.js`:
- Komenda `send-olm-message(participantId, type, payload)` → `conference.sendOlmMessage()`
- Metoda `notifyOlmMessageReceived(from, type, payload)` → fires external event

`external_api.js`:
- Rejestracja `'olm-message-received'` → `'olmMessageReceived'` w mapie eventów

`middleware.ts`:
- Listener `JitsiConferenceEvents.OLM_MESSAGE_RECEIVED` → `APP.API.notifyOlmMessageReceived`

**Po co:** host-app może wysyłać/odbierać wiadomości przez szyfrowany kanał OLM
używając standardowego External API (bez modyfikacji kodu Jitsi po stronie hosta).

---

### Commit `94dc26f71` — auto-enable E2EE on conference join
**PR upstream:** (do zgłoszenia)

**Plik:** `react/features/e2ee/middleware.ts`

**Co zmieniono:**
Gdy `e2ee.externallyManagedKey: true` w konfiguracji Jitsi, E2EE jest automatycznie
włączane przy `CONFERENCE_JOINED` (dispatch `toggleE2EE(true)`).

**Po co:** media są szyfrowane od pierwszej klatki — żadna klatka nie wychodzi
w plaintext nawet przez ułamek sekundy. Bez tej zmiany moderator musiałby
ręcznie klikać "Enable E2EE" lub host-app musiałby to robić przez External API
z niezerowym opóźnieniem.

---

## Podsumowanie — co NIE zostało zmienione

- OLM session establishment — bez zmian (standardowy Jitsi flow)
- SFrame/JFrame media encryption pipeline — bez zmian
- XMPP/Prosody/Jicofo/JVB — zero zmian (tylko config)
- JWT auth — bez zmian
- React UI — bez zmian
