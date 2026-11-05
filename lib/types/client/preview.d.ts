/** Auditions the draft description without changing persisted voice settings. */
export declare class VoicePreview {
    private abort?;
    private context?;
    private player?;
    play(input: string, instruction: string, onPhase: (phase: string) => void, voiceId?: string): Promise<void>;
    stop(): Promise<void>;
}
