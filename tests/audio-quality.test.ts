import {describe, it, expect, vi} from 'vitest';
import {SpeechTurn} from '../src/client/vad-turn.js';
import {Microphone} from '../src/client/audio.js';
const frame = () => new Float32Array(512).fill(.05);
function fixture(playback = false) {
  const speechStart = vi.fn(), utterance = vi.fn();
  const gate = new SpeechTurn({silenceMs:1200, isPlayback:()=>playback,speechStart,utterance});
  const feed = (probability:number, count:number) => { for (let i=0;i<count;i++) gate.push(frame(), probability); };
  return {gate,feed,speechStart,utterance};
}
describe('neural probability turn policy', () => {
  it('rejects background noise and isolated clicks even with large audio energy', () => {
    const x=fixture(); x.feed(.02,100); x.feed(.99,2); x.feed(.03,100);
    expect(x.speechStart).not.toHaveBeenCalled(); expect(x.utterance).not.toHaveBeenCalled();
  });
  it('keeps short pauses in one sentence and preserves 800ms onset context', () => {
    const x=fixture(); x.feed(.01,20); x.feed(.9,20); x.feed(.05,20); x.feed(.95,20);
    expect(x.utterance).not.toHaveBeenCalled(); x.feed(.01,38);
    expect(x.speechStart).toHaveBeenCalledTimes(1); expect(x.utterance).toHaveBeenCalledTimes(1);
    expect(x.utterance.mock.calls[0]![0].length).toBe((25+14+20+20+38)*512);
  });
  it('requires sustained stronger speech before interrupting speaker playback', () => {
    const x=fixture(true); x.feed(.6,40); x.feed(.9,14);
    expect(x.speechStart).not.toHaveBeenCalled(); x.feed(.9,1);
    expect(x.speechStart).toHaveBeenCalledTimes(1);
  });
  it('recognizes a short normal answer after 192ms without waiting 320ms', () => {
    const x=fixture(); x.feed(.02,10); x.feed(.95,6); x.feed(.02,38);
    expect(x.speechStart).toHaveBeenCalledTimes(1); expect(x.utterance).toHaveBeenCalledTimes(1);
  });
  it('explicit finish rescues a 128ms short answer even after a 960ms pause', () => {
    const x=fixture(); x.feed(.02,10); x.feed(.95,4); x.feed(.02,30);
    expect(x.speechStart).not.toHaveBeenCalled(); x.gate.flush();
    expect(x.speechStart).toHaveBeenCalledTimes(1); expect(x.utterance).toHaveBeenCalledTimes(1);
    expect(x.utterance.mock.calls[0]![0].length).toBe(44*512);
  });
  it('explicit finish still rejects clicks and expired short candidates', () => {
    const x=fixture(); x.feed(.99,2); x.gate.flush(); expect(x.utterance).not.toHaveBeenCalled();
    x.feed(.99,4); x.feed(.01,38); x.gate.flush(); expect(x.utterance).not.toHaveBeenCalled();
  });
  it('explicit flush emits exactly once, reset discards stale turn', () => {
    const x=fixture(); x.feed(.9,12); x.gate.flush(); x.gate.flush();
    expect(x.utterance).toHaveBeenCalledTimes(1); x.feed(.9,12); x.gate.reset(); x.gate.flush();
    expect(x.utterance).toHaveBeenCalledTimes(1);
  });
  it('does not accumulate unrelated noise spikes into valid speech', () => {
    const x=fixture(); for(let i=0;i<30;i++){x.feed(.99,3);x.feed(.01,5);}
    expect(x.speechStart).not.toHaveBeenCalled();
  });
});
it('closes tracks if microphone permission resolves after stop', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis,'navigator');
  let grant!: (stream:MediaStream)=>void;
  const stop=vi.fn();
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>new Promise<MediaStream>(resolve=>grant=resolve)}}});
  try {
    const mic=new Microphone({} as AudioContext,{silenceMs:1200,threshold:.018,canListen:()=>true,speechStart:vi.fn(),utterance:vi.fn(),level:vi.fn()});
    const starting=mic.start(); mic.stop(); grant({getTracks:()=>[{stop}]} as unknown as MediaStream); await starting;
    expect(stop).toHaveBeenCalledTimes(1);
  } finally { if(original) Object.defineProperty(globalThis,'navigator',original); else Reflect.deleteProperty(globalThis,'navigator'); }
});
