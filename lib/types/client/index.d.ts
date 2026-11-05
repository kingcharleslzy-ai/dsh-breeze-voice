import type { Context } from '@deepseek-ai/cordis';
import { type Scope } from './workbench.js';
export declare const inject: string[];
export declare function apply(ctx: Context): void;
export declare function VoiceSettings({ scope }: {
    scope?: Scope;
}): import("react").JSX.Element;
