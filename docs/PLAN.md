# Plan: Encedo Meet — Host-App + iframe API (clean arch)

## Context

Jitsi Meet ma już wszystkie potrzebne mechanizmy zewnętrzne (oficjalne, nie hacki):

- `JitsiMeetExternalAPI` — biblioteka do embedowania Jitsi w iframe
- Komendy: `toggle-e2ee`, `set-media-encryption-key`, `send-endpoint-text-message`
  (`modules/API/API.js:577-607`)
- Eventy: `participantJoined`, `participantRoleChanged`, `endpointTextMessageReceived`,
  `dataChannelOpened` (`modules/API/external/external_api.js:126-157`)
- JWT auth — natywnie obsługiwane

Drobny brak do naprawy: `ExternallyManagedKeyHandler.setKey` w lib-jitsi-meet oczekuje
`CryptoKey`, ale `CryptoKey` nie serializuje się przez `postMessage`. Potrzeba ~10-linijkowego
patcha upstreamowalnego, który zaakceptuje też `Uint8Array`/base64 i wykona `importKey`
po stronie Jitsi.

Cel: czysta architektura, Jitsi jako black box biblioteczny, cała logika Encedo (HSM, UI,
klucze, anonimizacja) poza Jitsi, komunikacja tylko przez oficjalny External API.

---

## Architektura

```
┌────────────────────────────────────────────────────────────┐
│  encedo-meet-host  (osobna aplikacja, React+Vite)          │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ UI shell                                             │  │
│  │  - login (OIDC → encedo-oidc)                        │  │
│  │  - room creator (hashuje nazwę)                      │  │
│  │  - panel HSM (status, aktywacja)                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ EncedoKeyProvider                                    │  │
│  │  - HEM SDK (hem.ecdh, getPubKey, createKeyPair)      │  │
│  │  - room-key generation / rotation (moderator)        │  │
│  │  - AES-KW wrap per-participant                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ JitsiBridge  (jedyny punkt kontaktu z Jitsi)         │  │
│  │  api = new JitsiMeetExternalAPI(domain, {...})       │  │
│  │  api.executeCommand('toggle-e2ee', true)             │  │
│  │  api.executeCommand('set-media-encryption-key', ...) │  │
│  │  api.executeCommand('send-endpoint-text-message',...)│  │
│  │  api.addListener('endpointTextMessageReceived', ...) │  │
│  │  api.addListener('participantJoined', ...)           │  │
│  └────────────────────┬─────────────────────────────────┘  │
└───────────────────────┼────────────────────────────────────┘
                        │ postMessage (oficjalne API)
            ┌───────────▼──────────┐
            │  Jitsi Meet iframe   │
            │  (standard + patch)  │
            └───────────┬──────────┘
                        │
                        ▼
                 XMPP / WebRTC
```

**Anonimizacja kanału** — adres wyprowadzony z ECDH tożsamości + losowego nonce z URL fragmentu.
Nazwa pokoju nie istnieje w żadnej formie czytelnej, a adres jest niewyprowadzalny przez nikogo
poza stronami (bo wymaga klucza prywatnego w HSM). Szczegóły w sekcji niżej.

---

## Warstwa bezpieczeństwa: OLM + ML-KEM + HSM Attestation (Hybrid Protocol)

> **Status:** decyzja architektoniczna — zastępuje poprzedni model wymiany kluczy
> przez `send-endpoint-text-message` (XMPP plaintext). Reszta architektury
> (host-app, iframe, External API) pozostaje bez zmian.

### Model warstwowy

```
┌─────────────────────────────────────────────────────┐
│  Warstwa 2 — Encedo Protocol                        │
│  (autentykacja HSM + wymiana kluczy ML-KEM)         │
│  analogia: aplikacja HTTP / mTLS handshake          │
├─────────────────────────────────────────────────────┤
│  Warstwa 1 — OLM (Double Ratchet)                   │
│  E2EE transport między uczestnikami                 │
│  analogia: TLS — szyfruje i dostarcza warstwę wyżej │
├─────────────────────────────────────────────────────┤
│  Warstwa 0 — XMPP / WebRTC (Jitsi infrastructure)   │
│  sieć, sygnalizacja, SFU                            │
└─────────────────────────────────────────────────────┘
```

**Warstwa 1 (OLM)** daje E2EE transport — serwer nie widzi treści wiadomości
wymienianych przez Encedo Protocol. Słabość OLM (X25519 podatne na quantum,
identity keys efemeryczne i software-generated) nie narusza warstwy 2.

**Warstwa 2 (Encedo)** dodaje:
- **Autentykację HSM** — długożywa tożsamość sprzętowa, podpisuje klucze efemeryczne
- **ML-KEM-768** — post-kwantowa wymiana kluczy, HNDL-safe
- Wynikowy klucz sesji → SFrame AES-GCM (media encryption)

Analogia pełna:

| TLS | Encedo over OLM |
|-----|-----------------|
| Certyfikat X.509 (CA-signed) | Klucz HSM (hardware-backed) |
| ECDH ephemeral key exchange | ML-KEM-768 ephemeral key exchange |
| Serwer/klient authenticates | Obaj uczestnicy (mTLS equivalent) |
| Record layer AES-GCM | SFrame AES-GCM (Jitsi E2EE) |
| Transport: TCP | Transport: OLM Double Ratchet |

Bezpieczeństwo jest addytywne: przełamanie warstwy 1 (OLM/X25519) nie daje
dostępu do klucza sesji — atakujący nadal musi przełamać ML-KEM-768 **i**
sfałszować podpis HSM. Obie operacje są obliczeniowo niemożliwe jednocześnie.

### Problem z poprzednim modelem

Wiadomości `encedo:announce`, `encedo:kem-init` itd. leciały przez
`send-endpoint-text-message` → kanał XMPP → ochrona **tylko TLS**.
Serwer Prosody widzi je w plaintext. "Harvest now, decrypt later" jest możliwy.

### Nowe podejście

