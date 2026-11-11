/** Probability-based utterance gate, independent of capture and inference. */
export interface TurnOptions {
    silenceMs: number;
    isPlayback?(): boolean;
    speechStart(): void;
    utterance(samples: Float32Array): void;
}
export declare class SpeechTurn {
    private options;
    private preRoll;
    private frames;
    private candidateFrames;
    private positiveMs;
    private gapMs;
    private quietMs;
    private active;
    constructor(options: TurnOptions);
    push(frame: Float32Array, probability: number): void;
    flush(): void;
    reset(): void;
}
