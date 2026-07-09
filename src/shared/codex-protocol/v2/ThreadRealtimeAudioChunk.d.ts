/**
 * EXPERIMENTAL - thread realtime audio chunk.
 */
export type ThreadRealtimeAudioChunk = {
    data: string;
    sampleRate: number;
    numChannels: number;
    samplesPerChannel: number | null;
    itemId: string | null;
};
