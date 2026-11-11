import { type VoiceConfig } from './config.js';
import type { Tunnel } from './tunnel.js';
export interface VoiceSettings {
    describe(options: {
        redactSecrets: true;
    }): {
        ns: string;
        revision: number;
        value?: Record<string, unknown>;
    }[];
    mutate(ns: string, ops: {
        op: 'set';
        path: string[];
        value: unknown;
    }[], revision: number): Promise<void>;
}
export declare const editable: {
    readonly instruction: "string";
    readonly asrEngine: "string";
    readonly asrHotwords: "string";
    readonly reviewBeforeSend: "boolean";
    readonly silenceMs: "number";
    readonly bargeIn: "boolean";
    readonly idleMinutes: "number";
    readonly voicePromptEnabled: "boolean";
    readonly voicePrompt: "string";
    readonly personaEnabled: "boolean";
    readonly personaName: "string";
    readonly personaPrompt: "string";
};
export type RemoteCall = (path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<any>;
export declare function remoteControl(current: () => VoiceConfig, tunnel: Pick<Tunnel, 'acquire'>): RemoteCall;
export declare class VoiceChatControl {
    private current;
    private settings;
    private remote;
    private active;
    private nativeReady;
    private pending;
    constructor(current: () => VoiceConfig, settings: VoiceSettings, remote: RemoteCall, active?: () => number, nativeReady?: () => boolean);
    private descriptor;
    snapshot(): {
        revision: number;
        settings: {
            [k: string]: string | number | boolean | import("./config.js").VoiceProfile[];
        };
        active_calls: number;
        scope: string;
        restart_required: boolean;
    };
    private serial;
    private revision;
    private validate;
    private save;
    update(patch: unknown, revision: number, signal?: AbortSignal): Promise<{
        server_sync: unknown;
        effect: {
            [k: string]: string;
        };
        warning?: string | undefined;
        saved: boolean;
        revision: number;
        settings: {
            [k: string]: string | number | boolean | import("./config.js").VoiceProfile[];
        };
        active_calls: number;
        scope: string;
        restart_required: boolean;
        changed_fields: string[];
    }>;
    private syncIdle;
    voices(args: {
        action?: string;
        voice_id?: string;
        revision?: number;
        name?: string;
        instruction?: string;
    }, signal?: AbortSignal): Promise<any>;
    service(action?: string, signal?: AbortSignal): Promise<{
        ok: boolean;
        idle_seconds: number;
    } | {
        server: any;
        active_calls: number;
    } | {
        server: any;
        active_calls?: undefined;
    }>;
}