OLM jest już w Jitsi i daje **E2EE na poziomie aplikacji** między uczestnikami.
Używamy OLM jako szyfrowanego, uwierzytelnionego kanału transportowego dla
wymiany kluczy ML-KEM. HSM podpisuje klucze efemeryczne — wiąże ephemeral
session z długożywą tożsamością sprzętową.

Analogia: **TLS 1.3 hybrid key exchange** (X25519 + ML-KEM-768):

```
media_key = HKDF(ml_kem_ss || hsm_shared_context, channelId, "encedo-meet-media-v1", 16B)
```

### Właściwości bezpieczeństwa

| Zagrożenie | Ochrona |
|------------|---------|
| Serwer widzi wymianę kluczy | OLM E2EE — serwer widzi tylko zaszyfrowany blob |
| Quantum break X25519 (OLM) | ML-KEM-768 (FIPS 203) — PQC, harvest-now-decrypt-later safe |
| MITM na kluczu ML-KEM | HSM podpisuje `ml_kem_pub` — podpis weryfikowalny bez OLM |
| Replay attak podpisu | Podpis zawiera `channelId ║ sessionNonce` |
| Fałszywy uczestnik bez HSM | Nie może wygenerować ważnego podpisu HSM |

Bezpieczeństwo media key: wystarczy że **JEDEN** z prymitywów trzyma
(ML-KEM **lub** brak MITM na kluczu). HSM signature działa niezależnie od OLM.

### Protokół — flow pełny

```
host-app (HEM SDK)                    Jitsi iframe (OLM)
─────────────────                     ─────────────────

[przed dołączeniem]
1. Generuj ML-KEM-768 keypair
   (ml_kem_pub, ml_kem_priv)           → przekaż ml_kem_pub + sig do Jitsi
2. sig = HSM.exdsaSign(kid,               jako configOverwrite lub initial command
     ml_kem_pub ║ channelId ║ nonce)

[OLM session establishment — bez zmian, wewnątrz Jitsi]
                                       3. OLM prekey exchange między uczestnikami
                                          (X25519, standard Jitsi flow)

[przez OLM session — E2EE:]
                                       4. Broadcast: { ml_kem_pub, sig, kid_fp }
                                          do wszystkich przez OLM sessions
                                       5. Odbierz: { peer_ml_kem_pub, peer_sig, peer_kid_fp }

                                       6. Zweryfikuj peer_sig:
                                          peer_hsm_pub.verify(sig,
                                            peer_ml_kem_pub ║ channelId ║ nonce)
                                          → peer jest zaufany ✓

                                       7. Encapsulate:
                                          ct, ss_kem = ML-KEM.enc(peer_ml_kem_pub)
                                          Wyślij { ct } przez OLM do peer

                                       8. Odbierz { peer_ct } przez OLM
                                          → przekaż peer_ct do host-app
                                             przez External API event

[host-app odbiera ciphertext przez External API event]
9. ss_kem = ML-KEM.dec(ml_kem_priv, peer_ct)
10. media_key = HKDF(ss_kem ║ kid_fp_local ║ kid_fp_peer,
                     channelId, "encedo-meet-media-v1", 16B)
11. bridge.setMediaKey(media_key, keyIndex, participantId: peer)
    [ustawia klucz deszyfrowania strumienia od peer]

[send key — per sender]
12. Generuj K_send (random 32B)
    sig_send = HSM.sign(K_send ║ channelId)
    → wyślij { K_send, sig_send } przez OLM do wszystkich
    → wszyscy ustawiają K_send jako receive key dla tego nadawcy
    bridge.setMediaKey(K_send, keyIndex)   [mój klucz szyfrowania]
```

Każdy uczestnik szyfruje swój strumień **jednym** `K_send` (jak Signal Sender Keys).
Odbiorcy trzymają mapę `participantId → K_send`.

### Mapping user → HSM pub (out-of-band)

JWT od `encedo-oidc` zawiera claim `encedo_kid` (fingerprint klucza HSM).
Po stronie receivera:

```
kid_fp → hsm_pub:
  1. Z JWT claims (jeśli peer ma JWT w konferencji)
  2. Lub: katalog OIDC/WKD: GET /encedo-keys/{kid_fp}
  3. Cache lokalnie per sesję
```

Nie wymaga żadnych zmian w Prosody ani Jitsi auth — JWT już zawiera kid.

### Co wymaga patcha w Jitsi

**lib-jitsi-meet — `OlmAdapter.js` (~25 linii):**

```
+ sendCustomMessage(participantId, type, payload)
    → szyfruje przez istniejącą OLM session, wysyła przez XMPP
    → participantId='' → broadcast do wszystkich

+ event CUSTOM_MESSAGE_RECEIVED(participantId, type, payload)
    → emitowany gdy przychodzi custom message z OLM channel
```

**jitsi-meet — External API (~20 linii):**

```
+ command: 'send-olm-message'(participantId, type, payload)
    → wywołuje OlmAdapter.sendCustomMessage()

+ event: 'olmMessageReceived' { from, type, payload }
    → fires gdy CUSTOM_MESSAGE_RECEIVED z OlmAdapter
```

**Patche B1/B2/B3 (już zrobione) — nadal potrzebne:**
`set-media-encryption-key` z `participantId` to mechanizm przez który
host-app ustawia media keys po zakończeniu ML-KEM handshake.

**Łącznie:** ~45 linii diff w Jitsi, 2 pliki — upstream PR candidates.

### Implementacja — kolejność

1. **OlmAdapter patch** (`lib-jitsi-meet`) — `sendCustomMessage` + event
2. **External API patch** (`jitsi-meet`) — `send-olm-message` command + `olmMessageReceived` event
3. **host-app: `mlKem.ts`** — wrapper `@noble/post-quantum` (ML-KEM-768)
4. **host-app: `hsmAttestation.ts`** — sign/verify flow z HEM SDK
5. **host-app: `EncedoKeyProvider.ts`** — główna logika (opisana wyżej)
6. **host-app: `JitsiBridge.ts`** — dodać `sendOlmMessage()` + `onOlmMessage()`

