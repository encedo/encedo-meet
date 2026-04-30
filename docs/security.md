# Analiza możliwości inwigilacji — Encedo Meet

## Model zagrożeń

Trzy perspektywy: dostawca sieci (ISP), operator serwera (my), służby specjalne.

---

## Dostawca sieci (ISP)

**Widzi:**
- IP serwera + timing + wolumen ruchu (kto kiedy ile transferował)
- SNI w TLS handshake → nazwę domeny (`meet.encedo.com`)
- DNS queries (jeśli nie DoH/DoT)
- Graf społeczny: które IP łączyły się jednocześnie z tym samym serwerem

**Nie widzi:**
- Nazwy pokoju
- Treści mediów (SFrame E2EE)
- Treści chatu (OLM)
- Kluczy

**Może:** korelować timing połączeń → "te dwa IP były na calu w tym samym czasie"

---

## Operator serwera (my)

Największa luka w obecnym designie.

**Widzimy:**
- **Nazwę pokoju** — jest częścią XMPP MUC JID: `roomname@conference.domain`. Widoczna w logach XMPP w plaintext
- **Kto z kim** — które JID dołączyły do którego pokoju, kiedy, jak długo
- **IP uczestników** — z połączenia HTTPS/WebSocket
- **Rozmiar OLM stanz** — nie treść, ale fakt wymiany kluczy i timing

**Nie widzimy:**
- Treści mediów — JVB dostaje zaszyfrowane RTP (SFrame), nie ma klucza
- Treści chatu — OLM ciphertext, opaque dla serwera
- Kluczy ML-KEM ani room key — nigdy nie przechodzą przez serwer

**Możemy (atak aktywny):**
- Podmienić JS przed dostarczeniem do klienta → kompromitacja endpointa
- Jedyne zabezpieczenie: CSP + subresource integrity + natywna apka zamiast web

---

## Służby specjalne

**Przez serwer (legal intercept):**
- Mogą dostać to co my — metadane (kto kiedy z kim), nazwy pokoi
- Mogą zażądać zachowania logów
- Treści mediów/chatu: bez klucza bezużyteczne
- Mogą zażądać przyszłych kluczy przy aktywnej obserwacji (brak ochrony przed tym)

**Przez sieć:**
- Traffic analysis — korelacja timing/wolumen
- Nie mogą odszyfrować bez kluczy

**Endpoint compromise:**
- Dostęp do urządzenia → game over, HSM nie pomoże — przechwyt po deszyfracji
- HSM chroni klucz tożsamości, nie pamięć procesu

**Forward secrecy:**
- Room key zmienia się przy każdym join/leave → stare nagrania nie do odszyfrowania nawet po przejęciu obecnych kluczy ✓

---

## Nazwa pokoju — krytyczna luka

Obecny stan: nazwa pokoju przekazywana do Jitsi wprost → widoczna w XMPP jako
`roomname@conference.domain`, zapisywana w logach serwera w plaintext.

### Opcje mitygacji

**1. Hash (najprościej)**
```typescript
const roomId = toHex(await sha256(roomName)).slice(0, 32);
// użytkownik wpisuje "projekt-alfa", serwer widzi "3f7a2b..."
```
Serwer nie może odwrócić. Ale ten sam hash → ten sam pokój → korelacja historyczna możliwa.

**2. Losowe ID + hasło pokoju out-of-band**
```
roomId = random UUID (jednorazowy)
roomPassword = shared secret (wymieniony out-of-band lub przez HSM)
```
Serwer widzi UUID bez znaczenia semantycznego, nie może korelować z tematem.

**3. Hash(name + session_nonce) — najsilniejsze**
Nonce zmienny przy każdej sesji → ten sam "projekt-alfa" każdorazowo inny ID w XMPP.
Serwer nie może korelować nawet historycznie.

---

## Podsumowanie luk według priorytetu

