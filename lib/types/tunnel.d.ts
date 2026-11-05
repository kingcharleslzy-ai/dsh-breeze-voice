import type { EffectiveConfig } from './config.js';
/** Owns only the SSH process created by this plugin. Never closes user tunnels. */
export declare class Tunnel {
    private child?;
    private opening?;
    private identity;
    private idle?;
    private active;
    acquire(c: EffectiveConfig): Promise<() => void>;
    private open;
    close(): void;
}
