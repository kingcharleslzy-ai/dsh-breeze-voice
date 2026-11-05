import {describe,it,expect,vi} from 'vitest';
import {VoiceChatControl,remoteControl,type VoiceSettings} from '../src/chat-control.js';
import {voiceToolDefinitions} from '../src/chat-tools.js';
import type {VoiceConfig} from '../src/config.js';
import {createServer} from 'node:http';
const id='1234567890abcdef1234567890abcdef';
function fixture(){
  let config:VoiceConfig={apiKey:'secret-must-not-leak',sshHost:'private-host',idleMinutes:10,personaName:'原有角色',asrHotwords:'原热词'},revision=1,active=0;
  const settings:VoiceSettings={describe:()=>[{ns:'breeze-voice',revision}],mutate:async(_ns,ops,expected)=>{if(revision!==expected)throw Error('conflict');for(const op of ops)(config as any)[op.path[0]!]=op.value;revision++;}};
  const remote=vi.fn(async(path:string,_method?:string,body?:any)=>path==='/v1/voices'?{voices:[{id,name:'男声'}],default_voice_id:id}:body??{ready:true});
  const control=new VoiceChatControl(()=>config,settings,remote,()=>active,()=>false);
  return {control,remote,settings,config,setActive:(n:number)=>active=n};
}
describe('chat controls share native settings',()=>{
  it('redacts credentials and connection metadata without opening SSH',()=>{const f=fixture();const result=JSON.stringify(f.control.snapshot());expect(result).not.toContain('secret-must-not-leak');expect(result).not.toContain('private-host');expect(f.remote).not.toHaveBeenCalled();});
  it('merges only requested fields, reads back, and confirms remote idle policy',async()=>{const f=fixture();const r=await f.control.update({idleMinutes:5,personaEnabled:true},1);expect(r.saved).toBe(true);expect(r.server_sync).toEqual({ok:true,idle_seconds:300});expect(f.config.personaName).toBe('原有角色');expect(f.config.apiKey).toBe('secret-must-not-leak');expect(r.revision).toBe(2);});
  it('rejects a stale revision instead of overwriting concurrent edits',async()=>{const f=fixture();await f.control.update({personaName:'新角色'},1);await expect(f.control.update({personaName:'覆盖'},1)).rejects.toThrow('revision');expect(f.config.personaName).toBe('新角色');});
  it.each([{apiKey:'replace'},{sshHost:'other'},{voiceId:id},{silenceMs:399},{idleMinutes:1.5},{bargeIn:'false'},{asrEngine:'other'},{personaPrompt:'x'.repeat(6001)}])('rejects invalid or out-of-scope patch %j',async patch=>{const f=fixture();await expect(f.control.update(patch,1)).rejects.toThrow();expect(f.control.snapshot().revision).toBe(1);});
  it('returns partial success when server sync fails and retry uses latest stored value',async()=>{const f=fixture();f.remote.mockRejectedValueOnce(Error('private backend trace'));const r=await f.control.update({idleMinutes:3},1);expect(r.saved).toBe(true);expect(r.server_sync).toMatchObject({ok:false});expect(JSON.stringify(r)).not.toContain('private backend trace');expect(await f.control.service('sync_idle')).toEqual({ok:true,idle_seconds:180});});
  it('does not claim applied when remote response disagrees',async()=>{const f=fixture();f.remote.mockResolvedValueOnce({idle_seconds:600} as any);expect((await f.control.update({idleMinutes:5},1)).server_sync).toMatchObject({ok:false});});
  it('reconciles a concurrent sidebar change during idle sync',async()=>{const f=fixture();f.remote.mockImplementationOnce(async(_p,_m,body)=>{f.config.idleMinutes=7;return body;});const r=await f.control.update({idleMinutes:5},1);expect(r.server_sync).toEqual({ok:true,idle_seconds:420});});
  it('serializes writes and preserves revision checking',async()=>{const f=fixture();const results=await Promise.allSettled([f.control.update({idleMinutes:5},1),f.control.update({personaName:'overwrite'},1)]);expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);});
  it('reports microphone changes as next-call only',async()=>{const f=fixture();const r=await f.control.update({silenceMs:2000,bargeIn:false},1);expect(r.effect.silenceMs).toBe('下次开始语音通话');});
  it('blocks active-call ASR switching and release, and unprepared native ASR',async()=>{const f=fixture();f.setActive(1);await expect(f.control.update({asrEngine:'dsh'},1)).rejects.toThrow('结束');await expect(f.control.service('release')).rejects.toThrow('结束');f.setActive(0);await expect(f.control.update({asrEngine:'dsh'},1)).rejects.toThrow('尚未就绪');expect(f.remote).not.toHaveBeenCalled();});
  it('selects an existing fixed voice without synthesis or changing server default',async()=>{const f=fixture();const r=await f.control.voices({action:'select',voice_id:id,revision:1});expect(r.saved).toBe(true);expect(f.config.voiceId).toBe(id);expect(f.remote).toHaveBeenCalledExactlyOnceWith('/v1/voices','GET',undefined,undefined);});
  it('rechecks revision after fetching voice list',async()=>{const f=fixture();f.remote.mockImplementationOnce(async()=>{await f.settings.mutate('breeze-voice',[{op:'set',path:['personaName'],value:'并发修改'}],1);return {voices:[{id}]} as any;});await expect(f.control.voices({action:'select',voice_id:id,revision:1})).rejects.toThrow('revision');expect(f.config.voiceId).toBeUndefined();});
  it('rejects missing voice IDs and never retries an uncertain creation',async()=>{const f=fixture();await expect(f.control.voices({action:'select',voice_id:'a'.repeat(32),revision:1})).rejects.toThrow('不存在');f.remote.mockRejectedValueOnce(Error('timeout'));await expect(f.control.voices({action:'create',name:'低沉男声',instruction:'温和低沉'})).rejects.toThrow('不要自动重复');expect(f.remote).toHaveBeenCalledTimes(2);});
  it('cancellation before mutation preserves config',async()=>{const f=fixture();await expect(f.control.update({personaName:'覆盖'},1,AbortSignal.abort())).rejects.toThrow();expect(f.config.personaName).toBe('原有角色');});
  it('native defineTool rejects unknown patch keys and invalid action types',async()=>{const f=fixture();const [tool]=voiceToolDefinitions(f.control);const exec={signal:new AbortController().signal} as any;await expect(tool!.execute({action:'update',patch:{apiKey:'x'},revision:1},exec)).rejects.toThrow();await expect(tool!.execute({action:'typo'},exec)).rejects.toThrow();expect(JSON.parse((await tool!.execute({action:'get'},exec) as any).result).revision).toBe(1);});
  it('remote adapter authenticates, cancels fetch, and releases its tunnel lease',async()=>{
    const server=createServer((req,res)=>{expect(req.headers.authorization).toBe('Bearer local-secret');res.writeHead(200,{'content-type':'application/json'});res.write('{');});
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));let released=false;
    const call=remoteControl(()=>({localPort:(server.address() as any).port,apiKey:'local-secret'}),{acquire:async()=>()=>{released=true;}});
    const abort=new AbortController();const promise=call('/health','GET',undefined,abort.signal);setTimeout(()=>abort.abort(),30);
    try{await expect(promise).rejects.toThrow();expect(released).toBe(true);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  });
});
