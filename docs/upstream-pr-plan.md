# Plan upstream PRów do Jitsi

## Status

Patches gotowe w naszym forku, czekamy na merge przez Jitsi team zanim
robimy kolejne PRy. Szczegóły techniczne w `jitsi-changes.md` i `jitsi-changes2.md`.

---

## PRy już gotowe (czekają na zgłoszenie)

### PR-A: `lib-jitsi-meet` — ExternallyManagedKeyHandler fix (B1/B2/B3)
**Branch:** brak osobnego — commit `e4e6ca9c` w naszym forku  
**Upstream PR:** https://github.com/jitsi/lib-jitsi-meet/pull/3028  
**Status:** zgłoszony  

### PR-B: `lib-jitsi-meet` — OLM custom message channel
**Branch:** brak osobnego — commit `28beab91` w naszym forku  
**Upstream PR:** do zgłoszenia (companion do PR-C)  
**Status:** gotowy, czeka na cherry-pick na upstream  

### PR-C: `jitsi-meet` — send-olm-message + olmMessageReceived External API
**Branch:** `pr/olm-custom-message` → commit `6f6cd3c9a`  
**Upstream PR:** do zgłoszenia razem z PR-B  
**Status:** gotowy, czeka na cherry-pick na upstream  

### PR-D: `jitsi-meet` — chat E2EE warning
**Branch:** `pr/chat-e2ee-warning` → commit `e371baf1c`  
**Upstream PR:** do zgłoszenia osobno  
**Status:** gotowy, czeka na cherry-pick na upstream  

---

## Przed zgłoszeniem każdego PR

Cherry-pick na czysty branch z upstream (nie z naszego mastera):

```bash
# przykład dla PR-C
git fetch upstream
git checkout -b pr/olm-custom-message-clean upstream/master
git cherry-pick 6f6cd3c9a

# przykład dla PR-D
git checkout -b pr/chat-e2ee-warning-clean upstream/master
git cherry-pick e371baf1c
```

PR-B (`lib-jitsi-meet`) analogicznie na `jitsi/lib-jitsi-meet` upstream.

---

## Kolejność zgłaszania

1. **PR-B + PR-C razem** — OLM custom message channel (lib + jitsi-meet)
   - PR-B musi być merged w lib-jitsi-meet zanim PR-C ma sens
   - Zgłosić jako companion PRs z wzajemnymi referencjami
2. **PR-D osobno** — chat warning, niezależny od B/C

---

## Po merge przez Jitsi team

- Usunąć odpowiednie commity z naszego mastera (zastąpione upstream)
- Rebase naszego mastera na nowy upstream
- Branche `pr/*` archiwalne — można usunąć

---

## Parkowane tematy (do PR po merge)

- **PR #3 pełny** — E2EE chat przez OLM wbudowany w Jitsi (opis w `jitsi-changes2.md`)
- **AES-256 w SFrame** — patch `crypto-utils.ts` w lib-jitsi-meet (`length: 256`)

---

## Nasze branche w jitsi-meet

| Branch | Commit | Co zawiera |
|---|---|---|
| `master` | HEAD | Wszystkie encedo-patches razem |
| `pr/olm-custom-message` | `6f6cd3c9a` | Marker dla PR-C |
| `pr/chat-e2ee-warning` | `e371baf1c` | Marker dla PR-D |
