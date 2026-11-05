export interface SessionEvent {
    type: string;
    seq: number;
    surfaceOp?: string;
    data: any;
}
export interface EventEntry {
    event: SessionEvent;
    type?: string;
}
export interface EventSnapshot {
    revision: number;
    entries: readonly EventEntry[];
    change: {
        kind: string;
        entries?: readonly EventEntry[];
        entry?: EventEntry;
    };
}
export interface Observable<T> {
    getSnapshot(): T;
    subscribe(listener: () => void): () => void;
}
export interface SessionBinding {
    sessionId: string;
    eventSource: Observable<EventSnapshot>;
    session: Observable<{
        running: boolean;
        removed?: boolean;
        promptError?: unknown;
    }>;
}
export interface Conversation {
    send(text: string): Promise<void>;
    cancel(): Promise<void>;
}
/** Only speak new assistant text. Never reads reasoning, tool arguments or historical messages. */
export declare class ReplyFeed {
    private readonly speak;
    private readonly end;
    private seen;
    private streamed;
    private pending;
    private baseline;
    private fence;
    private turn;
    constructor(speak: (text: string) => void, end: () => void);
    reset(entries: readonly EventEntry[]): void;
    accept(snapshot: EventSnapshot): void;
    private append;
    flush(): void;
    private emit;
}
