import {afterEach,describe,it,expect,vi} from 'vitest';
import {VoiceController} from '../src/client/controller.js';
import {resolveConfig} from '../src/config.js';
import type {SessionBinding} from '../src/client/feed.js';
class FakeContext {
  sampleRate=48000;currentTime=0;destination={};state='running';
  async resume(){} async close(){this.state='closed';}
  createMediaStreamSource(){return {connect(){},disconnect(){}};}
  createScriptProcessor(){return {connect(){},disconnect(){},onaudioprocess:null};}
  createGain(){return {gain:{value:0},connect(){},disconnect(){}};}
}
vi.mock('../src/client/vad-model.js',()=>({VAD_ASSETS:'/api/breeze-voice/assets/',loadVadModel:async()=>({process:async()=>0,reset(){},dispose:async()=>{}})}));
const tick=()=>new Promise(r=>setTimeout(r,0));
afterEach(()=>vi.unstubAllGlobals());
function setup(media:Promise<unknown>=Promise.resolve({getTracks:()=>[{stop(){}}]})){
  vi.stubGlobal('AudioContext',FakeContext);
  vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:()=>media}});
  const binding:SessionBinding={sessionId:'test',session:{getSnapshot:()=>({running:false}),subscribe:()=>()=>{}},eventSource:{getSnapshot:()=>({revision:0,entries:[],change:{kind:'replace'}}),subscribe:()=>()=>{}}};
  const fetchMock=vi.fn(async(input:string)=>new Response(JSON.stringify(input.endsWith('config')?resolveConfig({}):input.endsWith('session')?{leaseId:'test-lease',active:true}:{ready:true}),{headers:{'content-type':'application/json'}}));
  vi.stubGlobal('fetch',fetchMock);
  const c=new VoiceController(binding,{send:vi.fn(async()=>{}),cancel:vi.fn(async()=>{})},()=>{});
  return {c,fetchMock,conversation:(c as any).conversation};
}
describe('voice lifecycle races',()=>{
  it('warms a cold service before requesting microphone access',async()=>{
    const {c,fetchMock}=setup();
    fetchMock.mockImplementation(async(input:string)=>new Response(JSON.stringify(input.endsWith('config')?resolveConfig({}):input.endsWith('session')?{leaseId:'test-lease',active:true}:input.endsWith('health')?{ready:false}:{ready:true}),{headers:{'content-type':'application/json'}}));
    await c.start();expect(fetchMock.mock.calls.some(args=>String(args[0]).endsWith('/warmup'))).toBe(true);expect(c.state.cold).toBe(false);expect(c.state.phase).toBe('正在听');await c.stop();
  });
  it('releases a microphone granted after the user ends the call',async()=>{
    let grant!:(x:unknown)=>void;const stopped=vi.fn();const media=new Promise(resolve=>{grant=resolve;});
    const {c}=setup(media);const starting=c.start();await tick();expect(c.state.active).toBe(true);
    await c.stop();grant({getTracks:()=>[{stop:stopped}]});await starting;
    expect(stopped).toHaveBeenCalledOnce();expect(c.state.active).toBe(false);
  });
  it('manual interrupt during ASR clears the busy latch and aborts stale submission',async()=>{
    const {c,fetchMock}=setup();await c.start();
    let asrSignal:AbortSignal|undefined;
    fetchMock.mockImplementationOnce(async(_input:any,init:any)=>new Promise((_resolve,reject)=>{asrSignal=init.signal;init.signal.addEventListener('abort',()=>reject(new DOMException('abort','AbortError')));}));
    const transcribing=(c as any).transcribe(new Blob(['wav']));await tick();expect((c as any).transcribing).toBe(true);
    c.stopReply();await transcribing;
    expect(asrSignal?.aborted).toBe(true);expect((c as any).transcribing).toBe(false);expect(c.state.phase).toBe('正在听');
    await c.stop();
  });
  it('microphone denial ends the call and surfaces a recoverable error',async()=>{
    const {c}=setup(Promise.reject(new DOMException('denied','NotAllowedError')));await c.start();
    expect(c.state.active).toBe(false);expect(c.state.error).toContain('麦克风访问被拒绝');
  });
});

