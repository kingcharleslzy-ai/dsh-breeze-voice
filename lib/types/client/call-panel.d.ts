import { VoiceSessionView } from './voice-session.js';
export declare function CallIcon({ kind }: {
    kind: 'mic' | 'muted' | 'end' | 'stop' | 'collapse' | 'expand' | 'close';
}): import("react").JSX.Element;
export declare function useCall(view: VoiceSessionView): import("./voice-session.js").CallView;
export declare function VoiceCallButton({ view }: {
    view: VoiceSessionView;
}): import("react").JSX.Element;
export declare function VoiceCallPanel({ view }: {
    view: VoiceSessionView;
}): import("react").JSX.Element | null;
