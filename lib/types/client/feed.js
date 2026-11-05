/** Only speak new assistant text. Never reads reasoning, tool arguments or historical messages. */
export class ReplyFeed {
    speak;
    end;
    seen = new Set();
    streamed = new Map();
    pending = '';
    baseline = -1;
    fence = false;
    turn;
    constructor(speak, end) {
        this.speak = speak;
        this.end = end;
    }
    reset(entries) {
        this.seen.clear();
        this.streamed.clear();
        this.pending = '';
        this.fence = false;
        this.turn = undefined;
        this.baseline = entries.reduce((n, { event }) => Math.max(n, event.seq), -1);
    }
    accept(snapshot) {
        if (snapshot.change.kind === 'prepend')
            return;
        const entries = snapshot.change.kind === 'append' ? snapshot.change.entries ?? []
            : snapshot.change.kind === 'settle-assistant' ? snapshot.change.entry ? [snapshot.change.entry] : []
                : snapshot.entries;
        for (const { event } of entries) {
            if (event.seq <= this.baseline)
                continue;
            const key = `${event.type}:${event.seq}:${event.data?.attemptId ?? ''}`;
            if (this.seen.has(key))
                continue;
            this.seen.add(key);
            if (event.type === 'turn/start' && this.turn === undefined)
                this.turn = event.data?.turn;
            if (this.turn === undefined || event.data?.turn !== this.turn)
                continue;
            const step = `${event.data?.turn}:${event.data?.step}`;
            if (event.type === 'assistant/live-chunk' && event.data?.chunk?.type === 'text-delta') {
                const text = event.data.chunk.text;
                if (typeof text !== 'string')
                    continue;
                this.streamed.set(step, (this.streamed.get(step) ?? '') + text);
                this.append(text);
            }
            else if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
                const content = event.data?.message?.content;
                const text = Array.isArray(content) ? content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('') : '';
                const streamed = this.streamed.get(step) ?? '';
                // Reconnect may provide only a durable message; fill missing text, never repeat streamed prefix.
                if (text.startsWith(streamed))
                    this.append(text.slice(streamed.length));
                this.flush();
            }
            else if (event.type === 'turn/end') {
                this.flush();
                this.end();
            }
        }
    }
    append(text) {
        this.pending += text;
        // Sentence boundaries keep latency low without reading partial tokens.
        let match;
        while ((match = /[。！？!?；;\n]|\.(?:\s|$)/u.exec(this.pending))) {
            const at = match.index + match[0].length;
            const part = this.pending.slice(0, at);
            this.pending = this.pending.slice(at);
            this.emit(part);
        }
        if (this.pending.length > 180) {
            const at = this.pending.slice(0, 160).lastIndexOf(' ');
            const split = at > 40 ? at : 140;
            this.emit(this.pending.slice(0, split));
            this.pending = this.pending.slice(split);
        }
    }
    flush() { if (this.pending.trim())
        this.emit(this.pending); this.pending = ''; }
    emit(text) {
        const parts = text.split('```');
        let clean = '';
        for (let i = 0; i < parts.length; i++) {
            if (!this.fence)
                clean += parts[i];
            if (i < parts.length - 1)
                this.fence = !this.fence;
        }
        clean = clean.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/^[\s#>*-]+/gm, '').replace(/[`*_~]/g, '').trim();
        // Bound every request, including a very long sentence ending in punctuation.
        while (clean.length > 140) {
            const whitespace = clean.slice(0, 140).lastIndexOf(' '), at = whitespace > 50 ? whitespace : 140;
            this.speak(clean.slice(0, at).trim());
            clean = clean.slice(at).trimStart();
        }
        if (clean)
            this.speak(clean);
    }
}