| Ryzyko | Dotkliwość | Trudność mitygacji |
|---|---|---|
| Nazwa pokoju widoczna w XMPP | Wysoka | Niska — hash/nonce |
| Metadane: kto kiedy z kim | Średnia | Średnia — losowe JID, padding ruchu |
| JS delivery attack (operator podmienia JS) | Wysoka | Wysoka — wymaga natywnej apki |
| Endpoint compromise | Krytyczna | Bardzo wysoka — poza zakresem |
| Traffic analysis (ISP) | Niska–Średnia | Wysoka — VPN/Tor, cover traffic |

---

## Autoryzacja backendu — JWT vs hasło pokoju z ECDH

### Dlaczego JWT nie jest potrzebny

JWT w Prosody wymaga, żeby serwer znał tożsamość uczestnika — sprzeczne z modelem
gdzie serwer jest potencjalnie wrogi. JWT dodaje serwer jako zaufany autorytet tożsamości,
co niszczy prywatność metadanych.

Weryfikacja tożsamości w Encedo Meet jest **peer-to-peer** (EdDSA + PANIC) — serwer
nie jest w tym łańcuchu.

### Problem bez JWT — DoS

Bez ochrony wejścia do pokoju: atakujący zna room ID → dołącza → HSM PANIC odpala →
legalny call dropuje. Prosty DoS przez wielokrotne dołączanie.

### Rozwiązanie — hasło pokoju wyprowadzone z ECDH

```
room_password = HKDF(ecdh_shared, nonce, "room-password")[:16]
```

To samo ECDH co do wyprowadzenia room ID (operacja 2 klucza X25519).
Tylko uczestnicy z kluczem X25519 i znajomością peer pubkey mogą wyliczyć hasło.

- Serwer Prosody **egzekwuje** hasło (blokuje wejście) ale go **nie rozumie**
- Serwer nie zna tożsamości uczestników
- Przypadkowy napastnik nie wejdzie — brak hasła
- HSM PANIC pozostaje jako ostatnia linia obrony dla edge cases
- Zero dodatkowych operacji HEM — hasło pochodzi z tego samego ECDH co room ID

### Podsumowanie

| Mechanizm | Kto weryfikuje | Serwer zna tożsamość | Chroni przed DoS |
|---|---|---|---|
| JWT (Prosody) | serwer | tak | tak |
| Hasło z ECDH | serwer (blind) | nie | tak |
| HSM PANIC | peer-to-peer | nie | nie (za późno) |

Właściwa kolejność: hasło z ECDH blokuje wejście → HSM PANIC jako ostateczna weryfikacja.

---

## Rekomendacje

1. **Krótkoterminowo:** hash nazwy pokoju (`SHA-256(name + nonce)`) — jedna zmiana w `JitsiBridge.ts`
2. **Średnioterminowo:** natywna apka (Electron/mobile) zamiast web — eliminuje JS delivery attack
3. **Długoterminowo:** losowe JID uczestników per-sesja, brak stałych identyfikatorów w XMPP

---

## Tożsamość X25519 — jeden klucz, dwie operacje

Każdy uczestnik ma w HEM klucz X25519 (Ed25519 + ECDH na tej samej parze kluczy).
Publiczne klucze wymienione out-of-band — tworzą krąg zaufania.

### Operacja 1 — potwierdzenie tożsamości (EdDSA sign)

```
sig = HEM.sign(kyber_pub || olm_session_pub || session_nonce)
```

Odbiorca weryfikuje `sig` kluczem publicznym nadawcy z lokalnego repozytorium zaufania.
Weryfikacja negatywna → PANIC, call dropuje natychmiast.

### Operacja 2 — room ID i deszyfrowanie nazwy pokoju (ECDH + HKDF)

```
shared   = HEM.ecdh(peer_x25519_pub)          // klucz prywatny nigdy nie opuszcza HEM
key      = HKDF(shared, nonce)
room_id  = SHA-256(key)[:32]                  // ID w XMPP — serwer nie wie co to
room_name = AES-GCM-decrypt(key, ciphertext)  // ciphertext z URL #fragment
```

Link zaproszenia:
```
https://meet.encedo.com/join#n=<nonce>&r=<AES-GCM(key, "projekt-alfa")>
```

