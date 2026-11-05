import {resolveConfig, type VoiceConfig} from './config.js';
import type {Tunnel} from './tunnel.js';

export interface VoiceSettings {
  describe(options:{redactSecrets:true}): {ns:string;revision:number;value?:Record<string,unknown>}[];
  mutate(ns:string,ops:{op:'set';path:string[];value:unknown}[],revision:number):Promise<void>;
}
export const editable = {
  instruction: 'string', asrEngine: 'string', asrHotwords: 'string', reviewBeforeSend: 'boolean',
  silenceMs: 'number', bargeIn: 'boolean', idleMinutes: 'number', voicePromptEnabled: 'boolean',
  voicePrompt: 'string', personaEnabled: 'boolean', personaName: 'string', personaPrompt: 'string',
} as const;
export type RemoteCall=(path:string,method?:string,body?:unknown,signal?:AbortSignal)=>Promise<any>;
export function remoteControl(current:()=>VoiceConfig,tunnel:Pick<Tunnel,'acquire'>):RemoteCall {
  return async(path,method='GET',body,signal)=>{
    signal?.throwIfAborted();
    const c=resolveConfig(current());
    const release=await tunnel.acquire(c);
    try {
      signal?.throwIfAborted();
      const response=await fetch(`http://127.0.0.1:${c.localPort}${path}`,{
        method,headers:{'content-type':'application/json',...(c.apiKey?{authorization:`Bearer ${c.apiKey}`}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
        signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(path==='/v1/voices'&&method==='POST'?180000:20000)]),
      });
      if(!response.ok) throw Error(response.status===409?'语音服务忙碌，请稍后重试':`语音服务请求失败（HTTP ${response.status}）`);
      return await response.json();
    } finally {release();}
  };
}
export class VoiceChatControl {
  private pending:Promise<unknown>=Promise.resolve();
  constructor(private current:()=>VoiceConfig,private settings:VoiceSettings,private remote:RemoteCall,private active:()=>number=()=>0,private nativeReady:()=>boolean=()=>false){}
  private descriptor(){const d=this.settings.describe({redactSecrets:true}).find(d=>d.ns==='breeze-voice');if(!d)throw Error('语音插件设置尚未就绪');return d;}
  snapshot(){
    const d=this.descriptor(),c=resolveConfig(this.current());
    return {revision:d.revision,settings:Object.fromEntries([...Object.keys(editable),'voiceId'].map(key=>[key,c[key as keyof typeof c]])),active_calls:this.active(),scope:'当前 DSH profile 的所有语音会话',restart_required:false};
  }
  private serial<T>(fn:()=>Promise<T>):Promise<T>{const next=this.pending.then(fn,fn);this.pending=next.catch(()=>{});return next;}
  private revision(value:unknown){if(!Number.isInteger(value)||value!==this.descriptor().revision)throw Error('设置已变更或缺少 revision，请先读取设置，再带回最新修订号');}
  private validate(patch:unknown):Record<string,unknown>{
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length)throw Error('patch 不能为空');
    for(const [key,value] of Object.entries(patch)){
      if(!Object.hasOwn(editable,key))throw Error(`不可通过设置工具修改 ${key}；固定音色请用音色工具选择`);
      if(typeof value!==editable[key as keyof typeof editable])throw Error(`${key} 类型无效`);
    }
    resolveConfig({...this.current(),...patch});
    if(Object.hasOwn(patch,'asrEngine')&&(patch as any).asrEngine!==resolveConfig(this.current()).asrEngine){
      if(this.active())throw Error('请先结束语音通话，再切换识别引擎');
      if((patch as any).asrEngine==='dsh'&&!this.nativeReady())throw Error('DSH 原生语音识别尚未就绪，请先在原生插件中准备模型');
    }
    return patch as Record<string,unknown>;
  }
  private async save(patch:Record<string,unknown>,revision:number,signal?:AbortSignal){
    signal?.throwIfAborted();this.revision(revision);
    await this.settings.mutate('breeze-voice',Object.entries(patch).map(([key,value])=>({op:'set' as const,path:[key],value})),revision);
    const result=this.snapshot();
    const readback=Object.entries(patch).every(([key,value])=>JSON.stringify(result.settings[key])===JSON.stringify(value));
    return {...result,saved:readback,changed_fields:Object.keys(patch),...(readback?{}:{warning:'写入后配置又发生变化，请核对回读值'})};
  }
  async update(patch:unknown,revision:number,signal?:AbortSignal){
    return this.serial(async()=>{
      this.revision(revision);const values=this.validate(patch);
      const saved=await this.save(values,revision,signal);
      let server_sync:unknown={required:false};
      if(saved.saved&&Object.hasOwn(values,'idleMinutes')){
        try{server_sync=await this.syncIdle(signal);}catch{server_sync={ok:false,error:'本机已保存，服务器同步未确认；请用 service sync_idle 重试，不要重复覆盖设置'};}
      }
      const latest=this.snapshot();
      const matches=Object.entries(values).every(([key,value])=>JSON.stringify(latest.settings[key])===JSON.stringify(value));
      return {...saved,...latest,saved:saved.saved&&matches,...(!matches?{warning:'保存后设置被再次修改，以当前回读值为准'}:{}),server_sync,effect:Object.fromEntries(Object.keys(values).map(key=>[key,
        ['silenceMs','bargeIn','reviewBeforeSend','asrEngine'].includes(key)?'下次开始语音通话':
        key==='instruction'?'仅新建/试听音色描述，不改变已固定音色':key==='idleMinutes'?'本机已保存；服务器以 server_sync 为准':'下一次相关识别或语音对话请求']))};
    });
  }
  private async syncIdle(signal?:AbortSignal){
    for(let n=0;n<3;n++){
      const seconds=resolveConfig(this.current()).idleMinutes*60;
      const applied=await this.remote('/v1/settings','PATCH',{idle_seconds:seconds},signal);
      if(applied.idle_seconds!==seconds)throw Error('服务器空闲策略回读不一致');
      if(resolveConfig(this.current()).idleMinutes*60===seconds)return {ok:true,idle_seconds:seconds};
    }
    throw Error('设置被连续修改，服务器同步未确认');
  }
  async voices(args:{action?:string;voice_id?:string;revision?:number;name?:string;instruction?:string},signal?:AbortSignal){
    const action=args.action??'list';
    if(action==='list'){
      const library=await this.remote('/v1/voices','GET',undefined,signal);
      return {...library,selected_voice_id:resolveConfig(this.current()).voiceId||library.default_voice_id,revision:this.descriptor().revision};
    }
    if(action==='select')return this.serial(async()=>{
      this.revision(args.revision);
      if(typeof args.voice_id!=='string'||!(/^[a-f0-9]{32}$/.test(args.voice_id)))throw Error('必须提供列表中真实的 voice_id');
      const library=await this.remote('/v1/voices','GET',undefined,signal);
      if(!Array.isArray(library.voices)||!library.voices.some((v:any)=>v.id===args.voice_id))throw Error('所选音色不存在，请重新读取列表');
      return {...await this.save({voiceId:args.voice_id},args.revision!,signal),effect:'下一段新合成的语音；已播放/正在播放的音频不变'};
    });
    if(action==='create'){
      if(typeof args.name!=='string'||!args.name.trim()||args.name.length>80||typeof args.instruction!=='string'||!args.instruction.trim()||args.instruction.length>1000)throw Error('新音色需要 1–80 字名称和 1–1000 字声音描述');
      // Never retry creation: a timeout can still have produced a saved reference.
      try{return {created:await this.remote('/v1/voices','POST',{name:args.name.trim(),instruction:args.instruction.trim()},signal),selected:false,note:'固定参考音色已创建；如需切换，请先 list 后 select'};}
      catch{throw Error('创建音色未确认。请先 list 检查是否已保存，不要自动重复创建');}
    }
    throw Error('音色 action 应为 list、select 或 create');
  }
  async service(action='status',signal?:AbortSignal){
    if(action==='status')return {server:await this.remote('/health','GET',undefined,signal),active_calls:this.active()};
    if(action==='sync_idle')return this.serial(()=>this.syncIdle(signal));
    if(action==='release'){
      if(this.active())throw Error('仍有语音通话，请先结束通话后释放模型');
      return {server:await this.remote('/v1/models/unload','POST',{},signal)};
    }
    throw Error('服务 action 应为 status、sync_idle 或 release');
  }
}
