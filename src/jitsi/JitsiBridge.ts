declare const JitsiMeetExternalAPI: any;

export type OlmMessageHandler = (from: string, type: string, payload: unknown) => void;
export type ConferenceJoinedHandler = (myId: string) => void;
export type ParticipantJoinedHandler = (participantId: string) => void;
export type ParticipantLeftHandler = (participantId: string) => void;

export class JitsiBridge {
    private api: any;

    constructor(container: HTMLElement, domain: string, roomName: string) {
        this.api = new JitsiMeetExternalAPI(domain, {
            configOverwrite: {
                e2ee: {
                    externallyManagedKey: true,
                    externallyManagedSharedKey: true
                }
            },
            parentNode: container,
            roomName
        });
    }

    onConferenceJoined(cb: ConferenceJoinedHandler) {
        this.api.addListener('videoConferenceJoined', (e: any) => cb(e.id));
    }

    onParticipantJoined(cb: ParticipantJoinedHandler) {
        this.api.addListener('participantJoined', (e: any) => cb(e.id));
    }

    onParticipantLeft(cb: ParticipantLeftHandler) {
        this.api.addListener('participantLeft', (e: any) => cb(e.id));
    }

    onOlmMessage(cb: OlmMessageHandler) {
        this.api.addListener('olmMessageReceived', (e: any) => cb(e.from, e.type, e.payload));
    }

    sendOlmMessage(participantId: string, type: string, payload: unknown) {
        this.api.executeCommand('sendOlmMessage', participantId, type, JSON.stringify(payload));
    }

    setMediaKey(encryptionKey: Uint8Array, index: number) {
        this.api.executeCommand('setMediaEncryptionKey', JSON.stringify({
            exportedKey: Array.from(encryptionKey),
            index
        }));
    }

    getParticipants(): Array<{ participantId: string }> {
        return this.api.getParticipantsInfo() ?? [];
    }

    getMyUserId(): string {
        return this.api.getMyUserId();
    }

    dispose() {
        this.api.dispose();
    }
}
