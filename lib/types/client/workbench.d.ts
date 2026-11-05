import type { VoiceConfig } from '../config.js';
export interface Scope {
    getSnapshot(): {
        value?: VoiceConfig;
        revision?: number;
        writable?: boolean;
    };
    subscribe(fn: () => void): () => void;
    mutate(ops: {
        op: 'set';
        path: string[];
        value: unknown;
    }[], revision?: number): Promise<boolean>;
}
export declare function VoiceIcon({ size }: {
    size?: number;
}): import("react").JSX.Element;
export declare function validateDraft(value: Required<VoiceConfig>): void;
export declare function VoiceWorkbench({ scope, compact }: {
    scope?: Scope;
    compact?: boolean;
}): import("react").JSX.Element;