### Co NIE zmienia się

- OLM session establishment — bez zmian
- Jitsi E2EE pipeline (SFrame/JFrame) — bez zmian
- Anonimizacja channelId — bez zmian
- OIDC/JWT auth — bez zmian
- Patche B1/B2/B3 — nadal aktualne i potrzebne

---

## Nowy projekt: `encedo-meet-host`

Lokalizacja: `/home/chris/develop/encedo-meet-host/` (osobne repo, osobny build)

Stack:
- Vite + React + TypeScript
- `@jitsi/jitsi-meet-external-api` (oficjalna paczka)
- `@encedo/hem-sdk` (z `encedo-pgp/hem-sdk-js`)
- `oidc-client-ts` — integracja z `encedo-oidc`

Struktura:

```
encedo-meet-host/
├── package.json
├── vite.config.ts
├── index.html
├── src/
│   ├── main.tsx                   // entry
│   ├── App.tsx                    // router (landing / meeting)
│   ├── auth/
│   │   └── OidcProvider.tsx       // delegacja do encedo-oidc
│   ├── pages/
│   │   ├── Landing.tsx            // login + "Create meeting"
│   │   └── Meeting.tsx            // embed Jitsi + Encedo panel
│   ├── encedo/
│   │   ├── EncedoKeyProvider.ts   // logika HSM + ECDH + room key
│   │   ├── roomHash.ts            // SHA-256 nazwy pokoju
│   │   ├── hemClient.ts           // wrapper na HEM SDK
│   │   └── keyExchange.ts         // protokół wymiany + rotacja
│   ├── jitsi/
│   │   ├── JitsiBridge.ts         // wrapper na JitsiMeetExternalAPI
│   │   └── types.ts               // typy eventów/komend
│   └── ui/
│       ├── EncedoStatusPanel.tsx  // mały panel statusu
│       └── MeetingShell.tsx       // layout: Jitsi fullscreen + overlay
└── README.md
```

---

## Kluczowe komponenty — szczegóły

### 1. `roomHash.ts`

```typescript
export async function hashRoomName(humanName: string): Promise<string> {
    const data = new TextEncoder().encode(humanName.toLowerCase().trim());
    const buf  = await crypto.subtle.digest('SHA-256', data);
    const hex  = Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    return 'e' + hex.substring(0, 31); // 'e' + 31 hex = 32 znaków, XMPP JID-safe
}
```

### 2. `JitsiBridge.ts` (abstrakcja nad External API)

```typescript
export class JitsiBridge {
    private api: any; // JitsiMeetExternalAPI

    constructor(parentNode: HTMLElement, opts: {
        domain: string;          // np. "meet.example.com"
        roomName: string;        // już zhashowana nazwa
        jwt?: string;            // JWT z encedo-oidc
        userInfo: { displayName: string };
    }) {
        this.api = new (window as any).JitsiMeetExternalAPI(opts.domain, {
            roomName: opts.roomName,
            parentNode,
            jwt: opts.jwt,
            userInfo: opts.userInfo,
            configOverwrite: {
                e2ee: { externallyManagedKey: true, disabled: false },
                disableModeratorIndicator: false,
            },
        });
    }

    onReady(cb: () => void) { this.api.addListener('videoConferenceJoined', cb); }
    onParticipantJoined(cb: (e: { id: string }) => void) { this.api.addListener('participantJoined', cb); }
    onParticipantLeft(cb: (e: { id: string }) => void) { this.api.addListener('participantLeft', cb); }
    onRoleChanged(cb: (e: { id: string; role: string }) => void) { this.api.addListener('participantRoleChanged', cb); }
    onMessage(cb: (e: { senderInfo: { id: string }; data: any }) => void) {
        this.api.addListener('endpointTextMessageReceived', cb);
    }

    sendMessage(to: string, data: object) {
        this.api.executeCommand('send-endpoint-text-message', to, JSON.stringify(data));
    }
    enableE2EE() { this.api.executeCommand('toggle-e2ee', true); }

    setMediaKey(rawKeyBytesB64: string, index: number) {
        // Po patchu upstream — Jitsi zaakceptuje raw bytes
        this.api.executeCommand('set-media-encryption-key',
            JSON.stringify({ encryptionKey: rawKeyBytesB64, index }));
    }

    getMyId(): string { return this.api.getMyUserId(); }
    getParticipants(): Array<{ participantId: string; role: string }> { return this.api.getParticipantsInfo(); }
    dispose() { this.api.dispose(); }
}
```

### 3. `EncedoKeyProvider.ts` (główna logika) — PQC hybrid + klucze asymetryczne

