import {describe,it,expect} from 'vitest';
import {wav16,PcmDecoder} from '../src/client/audio.js';
describe('real wire audio encoding',()=>{
  it('encodes 48k input as 16k mono WAV with correct sizes and clipping',async()=>{
    const samples=new Float32Array(48000).fill(0.5);const data=new DataView(await wav16(samples,48000).arrayBuffer());
    expect(data.byteLength).toBe(32044);expect(data.getUint32(24,true)).toBe(16000);expect(data.getUint16(22,true)).toBe(1);
    expect(data.getInt16(44,true)).toBe(16384);expect(data.getUint32(40,true)).toBe(32000);
  });
  it('preserves PCM samples split across HTTP byte boundaries',()=>{
    const decoder=new PcmDecoder();expect([...decoder.push(new Uint8Array([0]))]).toEqual([]);
    expect([...decoder.push(new Uint8Array([128,255,127,0]))]).toEqual([-1,32767/32768]);
    expect([...decoder.push(new Uint8Array([0]))]).toEqual([0]);expect(()=>decoder.finish()).not.toThrow();
  });
  it('rejects truncated odd-byte PCM instead of silent corruption',()=>{const d=new PcmDecoder();d.push(new Uint8Array([1]));expect(()=>d.finish()).toThrow('不完整');});
});
