export class SpeechTurn {
    options;
    preRoll = [];
    frames = [];
    candidateFrames = [];
    positiveMs = 0;
    gapMs = 0;
    quietMs = 0;
    active = false;
    constructor(options) {
        this.options = options;
    }
    push(frame, probability) {
        const ms = frame.length / 16;
        const playback = this.options.isPlayback?.() ?? false;
        // Stronger and longer confirmation during playback reduces acoustic echo
        // interruptions. Browser AEC/headphones are still needed for speaker echo.
        const positive = probability >= (playback ? .7 : .5);
        if (!this.active) {
            if (this.candidateFrames.length)
                this.candidateFrames.push(frame);
            if (this.candidateFrames.length * ms >= 24000)
                this.candidateFrames = [];
            this.preRoll.push(frame);
            while (this.preRoll.length > Math.ceil(800 / ms))
                this.preRoll.shift();
            if (positive) {
                this.positiveMs += ms;
                this.gapMs = 0;
            }
            else {
                this.gapMs += ms;
                if (this.gapMs >= 128)
                    this.positiveMs = 0;
            }
            // A deliberate finish can submit a short answer after 128 ms of neural
            // speech evidence. Preserve it through the endpoint pause, not only the
            // rolling pre-buffer, so clicking after the last syllable still works.
            if (!this.candidateFrames.length && this.positiveMs >= 128)
                this.candidateFrames = [...this.preRoll];
            if (this.gapMs >= Math.max(400, Math.min(3000, this.options.silenceMs)))
                this.candidateFrames = [];
            if (this.positiveMs < (playback ? 480 : 192))
                return;
            this.active = true;
            this.frames = this.preRoll.splice(0);
            this.candidateFrames = [];
            this.options.speechStart();
        }
        else
            this.frames.push(frame);
        // Hysteresis: ambiguous frames retain a phrase, but only confident speech
        // resets the endpoint timer. A brief breath must not split the sentence.
        if (probability >= .5)
            this.quietMs = 0;
        else if (probability < .35)
            this.quietMs += ms;
        if (this.quietMs >= Math.max(400, Math.min(3000, this.options.silenceMs)) || this.frames.length * ms >= 24000)
            this.flush();
    }
    flush() {
        if (!this.active) {
            if (!this.candidateFrames.length) {
                this.reset();
                return;
            }
            this.frames = this.candidateFrames;
            this.active = true;
            this.options.speechStart();
        }
        const samples = new Float32Array(this.frames.reduce((n, frame) => n + frame.length, 0));
        let offset = 0;
        for (const frame of this.frames) {
            samples.set(frame, offset);
            offset += frame.length;
        }
        this.reset();
        this.options.utterance(samples);
    }
    reset() { this.preRoll = []; this.frames = []; this.candidateFrames = []; this.positiveMs = 0; this.gapMs = 0; this.quietMs = 0; this.active = false; }
}
