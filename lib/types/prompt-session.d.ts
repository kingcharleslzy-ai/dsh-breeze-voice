import type { Context } from '@deepseek-ai/cordis';
import { type VoiceConfig } from './config.js';
export interface SessionAction {
    action: 'start' | 'keepalive' | 'stop';
    sessionId: string;
    leaseId?: string;
}
/** Process-local leases: no model instructions are persisted into user messages. */
export declare class VoicePromptSessions {
    private current;
    private clock;
    private leases;
    readonly ttlMs = 90000;
    constructor(current: () => VoiceConfig, clock?: () => number);
    private prune;
    activeCount(): number;
    handle(input: SessionAction): {
        active: boolean;
    } | {
        voicePromptActive: boolean;
        personaActive: boolean;
        personaName: string;
        active: boolean;
        leaseId: string;
        expiresAt: number;
    };
    private promptStatus;
    textFor(context: any): string;
    dispose(): void;
}
export declare function installVoicePromptSessions(ctx: Context, current: () => VoiceConfig): VoicePromptSessions;
