/** Small PCM helpers shared by microphone capture, playback and acceptance tests. */
export declare function wav16(samples: Float32Array, sampleRate: number): Blob;
export declare class PcmDecoder {
    private pending?;
    push(bytes: Uint8Array): Float32Array<ArrayBuffer>;
    finish(): void;
}
export declare class PcmPlayer {
    readonly context: AudioContext;
    private sources;
    private cursor;
    constructor(context: AudioContext);
    get pendingSeconds(): number;
    push(samples: Float32Array, sampleRate: number): void;
    stop(): void;
}
export interface CaptureOptions {
    silenceMs: number;
    /** Retained for older saved settings; neural probability is the primary gate. */
    threshold: number;
    canListen(): boolean;
    isPlayback?(): boolean;
    speechStart(): void;
    utterance(wav: Blob): void;
    level(value: number): void;
    error?(error: Error): void;
}
export declare class Microphone {
    readonly context: AudioContext;
    readonly options: CaptureOptions;
    private media?;
    private source?;
    private processor?;
    private silent?;
    private model?;
    private closed;
    private enabled;
    private muted;
    private generation;
    private pending;
    private chain;
    private turn;
    constructor(context: AudioContext, options: CaptureOptions);
    start(): Promise<void>;
    private capture;
    setMuted(muted: boolean): void;
    flush(): void;
    private fail;
    stop(): void;
}