describe('recognition review',()=>{
 it('does not send until reviewed, sends edits, and releases the prompt lease',async()=>{
  const {c,fetchMock,conversation}=setup();
  fetchMock.mockImplementation(async(input:string)=>new Response(JSON.stringify(input.endsWith('config')?resolveConfig({reviewBeforeSend:true}):input.endsWith('session')?{leaseId:'review-lease',active:true}:input.endsWith('transcriptions')?{text:'错误识别'}:{ready:true})));
  await c.start();await (c as any).transcribe(new Blob(['wav']));expect(c.state.reviewText).toBe('错误识别');expect(conversation.send).not.toHaveBeenCalled();
  expect((c as any).mic.options.canListen()).toBe(false);c.setReviewText('更正后的术语');await c.sendReviewed();expect(conversation.send).toHaveBeenCalledWith('更正后的术语');expect(c.state.reviewText).toBeUndefined();
  await c.stop();expect(fetchMock.mock.calls.some((args:any)=>String(args[0]).endsWith('/session')&&JSON.parse(args[1].body).action==='stop')).toBe(true);
 });
 it('discarding recognition returns to listening without submitting',async()=>{
  const {c,conversation}=setup();await c.start();(c as any).patch({reviewText:'待确认'});c.discardReview();expect(c.state.reviewText).toBeUndefined();expect((c as any).mic.options.canListen()).toBe(true);expect(conversation.send).not.toHaveBeenCalled();await c.stop();
 });
});

describe('optional native ASR startup',()=>{
 it('uses ready native recognizer while remote ASR stays unloaded',async()=>{
  const {c,fetchMock}=setup();fetchMock.mockImplementation(async(input:string)=>new Response(JSON.stringify(input.endsWith('config')?resolveConfig({asrEngine:'dsh'}):input.endsWith('native-asr')?{ready:true}:input.endsWith('session')?{leaseId:'native'}:input.endsWith('health')?{tts:'ready',asr:'unloaded',ready:false}:{})));
  await c.start();expect(c.state.phase).toBe('正在听');expect(fetchMock.mock.calls.some(args=>String(args[0]).endsWith('/warmup'))).toBe(false);await c.stop();
 });
 it('does not silently fall back or download when native model is unprepared',async()=>{
  const {c,fetchMock}=setup();fetchMock.mockImplementation(async(input:string)=>new Response(JSON.stringify(input.endsWith('config')?resolveConfig({asrEngine:'dsh'}):input.endsWith('native-asr')?{ready:false,message:'请先准备原生模型'}:{ready:true,tts:'ready'})));
  await c.start();expect(c.state.active).toBe(false);expect(c.state.error).toContain('准备原生');expect(fetchMock.mock.calls.some(args=>String(args[0]).endsWith('/warmup'))).toBe(false);
 });
});

describe('inline call controls',()=>{
 it('mutes capture while keeping the voice lease and restores listening',async()=>{
  const {c,fetchMock}=setup();await c.start();expect(c.state.ready).toBe(true);c.setMuted(true);expect(c.state.muted).toBe(true);expect(c.state.phase).toBe('麦克风已静音');expect((c as any).mic.options.canListen()).toBe(false);
  expect(fetchMock.mock.calls.filter((args:any)=>String(args[0]).endsWith('/session')&&JSON.parse(args[1].body).action==='stop')).toHaveLength(0);
  c.stopReply();expect(c.state.phase).toBe('麦克风已静音');c.setMuted(false);expect(c.state.phase).toBe('正在听');await c.stop();expect(c.state.ready).toBe(false);expect(c.state.promptActive).toBe(false);
 });
 it('shows only server-confirmed scoped persona and refreshes it on lease renewal',async()=>{
  const {c,fetchMock}=setup();fetchMock.mockImplementation(async(input:string)=>new Response(JSON.stringify(input.endsWith('config')?resolveConfig({}):input.endsWith('session')?{leaseId:'lease',personaActive:true,personaName:'英语老师',voicePromptActive:true}:{ready:true})));
  await c.start();expect(c.state.personaName).toBe('英语老师');expect(c.state.promptActive).toBe(true);
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({personaActive:false,voicePromptActive:false})));
  await (c as any).keepLease();expect(c.state.personaName).toBeUndefined();expect(c.state.promptActive).toBe(false);await c.stop();
 });
});
