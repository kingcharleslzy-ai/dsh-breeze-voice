/** Local-only Silero v5 inference. No remote model, script, worker or telemetry. */
export declare const VAD_ASSETS = "/api/breeze-voice/assets/";
export interface VadModel {
    process(frame: Float32Array): Promise<number>;
    reset(): void;
    dispose(): Promise<void>;
}
export declare function loadVadModel(): Promise<VadModel>;
