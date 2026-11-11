import { VoiceController, type VoiceState } from './controller.js';
import type { Conversation, SessionBinding } from './feed.js';
export interface CallView {
    voice: VoiceState;
    open: boolean;
    minimized: boolean;
}
/** One controller shared by the native composer button and its inline dock. */
export declare class VoiceSessionView {
    private onDispose;
    private view;
    private listeners;
    private refs;
    private disposed;
    readonly controller?: VoiceController;
    constructor(binding: SessionBinding | undefined, conversation: Conversation | undefined, onDispose: () => void);
    snapshot: () => CallView;
    subscribe: (fn: () => void) => () => void;
    private set;
    retain(): () => void;
    dispose(): void;
    show(): void;
    minimize(): void;
    dismiss(): void;
    start(): Promise<void>;
    end(): Promise<void>;
}
