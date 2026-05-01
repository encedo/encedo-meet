import { useEffect, useState } from 'react';
import { HEM, HemError, HemKey } from '../vendor/hem-sdk';

const LS_HSM_URL = 'encedo_meet_hsm_url';
const ETSEVC_PREFIX = 'ETSEVC';

export interface HsmAuthResult {
    hem: HEM;
    useToken: string;
    kid: string;
    label: string;
    pubKey: string;       // base64
    descrPayload: string; // ETSEVC:<uuid>[:<email>] payload after prefix
}

interface KeyOption {
    kid: string;
    label: string;
    descrPayload: string;
}

function decodeEvcDescr(description: Uint8Array | null): string | null {
    if (!description) return null;
    try {
        const text = new TextDecoder().decode(description);
        return text.startsWith(ETSEVC_PREFIX + ':') ? text.slice(ETSEVC_PREFIX.length + 1) : null;
    } catch {
        return null;
    }
}

function btoaUtf8(s: string): string {
    return btoa(s);
}

function hemErrMsg(err: unknown): string {
    if (err instanceof HemError) {
        if (err.code === 'http_401') return 'Authentication failed. Is passphrase correct?';
        return `HSM error (${err.code}): ${err.message}`;
    }
    if (err instanceof Error) return err.message;
    return String(err);
}

export function HsmAuth({ onReady }: { onReady: (r: HsmAuthResult) => void }) {
    const [ hsmUrl, setHsmUrl ] = useState('');
    const [ passphrase, setPassphrase ] = useState('');
    const [ keys, setKeys ] = useState<KeyOption[] | null>(null);
    const [ selectedKid, setSelectedKid ] = useState('');
    const [ status, setStatus ] = useState('');
    const [ err, setErr ] = useState('');
    const [ busy, setBusy ] = useState(false);
    const [ hem, setHem ] = useState<HEM | null>(null);

    useEffect(() => {
        try {
            const cached = localStorage.getItem(LS_HSM_URL);
            if (cached) setHsmUrl(cached);
        } catch {/* ignore */}
    }, []);

    async function doSearchKeys() {
        if (!hsmUrl || !passphrase) {
            setErr('Provide HSM URL and passphrase');
            return;
        }
        setBusy(true);
        setErr('');
        setStatus('Connecting to HSM...');

        try {
            try { localStorage.setItem(LS_HSM_URL, hsmUrl); } catch {/* ignore */}

            const h = new HEM(hsmUrl);
            await h.hemCheckin();

            setStatus('Authorizing...');
            const listToken = await h.authorizePassword(passphrase, 'keymgmt:search');

            setStatus('Searching ETSEVC keys...');
            const found = await h.searchKeys(listToken, '^' + btoaUtf8(ETSEVC_PREFIX));

            if (found.length === 0) {
                setErr('No ETSEVC keys on this HSM. Complete enrollment first.');
                setBusy(false);
                setStatus('');
                return;
            }

            const opts: KeyOption[] = found.map((k: HemKey) => ({
                kid: k.kid,
                label: k.label || '(no label)',
                descrPayload: decodeEvcDescr(k.description) ?? ''
            }));

            setHem(h);
            setKeys(opts);
            setSelectedKid(opts[0].kid);
            setStatus('');
            setBusy(false);

            if (opts.length === 1) {
                doAuthorizeKey(h, opts[0]);
            }
        } catch (e) {
            console.error('[encedo:hsm] search failed', e);
            setErr(hemErrMsg(e));
            setBusy(false);
            setStatus('');
        }
    }

    async function doAuthorizeKey(activeHem: HEM, opt: KeyOption) {
        setBusy(true);
        setErr('');
        setStatus(`Authorizing key ${opt.label}...`);

        try {
            const useToken = await activeHem.authorizePassword(passphrase, `keymgmt:use:${opt.kid}`);

            setStatus('Fetching public key...');
            const pubKey = await activeHem.getPubKey(useToken, opt.kid);

            console.log('[encedo:hsm] authorized', { kid: opt.kid, label: opt.label, descr: opt.descrPayload, pubKey });

            onReady({
                hem: activeHem,
                useToken,
                kid: opt.kid,
                label: opt.label,
                pubKey,
                descrPayload: opt.descrPayload
            });
        } catch (e) {
            console.error('[encedo:hsm] authorize failed', e);
            setErr(hemErrMsg(e));
            setBusy(false);
            setStatus('');
        }
    }

    function onContinue() {
        if (keys === null) {
            doSearchKeys();
        } else {
            const opt = keys.find(k => k.kid === selectedKid);
            if (!opt) {
                setErr('Pick a key');
                return;
            }
            doAuthorizeKey(hem!, opt);
        }
    }

    const wrap: React.CSSProperties = {
        position: 'fixed', inset: 0, background: '#0b0d12',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#eee', fontFamily: 'system-ui, sans-serif', zIndex: 9999
    };
    const card: React.CSSProperties = {
        background: '#15181f', padding: 28, borderRadius: 12,
        minWidth: 360, maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 12
    };
    const input: React.CSSProperties = {
        padding: 10, borderRadius: 6, border: '1px solid #333',
        background: '#0b0d12', color: '#eee', fontSize: 14
    };
    const btn: React.CSSProperties = {
        padding: '10px 18px', borderRadius: 6, border: 'none',
        background: '#3b82f6', color: '#fff', fontSize: 14, fontWeight: 600,
        cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1
    };

    return (
        <div style={ wrap }>
            <div style={ card }>
                <div style={ { fontSize: 20, fontWeight: 700 } }>Encedo Meet — HSM Sign-in</div>
                { keys === null ? (
                    <>
                        <label style={ { fontSize: 12, color: '#aaa' } }>HSM URL</label>
                        <input
                            style={ input }
                            value={ hsmUrl }
                            onChange={ e => setHsmUrl(e.target.value) }
                            placeholder='https://my.ence.do'
                            disabled={ busy } />
                        <label style={ { fontSize: 12, color: '#aaa' } }>Passphrase</label>
                        <input
                            type='password'
                            style={ input }
                            value={ passphrase }
                            onChange={ e => setPassphrase(e.target.value) }
                            onKeyDown={ e => e.key === 'Enter' && !busy && onContinue() }
                            disabled={ busy } />
                    </>
                ) : (
                    <>
                        <label style={ { fontSize: 12, color: '#aaa' } }>Select ETSEVC key</label>
                        <select
                            style={ input }
                            value={ selectedKid }
                            onChange={ e => setSelectedKid(e.target.value) }
                            disabled={ busy }>
                            { keys.map(k =>
                                <option key={ k.kid } value={ k.kid }>
                                    { k.label } / { k.descrPayload || k.kid }
                                </option>) }
                        </select>
                    </>
                ) }

                { status && <div style={ { fontSize: 13, color: '#aaa' } }>{ status }</div> }
                { err && <div style={ { fontSize: 13, color: '#ef4444' } }>{ err }</div> }

                <button style={ btn } onClick={ onContinue } disabled={ busy }>
                    { busy ? 'Working...' : keys === null ? 'Continue' : 'Use this key' }
                </button>
            </div>
        </div>
    );
}
