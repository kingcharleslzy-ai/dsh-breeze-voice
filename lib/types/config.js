import z from '@deepseek-ai/schemastery';
import { DEFAULT_VOICE_PROMPT, DEFAULT_INSTRUCTION } from './voice-defaults.js';
export const defaults = {
    sshHost: '', remotePort: 8870, localPort: 19889, apiKey: '', remoteTaskName: '',
    instruction: DEFAULT_INSTRUCTION, voiceId: '', asrHotwords: '', asrEngine: 'server', reviewBeforeSend: false,
    silenceMs: 1200, vadThreshold: 0.018, bargeIn: true,
    idleMinutes: 10, activeVoiceId: 'custom', voiceProfiles: [],
    voicePromptEnabled: true, voicePrompt: DEFAULT_VOICE_PROMPT,
    personaEnabled: false, personaName: '', personaPrompt: '',
};
export const Config = z.object({
    sshHost: z.string().default('').volatile(),
    remotePort: z.number().default(8870).volatile(),
    localPort: z.number().default(19889).volatile(),
    apiKey: z.string().default('').role('secret').volatile(),
    remoteTaskName: z.string().default('').volatile(),
    instruction: z.string().default(defaults.instruction).volatile(),
    voiceId: z.string().default('').volatile(),
    asrEngine: z.union(['server', 'dsh']).default('server').volatile(),
    asrHotwords: z.string().default('').volatile(),
    reviewBeforeSend: z.boolean().default(false).volatile(),
    silenceMs: z.number().default(1200).volatile(),
    vadThreshold: z.number().default(0.018).volatile(),
    bargeIn: z.boolean().default(true).volatile(),
    idleMinutes: z.number().default(10).volatile(),
    activeVoiceId: z.string().default('custom').volatile(),
    voiceProfiles: z.array(z.object({ id: z.string(), name: z.string(), instruction: z.string() })).default([]).volatile(),
    voicePromptEnabled: z.boolean().default(true).volatile(),
    voicePrompt: z.string().default(DEFAULT_VOICE_PROMPT).volatile(),
    personaEnabled: z.boolean().default(false).volatile(),
    personaName: z.string().default('').volatile(),
    personaPrompt: z.string().default('').volatile(),
});
export function resolveConfig(raw) {
    const c = { ...defaults, ...raw };
    if (c.sshHost && !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,200}$/.test(c.sshHost))
        throw Error('SSH 主机别名格式无效');
    if (c.remoteTaskName && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(c.remoteTaskName))
        throw Error('服务器任务名称格式无效');
    for (const port of [c.localPort, c.remotePort])
        if (!Number.isInteger(port) || port < 1024 || port > 65535)
            throw Error('端口须为 1024–65535 的整数');
    if (!Number.isFinite(c.silenceMs) || c.silenceMs < 400 || c.silenceMs > 3000)
        throw Error('停顿时间须为 400–3000 毫秒');
    if (!Number.isFinite(c.vadThreshold) || c.vadThreshold < 0.005 || c.vadThreshold > 0.2)
        throw Error('麦克风阈值须为 0.005–0.2');
    if (typeof c.voiceId !== 'string' || (c.voiceId && !/^[a-zA-Z0-9_-]{1,100}$/.test(c.voiceId)))
        throw Error('固定音色标识无效');
    if (!['server', 'dsh'].includes(c.asrEngine))
        throw Error('识别引擎无效');
    if (typeof c.asrHotwords !== 'string' || c.asrHotwords.length > 2000)
        throw Error('识别热词最多 2000 字');
    if (c.instruction.length > 1000)
        throw Error('声音描述过长');
    if (!Number.isInteger(c.idleMinutes) || c.idleMinutes < 0 || c.idleMinutes > 120)
        throw Error('空闲卸载时间须为 0–120 分钟的整数；0 表示不自动卸载');
    if (typeof c.voicePrompt !== 'string' || c.voicePrompt.length > 6000)
        throw Error('语音模式提示词最多 6000 字');
    if (typeof c.personaPrompt !== 'string' || c.personaPrompt.length > 6000)
        throw Error('角色提示词最多 6000 字');
    if (typeof c.personaName !== 'string' || c.personaName.length > 80)
        throw Error('角色名称最多 80 字');
    if (typeof c.activeVoiceId !== 'string' || c.activeVoiceId.length > 100)
        throw Error('音色标识无效');
    if (!Array.isArray(c.voiceProfiles) || c.voiceProfiles.length > 40)
        throw Error('最多保存 40 个音色');
    const ids = new Set();
    for (const voice of c.voiceProfiles) {
        if (!voice || !/^[a-zA-Z0-9_-]{1,100}$/.test(voice.id) || ids.has(voice.id))
            throw Error('音色标识无效或重复');
        if (typeof voice.name !== 'string' || !voice.name.trim() || voice.name.length > 80)
            throw Error('音色名称须为 1–80 字');
        if (typeof voice.instruction !== 'string' || !voice.instruction.trim() || voice.instruction.length > 1000)
            throw Error('音色描述须为 1–1000 字');
        ids.add(voice.id);
    }
    return c;
}
