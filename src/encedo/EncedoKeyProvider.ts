import { JitsiBridge } from '../jitsi/JitsiBridge';
import { decapsulate, deriveMediaKey, encapsulate, generateKeypair, MlKemKeypair } from './mlKem';

const MSG_PUB = 'encedo:kyber-pub';
const MSG_CT = 'encedo:kyber-ct';

export class EncedoKeyProvider {
    private bridge: JitsiBridge;
    private myId = '';
    private keypair: MlKemKeypair | null = null;
    private peerPubs = new Map<string, Uint8Array>();
    private keyIndex = 0;

    constructor(bridge: JitsiBridge) {
        this.bridge = bridge;
    }

    start(myId: string) {
        this.myId = myId;
        this.keypair = generateKeypair();

        console.log('[Encedo] ML-KEM keypair generated, pub size:', this.keypair.publicKey.length);

        this.bridge.onOlmMessage(this._onOlmMessage.bind(this));

        this.bridge.sendOlmMessage('', MSG_PUB, {
            pub: Array.from(this.keypair.publicKey)
        });

        console.log('[Encedo] Broadcast ml_kem_pub');
    }

    onParticipantJoined(peerId: string) {
        if (!this.keypair) {
            return;
        }
        this.bridge.sendOlmMessage(peerId, MSG_PUB, {
            pub: Array.from(this.keypair.publicKey)
        });
    }

    private async _onOlmMessage(from: string, type: string, payload: any) {
        if (type === MSG_PUB) {
            await this._handlePub(from, new Uint8Array(payload.pub));
        } else if (type === MSG_CT) {
            await this._handleCt(from, new Uint8Array(payload.ct));
        }
    }

    private async _handlePub(from: string, peerPub: Uint8Array) {
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
