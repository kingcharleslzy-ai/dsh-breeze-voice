import type { Context } from '@deepseek-ai/cordis';
import { VoiceChatControl } from './chat-control.js';
export declare function voiceToolDefinitions(control: VoiceChatControl): import("@deepseek-ai/dsh-tools").ToolDefinition[];
export declare function registerVoiceTools(ctx: Context, control: VoiceChatControl): void;
