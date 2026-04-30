# Jitsi Meet — obecna architektura E2EE (stan upstream, bez zmian Encedo)

Dokument referencyjny opisujący jak działa End-to-End Encryption w czystym Jitsi Meet.
Zachowany żeby nie trzeba było ponownie analizować przy dalszych iteracjach planu Encedo.

---

## 1. Wysokopoziomowy obraz

Jitsi Meet używa **podwójnej warstwy** szyfrowania:

- **Warstwa transportowa**: DTLS-SRTP między klientem a JVB (Jitsi Videobridge — SFU).
  Standard WebRTC. JVB widzi pakiety RTP **odszyfrowane** na poziomie SRTP.
- **Warstwa E2E** (opcjonalna, ten dokument): dodatkowe szyfrowanie zawartości payloadu RTP
  **przed** wejściem do PeerConnection. JVB widzi tylko nagłówki RTP + zaszyfrowany payload —
  nie może zdekodować audio/video.

Standard E2E w Jitsi: wariant **SFrame** (`draft-omara-sframe-00`) nazwany **JFrame**.
Klucze dystrybuowane przez **Olm** (Matrix's Double Ratchet) sesje pairwise.

```
┌─────────────────────────────────────────────────────────────┐
│ Klient A                                                     │
│  Mikrofon/Kamera → Encoder (Opus/VP8) → RTCEncodedFrame      │
│                                            │                 │
│                                            ▼                 │
│                              ┌──────────────────────┐        │
│                              │ E2EEContext (Worker) │        │
│                              │  AES-GCM 128-bit     │        │
│                              │  klucz: media key    │        │
│                              └──────────┬───────────┘        │
│                                         ▼                    │
│                              [zaszyfrowany payload]          │
│                                         ▼                    │
│                                  PeerConnection              │
│                                  (DTLS-SRTP)                 │
└─────────────────────────────────────────┬───────────────────┘
                                          │
                                          ▼
                                ┌─────────────────┐
                                │  JVB (SFU)      │
                                │  widzi RTP      │
                                │  ALE NIE widzi  │
                                │  zawartości     │
                                └────────┬────────┘
                                         ▼
                            (analogicznie u odbiorcy: deszyfrowanie)
```

---

## 2. Trzy współpracujące mechanizmy

### A) Olm (key exchange channel)
- Pairwise zaszyfrowany kanał między każdą parą uczestników (Double Ratchet)
- Używany **wyłącznie** do dystrybucji kluczy media — nie szyfruje samego media
- Bazuje na X25519 (curve25519) + Ed25519, biblioteka `@matrix-org/olm`

### B) E2EEContext + JFrame (media encryption)
- AES-GCM 128-bit szyfruje payload każdego RTCEncodedFrame
- Web Worker (osobny kontekst) — performance + izolacja kluczy
- Format ramki:
  `[headers nieszyfrowane] [zaszyfrowany payload] [IV 12B] [IV_LENGTH 1B] [KEY_INDEX 1B]`

### C) SAS Verification (opcjonalna manualna weryfikacja)
- Użytkownicy porównują 6 emoji/słów (Short Authentication String)
- Wykrycie MITM na poziomie XMPP

---

## 3. Sekwencja: dwie strony dołączają do call'a

### Krok 1 — Inicjalizacja Olm na każdym kliencie

Plik: `lib-jitsi-meet/modules/e2ee/OlmAdapter.js:325-343` (`_bootstrapOlm`)

```
await Olm.init()
account = new Olm.Account()
account.create()                      ← generuje losowo:
                                        - curve25519 identity key (32B)
                                        - ed25519 identity key (32B)
                                        - 100 one-time keys (curve25519)
idKeys = account.identity_keys()      ← {curve25519: "...", ed25519: "..."}
```

Klucze prywatne **żyją w pamięci RAM przeglądarki**. Brak persystencji — każdy join generuje
nową tożsamość.

### Krok 2 — Publikacja tożsamości w XMPP presence

Plik: `OlmAdapter.js:416-427` (`_onIdKeysReady`)

Każdy klucz publiczny trafia do XMPP presence stanza jako properties:

```xml
<presence to="myroom@conference.meet.example.com/nick123">
  <jitsi_participant_e2ee.idKey.curve25519>BASE64_PUBKEY</jitsi_participant_e2ee.idKey.curve25519>
  <jitsi_participant_e2ee.idKey.ed25519>BASE64_PUBKEY</jitsi_participant_e2ee.idKey.ed25519>
  <jitsi_participant_e2ee.enabled>true</jitsi_participant_e2ee.enabled>
</presence>
```

Serwer XMPP (Prosody) routuje to do wszystkich w pokoju. Wszyscy poznają nawzajem swoje
identity public keys.

### Krok 3 — Establishing pairwise Olm session

Inicjator (deterministycznie: ten z niższym participantId) wysyła SESSION_INIT:

```
1. account.generate_one_time_keys(1)
2. otKey = account.one_time_keys().curve25519[0]
3. account.mark_keys_as_published()
4. message = {
     type: 'olm',
     olm: {
       type: SESSION_INIT,
       data: {
         idKey: my_curve25519_pub,
         otKey: otKey,
         uuid: <random>
       }
     }
   }
5. wyślij przez XMPP private message do peer participantId
```

Odbiorca:
```
1. session = new Olm.Session()
2. session.create_inbound(account, body)        ← Triple Diffie-Hellman
3. account.remove_one_time_keys(session)        ← klucz zużyty
4. odeśle SESSION_ACK z pierwszą zaszyfrowaną wiadomością
```

Po obu stronach: wspólna **Olm session** (Double Ratchet state) — każda strona ma swój
chain key, message keys ratchetują się przy każdej wiadomości.

### Krok 4 — Generacja media key (lokalnie, każdy uczestnik)

Plik: `lib-jitsi-meet/modules/e2ee/ManagedKeyHandler.js`

Każdy uczestnik **swój własny** klucz media:

```
keyMaterial = crypto.getRandomValues(32 bytes)        ← 256 bitów random
keyIndex    = 0 (rośnie przy rotacji)
```

To **NIE jest** klucz AES bezpośrednio — to materiał wejściowy do HKDF.

### Krok 5 — Dystrybucja media key przez Olm

Dla każdego peer'a w pokoju:

```
plaintext = JSON.stringify({
  type: KEY_INFO,
  data: {
    key: base64(keyMaterial),
    keyIndex: 0
  }
})

ciphertext = olmSession.encrypt(plaintext)            ← Double Ratchet step

wyślij {olm: {type: KEY_INFO, data: ciphertext}} przez XMPP private message
```

Odbiorca:
```
plaintext = olmSession.decrypt(ciphertext)            ← Double Ratchet decrypt
{key, keyIndex} = JSON.parse(plaintext)
e2eeContext.setKey(senderId, {keyMaterial: base64decode(key)}, keyIndex)
```

Każdy uczestnik trzyma **mapę kluczy**: `participantId → keyMaterial`.
Maks. 16 kluczy per uczestnik (4-bitowy KEY_INDEX w ramce → ring buffer).

### Krok 6 — Derivacja AES-GCM klucza

Plik: `lib-jitsi-meet/modules/e2ee/crypto-utils.ts`

W E2EEContext:

```
material = crypto.subtle.importKey('raw', keyMaterialBytes, 'HKDF', false,
                                   ['deriveBits', 'deriveKey'])

aesGcmKey = crypto.subtle.deriveKey({
  name: 'HKDF',
  hash: 'SHA-256',
  salt: utf8('JFrameEncryptionKey'),
  info: empty
}, material, { name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt'])
```

128-bit AES-GCM (nie 256 — explicite, "klucze są krótkozżywające, więc 128 wystarczy" —
`lib-jitsi-meet/doc/e2ee.md`).

### Krok 7 — Szyfrowanie ramek media

Plik: `lib-jitsi-meet/modules/e2ee/Worker.js` + `Context.ts`

WebRTC Insertable Streams: `RTCRtpSender.transform = new RTCRtpScriptTransform(worker)`.
Każdy outgoing frame przechodzi przez worker.

Per ramka:

```
1. Przeczytaj nagłówek payloadu (NIE szyfrujemy):
     - VP8 keyframe: pierwsze 10B
     - VP8 deltaframe: pierwsze 3B
     - Opus audio: 1B (TOC byte)

2. Konstrukcja IV (96-bit):
     IV = SSRC (4B) || RTP_timestamp (4B) || frameCounter (4B)

3. additional data (AAD) = nagłówek payloadu

4. ciphertext = AES-GCM-encrypt(aesGcmKey, IV, plaintext_payload, AAD)
                                                  ↑                  ↑
                                           reszta payloadu     auth dla nagłówka

5. trailer = IV (12B) || IV_LENGTH (1B = 12) || KEY_INDEX (4 bity widely w 1B)

6. Wyjściowa ramka:
     [unchanged_header] || ciphertext (zawiera 16B GCM tag) || trailer (14B overhead)
```

Headery zostawiamy nieszyfrowane bo SFU musi widzieć:
- VP8 frame markers (czy to keyframe — dla forwarding decisions)
- Opus TOC (frame size — dla packetization)

To jest "plausible deniability for SFU" — JVB myśli że dostaje normalny RTP, tylko payload
wygląda jak losowe bajty.

### Krok 8 — Deszyfrowanie po stronie odbiorcy

```
1. Wyciągnij trailer (ostatnie 14B): IV + IV_LENGTH + KEY_INDEX
2. participantId = z metadata RTCEncodedFrame (SSRC → mapowanie)
3. keyMaterial   = mapa[participantId][KEY_INDEX]
4. aesGcmKey     = HKDF(keyMaterial)  ← deriveKeys, ten sam co po stronie nadawcy
5. plaintext     = AES-GCM-decrypt(aesGcmKey, IV, ciphertext, AAD=header)

6. Jeśli auth tag fail → spróbuj **ratchet** (forward):
     keyMaterial' = HKDF-SHA256(keyMaterial, salt: 'JFrameRatchetKey', 256B)
     deryw nowy aesGcmKey, spróbuj ponownie
     (max kilka kroków, nieudane → drop frame)
```

Ratchet implementuje "lazy synchronization" — gdy nadawca rotuje klucz a odbiorca jeszcze
nie dostał notyfikacji, odbiorca dogania ratchetując.

---

## 4. Topologia z SFU (kluczowe!)

Jitsi NIE jest mesh — każdy klient ma **jedno połączenie WebRTC z JVB** (Selective
Forwarding Unit). JVB replikuje strumienie.

```
        A ◄─── jeden upload, jeden download (multipleksowany) ───► JVB
        B ◄────────────────────────────────────────────────────► JVB
        C ◄────────────────────────────────────────────────────► JVB
        D ◄────────────────────────────────────────────────────► JVB
```

A wysyła **jeden strumień** swojego audio/wideo do JVB. JVB **kopiuje** ten sam strumień
(te same pakiety RTP, ten sam payload, ten sam SSRC) do B, C, D.

### Klucze w grupie N=4

Każdy nadawca ma **jeden klucz dla swojego strumienia** (broadcast key). Tym samym kluczem
szyfruje co wysyła — niezależnie od liczby odbiorców.

```
A ma:  K_A_send  (szyfruje swój audio+wideo)
B ma:  K_B_send  (szyfruje swój audio+wideo)
C ma:  K_C_send
D ma:  K_D_send
```

A wysyła **jeden zaszyfrowany strumień** kluczem `K_A_send`. JVB rozprowadza ten strumień
do B, C, D — wszyscy trzej deszyfrują tym samym `K_A_send`.

### Co musi mieć odbiorca (np. B)

```
B przechowuje:
  K_B_send       ← własny klucz, szyfruje swoje wychodzące
  K_A_send       ← do deszyfrowania strumienia od A
  K_C_send       ← do deszyfrowania strumienia od C
  K_D_send       ← do deszyfrowania strumienia od D
```

Czyli **N kluczy łącznie** dla N uczestników (1 swój + N-1 cudzych do deszyfrowania).

### Strumień własny

B nie szyfruje/deszyfruje "samego siebie":

- **Przed wysłaniem** (encoder → sieć): B szyfruje **raz** kluczem `K_B_send` przed
  wysłaniem do JVB. JVB nie zobaczy plaintextu.
- **Echo / loopback**: WebRTC nie odsyła do B jego własnego strumienia z powrotem.
  B ma już lokalnie surowy obraz z własnej kamery (do podglądu w UI) — to jest
  **niezależne** od pipeline'u E2EE. Lokalny `<video>` element pokazujący `MediaStream`
  z `getUserMedia()`.

B faktycznie ma **3 strumienie do deszyfrowania** (od A, C, D) + 1 lokalny preview siebie
(bez E2EE, bo nigdy nie opuścił przeglądarki) + 1 strumień który sam wysłał (zaszyfrowany,
ale go nie odbiera z powrotem).

### Mapping w SFrame: po czym odbiorca wybiera klucz?

Każda zaszyfrowana ramka (JFrame) ma w trailerze:
```
[ciphertext] [IV 12B] [IV_LENGTH 1B] [KEY_INDEX 1B]
```

KEY_INDEX to indeks w ring buffer **per nadawca**. Mapowanie ramka→nadawca robi się przez
**SSRC** (Synchronization Source) z nagłówka RTP — to jest plaintext, JVB go potrzebuje
do routingu.

W `E2EEContext`:
```
ssrc → participantId   ← znane z sygnalizacji XMPP
participantId → mapa[KEY_INDEX] → klucz_nadawcy
```

Więc odbiorca dla każdej przychodzącej ramki:
1. Czyta SSRC z nagłówka RTP (plaintext)
2. Mapuje SSRC → participantId nadawcy
3. Czyta KEY_INDEX z trailera
4. Szuka `klucz[participantId][KEY_INDEX]` w swojej tablicy
5. Deszyfruje AES-GCM tym kluczem

### Liczba SSRC vs liczba kluczy

Jeden uczestnik może mieć **wiele SSRC** (np. simulcast wideo: 3 warstwy LD/SD/HD = 3 SSRC
+ audio = 4 SSRC łącznie). Wszystkie te SSRC od jednego nadawcy szyfrowane są **tym samym**
kluczem `K_A_send`. Mapowanie SSRC→participantId daje wszystkie SSRC jednego uczestnika
ten sam klucz.

### Tabela podsumowująca (4 uczestników)

| Aspekt | Wartość |
|--------|---------|
| Strumieni wychodzących z A do sieci | 1 (zaszyfrowany kluczem `K_A_send`) |
| Strumieni przychodzących do B z sieci | 3 (od A, C, D) |
| Kluczy które trzyma B | 4 (1 send + 3 recv) — albo 3 jeśli liczymy tylko cudze |
| Strumieni które B widzi w UI | 4 (lokalny preview siebie + 3 zdalne) |
| Lokalny preview B | nie przechodzi przez E2EE pipeline w ogóle |
| Wysyłek kluczy przy setup (Olm pairwise, N=4) | 12 (każdy do każdego) |

---

## 5. Cykl życia kluczy

### Generation
- Każdy uczestnik ma **własny media key** (asymetria nadawca/odbiorca, podobnie do Signal
  Sender Keys)

### Ratchet (przy join nowego uczestnika)
Plik: `OlmAdapter.js`, event `USER_JOINED`

- **Wszyscy istniejący** uczestnicy ratchetują swój media key:
  ```
  newKeyMaterial = HKDF(oldKeyMaterial, salt: 'JFrameRatchetKey', 256B)
  keyIndex++
  ```
- Ratchet jest **deterministyczny** — nowy uczestnik DOSTAJE aktualny `keyMaterial` przez
  Olm, dalej sam ratchetuje
- **NIE wysyłamy** ratchetowanego klucza przez Olm (forward secrecy: nowo dołączony nie
  odszyfruje historycznych ramek)

### Rotation (przy leave uczestnika)
Plik: `ManagedKeyHandler.js`, event `USER_LEFT`, debounce 5s

- Wszyscy uczestnicy generują **całkowicie nowy losowy** keyMaterial
- Dystrybuują przez Olm do wszystkich pozostałych
- Stary uczestnik nie ma nowego klucza → nie odszyfruje przyszłego ruchu

Debounce 5s — żeby nie rotować kilka razy gdy wychodzi grupa naraz.

---

## 6. SAS Verification (opcjonalna)

Manual MITM detection. Bazuje na Matrix spec.

Sekwencja (uproszczona):
```
A → B: SAS_START (transactionId)
B → A: SAS_ACCEPT (commitment = HMAC(B_pub, transactionId))
A → B: SAS_KEY (A_ephemeral_pub_for_SAS)
B → A: SAS_KEY (B_ephemeral_pub_for_SAS)
       ↓
       Każdy liczy: shared = ECDH(my_eph, peer_eph)
       Wyświetl 6 emoji/słów z HKDF(shared, "MATRIX_KEY_VERIFICATION_SAS")
       ↓
A i B porównują głosem/wzrokowo
       ↓
A → B: SAS_MAC = HMAC(shared, A_ed25519_id_pub || ...)
B → A: SAS_MAC = HMAC(shared, B_ed25519_id_pub || ...)
       ↓
Każdy weryfikuje MAC i oznacza peer'a jako "verified"
```

Po sukcesie — UI pokazuje "✓ verified" przy uczestniku.

---

## 7. Wybory architektoniczne i ograniczenia

### Co robi to dobrze
- **JVB nie deszyfruje media** — wystarczy mu kompresja niezaszyfrowanego nagłówka VP8 do routingu
- **Forward secrecy częściowy** — leave triggeruje pełną rotację, nowi nie widzą historii (ratchet)
- **Authentication** — AES-GCM zawiera auth tag, weryfikacja MAC w SAS
- **Asymetria per-sender** — każdy nadawca ma własny klucz, jak w Signal Sender Keys
- **Efektywność z SFU** — A wysyła jeden zaszyfrowany strumień niezależnie od liczby odbiorców

### Ograniczenia / kompromisy
- **Identity keys ulotne** — każdy join generuje nowe Olm identity. Brak długożywej tożsamości
  → SAS verification dotyczy tylko bieżącej sesji
- **Klucze tylko w RAM** — exit z karty = utrata kluczy
- **Brak PQC** — czysty X25519 + AES-GCM, podatne na "harvest now decrypt later"
- **Trust w server XMPP dla announcement** — server widzi public identity keys; może w teorii
  zrobić MITM przez podmianę presence (mityguje SAS)
- **Media keys symmetric (sharedKey: true)** w trybie `externallyManagedKey` — w
  ManagedKeyHandler każdy ma swój, ale w External tryb jest jeden shared
- **Nazwa pokoju czytelna w XMPP JID** — serwer wie kto z kim
- **WebRTC handshake sygnalizacja** (ICE candidates, SDP) idą w plaintext przez XMPP — JVB
  zna IP, codeci, SSRC
- **N×(N-1) wysyłek kluczy** przez Olm pairwise przy każdym setup/rotate

### Wymaganie browsera
- Insertable Streams (Chromium-based) lub Encoded Transform (Firefox)
- WebCrypto SubtleCrypto (HKDF, AES-GCM)
- Web Workers (transferable streams)

---

## 8. Kluczowe pliki

| Plik | Zadanie |
|------|---------|
| `lib-jitsi-meet/modules/e2ee/E2EEncryption.js` | Top-level: wybór ManagedKeyHandler vs ExternallyManagedKeyHandler |
| `lib-jitsi-meet/modules/e2ee/KeyHandler.js` | Wiring track events do E2EEContext, lifecycle |
| `lib-jitsi-meet/modules/e2ee/ManagedKeyHandler.js` | Logika rotacji/ratchetu z Olm jako transportem |
| `lib-jitsi-meet/modules/e2ee/ExternallyManagedKeyHandler.js` | Stub do externally-supplied keys (tu wpinamy się my) |
| `lib-jitsi-meet/modules/e2ee/OlmAdapter.js` | Pełna implementacja Olm: bootstrap, sessions, key dist, SAS |
| `lib-jitsi-meet/modules/e2ee/E2EEContext.ts` | Bridge main thread → Web Worker, mapowanie klucz→participant |
| `lib-jitsi-meet/modules/e2ee/Worker.js` | Web Worker z transformem szyfrowania |
| `lib-jitsi-meet/modules/e2ee/Context.ts` | Per-participant context: encrypt/decrypt frames, ratchet on auth fail |
| `lib-jitsi-meet/modules/e2ee/crypto-utils.ts` | HKDF deriveKeys, ratchet, importKey |
| `lib-jitsi-meet/modules/e2ee/SAS.ts` | Krótki authentication string generation |
| `lib-jitsi-meet/doc/e2ee.md` | Oficjalna dokumentacja Jitsi (skrótowa) |

---

## 9. Mapowanie do planu Encedo (gdzie się wpinamy)

| Słabość obecnego stanu | Nasz plan (PLAN.md) |
|------------------------|---------------------|
| Identity ulotne, w RAM | Klucz tożsamości X25519 w HSM Encedo (długożywy) |
| Brak PQC | Hybrid PQXDH: ML-KEM-768 + X25519 |
| Olm jako transport (sesje pairwise w software) | External API + nasze pairwise przez `send-endpoint-text-message` |
| `sharedKey: true` w externallyManaged | Asymetria send/receive (patch upstream #2/#3) |
| Nazwa pokoju czytelna | channelId = HKDF(group_seed, nonce_R, ...) — nieskorelowalne |
| Brak weryfikacji członkostwa grupy | Creator-anchored model + signed roster (TBD) |
| N×(N-1) wysyłek pairwise | Gwiazda przez hosta (N pairwise + N forwardów broadcast keys) |
