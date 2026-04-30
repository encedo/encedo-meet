# Encedo Meet vs. Jitsi Meet — różnice i zalety

## Kryptografia

| | Jitsi (standardowy) | Encedo over Jitsi |
|---|---|---|
| Algorytm wymiany kluczy | X25519 (OLM Double Ratchet) | **ML-KEM-768** (FIPS 203, post-kwantowy) |
| HNDL-safe ("harvest now, decrypt later") | ❌ X25519 podatny na komputer kwantowy | ✅ ML-KEM-768 nie do złamania przez QC |
| Transport wymiany kluczy | XMPP MUC (TLS only — serwer widzi) | **OLM E2EE** — serwer widzi zaszyfrowany blob |
| Gdzie generowany klucz sesji | Wewnątrz Jitsi JS VM | **Host-app** — poza Jitsi, poza iframe |
| Weryfikacja tożsamości uczestnika | Brak (lub JWT — serwer weryfikuje) | *Placeholder →* **HSM** (sprzętowy podpis ExDSA) |
| Rekey przy wyjściu uczestnika | Brak | ✅ automatyczny (forward secrecy) |
| Failover dystrybutora | N/A | ✅ następny uczestnik (min ID) przejmuje |

## Co jest szyfrowane

| Funkcja | Jitsi standardowy | Encedo |
|---|---|---|
| Audio | ✅ SFrame (klucz OLM-wewnętrzny) | ✅ SFrame (klucz ML-KEM) |
| Video (kamera) | ✅ SFrame | ✅ SFrame |
| Dzielenie ekranu | ✅ SFrame | ✅ SFrame |
| Wymiana kluczy | ❌ XMPP plaintext | ✅ OLM E2EE |
| Chat | ❌ XMPP MUC plaintext | ❌ (wbudowany Jitsi) / ✅ (opcjonalny overlay przez OLM) |
| Metadata (nicke, join/leave) | ❌ XMPP presence | ❌ (bez zmian) |
| Sygnalizacja (SDP, ICE) | ❌ XMPP Jingle | ❌ (bez zmian) |

## Architektura

**Jitsi standardowy:**
```
Przeglądarka → Jitsi JS VM → OLM (klucz wewnętrzny) → SFrame → JVB → ...
```

**Encedo:**
```
Host-app (React) ──External API──→ Jitsi iframe
     │                                   │
     │  ML-KEM-768 handshake             │ OLM E2EE transport
     │  (room key w host-app)            │ (serwer widzi blob)
     │                                   │
     └──setMediaEncryptionKey(roomKey)──→ SFrame → JVB → ...
```

Klucz sesji generowany jest w host-app i nigdy nie wychodzi poza niego w postaci jawnej.
Jitsi dostaje tylko finalny klucz AES do ustawienia w SFrame — nie wie skąd pochodzi.

## Model dystrybucji klucza grupowego

Uczestnik o najniższym ID = dystrybutor. Przy każdym join/leave:
1. Dystrybutor generuje nowy 16-bajtowy `roomKey`
2. Dla każdego peera: ML-KEM exchange → HKDF(shared_secret) → AES-GCM wrap → wysyła `roomKey`
3. Wszyscy ustawiają ten sam klucz na tym samym `epoch` (SFrame key index)
4. Jeśli dystrybutor wyjdzie — następny (min ID) przejmuje automatycznie

## Porównanie z Signal Sender Keys

| Aspekt | Signal (grupowy) | Encedo |
|---|---|---|
| Topologia | Peer-to-peer (każdy ↔ każdy) | Gwiazda (każdy ↔ dystrybutor) |
| Dystrybucja klucza | O(N²) pairwise | O(N) przez dystrybutora |
| PQC | PQXDH (X25519 + ML-KEM-768) | ML-KEM-768 |
| Rekey on leave | Wszyscy generują nowe SenderKeys | Dystrybutor generuje nowy roomKey |
| Wymagany host | ❌ | ✅ (upraszcza handshake) |

Tradeoff: Signal jest w pełni peer-to-peer (brak pojedynczego punktu awarii).
Encedo wymaga obecności dystrybutora — akceptowalne dla wideokonferencji
(organizator i tak musi być obecny).

## Planowane rozszerzenia

- **HSM attestation** — podpis ExDSA nad `kyber-pub || channelId || nonce`; weryfikacja przed encapsulacją; uczestnik bez HSM nie może dołączyć
- **Encrypted chat overlay** — chat w host-app przez OLM channel (E2EE), ukrycie wbudowanego chatu Jitsi
- **Anonimizacja channelId** — HKDF(ECDH tożsamości, nonce) zamiast nazwy pokoju w plaintext
- **OIDC/JWT auth** — integracja z encedo-oidc, JWT z `encedo_kid` claim

## Zmiany w Jitsi (upstream PR candidates)

Łącznie ~45 linii diff w 3 plikach:

| Plik | Zmiana |
|---|---|
| `lib-jitsi-meet/modules/e2ee/OlmAdapter.js` | `sendCustomMessage` + event `CUSTOM_MESSAGE_RECEIVED` |
| `jitsi-meet/modules/API/API.js` | komenda `send-olm-message` + event `olmMessageReceived` (fix: pola na poziomie obiektu, nie w `data:{}`) |
| `jitsi-meet/modules/API/external/external_api.js` | `sendOlmMessage` w mapie komend |
