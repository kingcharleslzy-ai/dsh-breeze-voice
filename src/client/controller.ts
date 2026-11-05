import type { EffectiveConfig } from '../config.js';
import { Microphone, PcmDecoder, PcmPlayer } from './audio.js';
import { ReplyFeed, type Conversation, type SessionBinding } from './feed.js';
export const API='/api/breeze-voice';
export interface VoiceState {active:boolean; phase:string; transcript:string; error:string; level:number; cold:boolean;reviewText?:string;ready?:boolean;muted?:boolean;replyText?:string;personaName?:string;promptActive?:boolean;startedAt?:number;}
export async function responseOrThrow(response:Response) {
  if (!response.ok) {
    let message=`语音请求失败 (${response.status})`;
    try { const data=await response.json(); message=data.error?.message ?? data.error ?? data.detail ?? message; } catch {}
    throw Error(String(message));
  }
  return response;
}
export class VoiceController {
  state:VoiceState={active:false,phase:'语音对话',transcript:'',error:'',level:0,cold:false};
  private context?:AudioContext;
  private mic?:Microphone;
  private player?:PcmPlayer;
  private settings?:EffectiveConfig;
  private generation=0;
  private speechAbort?:AbortController;
  private listenAbort?:AbortController;
  private lifetime?:AbortController;
  private queue:string[]=[];
  private speaking=false;
  private transcribing=false;
  private uttering=false;
  private ownTurn=false;
  private awaiting=false;
  private canceled:Promise<void>=Promise.resolve();
  private unsubscribe?:()=>void;
  private sessionUnsubscribe?:()=>void;
  private lastLevelAt=0;
  private leaseId?:string;
  private leaseTimer?:ReturnType<typeof setInterval>;
  private leaseCheck=false;
  readonly feed:ReplyFeed;
  constructor(private binding:SessionBinding, private conversation:Conversation, private changed:(state:VoiceState)=>void) {
    this.feed=new ReplyFeed(text=>{ this.queue.push(text); void this.pump(); },()=>{
      this.awaiting=false; this.ownTurn=false; this.refreshPhase();
    });
  }
  private patch(values:Partial<VoiceState>) { this.state={...this.state,...values}; this.changed(this.state); }
  async start() {
    if(this.state.active) return;
    if(this.binding.session.getSnapshot().running) throw Error('当前 DSH 任务仍在运行，请等它结束后开启语音对话');
    this.patch({active:true,phase:'正在连接语音服务…',error:'',transcript:'',reviewText:undefined,ready:false,muted:false,replyText:'',personaName:undefined,promptActive:false,startedAt:undefined});
    const gen=++this.generation;
    this.lifetime=new AbortController();
    // Create/resume audio inside the click gesture before network awaits.
    try {
      this.context=new AudioContext();
      await this.context.resume();
      this.player=new PcmPlayer(this.context);
      const [configResponse, healthResponse]=await Promise.all([
        fetch(`${API}/config`,{signal:this.lifetime.signal}).then(responseOrThrow),
        fetch(`${API}/health`,{signal:AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(25000)])}).then(responseOrThrow),
      ]);
      this.settings=await configResponse.json();
      const health=await healthResponse.json();
      if(gen!==this.generation || !this.state.active)return;
      if(this.settings!.asrEngine==='dsh'){
        const native=await fetch(`${API}/native-asr`,{signal:AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(10000)])}).then(responseOrThrow).then(r=>r.json());
        if(!native.ready)throw Error(native.message??'DSH 原生识别尚未准备好，请在原生语音输入设置完成准备');
        if(gen!==this.generation||!this.state.active)return;
      }
      await fetch(`${API}/service-settings`,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(25000)])}).then(responseOrThrow);
      if(gen!==this.generation||!this.state.active)return;
      const cold=this.settings!.asrEngine==='dsh'?health.tts!=='ready':health.ready===false;
      this.patch({cold});
      if(cold){
        this.patch({phase:'首次加载语音模型…'});
        await fetch(`${API}/warmup`,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(180000)])}).then(responseOrThrow);
        if(gen!==this.generation||!this.state.active)return;
        this.patch({cold:false});
      }
      this.feed.reset(this.binding.eventSource.getSnapshot().entries);
      this.unsubscribe=this.binding.eventSource.subscribe(()=>{
        if(this.state.active&&this.ownTurn) this.feed.accept(this.binding.eventSource.getSnapshot());
      });
      this.sessionUnsubscribe=this.binding.session.subscribe(()=>{
        if(this.binding.session.getSnapshot().removed) void this.stop();
      });
      this.mic=new Microphone(this.context!,{
        silenceMs:this.settings!.silenceMs,threshold:this.settings!.vadThreshold,
        canListen:()=>this.state.active&&!this.state.muted&&Boolean(this.leaseId)&&this.state.reviewText===undefined&&!this.transcribing&&(this.settings!.bargeIn||(!this.speaking&&!this.awaiting)),
        isPlayback:()=>Boolean(this.player&&this.player.pendingSeconds>.03),
        error:error=>{void this.stop().then(()=>this.patch({error:`本机语音检测失败：${error.message}`}));},
        speechStart:()=>this.interrupt(),utterance:wav=>{void this.transcribe(wav);},
        level:level=>{ if(performance.now()-this.lastLevelAt>80){this.lastLevelAt=performance.now();this.patch({level});} },
      });
      this.patch({phase:'请允许麦克风访问…'});
      await this.mic.start();
      if(gen!==this.generation||!this.state.active)return;
      const lease=await this.sessionAction('start');
      if(typeof lease.leaseId!=='string')throw Error('DSH 语音会话接口没有返回连接标识');
      if(gen!==this.generation||!this.state.active){await this.releaseLease(lease.leaseId);return;}
      this.leaseId=lease.leaseId;
      this.leaseTimer=setInterval(()=>{void this.keepLease();},25000);
      this.patch({phase:'正在听',ready:true,startedAt:Date.now(),personaName:lease.personaActive?lease.personaName:undefined,promptActive:Boolean(lease.voicePromptActive)});
    } catch(e) {
      if(gen===this.generation){await this.stop();this.patch({error:e instanceof Error&&e.name==='NotAllowedError'?'麦克风访问被拒绝，请在系统和 DSH 权限中允许麦克风后重试。':e instanceof Error?e.message:'无法启动语音'});}
    }
  }
  private async sessionAction(action:'start'|'keepalive'|'stop',leaseId=this.leaseId){
    const response=await fetch(`${API}/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,sessionId:this.binding.sessionId,...(leaseId?{leaseId}:{})}),signal:AbortSignal.timeout(15000),keepalive:action==='stop'}).then(responseOrThrow);
    return response.json();
  }
  private async releaseLease(leaseId:string){await this.sessionAction('stop',leaseId).catch(()=>{});}
  private async keepLease(){
    if(this.leaseCheck||!this.leaseId||!this.state.active)return;
    this.leaseCheck=true;const leaseId=this.leaseId;
    try{const lease=await this.sessionAction('keepalive',leaseId);if(this.leaseId===leaseId)this.patch({personaName:lease.personaActive?lease.personaName:undefined,promptActive:Boolean(lease.voicePromptActive)});}catch(e){if(this.leaseId===leaseId){await this.stop();this.patch({error:`语音连接已中断：${e instanceof Error?e.message:String(e)}`});}}finally{this.leaseCheck=false;}
  }
  interrupt() {
    if(!this.state.active)return;
    this.generation++; this.uttering=true;
    this.speechAbort?.abort(); this.listenAbort?.abort(); this.player?.stop(); this.queue=[];
    this.awaiting=false; this.speaking=false; this.transcribing=false;
    if(this.ownTurn&&this.binding.session.getSnapshot().running) {
      this.canceled=this.conversation.cancel().catch(e=>{this.patch({error:`停止上次回答失败：${e.message}`});throw e;});
      // Observe now; transcribe awaits the same cancellation before submitting again.
      void this.canceled.catch(()=>{});
    }
    this.ownTurn=false;
    this.feed.reset(this.binding.eventSource.getSnapshot().entries);
    this.patch({phase:'正在听你说',error:''});
  }
  setMuted(muted:boolean){
    if(!this.state.active||!this.state.ready)return;
    this.mic?.setMuted(muted);this.uttering=false;this.patch({muted,level:0});this.refreshPhase();
  }
  finishUtterance(){if(!this.state.muted)this.mic?.flush();}
  stopReply(){this.interrupt();this.uttering=false;this.refreshPhase();}
  private async transcribe(wav:Blob) {
    if(!this.state.active)return;
    const gen=this.generation;this.uttering=false;this.transcribing=true;
    this.listenAbort=new AbortController();this.patch({phase:'正在识别…'});
    try {
      const body=new FormData();body.append('file',wav,'utterance.wav');
      const response=await fetch(`${API}/transcriptions`,{method:'POST',body,signal:AbortSignal.any([this.listenAbort.signal,AbortSignal.timeout(90000)])}).then(responseOrThrow);
      const data=await response.json();
      if(gen!==this.generation||!this.state.active)return;
      const text=typeof data.text==='string'?data.text.trim():'';
      if(!text){this.patch({phase:'没听清，请再说一次'});return;}
      this.patch({transcript:text});
      if(this.settings?.reviewBeforeSend){this.patch({reviewText:text,phase:'确认识别内容后发送'});return;}
      await this.submitText(text,gen);
    }catch(e){
      if(gen===this.generation&&this.state.active){this.ownTurn=false;this.awaiting=false;this.patch({error:e instanceof Error?e.message:'语音识别失败'});}
    }finally{if(gen===this.generation){this.transcribing=false;this.refreshPhase();}}
  }
  setReviewText(text:string){if(this.state.reviewText!==undefined)this.patch({reviewText:text});}
  discardReview(){this.patch({reviewText:undefined});this.refreshPhase();}
  async sendReviewed(){
    const text=this.state.reviewText?.trim();if(!text||!this.state.active||this.transcribing)return;
    const gen=this.generation;this.transcribing=true;
    try{await this.submitText(text,gen);if(gen===this.generation)this.patch({reviewText:undefined,transcript:text});}
    catch(e){if(gen===this.generation)this.patch({error:e instanceof Error?e.message:String(e)});}
    finally{if(gen===this.generation){this.transcribing=false;this.refreshPhase();}}
  }
  private async submitText(text:string,gen:number){
    await this.canceled;
    if(gen!==this.generation||!this.state.active)return;
    if(!this.leaseId)throw Error('语音连接已结束，请重新开始');
    await this.sessionAction('keepalive');
    if(gen!==this.generation||!this.state.active)return;
    this.patch({phase:'DSH 正在思考…',error:'',replyText:''});
    this.feed.reset(this.binding.eventSource.getSnapshot().entries);
    this.ownTurn=true;this.awaiting=true;
    try{await this.conversation.send(text);}catch(e){this.ownTurn=false;this.awaiting=false;throw e;}
  }
  private refreshPhase(){
    if(!this.state.active||this.uttering||this.transcribing)return;
    this.patch({phase:this.state.reviewText!==undefined?'确认识别内容后发送':this.speaking?'正在回答':this.awaiting?'DSH 正在思考…':this.state.muted?'麦克风已静音':'正在听'});
  }
  private async pump(){
    if(this.speaking||!this.state.active||!this.queue.length)return;
    this.speaking=true;const gen=this.generation;this.speechAbort=new AbortController();
    const signal=this.speechAbort.signal;
    this.patch({phase:this.state.cold?'首次加载语音模型…':'正在回答'});
    try{
      const healthResponse=await fetch(`${API}/health`,{signal:AbortSignal.any([signal,AbortSignal.timeout(25000)])}).then(responseOrThrow);
      const health=await healthResponse.json();
      if(signal.aborted||gen!==this.generation)return;
      this.patch({cold:health.tts==='unloaded'||health.tts==='loading',phase:health.tts==='unloaded'||health.tts==='loading'?'正在重新加载语音模型…':'正在回答'});
      while(this.queue.length&&this.state.active&&!signal.aborted&&gen===this.generation){
        const input=this.queue.shift()!;
        this.patch({replyText:input});
        const response=await fetch(`${API}/speech`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input}),signal:AbortSignal.any([signal,AbortSignal.timeout(180000)])}).then(responseOrThrow);
        if(!response.body)throw Error('语音服务没有返回音频流');
        const sampleRate=Number(response.headers.get('x-sample-rate')??24000);
        if(!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>96000)throw Error('语音采样率无效');
        const reader=response.body.getReader(),decoder=new PcmDecoder();
        try{
          while(true){
            const {value,done}=await reader.read();if(done)break;
            if(signal.aborted||gen!==this.generation){await reader.cancel();break;}
            this.patch({cold:false,phase:'正在回答'});
            this.player!.push(decoder.push(value),sampleRate);
            while(this.player!.pendingSeconds>2.0&&!signal.aborted)await new Promise(r=>setTimeout(r,50));
          }
          if(!signal.aborted)decoder.finish();
        }finally{reader.releaseLock();}
      }
      while(this.player!.pendingSeconds>0.03&&!signal.aborted&&gen===this.generation)await new Promise(r=>setTimeout(r,50));
    }catch(e){if(!signal.aborted&&gen===this.generation){this.queue=[];this.player?.stop();this.patch({error:e instanceof Error?e.message:'播放失败'});}}
    finally{if(gen===this.generation){this.speaking=false;this.refreshPhase();if(this.queue.length)void this.pump();}}
  }
  async stop(){
    this.generation++;this.lifetime?.abort();this.listenAbort?.abort();this.speechAbort?.abort();
    this.mic?.stop();this.player?.stop();this.queue=[];this.unsubscribe?.();this.sessionUnsubscribe?.();
    clearInterval(this.leaseTimer);this.leaseTimer=undefined;const leaseId=this.leaseId;this.leaseId=undefined;
    await this.context?.close().catch(()=>{});
    this.context=undefined;this.mic=undefined;this.player=undefined;
    this.speaking=false;this.transcribing=false;this.ownTurn=false;this.awaiting=false;this.uttering=false;
    this.patch({active:false,phase:'语音对话',level:0,reviewText:undefined,ready:false,muted:false,promptActive:false,personaName:undefined,startedAt:undefined});
    if(leaseId)await this.releaseLease(leaseId);
  }
}
