import { jsx as _jsx } from "react/jsx-runtime";
import { VoiceWorkbench, VoiceIcon } from './workbench.js';
import { VoiceSessionView } from './voice-session.js';
import { VoiceCallButton, VoiceCallPanel } from './call-panel.js';
export const inject = ['slots', 'sessions', 'conversation', 'configForms'];
export function apply(ctx) {
    const slots = ctx.get('slots'), sessions = ctx.get('sessions');
    const views = new Map();
    const injectView = (sessionId) => {
        let view = views.get(sessionId);
        if (!view) {
            view = new VoiceSessionView(sessions.binding(sessionId), sessions.scope(sessionId)?.get('conversation'), () => { if (views.get(sessionId) === view)
                views.delete(sessionId); });
            views.set(sessionId, view);
        }
        return { view };
    };
    slots.inject('conversation.input.right', () => slots.register({ name: 'conversation.input.right', id: 'breeze-voice-microphone', order: 20, inject: injectView }, VoiceCallButton));
    slots.inject('conversation.input.dock', () => slots.register({ name: 'conversation.input.dock', id: 'breeze-voice-call', order: 10, inject: injectView }, VoiceCallPanel));
    ctx.effect(() => () => { for (const view of views.values())
        view.dispose(); views.clear(); }, 'breeze-voice call views');
    const forms = ctx.get('configForms');
    slots.inject('plugins.bundle.config', () => slots.register({ name: 'plugins.bundle.config', key: 'dsh-breeze-voice', inject: () => ({ scope: forms.get('breeze-voice') }) }, VoiceSettings));
    slots.inject('main', () => slots.register({ name: 'main', key: 'breeze-voice', inject: () => ({ scope: forms.get('breeze-voice') }) }, VoiceWorkbench));
    slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: 'breeze-voice', order: 11, label: '语音' }, VoiceIcon));
}
export function VoiceSettings({ scope }) { return _jsx(VoiceWorkbench, { scope: scope, compact: true }); }