- Fragment `#...` nigdy nie jest wysyłany w HTTP request — serwer go nie widzi
- Zapraszający i zaproszony robią ECDH ze swoich stron → ten sam `shared` (symetria DH)
- Każde zaproszenie ma inny `nonce` → inny `room_id` i inny ciphertext nawet dla tego samego pokoju
- Użytkownik widzi przyjazną nazwę, serwer widzi tylko bezsensowny hash w XMPP

### Zyski

- Zero dodatkowych kluczy — klucz tożsamości robi wszystko
- Tylko dwie operacje HEM na całą sesję: `sign` + `ecdh`
- Serwer ślepy na nazwę pokoju i tożsamość uczestników
- Każdy link jednorazowy przez nonce

### Uwaga kryptograficzna

X25519 (ECDH) i Ed25519 (EdDSA) to różne reprezentacje tej samej krzywej 25519
(Montgomery vs twisted Edwards) — konwersja jest dobrze znana, HEM obsługuje obie
operacje jednym kluczem. Taki sam wzorzec stosuje Signal Protocol.

---

## Co chroni HSM

- Klucz tożsamości użytkownika nigdy nie opuszcza urządzenia
- Podpis pod `kyber-pub` + OLM session pubkey → odbiorca weryfikuje tożsamość nadawcy
- Klucze wymienione out-of-band → żaden MITM nie może podszyć się pod uczestnika
- HSM **nie chroni** przed: endpoint compromise, traffic analysis, metadanymi serwera

### Architektura HSM (Encedo HEM)

HSM udostępnia operacje kryptograficzne przez **REST API z TLS** — nawet gdy urządzenie podłączone przez USB działa jako lokalny serwer HTTP/TLS. Klucz prywatny nigdy nie opuszcza urządzenia, na zewnątrz wychodzą wyłącznie wyniki operacji (podpis, wynik KEM).

SDK: `/hem-sdk-js` — gotowa biblioteka JS do integracji z host-app.

```
host-app  →  REST/TLS  →  HEM (USB)  →  operacja kryptograficzna
                           klucz prywatny nigdy nie opuszcza HEM
```

Dzięki REST API integracja działa identycznie w przeglądarce i w Electron — brak zależności od WebUSB czy natywnych bindingów.

---

## Natywna apka (Electron) — plan mitygacji JS delivery attack

### Problem przeglądarki

Przeglądarka to fundamentalnie otwarte środowisko:
- Devtools pozwalają postawić breakpoint w dowolnym miejscu i odczytać zmienne (w tym `roomKey`)
- Monkey-patching: `crypto.subtle.encrypt = ...` → przechwyt kluczy przed szyfrowaniem
- Heap snapshot: `Uint8Array` room key widoczny w pamięci jako surowe bajty
- JS delivery attack: operator serwera może podmienić bundle przed dostarczeniem

Obecna mitygacja: logi kluczy ukryte w produkcji (`import.meta.env.DEV`), ale devtools nadal dają dostęp.

### Electron jako rozwiązanie

Host-app to Vite + React — migracja do Electron to dodanie ~50 linii kodu głównego procesu.

**Struktura:**
```
encedo-meet-host/
  src/              ← bez zmian
  electron/
    main.ts         ← BrowserWindow, disable devtools w produkcji
    preload.ts      ← opcjonalny bridge main↔renderer
```

**Zyski:**

| | Przeglądarka | Electron (prod) |
|---|---|---|
| Devtools | dostępne zawsze | zablokowane |
| JS delivery attack | możliwy | code signing eliminuje |
| HSM (REST/TLS) | identyczne | identyczne |
| Trusted app (root-of-trust) | CSP + SRI | podpisany binary |

**Trusted app flow (Encedo HEM):**
Pierwszy ładowany HTML z inline JS jest podpisany przez HEM i weryfikowany przy starcie → sprzętowy root-of-trust dla całego łańcucha ładowania. Operator serwera nie może podmienić JS bo podpis nie przejdzie weryfikacji.

**Nakład pracy:**
- Podstawowy wrapper działający: 1 dzień
- Wyłączenie devtools + code signing (Windows/Mac): 1–2 dni
- Integracja `hem-sdk-js`: bez zmian względem wersji webowej (REST/TLS działa tak samo)
- Auto-update (electron-updater): pół dnia
