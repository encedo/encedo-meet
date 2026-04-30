# Upstream patches — E2EE externally-managed key path

## Overview

Two commits fixing the `externallyManagedKey` E2EE pipeline so that the
`set-media-encryption-key` External API command actually works end-to-end.
Both patches are upstream-candidate PRs against the official Jitsi repos.

---

## lib-jitsi-meet — commit `e4e6ca9c`

### Files changed

| File | Change |
|------|--------|
| `modules/e2ee/ExternallyManagedKeyHandler.js` | Bug fixes + per-sender mode |
| `modules/e2ee/ExternallyManagedKeyHandler.spec.ts` | New — 9 Jasmine tests |
| `JitsiConference.ts` | Corrected TypeScript signature |

### What was broken (3 bugs)

**Bug 1 — undefined participantId**
`ExternallyManagedKeyHandler.setKey()` called `e2eeCtx.setKey(undefined, ...)`.
The worker's `setKey` handler checks `if (!participantId)` and throws
`"Missing required data: participantId"` — every key-set operation silently
failed with an uncaught worker error.

**Bug 2 — wrong key type**
The key was forwarded as `{ encryptionKey: CryptoKey }` (an object wrapper).
`E2EEContext.setKey()` posts this to the worker, which does
`context.setKey(new Uint8Array(key), keyIndex)`.  `new Uint8Array(object)`
produces an empty buffer — no encryption key was ever set.
The worker's `Context.setKey()` expects raw bytes (Uint8Array / ArrayBuffer)
so it can run its own `importKey()` + `deriveKeys()` (HKDF-SHA-256 → AES-GCM-128).

