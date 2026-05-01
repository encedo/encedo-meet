import { useEffect, useState } from 'react';
import { HEM, HemError, type HemKey } from '../vendor/hem-sdk';

const LS_HSM_URL = 'encedo_meet_hsm_url';
const ETSEVC_PREFIX = 'ETSEVC';

export interface HsmAuthResult {
    hem: HEM;
    useToken: string;
    kid: string;
    label: string;
    pubKey: string;       // base64
    descrPayload: string; // <uuid>[:<email>] payload after ETSEVC: prefix
}

interface KeyOption {
    kid: string;
    label: string;
    descrPayload: string;
}

type Mode = 'login' | 'create' | 'keys';

function decodeEvcDescr(description: Uint8Array | null): string | null {
    if (!description) return null;
    try {
        const text = new TextDecoder().decode(description);
        return text.startsWith(ETSEVC_PREFIX + ':') ? text.slice(ETSEVC_PREFIX.length + 1) : null;
    } catch {
        return null;
    }
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
    const [ mode, setMode ] = useState<Mode>('login');
    const [ hsmUrl, setHsmUrl ] = useState('');
    const [ passphrase, setPassphrase ] = useState('');
    const [ keys, setKeys ] = useState<KeyOption[]>([]);
    const [ selectedKid, setSelectedKid ] = useState('');
    const [ createLabel, setCreateLabel ] = useState('');
    const [ createEmail, setCreateEmail ] = useState('');
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
            // hem-sdk.browser.js wraps the prefix as '^' + base64(descr) — pass raw prefix.
            const found = await h.searchKeys(listToken, ETSEVC_PREFIX);

            setHem(h);

            if (found.length === 0) {
                setStatus('');
                setBusy(false);
                setMode('create');
                return;
            }

            const opts: KeyOption[] = found.map((k: HemKey) => ({
                kid: k.kid,
                label: k.label || '(no label)',
                descrPayload: decodeEvcDescr(k.description) ?? ''
            }));

            setKeys(opts);
            setSelectedKid(opts[0].kid);
            setStatus('');
            setBusy(false);

            if (opts.length === 1) {
                doAuthorizeKey(h, opts[0]);
            } else {
                setMode('keys');
            }
        } catch (e) {
            console.error('[encedo:hsm] search failed', e);
            setErr(hemErrMsg(e));
            setBusy(false);
            setStatus('');
        }
    }

    async function doCreateKey() {
        if (!hem) {
            setErr('Internal error: no HSM session');
            return;
        }
        if (!createLabel.trim()) {
            setErr('Label is required');
            return;
        }

        setBusy(true);
        setErr('');
        setStatus('Authorizing key generation...');

        try {
            const genToken = await hem.authorizePassword(passphrase, 'keymgmt:gen');

            const uuid = crypto.randomUUID();
            const email = createEmail.trim();
            const descrPayload = email ? `${uuid}:${email}` : uuid;
            const fullDescr = `${ETSEVC_PREFIX}:${descrPayload}`;
            const descrB64 = btoa(fullDescr);

            console.log('[encedo:hsm] creating key descr=', fullDescr, 'label=', createLabel);

            setStatus('Creating Ed25519 key on HSM...');
            const { kid } = await hem.createKeyPair(genToken, createLabel.trim(), 'ED25519', descrB64);

            console.log('[encedo:hsm] key created kid=', kid);

            setStatus('Authorizing key use...');
            const useToken = await hem.authorizePassword(passphrase, `keymgmt:use:${kid}`);

            setStatus('Fetching public key...');
            const pubKeyResp = await hem.getPubKey(useToken, kid) as unknown as { pubkey?: string } | string;
            const pubKey = typeof pubKeyResp === 'string' ? pubKeyResp : (pubKeyResp.pubkey ?? '');
            if (!pubKey) throw new Error('HSM returned no pubkey');

            console.log('[encedo:hsm] enrolled', { kid, label: createLabel, descr: descrPayload, pubKey });

            onReady({
                hem,
                useToken,
                kid,
                label: createLabel.trim(),
                pubKey,
                descrPayload
            });
        } catch (e) {
            console.error('[encedo:hsm] create failed', e);
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
            const pubKeyResp = await activeHem.getPubKey(useToken, opt.kid) as unknown as { pubkey?: string } | string;
            const pubKey = typeof pubKeyResp === 'string' ? pubKeyResp : (pubKeyResp.pubkey ?? '');
            if (!pubKey) throw new Error('HSM returned no pubkey');

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
        if (mode === 'login') {
            doSearchKeys();
        } else if (mode === 'keys') {
            const opt = keys.find(k => k.kid === selectedKid);
            if (!opt) {
                setErr('Pick a key');
                return;
            }
            doAuthorizeKey(hem!, opt);
        } else if (mode === 'create') {
            doCreateKey();
        }
    }

    function onBack() {
        setMode('login');
        setKeys([]);
        setSelectedKid('');
        setCreateLabel('');
        setCreateEmail('');
        setErr('');
        setStatus('');
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
    const btnSecondary: React.CSSProperties = {
        ...btn, background: '#374151'
    };

    return (
        <div style={ wrap }>
            <div style={ card }>
                <div style={ { fontSize: 20, fontWeight: 700 } }>Encedo Meet — HSM Sign-in</div>

                { mode === 'login' && (
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
                ) }

                { mode === 'keys' && (
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

                { mode === 'create' && (
                    <>
                        <div style={ { fontSize: 13, color: '#fbbf24' } }>
                            No ETSEVC keys on this HSM — create one to enroll.
                        </div>
                        <label style={ { fontSize: 12, color: '#aaa' } }>Label *</label>
                        <input
                            style={ input }
                            value={ createLabel }
                            onChange={ e => setCreateLabel(e.target.value) }
                            placeholder='e.g. My laptop key'
                            disabled={ busy } />
                        <label style={ { fontSize: 12, color: '#aaa' } }>Email (optional)</label>
                        <input
                            type='email'
                            style={ input }
                            value={ createEmail }
                            onChange={ e => setCreateEmail(e.target.value) }
                            placeholder='you@example.com'
                            disabled={ busy } />
                    </>
                ) }

                { status && <div style={ { fontSize: 13, color: '#aaa' } }>{ status }</div> }
                { err && <div style={ { fontSize: 13, color: '#ef4444' } }>{ err }</div> }

                <div style={ { display: 'flex', gap: 8 } }>
                    { (mode === 'keys' || mode === 'create') && (
                        <button style={ btnSecondary } onClick={ onBack } disabled={ busy }>
                            Back
                        </button>
                    ) }
                    <button style={ { ...btn, flex: 1 } } onClick={ onContinue } disabled={ busy }>
                        { busy ? 'Working...' :
                            mode === 'login' ? 'Continue' :
                                mode === 'keys' ? 'Use this key' :
                                    'Create key' }
                    </button>
                </div>
            </div>
        </div>
    );
}
