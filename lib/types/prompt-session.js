import { randomUUID } from 'node:crypto';
import { resolveConfig } from './config.js';
/** Process-local leases: no model instructions are persisted into user messages. */
export class VoicePromptSessions {
    current;
    clock;
    leases = new Map();
    ttlMs = 90000;
    constructor(current, clock = Date.now) {
        this.current = current;
        this.clock = clock;
    }
    prune() { const now = this.clock(); for (const [id, lease] of this.leases)
        if (lease.expiresAt <= now)
            this.leases.delete(id); }
    activeCount() { this.prune(); return this.leases.size; }
    handle(input) {
        this.prune();
        if (!input || typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(input.sessionId))
            throw Error('语音会话标识无效');
        const existing = this.leases.get(input.sessionId);
        if (input.action === 'start') {
            if (existing)
                throw Error('此会话已在另一个语音窗口中连接，请先结束原通话');
            if (this.leases.size >= 32)
                throw Error('语音连接过多，请结束闲置的通话');
            const lease = { leaseId: randomUUID(), expiresAt: this.clock() + this.ttlMs };
            this.leases.set(input.sessionId, lease);
            return { ...lease, active: true, ...this.promptStatus() };
        }
        if (input.action !== 'keepalive' && input.action !== 'stop')
            throw Error('语音会话操作无效');
        if (!existing) {
            if (input.action === 'stop')
                return { active: false };
            throw Error('语音连接已过期，请重新开始');
        }
        if (typeof input.leaseId !== 'string' || input.leaseId !== existing.leaseId)
            throw Error('语音连接标识不匹配');
        if (input.action === 'stop') {
            this.leases.delete(input.sessionId);
            return { active: false };
        }
        existing.expiresAt = this.clock() + this.ttlMs;
        return { ...existing, active: true, ...this.promptStatus() };
    }
    promptStatus() { const c = resolveConfig(this.current()); return { voicePromptActive: c.voicePromptEnabled && Boolean(c.voicePrompt.trim()), personaActive: c.personaEnabled && Boolean(c.personaPrompt.trim()), personaName: c.personaName }; }
    textFor(context) {
        this.prune();
        const agent = context?.agent, header = agent?.session?.header ?? agent?.session;
        const id = typeof header?.id === 'string' ? header.id : agent?.id;
        if (typeof id !== 'string' || !this.leases.has(id))
            return '';
        const c = resolveConfig(this.current()), parts = [];
        if (c.voicePromptEnabled && c.voicePrompt.trim())
            parts.push(`【当前语音交流方式】\n${c.voicePrompt.trim()}`);
        if (c.personaEnabled && c.personaPrompt.trim())
            parts.push(`【当前语音对话角色${c.personaName.trim() ? `：${c.personaName.trim()}` : ''}】\n${c.personaPrompt.trim()}`);
        return parts.join('\n\n');
    }
    dispose() { this.leases.clear(); }
}
export function installVoicePromptSessions(ctx, current) {
    const manager = new VoicePromptSessions(current);
    const prompt = ctx.get('systemPrompt');
    if (!prompt)
        throw Error('当前 DSH 未提供原生系统提示词服务');
    let order = 250;
    try {
        order = prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 2;
    }
    catch { /* Stable additive section fallback. */ }
    ctx.effect(() => prompt.section({ name: 'BREEZE_VOICE_SESSION', order, interpolate: false, text: (context) => manager.textFor(context) }), 'breeze-voice scoped prompt');
    ctx.effect(() => () => manager.dispose(), 'breeze-voice session leases');
    return manager;
}