Wzorowane na [Signal PQXDH](https://signal.org/docs/specifications/pqxdh/): łączy
klasyczny X25519 ECDH (tożsamość w HSM) z post-kwantowym ML-KEM (ephemerid, software).
Gwarantuje bezpieczeństwo tak długo jak **co najmniej jeden** z prymitywów trzyma się
(ochrona przed "harvest now, decrypt later").

Odpowiedzialności:
- Inicjalizacja HEM — X25519 tożsamość w HSM (`ETSMEET:self,<userId>,ident`)
- Po wejściu do kanału: wygenerowanie **świeżej pary ML-KEM-768** (ephemerid, w RAM)
- Broadcast `encedo:kyber-pub` zawierający pubkey ML-KEM + kid X25519 tożsamości
- Host inicjuje hybrid handshake (encapsulation), uczestnicy odpowiadają (decapsulation)
- Derivacja **dwóch kierunkowych kluczy AES-GCM** per uczestnik (send/receive asymmetry)
- Rotacja przy każdym leave/join (forward secrecy)

#### Prymitywy

| Funkcja | Biblioteka | Uwagi |
|---------|-----------|-------|
| X25519 ECDH | Encedo HSM (`hem.ecdh`) | Klucz prywatny nigdy nie opuszcza HSM |
| ML-KEM-768 | `@noble/post-quantum` (audyt 2024) | FIPS 203, ~1184B pubkey, ~1088B ciphertext, 32B SS |
| HKDF-SHA256 | WebCrypto `crypto.subtle` | Wyprowadzenie kluczy kierunkowych |
| AES-GCM 128-bit | WebCrypto | Zgodne z JFrame/SFrame Jitsi |

#### Protokół wymiany (przez `send-endpoint-text-message`)

| `type` | Od → Do | Pola | Kiedy |
|--------|---------|------|-------|
| `encedo:announce` | broadcast | `x25519_id_pub`, `kid_fingerprint`, `kyber_pub` | po dołączeniu |
| `encedo:kem-init` | host → uczestnik | `ct_kem`, `peer_ecdh_pub` (host ephemerid X25519), `session_nonce (32B)`, `uuid` | gdy host widzi nowego uczestnika z `kyber_pub` |
| `encedo:kem-ack` | uczestnik → host | `uuid` | po wyprowadzeniu kluczy sesji |
| `encedo:rekey` | host → wszyscy | `epoch++`, `new_session_nonce`, `ct_kem_per_peer` | po leave / co T minut |

#### Derivacja (Signal-PQXDH style, adaptowana)

Dla pary **host H** ↔ **uczestnik P**:

```
# Wejścia:
dh_id      = hem.ecdh(H_id_kid, P_id_pub)              // X25519 tożsamości (HSM)
dh_eph     = ECDH(H_eph_priv, P_eph_pub)               // X25519 ephemerid (software, opcjonalny)
ss_kem     = ML-KEM-768.decapsulate(P_kyber_priv, ct_kem)   // po stronie P
             ML-KEM-768.encapsulate(P_kyber_pub) → (ct_kem, ss_kem)   // po stronie H

# Master secret (konkatenacja — co najmniej jeden bezpieczny = całość bezpieczna):
MS = HKDF-SHA256(
    ikm:  dh_id || dh_eph || ss_kem,
    salt: session_nonce,
    info: "encedo-meet-pqxdh-v1" || sorted(H_id_pub, P_id_pub),
    len:  64 bytes
)

# Klucze kierunkowe (ASYMETRIA — różny klucz do wysyłania i odbierania):
K_H→P = HKDF(MS, salt: "dir", info: "send" || H_id_pub || P_id_pub, 16B)   // H używa do szyfrowania
K_P→H = HKDF(MS, salt: "dir", info: "send" || P_id_pub || H_id_pub, 16B)   // P używa do szyfrowania

# Z perspektywy P:
#   do szyfrowania swojego strumienia: K_P→H (co P nazywa "K_send")
#   do deszyfrowania strumienia od H:  K_H→P (co P nazywa "K_recv_from_H")
```

**Dlaczego asymetria**: każdy uczestnik szyfruje własny strumień unikalnym kluczem.
Rozdzielenie send/receive zapobiega "reflection attacks" i upraszcza rotację per-strumień.
Analogia: SRTP używa osobnych SSRC → osobne klucze; Double Ratchet: osobne chains.

#### Multi-party (N uczestników)

Dla każdej pary (H, P_i) host przechodzi handshake jak wyżej → dostaje:
- `K_H→Pi` (host używa do swojego strumienia, Pi do odbioru od H)
- `K_Pi→H` (Pi używa do swojego strumienia, H do odbioru)

Ale inni uczestnicy też muszą odbierać strumień od Pi. Rozwiązanie **SFrame-multicast**:
Pi szyfruje swój strumień **jednym** kluczem `K_Pi_send = HKDF(MS_Pi_with_host, "broadcast", ...)`
a host dystrybuuje ten klucz do pozostałych uczestników w wiadomości `encedo:broadcast-key`
(zaszyfrowanej pairwise kluczami `K_H→Pj`). Wtedy:
- Pi szyfruje jednym kluczem (broadcast)
- Wszyscy Pj ≠ Pi dostają ten klucz od H i mogą deszyfrować Pi
- Asymetria zachowana (każdy Pi ma inny broadcast key)

**Wstrzyknięcie do Jitsi**: Jitsi SFrame używa jednego klucza per SSRC. Musimy dla każdego
uczestnika ustawić osobny receive key:

```typescript
// Patch upstream na ExternallyManagedKeyHandler MUSI zostać rozszerzony:
// obecnie akceptuje {encryptionKey, index} (shared), potrzebujemy per-participant key:
bridge.setMediaKeyForParticipant(participantId, K_Pi_send_base64, keyIndex);
```

To wymaga drugiego rozszerzenia patcha upstream — zmiana ExternallyManagedKeyHandler
z `sharedKey: true` na akceptowanie kluczy per-participant (tak jak ManagedKeyHandler).
Szczegóły w sekcji "Patch upstream" niżej.

#### Rotacja

- **Leave**: host generuje nowy `session_nonce` + nowe ML-KEM ephemerids per pozostały uczestnik,
  rozsyła `encedo:rekey` → wszyscy wyprowadzają nowe klucze kierunkowe, `keyIndex++`
- **Join**: nowy uczestnik przechodzi pełny handshake; istniejący uczestnicy dostają
  `encedo:broadcast-key` z nowym kluczem dla nowego uczestnika (ich własne klucze bez zmian)
- **Periodic rekey**: co 15 minut (forward secrecy dla długich spotkań)

#### Referencja: Signal Sender Keys

Nasz model jest uproszczeniem [Signal Sender Keys](https://signal.org/docs/specifications/sesame/)
(protokół grupowy Signala, Android/iOS):

| Aspekt | Signal Sender Keys | Nasz plan |
|--------|--------------------|-----------|
| Klucz per-nadawca | ✅ `{chain_key, ed25519_sig_key}` per sender | ✅ `K_Pi_send` per sender |
| Dystrybucja klucza | pairwise N²/2 (każdy → każdy przez PQXDH) | centralnie przez hosta (N pairwise) |
| PQC | PQXDH (X25519 + ML-KEM-768) | PQXDH-adapted (X25519 HSM + ML-KEM-768) |
| Ratcheting chain_key | SHA-256 po każdej wiadomości | keyIndex++ (SFrame frame counter) |
| Rekey on leave | wszyscy pozostali generują nowe SenderKeys | host generuje nowe MS + rozsyła |
| Group identity | opaque `groupId` od serwera | anchor = `creator_pub` (deterministic) |
| Host required | ❌ (peer-to-peer) | ✅ (gwiazda, upraszcza handshake) |

Tradeoff: Signal jest w pełni peer-to-peer (brak pojedynczego punktu awarii w protokole),
nasz model wymaga obecności hosta — w zamian unikamy O(N²) dystrybucji kluczy.
Sensowne dla wideokonferencji (host i tak organizuje spotkanie) i upraszcza integrację
z Jitsi (gdzie host == moderator jest już konceptem).

### 4. Autentykacja (bez zmian w Jitsi)

- `encedo-oidc` już istnieje jako OIDC provider (ARCH.md)
- Host-app używa `oidc-client-ts` żeby uzyskać JWT
- JWT przekazywany do Jitsi przez `JitsiMeetExternalAPI({ jwt })`
- Jitsi natywnie waliduje JWT przez Prosody (konfiguracja serwera, nie kod)

---

## Patche upstream do Jitsi

Dwie niezależne zmiany, obie kandydaci na PR do
[jitsi/lib-jitsi-meet](https://github.com/jitsi/lib-jitsi-meet) i
[jitsi/jitsi-meet](https://github.com/jitsi/jitsi-meet).

### Patch #1: Raw bytes w `ExternallyManagedKeyHandler`

**Plik:** `lib-jitsi-meet/modules/e2ee/ExternallyManagedKeyHandler.js`

CryptoKey nie przechodzi przez postMessage → External API jest de facto niefunkcjonalne
dla integratorów trzecich. Akceptacja raw bytes (base64/ArrayBuffer) + wewnętrzny
`importKey` naprawia to generycznie.

```diff
+ import { deriveKeys, importKey } from './crypto-utils';

- setKey(keyInfo) {
+ async setKey(keyInfo) {
+     let encryptionKey = keyInfo.encryptionKey;
+     if (typeof encryptionKey === 'string') {
+         encryptionKey = Uint8Array.from(atob(encryptionKey), c => c.charCodeAt(0)).buffer;
+     }
+     if (encryptionKey instanceof ArrayBuffer || encryptionKey instanceof Uint8Array) {
+         const material = await importKey(encryptionKey);
+         encryptionKey  = (await deriveKeys(material)).encryptionKey;
+     }
-     this.e2eeCtx.setKey(undefined, { encryptionKey: keyInfo.encryptionKey }, keyInfo.index);
+     this.e2eeCtx.setKey(keyInfo.participantId, { encryptionKey }, keyInfo.index);
  }
```

Dodatkowo: przekazujemy `keyInfo.participantId` — gdy podany, klucz trafia do konkretnego
uczestnika (niezbędne dla asymetrii kluczy PQC). Gdy `undefined`, zachowanie jak dziś
(shared key).

### Patch #2: Per-participant keys w External API

**Plik:** `jitsi-meet/modules/API/API.js` (linia 605-607)

```diff
  'set-media-encryption-key': keyInfo => {
      APP.store.dispatch(setMediaEncryptionKey(JSON.parse(keyInfo)));
  },
+ 'set-media-encryption-key-for-participant': (participantId, keyInfo) => {
+     const parsed = JSON.parse(keyInfo);
+     APP.store.dispatch(setMediaEncryptionKey({ ...parsed, participantId }));
+ },
```

Pozwala host-app ustawić osobny klucz deszyfrujący per uczestnik (do odbioru
broadcast key od każdego Pi).

### Patch #3: sharedKey off dla externally managed

**Plik:** `lib-jitsi-meet/modules/e2ee/ExternallyManagedKeyHandler.js` konstruktor

```diff
  constructor(conference) {
-     super(conference, { sharedKey: true });
+     super(conference, { sharedKey: false });  // per-participant mode
  }
```

To przełącza `E2EEContext` z trybu "jeden klucz dla wszystkich" na tryb per-participant,
zgodny z rzeczywistą asymetrią E2E w PQC protocol.

### Uzasadnienie PR-ów

Wszystkie trzy są upstreamowalne — External Key Management w Jitsi jest obecnie martwym
mechanizmem dla integratorów trzecich (jeden użyty przypadek — Spot TV — używa
sharedKey, ale asymetria jest potrzebna każdemu kto chce zbudować własne E2EE z
prawdziwą kryptografią). Razem ~30 linii diff.

### Fallback przed akceptacją

Lokalny fork `lib-jitsi-meet` z trzema patchami, pinowany w Jitsi deployment przez
`package.json`:
```json
"lib-jitsi-meet": "file:../lib-jitsi-meet-encedo.tgz"
```
Rebase na upstream = trywialny (kilka plików, zmiany się nie nakładają).

---

## Anonimizacja — adres kanału z tożsamości + URL fragment

### Założenia

- Każdy użytkownik ma długożywą tożsamość X25519 w HSM Encedo (`ETSMEET:self,<uid>,ident`).
  Publiczne klucze tożsamości są znane stronom wcześniej (directory OIDC, WKD-like,
  lub ręczna wymiana przez QR).
- Adres kanału XMPP jest wyprowadzony kryptograficznie z: (a) ECDH tożsamości uczestników,
  (b) losowego nonce `R` przekazanego w **URL fragment** (`#...`), (c) MAC listy klucze
  tożsamości (binding do konkretnej grupy).
- URL fragment **nie jest wysyłany do serwera** przez przeglądarkę — zostaje po stronie klienta.
- Serwer XMPP/Jitsi widzi tylko 16-bajtowy opaque channelId, niekorelowalny z niczym.

### Schemat (2-party: Alice → Bob)

```
# Alice (organizator) tworzy spotkanie:

nonce_R        = crypto.getRandomValues(32)            // losowy, jednorazowy
peers_sorted   = sorted([alice_pub, bob_pub])          // deterministyczna kolejność wg bajtów pubkey
                                                        // (lub równoważnie wg KID = SHA1(pubkey)[:16])
mac_identities = SHA-256(peers_sorted[0] || peers_sorted[1])   // publiczny roster tag
ecdh_ab        = hem.ecdh(alice_kid, bob_pub)                   // HSM — klucz prywatny nie wycieka

channelId_bytes = HKDF-SHA256(
    ikm:  ecdh_ab,
    salt: nonce_R,
    info: "encedo-meet-channel-v1" || mac_identities,
    len:  16 bytes
)
channelId = "e" + hex(channelId_bytes).substring(0, 31)   // XMPP JID-safe, 32 znaki

# URL zaproszenia (fragment NIE jest wysyłany do serwera):
https://encedo-meet.example.com/m#R=<base64(nonce_R)>&p=<bob_pub_fingerprint>

# Bob otwiera link — host-app Boba odczytuje fragment, zna swoją identity,
# zna Alice (fingerprint → rozpoznaje pubkey z lokalnej książki adresowej lub OIDC directory)
# i liczy dokładnie to samo → ten sam channelId.
```

### Schemat (multi-party, N uczestników — **creator-anchored**)

Rdzeń: **twórca grupy ma długożywą parę kluczy `group_creator_kp`** dedykowaną
dla tej grupy (osobny wpis w HSM: `ETSMEET:group,<groupId>,owner`). Jego `group_creator_pub`
jest **anchorem** — klucz, do którego wszyscy zaproszeni odnoszą swoją tożsamość.
Twórca musi być obecny w każdym call'u (inicjuje handshake, dystrybuuje broadcast keys).

**Własności tego modelu:**
- Jasna topologia: gwiazda wokół twórcy (upraszcza PQC handshake — każdy ↔ twórca)
- Stały identyfikator grupy (`group_creator_pub`) — przetrwa usunięcie/dodanie członków
- Ekskluzja członków przez rotację `group_seed` i ew. rotację `group_creator_kp`
- Nie wymaga pełnej listy członków w URL (tylko anchor + per-invitee capability)

#### Wymiana kluczy grupy (setup, out-of-band per invitee)

Twórca, po utworzeniu grupy, dla każdego zaproszonego `P_i`:

```
group_seed_i = AES-GCM(
    key:       HKDF(hem.ecdh(creator_kid, P_i_id_pub), "group-seed-wrap-v1", 32B),
    plaintext: group_seed              // wspólny dla całej grupy, 32B random
)
```

`group_seed` jest tajemnicą grupy; każdy zaproszony dostaje go zaszyfrowanego ECDH-em
z twórcą. Invite link:

```
https://encedo-meet.example.com/g#
    anchor=<creator_pub_fingerprint>
    &seed=<group_seed_i (ciphertext)>
    &R=<nonce_R>
```

Odbiorca `P_i`:
```
ecdh_i      = hem.ecdh(P_i_kid, creator_pub)
wrap_key    = HKDF(ecdh_i, "group-seed-wrap-v1", 32B)
group_seed  = AES-GCM-decrypt(wrap_key, group_seed_i)
```

Teraz wszyscy znają `group_seed` (wspólny sekret grupy) + `creator_pub` (anchor).

#### Derivacja channelId (na konkretne spotkanie)

```
channelId_bytes = HKDF-SHA256(
    ikm:  group_seed,
    salt: nonce_R,                                   // inny dla każdego spotkania
    info: "encedo-meet-channel-v1" || creator_pub,
    len:  16 bytes
)
channelId = "e" + hex(channelId_bytes).substring(0, 31)
```

- Każde spotkanie: nowe `nonce_R` → nowy `channelId` (brak korelacji przez serwer)
- Grupa trwała: ten sam `group_seed` dla wszystkich spotkań grupy
- Wszyscy członkowie liczą to samo → dołączają do tego samego `channelId`
- Serwer widzi random 32B ID, nie wie nic o grupie ani członkach

#### Ekskluzja członka

Twórca wybiera: (a) rotacja `group_seed` + wysłanie nowego do pozostałych, (b) dla
maksymalnej ochrony — wygenerowanie nowego `group_creator_kp` i de facto nowa grupa.
Wariant (a) wystarczy w większości przypadków.

#### Roster — jak host zna pełną listę w czasie spotkania

Do rozważenia (TBD, zostawiamy jako otwartą kwestię):

- **Wariant A — discovery w kanale**: po dołączeniu każdy broadcastuje swój
  `id_pub + signature(id_pub, group_seed)`. Host zbiera i może odrzucić każdego,
  kto nie udowodni znajomości `group_seed`. Prosto, ale każdy zaproszony może
  dołączyć — nie ma listy "kto ma prawo" z góry.
- **Wariant B — explicit roster podpisany przez twórcę**: twórca podpisuje listę
  fingerprintów `L = sig(creator_priv, sorted(P_1_fp || ... || P_N_fp))` i umieszcza
  ją w URL fragmencie lub wysyła na kanale po dołączeniu. Każdy weryfikuje, że jest
  na liście i że podpis zgadza się z anchor. Zapewnia autorytatywny roster, ale
  URL robi się długi przy dużych grupach (alt: roster w pierwszej wiadomości w kanale).
- **Wariant C — Merkle tree**: root w URL, pełna lista w kanale, dowód inkluzji przy
  dołączaniu. Najbardziej skalowalne, najbardziej skomplikowane.

Decyzja na później — zapisane jako otwarte.

### Po dołączeniu — negocjacja kluczy sesji

Po wejściu do kanału `channelId` uruchamia się `EncedoKeyProvider` (jak wyżej opisany):
- Każdy uczestnik broadcastuje `encedo:announce` z ephemerid X25519 (NIE tożsamością —
  tożsamość została użyta tylko do wyprowadzenia adresu i już nie jest potrzebna na wire)
- Moderator generuje `roomKey` (256-bit) i wrapuje AES-KW dla każdego przez ECDH ephemerid↔ephemerid
- HKDF-SHA256 → AES-GCM 128-bit → `bridge.setMediaKey(...)`

Rozdzielenie klucza tożsamości (długożywy, do wyprowadzenia adresu) i ephemerid
(jednorazowy, do szyfrowania sesji) zapewnia forward secrecy: nawet jeśli tożsamość
wycieknie w przyszłości, nie da się odszyfrować nagranych wcześniej sesji.

### Właściwości bezpieczeństwa

| Zagrożenie | Ochrona |
|------------|---------|
| Serwer zna nazwę kanału → identyfikuje uczestników | Serwer widzi tylko `channelId` z HKDF, brak czytelnej nazwy |
| Słownikowy atak na hash nazwy | Brak "nazwy" — `channelId` zawiera 32B entropii z `nonce_R` |
| MITM w XMPP | Klucze sesji w HSM; poziom treści niezależny od XMPP |
| Wyciek URL → nieautoryzowany uczestnik | Uczestnik bez klucza tożsamości w HSM nie odszyfruje `encrypted_channelId` |
| Wyciek URL → serwer | URL fragment (`#...`) z definicji nie idzie do serwera |
| Rozpoznanie grupy przez korelację | `channelId` zmienia się przy każdym spotkaniu (nowy `nonce_R`) |
| Rejestracja historyczna (forward secrecy) | Klucze sesji są ephemerid, nie związane z tożsamością |

### Pliki implementacji

```
encedo-meet-host/src/encedo/
├── identity.ts        // getIdentityKey(hem, userId), getPeerIdentity(fingerprint)
├── channelDerive.ts   // deriveChannelId(myKid, peers, nonceR) + wrap/unwrap dla multi-party
├── urlCodec.ts        // encodeInviteUrl / decodeInviteUrl (fragment parsing)
└── EncedoKeyProvider.ts   // (jak wyżej — ephemerid keys, room-key, rotacja)
```

### Przepływ użytkownika

```
[Alice: Create meeting]
  1. host-app wybiera z directory listę zaproszonych (fingerprinty X25519)
  2. channelDerive: nonce_R, channelId, wrap per-invitee
  3. urlCodec: generuje N linków z fragmentami
  4. Alice wysyła linki przez dowolny kanał (Signal, email, ...)
  5. host-app otwiera Jitsi z roomName = channelId

[Bob: Klika link]
  1. host-app parsuje fragment → nonce_R, encrypted_channelId, group_hash
  2. hem.ecdh(my_kid, alice_pub) → szyfruje encrypted_channelId
  3. Dostaje channelId
  4. host-app otwiera Jitsi z roomName = channelId → dołącza do Alice
```

---

## Kolejność implementacji — incremental z checkpointami

Każdy krok jest niezależnie testowalny. Konfiguracja wyboru wariantu przez
`config.js` Jitsi — bez zmian kodu między testami.

---

### Krok 0 — Checkpoint: status quo OLM (punkt wyjścia)

**Cel:** zweryfikować że standardowe Jitsi E2EE działa w naszym środowisku
zanim cokolwiek zmienimy. Commit jako baseline.

**Co testować:**
- Dwie karty, konferencja z E2EE włączonym (`e2ee: {}` w config.js)
- OLM session established (logi w konsoli: `Olm session established`)
- WebRTC-Internals: SFrame trailer widoczny w RTP (`0x...`)
- Treść rozmowy niewidoczna w Wireshark/XMPP dump

**Config:**
```js
// config.js Jitsi — standardowe E2EE, bez żadnych modyfikacji
e2ee: {}
```

**Commit:** `chore(e2ee): baseline checkpoint — standard OLM E2EE verified`

---

### Krok 1 — ML-KEM nad OLM (bez HSM)

**Cel:** dodać post-kwantową wymianę kluczy nad istniejącym OLM.
OLM nadal działa, ML-KEM SS miesza się z kluczem sesji.
HSM jeszcze nie włączony — żadnego HEM SDK w tym kroku.

**Biblioteka ML-KEM: `@noble/post-quantum`**

Wybór uzasadniony:
- Audyt bezpieczeństwa Cure53 (2024) — jedyna JS implementacja ML-KEM z publicznym audytem
- Implementuje **FIPS 203** (ML-KEM), nie draft Kyber — standard finalny
- Pure TypeScript, bez WASM — działa w Karma, browserze, Node bez konfiguracji
- Tree-shakeable: `import { mlKem768 } from '@noble/post-quantum/ml-kem'`
- Autor: Paul Miller (ten sam co `@noble/curves`, `@noble/hashes`) — trusted w crypto community
- Rozmiary: pubkey 1184B, ciphertext 1088B, shared secret 32B (ML-KEM-768)

```bash
# w lib-jitsi-meet
npm install @noble/post-quantum
```

**Co się zmienia:**

```
lib-jitsi-meet:
  modules/e2ee/OlmAdapter.js
    + sendCustomMessage(participantId, type, payload)
    + event: CUSTOM_MESSAGE_RECEIVED

  modules/e2ee/EncedoMlKemLayer.js  [nowy]
    - po OLM session established: generuje ML-KEM-768 keypair
    - wysyła ml_kem_pub przez OLM do peera
    - odbiera peer_ml_kem_pub, encapsuluje → ct + ss_kem
    - wysyła ct przez OLM, odbiera peer_ct, decapsuluje
    - derives: session_key = HKDF(olm_room_key ║ ss_kem, channelId, "encedo-v1", 16B)
    - zastępuje room_key w ManagedKeyHandler tym kluczem

jitsi-meet:
  config.js flag: e2ee.encedoMlKem: true   → włącza EncedoMlKemLayer
```

**Co testować:**
- ML-KEM handshake w logach (pubkey sizes, ct size — weryfikacja że to naprawdę ML-KEM-768)
- SFrame nadal działa (szyfrowanie/deszyfrowanie)
- Rozmiar wiadomości OLM powiększony o ~1184B + ~1088B (pubkey + ct) — akceptowalne
- Bez HSM: brak weryfikacji tożsamości w tym kroku (zamierzone)

**Commit:** `feat(e2ee): add ML-KEM-768 key exchange over OLM channel`

---

### Krok 2 — HSM autentykacja (bez ML-KEM)

**Cel:** dodać weryfikację tożsamości przez podpis HSM nad istniejącym OLM.
ML-KEM jeszcze nie — klucz sesji pochodzi z OLM jak w status quo.

**Co się zmienia:**

```
jitsi-meet External API:
  + command: 'send-olm-message'(participantId, type, payload)
  + event:   'olmMessageReceived' { from, type, payload }

host-app (encedo-meet-host):
  encedo/hsmAttestation.ts  [nowy]
    - po videoConferenceJoined:
        sig = HSM.exdsaSign(kid, olm_identity_pub ║ channelId ║ nonce)
        bridge.sendOlmMessage('', 'encedo:attest', { olm_identity_pub, sig, kid_fp })
    - onOlmMessage 'encedo:attest':
        peer_hsm_pub = directory.lookup(peer_kid_fp)  // z JWT claims lub katalogu
        verify(peer_hsm_pub, sig, peer_olm_pub ║ channelId ║ nonce)
        → oznacz peera jako zweryfikowanego / niezweryfikowanego
        → UI: zielona/czerwona ikona przy uczestniku
```

**Config:**
```js
e2ee: { encedoHsmAuth: true }   // ML-KEM off, HSM auth on
```

**Co testować:**
- Podpis HSM generowany (log: `HSM attestation sent to peer`)
- Weryfikacja po stronie odbiorcy (log: `Peer verified: true/false`)
- UI: wskaźnik weryfikacji przy uczestniku
- Połączenie z nieposiadającym HSM: `Peer verified: false` — dostęp odrzucony lub ostrzeżenie
- Klucz sesji nadal z OLM (bez ML-KEM) — krok 2 testuje tylko autentykację

**Commit:** `feat(e2ee): add HSM-backed participant authentication over OLM`

---

### Krok 3 — Full: ML-KEM + HSM (Encedo Protocol v1)

**Cel:** połączenie kroków 1 + 2. Pełny model warstwowy z PLAN.md.

**Co się zmienia:**
- ML-KEM pubkey jest **dodatkowo podpisany przez HSM** przed wysłaniem
- Weryfikacja: receiver sprawdza HSM sig na ml_kem_pub przed encapsulacją
- Room key: `HKDF(ml_kem_ss ║ hsm_shared_context, channelId, "encedo-v1", 16B)`
- OLM room key (z ManagedKeyHandler) jest porzucany — zastąpiony w całości

```js
e2ee: { encedoFull: true }   // ML-KEM + HSM auth
```

**Co testować:**
- Pełny handshake w logach (OLM session → HSM attest → ML-KEM exchange → key set)
- Uczestnik bez HSM: nie może wygenerować ważnego podpisu → rejected
- Uczestnik z HSM innej osoby (skradziony): podpis nieważny (zły klucz prywatny)
- Rotacja klucza przy leave: nowy ML-KEM handshake z pozostałymi → nowy HKDF output

**Commit:** `feat(e2ee): Encedo Protocol v1 — ML-KEM-768 + HSM attestation over OLM`

---

### Warianty config — tabela

| Wariant | `config.js` | OLM | ML-KEM | HSM auth | Uwagi |
|---------|------------|-----|--------|----------|-------|
| Status quo Jitsi | `e2ee: {}` | ✅ | ❌ | ❌ | baseline |
| ML-KEM only | `encedoMlKem: true` | ✅ | ✅ | ❌ | PQC bez autentykacji |
| HSM auth only | `encedoHsmAuth: true` | ✅ | ❌ | ✅ | autentykacja bez PQC |
| Full Encedo | `encedoFull: true` | ✅ | ✅ | ✅ | produkcja |

---

## Pliki referencyjne (tylko read-only, do projektowania)

| Plik | Po co |
|------|-------|
| `jitsi-meet/modules/API/API.js:577-607` | Dostępne komendy External API |
| `jitsi-meet/modules/API/external/external_api.js:126-157` | Dostępne eventy External API |
| `lib-jitsi-meet/modules/e2ee/crypto-utils.ts` | Parametry HKDF do replikacji |
| `lib-jitsi-meet/modules/e2ee/ExternallyManagedKeyHandler.js` | Miejsce patcha |
| `encedo-pgp/hem-sdk-js/hem-sdk.browser.d.ts` | API HEM SDK |
| `encedo-oidc/ARCH.md` | Flow OIDC + JWT issuance |

---

## Weryfikacja end-to-end

1. Uruchom standardowy Jitsi Meet (lokalnie lub docker) z patchem w lib-jitsi-meet
2. `config.js` Jitsi: `e2ee.externallyManagedKey: true`
3. Uruchom `encedo-meet-host` (`npm run dev`)
4. Otwórz dwie karty z różnymi kontami → utwórz spotkanie "TestMeeting"
5. Sprawdź w Jitsi devtools: `APP.store.getState()['features/e2ee'].encryptionKey` niepuste
6. Sprawdź w Wireshark: XMPP stanza `to=` zawiera hash (np. `e3a8f2c1...`), nie "testmeeting"
7. Sprawdź WebRTC-Internals: ruch RTP zaszyfrowany (SFrame trailer widoczny)
8. Odłącz jednego uczestnika → moderator rotuje klucz (widać w logach host-app, nowy
   `keyIndex` w Redux state)

---

## Co NIE jest dotknięte

- `jitsi-meet/` (React app) — 0 zmian
- `lib-jitsi-meet/` — 1 plik, ~10 linii, jako upstream PR
- Deployment Jitsi (Prosody/Jicofo/JVB) — 0 zmian kodu, tylko config
- `encedo-oidc/` — 0 zmian (już gotowy)

Jitsi można aktualizować z upstreamu bez utrzymywania forka — po akceptacji PR zerowa
ingerencja, przed akceptacją jeden rebase na aktualny lib-jitsi-meet (trywialny, bo plik
się prawie nie zmienia).
