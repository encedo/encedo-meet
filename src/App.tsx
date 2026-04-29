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
            const isDistributor = bridge.getParticipants().length === 0;
            console.log('[encedo] Conference joined, myId:', myId, 'role:', isDistributor ? 'distributor' : 'joiner');
            provider.start(myId, isDistributor);
        });

        bridge.onParticipantJoined(peerId => {
            console.log('[encedo] Participant joined:', peerId);
            provider.onParticipantJoined(peerId);
        });

        bridge.onParticipantLeft(peerId => {
            console.log('[encedo] Participant left:', peerId);
            provider.onParticipantLeft(peerId);
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
