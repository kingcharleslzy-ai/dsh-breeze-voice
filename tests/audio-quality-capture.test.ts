import {beforeEach, describe, expect, it, vi} from 'vitest';
const model=vi.hoisted(()=>({process:vi.fn(async()=>.95),reset:vi.fn(),dispose:vi.fn(async()=>{})}));
vi.mock('../src/client/vad-model.js',()=>({VAD_ASSETS:'/api/breeze-voice/assets/',loadVadModel:vi.fn(async()=>model)}));
import {Microphone} from '../src/client/audio.js';
import {loadVadModel} from '../src/client/vad-model.js';
const drain=async()=>{for(let i=0;i<200;i++)await Promise.resolve();};
function fixture(){
 const trackStop=vi.fn(),track={stop:trackStop,enabled:true},node={connect:vi.fn(),disconnect:vi.fn(),onaudioprocess:null as null|((event:unknown)=>void)};
 const context={sampleRate:16000,createMediaStreamSource:()=>({connect:vi.fn(),disconnect:vi.fn()}),createGain:()=>({gain:{value:1},connect:vi.fn(),disconnect:vi.fn()}),createScriptProcessor:()=>node,destination:{}};
 const utterance=vi.fn(),speechStart=vi.fn(),error=vi.fn();let allowed=true;
 const mic=new Microphone(context as unknown as AudioContext,{silenceMs:1200,threshold:.018,canListen:()=>allowed,speechStart,utterance,level:vi.fn(),error});
 const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track]})}}});
 return {mic,utterance,speechStart,trackStop,track,node,error,setAllowed:(value:boolean)=>allowed=value,
   feed:()=>node.onaudioprocess?.({inputBuffer:{getChannelData:()=>new Float32Array(2048).fill(.1)}}),
   restore:()=>{mic.stop();if(original)Object.defineProperty(globalThis,'navigator',original);else Reflect.deleteProperty(globalThis,'navigator');}};
}
beforeEach(()=>{vi.clearAllMocks();model.process.mockImplementation(async()=>.95);vi.mocked(loadVadModel).mockImplementation(async()=>model);});
describe('microphone lifecycle and inference queue',()=>{
 it('explicit flush drains already captured speech before emitting once',async()=>{
   const x=fixture();try{await x.mic.start();x.feed();x.feed();x.feed();x.mic.flush();await drain();
     expect(x.speechStart).toHaveBeenCalledTimes(1);expect(x.utterance).toHaveBeenCalledTimes(1);expect(x.utterance.mock.calls[0]![0].size).toBe(44+6144*2);
   }finally{x.restore();}
 });
 it('drops paused speech and starts fresh when listening resumes',async()=>{
   const x=fixture();try{await x.mic.start();x.feed();x.feed();x.feed();await drain();expect(x.speechStart).toHaveBeenCalledTimes(1);
     x.setAllowed(false);x.feed();await drain();x.mic.flush();await drain();expect(x.utterance).not.toHaveBeenCalled();
     x.setAllowed(true);x.feed();x.feed();x.feed();await drain();x.mic.flush();await drain();expect(x.speechStart).toHaveBeenCalledTimes(2);expect(x.utterance).toHaveBeenCalledTimes(1);
   }finally{x.restore();}
 });
 it('cancels in-flight inference without late interruption or utterance',async()=>{
   let resolve!:(value:number)=>void;model.process.mockImplementation(()=>new Promise<number>(r=>resolve=r));
   const x=fixture();try{await x.mic.start();x.feed();await drain();x.mic.stop();resolve(.99);await drain();
     expect(x.trackStop).toHaveBeenCalledTimes(1);expect(x.speechStart).not.toHaveBeenCalled();expect(x.utterance).not.toHaveBeenCalled();expect(model.dispose).toHaveBeenCalledTimes(1);
   }finally{x.restore();}
 });
 it('releases a model loaded after stop without opening capture nodes',async()=>{
   let resolve!:(value:typeof model)=>void;vi.mocked(loadVadModel).mockImplementation(()=>new Promise(r=>resolve=r));
   const x=fixture();try{const start=x.mic.start();await drain();x.mic.stop();resolve(model);await start;
     expect(x.trackStop).toHaveBeenCalledTimes(1);expect(model.dispose).toHaveBeenCalledTimes(1);expect(x.node.onaudioprocess).toBeNull();
   }finally{x.restore();}
 });
});

it('mute disables tracks and discards partial speech before resume',async()=>{
 const x=fixture();try{await x.mic.start();x.feed();x.feed();await drain();x.mic.setMuted(true);expect(x.track.enabled).toBe(false);x.mic.flush();x.feed();await drain();expect(x.utterance).not.toHaveBeenCalled();
 x.mic.setMuted(false);expect(x.track.enabled).toBe(true);x.feed();x.feed();x.feed();x.mic.flush();await drain();expect(x.utterance).toHaveBeenCalledTimes(1);
 }finally{x.restore();}
});
