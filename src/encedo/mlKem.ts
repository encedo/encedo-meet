import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

export interface MlKemKeypair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export function generateKeypair(): MlKemKeypair {
    const { publicKey, secretKey } = ml_kem768.keygen();

    return { publicKey, secretKey };
}

export function encapsulate(peerPublicKey: Uint8Array): { ciphertext: Uint8Array; sharedSecret: Uint8Array } {
    const { cipherText: ciphertext, sharedSecret } = ml_kem768.encapsulate(peerPublicKey);

    return { ciphertext, sharedSecret };
}

export function decapsulate(ciphertext: Uint8Array, secretKey: Uint8Array): Uint8Array {
    return ml_kem768.decapsulate(ciphertext, secretKey);
}

export async function deriveMediaKey(sharedSecret: Uint8Array): Promise<Uint8Array> {
    const keyMaterial = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, [ 'deriveBits' ]);
    const bits = await crypto.subtle.deriveBits(
        {
            hash: 'SHA-256',
            info: new TextEncoder().encode('encedo-meet-media-v1'),
            name: 'HKDF',
            salt: new Uint8Array(0)
        },
        keyMaterial,
        128
    );

    return new Uint8Array(bits);
}
