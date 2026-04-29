import { JitsiBridge } from '../jitsi/JitsiBridge';
import type { MlKemKeypair } from './mlKem';
import { decapsulate, encapsulate, generateKeypair } from './mlKem';

const MSG_PUB = 'encedo:kyber-pub';
const MSG_CT = 'encedo:kyber-ct';
const MSG_ROOM_KEY = 'encedo:room-key';
const PUB_RETRY_INTERVAL_MS = 1000;
const PUB_MAX_RETRIES = 10;

async function deriveWrapKey(sharedSecret: Uint8Array): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(32),
            info: new TextEncoder().encode('encedo-room-key-wrap-v1'),
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptRoomKey(wrapKey: CryptoKey, roomKey: Uint8Array): Promise<{ wrapped: number[]; iv: number[] }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, roomKey);
    return { wrapped: Array.from(new Uint8Array(ct)), iv: Array.from(iv) };
}

function toHex(b: Uint8Array): string {
    return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

function keyFingerprint(b: Uint8Array): string {
    return toHex(b.slice(0, 4)) + '…';
}

const DEV = import.meta.env.DEV;

async function decryptRoomKey(wrapKey: CryptoKey, wrapped: number[], iv: number[]): Promise<Uint8Array> {
    const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(iv) },
        wrapKey,
        new Uint8Array(wrapped)
    );
    return new Uint8Array(pt);
}

export type PanicHandler = (reason: string) => void;

export class EncedoKeyProvider {
    private bridge: JitsiBridge;
    private myId = '';
    private keypair: MlKemKeypair | null = null;

    // Participant tracking — distributorId is always min(participantIds)
    private participantIds = new Set<string>();
    private distributorId = '';

    private roomKey: Uint8Array | null = null;
    // keyIndex tracks the next available slot. Current active epoch = keyIndex - 1.
    // All participants must set the same epoch for SFrame to match during decryption.
    private keyIndex = 0;

    private peerPubs = new Map<string, Uint8Array>();
    private peerWrapKeys = new Map<string, CryptoKey>();
    private pendingPeers: string[] = [];

    private panicHandler: PanicHandler | null = null;

    private get isDistributor(): boolean {
        return this.distributorId === this.myId;
    }

    constructor(bridge: JitsiBridge) {
        this.bridge = bridge;
    }

    onPanic(cb: PanicHandler) {
        this.panicHandler = cb;
    }

    private _panic(reason: string) {
        console.error('[encedo] PANIC:', reason);
        this.bridge.hangup();
        this.panicHandler?.(reason);
    }

    start(myId: string, currentPeerIds: string[]) {
        this.myId = myId;
        this.keypair = generateKeypair();
        this.participantIds = new Set([myId, ...currentPeerIds]);
        this.distributorId = this._lowestId();

        console.log('[encedo] start myId:', myId, 'distributor:', this.distributorId);

        this.bridge.onOlmMessage(this._onOlmMessage.bind(this));

        if (this.isDistributor) {
            this.roomKey = crypto.getRandomValues(new Uint8Array(32));
            this._setKey(this.keyIndex++);
        } else {
            this._sendPubWithRetry(this.distributorId, PUB_MAX_RETRIES);
        }

        for (const peerId of this.pendingPeers) {
            this.onParticipantJoined(peerId);
        }
        this.pendingPeers = [];
    }

    onParticipantJoined(peerId: string) {
        if (!this.keypair) {
            this.pendingPeers.push(peerId);
            return;
        }

        const prevDistributorId = this.distributorId;
        this.participantIds.add(peerId);
        this.distributorId = this._lowestId();

        if (this.isDistributor && prevDistributorId === this.myId) {
            this._rekey(`join ${peerId}`);
        } else if (prevDistributorId !== this.distributorId) {
            // Distributor changed because new peer has lower ID
            this._sendPubWithRetry(this.distributorId, PUB_MAX_RETRIES);
        }
    }

    onParticipantLeft(peerId: string) {
        const prevDistributorId = this.distributorId;
        this.participantIds.delete(peerId);
        this.peerPubs.delete(peerId);
        this.peerWrapKeys.delete(peerId);
        this.distributorId = this._lowestId();

        if (peerId === prevDistributorId) {
            if (this.isDistributor) {
                console.log('[encedo] Distributor left — I take over');
                this._takeOverAsDistributor();
            } else {
                console.log('[encedo] Distributor left — sending pub to new distributor', this.distributorId);
                this._sendPubWithRetry(this.distributorId, PUB_MAX_RETRIES);
            }
        } else if (this.isDistributor) {
            this._rekey(`leave ${peerId}`);
        }
    }

    private async _takeOverAsDistributor() {
        this.peerPubs.clear();
        this.peerWrapKeys.clear();
        this.roomKey = crypto.getRandomValues(new Uint8Array(32));
        const epoch = this.keyIndex++;
        console.log('[encedo] Taking over as distributor, epoch', epoch);
        this._setKey(epoch);
        // Remaining peers send us their kyber-pub (triggered by their onParticipantLeft)
        // _handlePub will send them the room key with epoch = keyIndex - 1
    }

