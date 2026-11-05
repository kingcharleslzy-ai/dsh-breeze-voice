import {loadVadModel, VAD_ASSETS} from './vad-model.js';
import type {VadModel} from './vad-model.js';
import {SpeechTurn} from './vad-turn.js';
/** Small PCM helpers shared by microphone capture, playback and acceptance tests. */
export function wav16(samples: Float32Array, sampleRate: number) {
  const targetRate = 16000;
  const count = Math.floor(samples.length * targetRate / sampleRate);
  const buffer = new ArrayBuffer(44 + count * 2), view = new DataView(buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,targetRate,true); view.setUint32(28,targetRate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
  ascii(36,'data'); view.setUint32(40,count*2,true);
  // Box filtering prevents simple high-frequency aliasing during 48k -> 16k capture.
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * sampleRate / targetRate), to = Math.max(from + 1, Math.floor((i+1) * sampleRate / targetRate));
    let sum = 0;
    for (let j = from; j < to && j < samples.length; j++) sum += samples[j]!;
    const value = Math.max(-1, Math.min(1, sum / (to-from)));
    view.setInt16(44+i*2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Blob([buffer], {type:'audio/wav'});
}
export class PcmDecoder {
  private pending?: number;
  push(bytes: Uint8Array) {
    const data = this.pending === undefined ? bytes : new Uint8Array([this.pending, ...bytes]);
    const usable = data.length - data.length % 2;
    this.pending = usable === data.length ? undefined : data[data.length-1];
    const out = new Float32Array(usable/2), view = new DataView(data.buffer, data.byteOffset, usable);
    for (let i=0;i<out.length;i++) out[i] = view.getInt16(i*2,true)/32768;
    return out;
  }
  finish() { if (this.pending !== undefined) throw Error('语音服务返回了不完整的 PCM 数据'); }
}
export class PcmPlayer {
  private sources = new Set<AudioBufferSourceNode>();
  private cursor = 0;
  constructor(readonly context: AudioContext) {}
  get pendingSeconds() { return Math.max(0, this.cursor - this.context.currentTime); }
  push(samples: Float32Array, sampleRate: number) {
    if (!samples.length) return;
    const buffer = this.context.createBuffer(1,samples.length,sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>,0);
    const source = this.context.createBufferSource(); source.buffer = buffer;
    source.connect(this.context.destination);
    const start = Math.max(this.cursor, this.context.currentTime+0.025);
    this.cursor = start + buffer.duration;
    this.sources.add(source);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    source.start(start);
  }
  stop() {
    for (const source of this.sources) { try { source.stop(); } catch {} source.disconnect(); }
    this.sources.clear(); this.cursor = 0;
  }
}
export interface CaptureOptions {
  silenceMs: number;
  /** Retained for older saved settings; neural probability is the primary gate. */
  threshold: number;
  canListen(): boolean;
  isPlayback?(): boolean;
  speechStart(): void;
  utterance(wav: Blob): void;
  level(value: number): void;
  error?(error: Error): void;
}
export class Microphone {
  private media?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private processor?: AudioWorkletNode | ScriptProcessorNode;
  private silent?: GainNode;
  private model?: VadModel;
  private closed = false;
  private enabled = false;
  private muted = false;
  private generation = 0;
  private pending = 0;
  private chain: Promise<void> = Promise.resolve();
  private turn: SpeechTurn;
  constructor(readonly context: AudioContext, readonly options: CaptureOptions) {
    this.turn = new SpeechTurn({...options, utterance: samples => options.utterance(wav16(samples, 16000))});
  }
  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw Error('当前窗口无法访问麦克风，请在 DSH 桌面版或本机安全连接中使用');
    // Ask for permission while handling the gesture; late grants are always closed.
    const media = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1},video:false});
    if (this.closed) { media.getTracks().forEach(t => t.stop()); return; }
    this.media = media;
    for(const track of media.getAudioTracks?.() ?? media.getTracks())track.enabled=!this.muted;
    try {
      const model = await loadVadModel();
      if (this.closed) { await model.dispose(); return; }
      this.model = model;
      this.source = this.context.createMediaStreamSource(media);
      this.silent = this.context.createGain(); this.silent.gain.value = 0;
      if (this.context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        await this.context.audioWorklet.addModule(VAD_ASSETS + 'vad.worklet.bundle.min.js');
        if (this.closed) return;
        const node = new AudioWorkletNode(this.context, 'vad-helper-worklet', {processorOptions:{frameSamples:512}});
        node.port.onmessage = event => {
          if (event.data?.data instanceof ArrayBuffer) this.capture(new Float32Array(event.data.data));
        };
        this.processor = node;
      } else {
        // Compatibility transport only: all detection still uses the neural model.
        const node = this.context.createScriptProcessor(2048, 1, 1);
        let input: number[] = [];
        node.onaudioprocess = event => {
          input.push(...event.inputBuffer.getChannelData(0));
          const needed = Math.ceil(512 * this.context.sampleRate / 16000);
          while (input.length >= needed) {
            const frame = new Float32Array(512);
            for (let i = 0; i < 512; i++) {
              const from = Math.floor(i * needed / 512), to = Math.floor((i + 1) * needed / 512);
              for (let j = from; j < to; j++) frame[i]! += input[j]! / (to - from);
            }
            input = input.slice(needed); this.capture(frame);
          }
        };
        this.processor = node;
      }
      this.source.connect(this.processor); this.processor.connect(this.silent); this.silent.connect(this.context.destination);
    } catch (error) { this.stop(); throw error; }
  }
  private capture(frame: Float32Array) {
    if (this.closed) return;
    this.options.level(Math.sqrt(frame.reduce((sum, x) => sum + x*x, 0) / frame.length));
    const enabled = !this.muted && this.options.canListen();
    if (enabled !== this.enabled) {
      this.enabled = enabled; this.generation++; this.turn.reset();
      this.chain = this.chain.then(() => this.model?.reset());
    }
    if (!enabled) return;
    // Never let delayed inference interrupt a later answer with stale microphone audio.
    if (this.pending >= 32) { this.fail(Error('本机语音检测处理过慢，请关闭其他高负载程序后重试')); return; }
    const generation = this.generation;
    this.pending++;
    this.chain = this.chain.then(async () => {
      if (this.closed || this.muted || generation !== this.generation || !this.options.canListen()) return;
      const probability = await this.model!.process(frame);
      if (!this.closed && !this.muted && generation === this.generation && this.options.canListen()) this.turn.push(frame, probability);
    }).catch(error => this.fail(error)).finally(() => { this.pending--; });
  }
  setMuted(muted:boolean){
    this.muted=muted;this.enabled=false;this.generation++;this.turn.reset();
    for(const track of this.media?.getTracks() ?? [])track.enabled=!muted;
    this.chain=this.chain.then(()=>this.model?.reset());
    this.options.level(0);
  }
  flush() {
    // Drain captured frames before flushing so the last syllable is not dropped.
    const generation = this.generation;
    this.chain = this.chain.then(() => {
      if (!this.closed && !this.muted && generation === this.generation && this.options.canListen()) this.turn.flush();
    });
  }
  private fail(error: unknown) {
    if (this.closed) return;
    this.stop(); this.options.error?.(error instanceof Error ? error : Error(String(error)));
  }
  stop() {
    if (this.closed) return;
    this.closed = true; this.generation++; this.turn.reset();
    if (this.processor && 'port' in this.processor) {
      this.processor.port.onmessage = null;
      this.processor.port.postMessage('SPEECH_STOP');
    } else if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect(); this.source?.disconnect(); this.silent?.disconnect();
    this.media?.getTracks().forEach(t => t.stop());
    const model = this.model; this.model = undefined;
    // Release only after any already-running inference finishes.
    void this.chain.finally(() => model?.dispose()).catch(() => {});
  }
}
