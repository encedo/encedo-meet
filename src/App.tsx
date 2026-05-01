import { useEffect, useRef, useState } from 'react';
import { EncedoKeyProvider } from './encedo/EncedoKeyProvider';
import { JitsiBridge } from './jitsi/JitsiBridge';

const JITSI_DOMAIN = import.meta.env.VITE_JITSI_DOMAIN ?? `api.${window.location.host}`;
const ROOM_NAME = 'testroom';

function PanicOverlay() {
    return (
        <div style={ {
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.92)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            gap: '16px',
        } }>
            <div style={ { fontSize: '48px' } }>🔴</div>
            <div style={ {
                color: '#fff',
                fontSize: '20px',
                fontWeight: 700,
                textAlign: 'center',
            } }>
                Sesja nie została prawidłowo autoryzowana
            </div>
            <div style={ {
                color: '#aaa',
                fontSize: '14px',
                textAlign: 'center',
                maxWidth: '360px',
            } }>
                Połączenie zostało przerwane ze względów bezpieczeństwa.
            </div>
        </div>
    );
}

export default function App() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [ panicked, setPanicked ] = useState(false);

    useEffect(() => {
        if (!containerRef.current) {
            return;
        }

        let bridge: JitsiBridge | null = null;

        const init = () => {
            if (!containerRef.current) {
                return;
            }
            bridge = new JitsiBridge(containerRef.current, JITSI_DOMAIN, ROOM_NAME);
            const provider = new EncedoKeyProvider(bridge);

            provider.onPanic(reason => {
                console.error('[encedo] PANIC — dropping call:', reason);
                setPanicked(true);
            });

            bridge.onConferenceJoined(myId => {
                const currentPeerIds = bridge!.getParticipants().map(p => p.participantId);
                console.log('[encedo] Conference joined, myId:', myId, 'peers:', currentPeerIds);
                provider.start(myId, currentPeerIds);
            });

            bridge.onParticipantJoined(peerId => {
                console.log('[encedo] Participant joined:', peerId);
                provider.onParticipantJoined(peerId);
            });

            bridge.onParticipantLeft(peerId => {
                console.log('[encedo] Participant left:', peerId);
                provider.onParticipantLeft(peerId);
            });
        };

        if ((window as unknown as { JitsiMeetExternalAPI?: unknown }).JitsiMeetExternalAPI) {
            init();
        } else {
            const script = document.createElement('script');
            script.src = `https://${JITSI_DOMAIN}/libs/external_api.js`;
            script.async = false;
            script.onload = init;
            script.onerror = () => console.error('[encedo] failed to load external_api.js from', script.src);
            document.head.appendChild(script);
        }

        return () => bridge?.dispose();
    }, []);

    return (
        <>
            <div
                ref={ containerRef }
                style={ { height: '100vh', width: '100vw' } }
            />
            { panicked && <PanicOverlay /> }
        </>
    );
}