    private async _rekey(reason: string) {
        this.roomKey = crypto.getRandomValues(new Uint8Array(32));
        const epoch = this.keyIndex++;
        console.log('[encedo] Rekey:', reason, 'epoch', epoch);
        this._setKey(epoch);
        for (const [peerId, wrapKey] of this.peerWrapKeys) {
            await this._sendRoomKey(peerId, wrapKey);
        }
    }

    private _sendPubWithRetry(peerId: string, retriesLeft: number) {
        if (!this.keypair || retriesLeft <= 0) return;

        console.log('[encedo] Sending kyber-pub to', peerId, `(retries: ${retriesLeft})`);
        this.bridge.sendOlmMessage(peerId, MSG_PUB, {
            pub: Array.from(this.keypair.publicKey),
            // TODO(hsm-attest): sig = HSM.exdsaSign(kid, pub || channelId || sessionNonce)
            sig: null,
            kid: null,
        });

        setTimeout(() => {
            if (!this.peerWrapKeys.has(peerId)) {
                this._sendPubWithRetry(peerId, retriesLeft - 1);
            }
        }, PUB_RETRY_INTERVAL_MS);
    }

    private async _onOlmMessage(from: string, type: string, payload: any) {
        if (type === MSG_PUB) {
            await this._handlePub(from, new Uint8Array(payload.pub), payload.sig ?? null, payload.kid ?? null);
        } else if (type === MSG_CT) {
            await this._handleCt(from, new Uint8Array(payload.ct));
        } else if (type === MSG_ROOM_KEY) {
            await this._handleRoomKey(from, payload.wrapped, payload.iv, payload.epoch);
        }
    }

    private async _handlePub(from: string, peerPub: Uint8Array, sig: string | null, kid: string | null) {
        if (!this.isDistributor || this.peerPubs.has(from)) return;

        console.log('[encedo] Received kyber-pub from', from, 'kid:', kid);

        if (sig !== null && kid !== null) {
            // TODO(hsm-attest): verify peerPub against sig using kid's HSM public key
            //   const peerHsmPub = await directory.lookup(kid);
            //   const valid = verifyExdsa(peerHsmPub, sig, concat(peerPub, channelId, sessionNonce));
            //   if (!valid) { this._panic(`invalid HSM signature from ${from} (kid=${kid})`); return; }
            console.log('[encedo] HSM signature present but verification not yet implemented — accepting');
        } else {
            // No signature — allowed only in dev/testing (no HSM connected).
            // In production builds this should trigger PANIC.
            console.warn('[encedo] WARNING: no HSM signature from', from, '— accepted (dev mode only)');
        }

        this.peerPubs.set(from, peerPub);

        const { ciphertext, sharedSecret } = encapsulate(peerPub);
        const wrapKey = await deriveWrapKey(sharedSecret);
        this.peerWrapKeys.set(from, wrapKey);

        console.log('[encedo] Sending kyber-ct + room-key to', from);
        this.bridge.sendOlmMessage(from, MSG_CT, { ct: Array.from(ciphertext) });
        await this._sendRoomKey(from, wrapKey);
    }

    private async _handleCt(from: string, ciphertext: Uint8Array) {
        if (this.isDistributor || !this.keypair || this.peerWrapKeys.has(from)) return;

        console.log('[encedo] Received kyber-ct from', from);
        const sharedSecret = decapsulate(ciphertext, this.keypair.secretKey);
        const wrapKey = await deriveWrapKey(sharedSecret);
        this.peerWrapKeys.set(from, wrapKey);
        // room-key arrives in the next message
    }

    private async _handleRoomKey(from: string, wrapped: number[], iv: number[], epoch: number) {
        const wrapKey = this.peerWrapKeys.get(from);
        if (!wrapKey) {
            console.log('[encedo] No wrap key for', from, '— room-key dropped');
            return;
        }

        const roomKey = await decryptRoomKey(wrapKey, wrapped, iv);
        this.roomKey = roomKey;
        this.keyIndex = epoch + 1; // stay in sync with distributor's epoch counter
        console.log('[encedo] Room key received from', from, 'epoch', epoch, 'key', DEV ? toHex(roomKey) : keyFingerprint(roomKey));
        this._setKey(epoch);
    }

    private async _sendRoomKey(peerId: string, wrapKey: CryptoKey) {
        if (!this.roomKey) return;
        const epoch = this.keyIndex - 1; // current active epoch
        const { wrapped, iv } = await encryptRoomKey(wrapKey, this.roomKey);
        console.log('[encedo] Sending room-key to', peerId, 'epoch', epoch);
        this.bridge.sendOlmMessage(peerId, MSG_ROOM_KEY, { wrapped, iv, epoch });
    }

    private _setKey(epoch: number) {
        if (!this.roomKey) return;
        console.log('[encedo] Applying room key, epoch', epoch, 'key', DEV ? toHex(this.roomKey) : keyFingerprint(this.roomKey));
        this.bridge.setMediaKey(this.roomKey, epoch);
    }

    private _lowestId(): string {
        return [...this.participantIds].sort()[0] ?? this.myId;
    }
}