**Bug 3 — hardcoded `sharedKey: true`**
The constructor always initialised a single shared E2EEContext regardless of
config, making per-sender key asymmetry (one unique key per remote participant,
as supported by the worker's `contexts: Map<participantId, Context>`) impossible
to reach through the External API.

### Fix

```js
constructor(conference) {
    const { e2ee = {} } = conference.options.config;
    // default true = backward-compatible shared-key mode
    const sharedKey = e2ee.externallyManagedSharedKey !== false;
    super(conference, { sharedKey });
}

setKey(keyInfo) {
    const participantId = keyInfo.participantId ?? this.conference.myUserId();
    this.e2eeCtx.setKey(participantId, keyInfo.encryptionKey, keyInfo.index);
}
```

To enable per-sender mode, set in Jitsi `config.js`:
```js
e2ee: { externallyManagedKey: true, externallyManagedSharedKey: false }
```

### Commit message

```
fix(e2ee): make ExternallyManagedKeyHandler work correctly with the E2EE worker

Three related bugs prevented the externally-managed key path from working:

1. The handler passed `undefined` as the participantId to E2EEContext.setKey(),
   causing the worker to throw "Missing required data: participantId" on every
   key-set operation.

2. The key was forwarded as `{ encryptionKey: CryptoKey }` instead of the raw
   bytes the worker expects.  Worker.setKey passes the value straight to
   Context.setKey(Uint8Array | ArrayBuffer), which then runs importKey() +
   deriveKeys() (HKDF-SHA-256 → AES-GCM-128).  Wrapping the key in an object
   caused new Uint8Array(key) in the worker to produce an empty buffer.

3. sharedKey mode was hardcoded to true, making it impossible for external
   integrators to use the per-sender key asymmetry already supported by the
   worker (one encryption context per participantId).

Fix:
- Read e2ee.externallyManagedSharedKey from the conference config (default
  true for backward compatibility) and propagate it to E2EEContext so the
  worker initialises the correct context strategy.
- Accept keyInfo.participantId; fall back to conference.myUserId() so the
  worker always receives a non-empty participantId. In shared-key mode the
  worker ignores this value and routes all calls to the single shared context.
- Forward keyInfo.encryptionKey (raw bytes) directly to e2eeCtx.setKey()
  without wrapping.

Also correct the JitsiConference.setMediaEncryptionKey() TypeScript signature,
which was declared as keyInfo: CryptoKey but actually accepts a plain object
with encryptionKey, index, and optional participantId fields.

Tests added: ExternallyManagedKeyHandler.spec.ts covers constructor sharedKey
propagation, participantId fallback logic, and the full worker postMessage path.
```

### PR description (github.com/jitsi/lib-jitsi-meet)

**Title:** `fix(e2ee): make ExternallyManagedKeyHandler work correctly with the E2EE worker`

**Body:**

The External API `set-media-encryption-key` command has been present for several
releases, but `ExternallyManagedKeyHandler.setKey()` was effectively broken for
any caller: it forwarded `undefined` as `participantId` (rejected by the worker)
and passed an object wrapper instead of raw bytes (producing an empty key in the
worker).  This PR makes the existing documented API actually work.

**Root cause analysis**

The worker (`Worker.ts`) validates `participantId` strictly:

```ts
if (!participantId || keyIndex === undefined) {
    throw new Error('Missing required data: participantId or keyIndex');
}
```

The handler passed `undefined`, so every call threw silently in the worker
thread (caught only by the generic `onerror` logger).

Additionally, `Context.setKey(key: Uint8Array | ArrayBuffer | false)` expects
raw key material for HKDF derivation.  The handler was passing
`{ encryptionKey: CryptoKey }` — an object — so `new Uint8Array(key)` in the
worker produced an empty buffer.

**Changes**

- `ExternallyManagedKeyHandler`: read `e2ee.externallyManagedSharedKey` from
  config (default `true` for backward compatibility); accept `participantId`
  from `keyInfo`, fall back to `conference.myUserId()`; forward raw bytes to
  `e2eeCtx.setKey()`.
- `JitsiConference.ts`: correct the `setMediaEncryptionKey()` TypeScript
  signature (was `CryptoKey`, is now the correct plain-object shape).
- `ExternallyManagedKeyHandler.spec.ts`: 9 new Jasmine tests covering sharedKey
  propagation, participantId fallback, and the full worker postMessage path.

**Backward compatibility**

`e2ee.externallyManagedSharedKey` defaults to `true`, preserving the existing
single-context behaviour.  No config changes are required for deployments that
do not need per-sender keys.

---

## jitsi-meet — commit `cd668b56b`

### Files changed

| File | Change |
|------|--------|
| `react/features/e2ee/middleware.ts` | Remove wrong importKey, add participantId |
| `modules/API/external/external_api.js` | JSDoc + participantId in setMediaEncryptionKey |

### What was broken (2 issues)

**Issue 1 — wrong importKey in middleware**
`middleware.ts` imported raw key bytes as an `AES-GCM` CryptoKey before
passing them to the conference:

```ts
window.crypto.subtle.importKey('raw', new Uint8Array(exportedKey), 'AES-GCM', false, ['encrypt','decrypt'])
.then(encryptionKey => conference.setMediaEncryptionKey({ encryptionKey, index }))
```

`Context.setKey()` inside the worker calls `importKey()` (as HKDF) then
`deriveKeys()` (HKDF-SHA-256 → AES-GCM-128) on the raw bytes.  An already
derived AES-GCM CryptoKey cannot be used as HKDF input — the wrong key type
was being forwarded.

**Issue 2 — participantId not propagated**
Neither `middleware.ts` nor `external_api.setMediaEncryptionKey()` read or
serialised a `participantId` field, so per-sender key selection was unreachable
through the External API even after the lib-jitsi-meet fix.

### Fix

```ts
// middleware.ts — before
const { exportedKey, index } = action.keyInfo;
window.crypto.subtle.importKey('raw', new Uint8Array(exportedKey), 'AES-GCM', ...)
    .then(encryptionKey => conference.setMediaEncryptionKey({ encryptionKey, index }))

// middleware.ts — after
const { exportedKey, index, participantId } = action.keyInfo;
conference.setMediaEncryptionKey({
    encryptionKey: exportedKey ? new Uint8Array(exportedKey) : false,
    index,
    participantId
});
```

### Commit message

```
fix(e2ee): fix SET_MEDIA_ENCRYPTION_KEY pipeline and add participantId support

Two issues in the externally-managed key path:

1. middleware.ts imported the raw key bytes as an AES-GCM CryptoKey before
   passing them to the conference.  The E2EE worker's Context.setKey() expects
   raw bytes so it can run its own importKey() + deriveKeys() (HKDF-SHA-256 →
   AES-GCM-128) derivation.  Importing as AES-GCM bypassed this step and
   produced a key the worker could not use.  The importKey call is removed;
   raw Uint8Array bytes are forwarded directly.

2. Neither middleware.ts nor the External API method propagated a participantId
   field.  Without it, ExternallyManagedKeyHandler cannot select the correct
   per-sender E2EEContext, and the worker receives an undefined participantId
   which it rejects.  participantId is now extracted from action.keyInfo and
   forwarded to conference.setMediaEncryptionKey(), and the External API
   setMediaEncryptionKey() method accepts and serialises it alongside the key.

External API callers that want per-sender key asymmetry (one unique key per
sender, as opposed to a shared group key) should pass participantId in the
keyInfo object.  The field is optional; omitting it keeps the existing
behaviour where the local participant's ID is used by the handler.
```

### PR description (github.com/jitsi/jitsi-meet)

**Title:** `fix(e2ee): fix SET_MEDIA_ENCRYPTION_KEY pipeline and add participantId support`

**Body:**

Companion to jitsi/lib-jitsi-meet#3028.

**Issue 1 — incorrect key type in middleware**

`middleware.ts` imported raw key bytes as an `AES-GCM` CryptoKey before
forwarding them to `conference.setMediaEncryptionKey()`.  However,
`ExternallyManagedKeyHandler` ultimately passes the value to the E2EE worker's
`Context.setKey(key: Uint8Array | ArrayBuffer)`, which calls:

```ts
const material = await importKey(keyBuffer);   // HKDF
const newKey   = await deriveKeys(material);   // HKDF-SHA-256 → AES-GCM-128
```

An already-derived AES-GCM key cannot serve as HKDF input.  The fix removes
the intermediate `importKey` call; raw `Uint8Array` bytes are passed directly
so the worker can perform the derivation itself.

**Issue 2 — participantId not propagated**

The `SET_MEDIA_ENCRYPTION_KEY` Redux action and the External API
`setMediaEncryptionKey()` method did not read or serialise a `participantId`
field.  This made per-sender key selection (enabled by
`e2ee.externallyManagedSharedKey: false` in lib-jitsi-meet) unreachable through
the public API.  `participantId` is now an optional field throughout the chain;
omitting it preserves the existing behaviour.

**Testing**

Unit tests are in the companion lib-jitsi-meet PR.  Manual verification:
1. Deploy Jitsi with `e2ee: { externallyManagedKey: true, externallyManagedSharedKey: false }`
2. From an embedding page call `api.setMediaEncryptionKey({ key, index, participantId })`
3. Confirm in the E2EE worker console that `setKey` is called with the correct
   `participantId` and non-empty key bytes.

---

## Checklist before push

```bash
# lib-jitsi-meet
cd lib-jitsi-meet && npm install
npm run lint
npm run type-check
npm test

# jitsi-meet
cd jitsi-meet && npm install
npm run lint:ci
npm run tsc:ci
```

## Submission order

1. PR to `jitsi/lib-jitsi-meet` first (independent review)
2. PR to `jitsi/jitsi-meet` — reference lib-jitsi-meet PR number in description
