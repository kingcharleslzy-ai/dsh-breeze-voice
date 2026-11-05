/** Optional adapter to the installed DSH speechToText registry. Never changes its settings. */
export interface NativeSpeechService {
    snapshot(): {
        providers: {
            id: string;
            name?: string;
            languages?: string[];
            preparation?: {
                phase?: string;
                error?: string;
            };
        }[];
    };
    resolve(request: {
        audio: Uint8Array;
        providerId: string;
        language: string;
    }): unknown;
    transcribe(spec: unknown, signal: AbortSignal): Promise<unknown>;
}
type Source = NativeSpeechService | {
    get(name: string): unknown;
} | undefined;
export declare const NATIVE_PROVIDER = "sensevoice-local";
export declare function lookupNativeAsr(source: Source): {
    available: boolean;
    ready: boolean;
    phase: string;
    providerId: string;
    name: string;
    message: string;
};
export declare function recognizeNativeAsr(source: Source, bytes: Uint8Array, signal: AbortSignal): Promise<{
    text: string;
    language: string;
    duration: number;
}>;
export {};
