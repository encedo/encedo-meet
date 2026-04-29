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

async function decryptRoomKey(wrapKey: CryptoKey, wrapped: number[], iv: number[]): Promise<Uint8Array> {
    const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(iv) },
        wrapKey,
        new Uint8Array(wrapped)
    );
    return new Uint8Array(pt);
}

export class EncedoKeyProvider {
    private bridge: JitsiBridge;
    private myId = '';
    private keypair: MlKemKeypair | null = null;
    private isDistributor = false;
    private roomKey: Uint8Array | null = null;
    private keyIndex = 0;

    // peerWrapKeys: wrap key derived from ML-KEM shared secret with each peer
    private peerPubs = new Map<string, Uint8Array>();
    private peerWrapKeys = new Map<string, CryptoKey>();
    private pendingPeers: string[] = [];

    constructor(bridge: JitsiBridge) {
        this.bridge = bridge;
    }

    start(myId: string, isDistributor: boolean) {
        this.myId = myId;
        this.isDistributor = isDistributor;
        this.keypair = generateKeypair();

        console.log('[encedo] keypair generated, role:', isDistributor ? 'distributor' : 'joiner');

        if (isDistributor) {
            this.roomKey = crypto.getRandomValues(new Uint8Array(16));
            this._applyRoomKey();
        }

        this.bridge.onOlmMessage(this._onOlmMessage.bind(this));

        for (const peerId of this.pendingPeers) {
            console.log('[encedo] Draining pending peer', peerId);
            this._sendPubWithRetry(peerId, PUB_MAX_RETRIES);
        }
        this.pendingPeers = [];
    }

    onParticipantJoined(peerId: string) {
        if (!this.keypair) {
            console.log('[encedo] Keypair not ready, queuing peer', peerId);
            this.pendingPeers.push(peerId);
            return;
        }

        if (this.isDistributor) {
            // Generate new room key and distribute to existing peers.
            // The new peer will send us their kyber-pub and get the key via _handlePub.
            this._rekeyAndDistribute(peerId);
        } else {
            // Send our pub to every peer — only the distributor will respond with ct+room-key.
            this._sendPubWithRetry(peerId, PUB_MAX_RETRIES);
        }
    }

    onParticipantLeft(peerId: string) {
        if (!this.isDistributor || !this.peerWrapKeys.has(peerId)) return;

        console.log('[encedo] Participant left:', peerId, '— rekeying');
        this.peerPubs.delete(peerId);
        this.peerWrapKeys.delete(peerId);
        this._rekeyAndDistribute(null);
    }

    private async _rekeyAndDistribute(newPeerId: string | null) {
        this.roomKey = crypto.getRandomValues(new Uint8Array(16));
        console.log('[encedo] Rekey —', newPeerId ? `peer joined: ${newPeerId}` : 'peer left', ', index', this.keyIndex);
        this._applyRoomKey();
        for (const [peerId, wrapKey] of this.peerWrapKeys) {
            await this._sendRoomKey(peerId, wrapKey);
        }
    }

    private _sendPubWithRetry(peerId: string, retriesLeft: number) {
        if (!this.keypair || retriesLeft <= 0) return;

        console.log('[encedo] Sending kyber-pub to', peerId, `(retries: ${retriesLeft})`);
        this.bridge.sendOlmMessage(peerId, MSG_PUB, { pub: Array.from(this.keypair.publicKey) });

        setTimeout(() => {
            if (!this.peerWrapKeys.has(peerId)) {
                this._sendPubWithRetry(peerId, retriesLeft - 1);
            }
        }, PUB_RETRY_INTERVAL_MS);
    }

    private async _onOlmMessage(from: string, type: string, payload: any) {
        if (type === MSG_PUB) {
            await this._handlePub(from, new Uint8Array(payload.pub));
        } else if (type === MSG_CT) {
            await this._handleCt(from, new Uint8Array(payload.ct));
        } else if (type === MSG_ROOM_KEY) {
            await this._handleRoomKey(from, payload.wrapped, payload.iv);
        }
    }

    private async _handlePub(from: string, peerPub: Uint8Array) {
        // Only distributor handles incoming pubs
        if (!this.isDistributor || this.peerPubs.has(from)) return;

        console.log('[encedo] Received kyber-pub from', from, 'pub size:', peerPub.length);
        this.peerPubs.set(from, peerPub);

        const { ciphertext, sharedSecret } = encapsulate(peerPub);
        const wrapKey = await deriveWrapKey(sharedSecret);
        this.peerWrapKeys.set(from, wrapKey);

        console.log('[encedo] Sending kyber-ct + room-key to', from);
        this.bridge.sendOlmMessage(from, MSG_CT, { ct: Array.from(ciphertext) });
        await this._sendRoomKey(from, wrapKey);
    }

    private async _handleCt(from: string, ciphertext: Uint8Array) {
        // Only joiners receive ct from the distributor
        if (this.isDistributor || !this.keypair || this.peerWrapKeys.has(from)) return;

        console.log('[encedo] Received kyber-ct from', from);
        const sharedSecret = decapsulate(ciphertext, this.keypair.secretKey);
        const wrapKey = await deriveWrapKey(sharedSecret);
        this.peerWrapKeys.set(from, wrapKey);
        // room-key arrives in a separate message
    }

    private async _handleRoomKey(from: string, wrapped: number[], iv: number[]) {
        const wrapKey = this.peerWrapKeys.get(from);
        if (!wrapKey) {
            console.log('[encedo] No wrap key for', from, '— room-key dropped (ct not yet received)');
            return;
        }

        const roomKey = await decryptRoomKey(wrapKey, wrapped, iv);
        this.roomKey = roomKey;
        console.log('[encedo] Room key received from', from, ', index', this.keyIndex);
        this._applyRoomKey();
    }

    private async _sendRoomKey(peerId: string, wrapKey: CryptoKey) {
        if (!this.roomKey) return;
        const { wrapped, iv } = await encryptRoomKey(wrapKey, this.roomKey);
        console.log('[encedo] Sending room-key to', peerId);
        this.bridge.sendOlmMessage(peerId, MSG_ROOM_KEY, { wrapped, iv });
    }

    private _applyRoomKey() {
        if (!this.roomKey) return;
        console.log('[encedo] Applying room key, index', this.keyIndex);
        this.bridge.setMediaKey(this.roomKey, this.keyIndex++);
    }
}
