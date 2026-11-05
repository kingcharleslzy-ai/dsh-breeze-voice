import {describe,it,expect,vi} from 'vitest';
import {lookupNativeAsr,recognizeNativeAsr,type NativeSpeechService} from '../src/native-asr.js';
import {wav16} from '../src/client/audio.js';
const service=(phase='ready')=>({snapshot:()=>({providers:[{id:'sensevoice-local',name:'SenseVoice',languages:['zh'],preparation:{phase}}]}),resolve:vi.fn(x=>x),transcribe:vi.fn(async()=>({text:' 星河语音。 ',audioSeconds:1,inferenceSeconds:.1}))}) satisfies NativeSpeechService;
describe('native DSH recognizer reuse',()=>{
 it('reports optional service availability without preparing or changing providers',()=>{
  expect(lookupNativeAsr(undefined)).toMatchObject({available:false,ready:false});expect(lookupNativeAsr(service('unprepared'))).toMatchObject({available:true,ready:false});expect(lookupNativeAsr(service('standby'))).toMatchObject({ready:true,phase:'standby'});
 });
 it('passes canonical WAV bytes to exact local provider, Chinese hint, and original abort signal',async()=>{
  const s=service(),wav=new Uint8Array(await wav16(new Float32Array(16000),16000).arrayBuffer()),abort=new AbortController();
  expect(await recognizeNativeAsr({get:()=>s},wav,abort.signal)).toEqual({text:'星河语音。',language:'zh',duration:1});
  expect(s.resolve).toHaveBeenCalledWith({audio:Buffer.from(wav),providerId:'sensevoice-local',language:'zh'});expect(s.transcribe.mock.calls[0]?.[1]).toBe(abort.signal);
 });
 it('rejects missing preparation and malformed WAV rather than falling back or sending audio elsewhere',async()=>{
  const cold=service('unprepared');await expect(recognizeNativeAsr(cold,new Uint8Array(),new AbortController().signal)).rejects.toThrow('尚未就绪');expect(cold.transcribe).not.toHaveBeenCalled();
  const s=service();await expect(recognizeNativeAsr(s,new Uint8Array(500),new AbortController().signal)).rejects.toThrow('WAV');expect(s.resolve).not.toHaveBeenCalled();
 });
 it('rejects already canceled work before accessing provider',async()=>{
  const s=service(),a=new AbortController();a.abort();await expect(recognizeNativeAsr(s,new Uint8Array(),a.signal)).rejects.toThrow();expect(s.resolve).not.toHaveBeenCalled();
 });
});
