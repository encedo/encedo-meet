import { JitsiBridge } from '../jitsi/JitsiBridge';
import type { MlKemKeypair } from './mlKem';
import { decapsulate, deriveMediaKey, encapsulate, generateKeypair } from './mlKem';

const MSG_PUB = 'encedo:kyber-pub';
const MSG_CT = 'encedo:kyber-ct';
const PUB_RETRY_INTERVAL_MS = 1000;
const PUB_MAX_RETRIES = 10;

export class EncedoKeyProvider {
    private bridge: JitsiBridge;
    private myId = '';
    private keypair: MlKemKeypair | null = null;
    private peerPubs = new Map<string, Uint8Array>();
    private keyIndex = 0;
    private pendingPeers: string[] = [];

    constructor(bridge: JitsiBridge) {
        this.bridge = bridge;
    }

    start(myId: string) {
        this.myId = myId;
        this.keypair = generateKeypair();

        console.log('[Encedo] ML-KEM keypair generated, pub size:', this.keypair.publicKey.length);

        this.bridge.onOlmMessage(this._onOlmMessage.bind(this));

        // Drain peers that joined before we had a keypair
        for (const peerId of this.pendingPeers) {
            console.log('[Encedo] Draining pending peer', peerId);
            this._sendPubWithRetry(peerId, PUB_MAX_RETRIES);
        }
        this.pendingPeers = [];
    }

    onParticipantJoined(peerId: string) {
        if (!this.keypair) {
            console.log('[Encedo] Keypair not ready, queuing peer', peerId);
            this.pendingPeers.push(peerId);
            return;
        }
        this._sendPubWithRetry(peerId, PUB_MAX_RETRIES);
    }

    private _sendPubWithRetry(peerId: string, retriesLeft: number) {
        if (!this.keypair || retriesLeft <= 0) {
            return;
        }

        console.log('[Encedo] Sending ml_kem_pub to', peerId, `(retries left: ${retriesLeft})`);
        this.bridge.sendOlmMessage(peerId, MSG_PUB, {
            pub: Array.from(this.keypair.publicKey)
        });

        setTimeout(() => {
            if (!this.peerPubs.has(peerId)) {
                this._sendPubWithRetry(peerId, retriesLeft - 1);
            }
        }, PUB_RETRY_INTERVAL_MS);
    }

    private async _onOlmMessage(from: string, type: string, payload: any) {
        if (type === MSG_PUB) {
            await this._handlePub(from, new Uint8Array(payload.pub));
        } else if (type === MSG_CT) {
            await this._handleCt(from, new Uint8Array(payload.ct));
        }
    }

    private async _handlePub(from: string, peerPub: Uint8Array) {
        if (this.peerPubs.has(from)) {
            return;
        }
        console.log('[Encedo] Received ml_kem_pub from', from, 'pub size:', peerPub.length);
        this.peerPubs.set(from, peerPub);

        // Lower ID encapsulates — deterministic role assignment
        if (this.myId < from) {
            const { ciphertext, sharedSecret } = encapsulate(peerPub);

            console.log('[Encedo] Encapsulating for', from);
            this.bridge.sendOlmMessage(from, MSG_CT, {
                ct: Array.from(ciphertext)
            });
            await this._applyKey(sharedSecret);
        }
    }

    private async _handleCt(from: string, ciphertext: Uint8Array) {
        if (!this.keypair) {
            return;
        }
        console.log('[Encedo] Received kyber-ct from', from);
        const sharedSecret = decapsulate(ciphertext, this.keypair.secretKey);

        await this._applyKey(sharedSecret);
    }

    private async _applyKey(sharedSecret: Uint8Array) {
        const mediaKey = await deriveMediaKey(sharedSecret);

        console.log('[Encedo] Media key derived, setting index', this.keyIndex);
        this.bridge.setMediaKey(mediaKey, this.keyIndex++);
    }
}
