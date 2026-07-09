import type { ThreadRealtimeAudioChunk } from "./ThreadRealtimeAudioChunk";
/**
 * EXPERIMENTAL - streamed output audio emitted by thread realtime.
 */
export type ThreadRealtimeOutputAudioDeltaNotification = {
    threadId: string;
    audio: ThreadRealtimeAudioChunk;
};
