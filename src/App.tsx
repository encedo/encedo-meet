import { useEffect, useRef } from 'react';
import { EncedoKeyProvider } from './encedo/EncedoKeyProvider';
import { JitsiBridge } from './jitsi/JitsiBridge';

const JITSI_DOMAIN = 'localhost:8080';
const ROOM_NAME = 'testroom';

export default function App() {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!containerRef.current) {
            return;
        }

        const bridge = new JitsiBridge(containerRef.current, JITSI_DOMAIN, ROOM_NAME);
        const provider = new EncedoKeyProvider(bridge);

        bridge.onConferenceJoined(myId => {
            console.log('[Encedo] Conference joined, myId:', myId);
            provider.start(myId);
        });

        bridge.onParticipantJoined(peerId => {
            console.log('[Encedo] Participant joined:', peerId);
            provider.onParticipantJoined(peerId);
        });

        return () => bridge.dispose();
    }, []);

    return (
        <div
            ref={ containerRef }
            style={ { height: '100vh', width: '100vw' } }
        />
    );
}
