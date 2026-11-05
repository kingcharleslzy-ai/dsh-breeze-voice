import {PcmDecoder,PcmPlayer} from './audio.js';
import {API,responseOrThrow} from './controller.js';
/** Auditions the draft description without changing persisted voice settings. */
export class VoicePreview {
  private abort?:AbortController;
  private context?:AudioContext;
  private player?:PcmPlayer;
  async play(input:string,instruction:string,onPhase:(phase:string)=>void,voiceId?:string){
    await this.stop();
    const abort=new AbortController();this.abort=abort;
    const context=new AudioContext();this.context=context;
    const player=new PcmPlayer(context);this.player=player;
    try{
      await context.resume();onPhase('正在生成试听…');
      const response=await fetch(`${API}/preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input,instruction,...(voiceId?{voiceId}:{})}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(180000)])}).then(responseOrThrow);
      if(!response.body)throw Error('服务没有返回试听音频');
      const rate=Number(response.headers.get('x-sample-rate')??24000);
      if(!Number.isFinite(rate)||rate<8000||rate>96000)throw Error('试听采样率无效');
      const reader=response.body.getReader(),decoder=new PcmDecoder();
      try{while(true){const {value,done}=await reader.read();if(done)break;if(abort.signal.aborted){await reader.cancel();break;}onPhase('正在播放');player.push(decoder.push(value),rate);while(player.pendingSeconds>2&&!abort.signal.aborted)await new Promise(r=>setTimeout(r,40));}if(!abort.signal.aborted)decoder.finish();}finally{reader.releaseLock();}
      while(player.pendingSeconds>.03&&!abort.signal.aborted)await new Promise(r=>setTimeout(r,40));
      if(!abort.signal.aborted)onPhase('试听完成');
    }catch(e){if(!abort.signal.aborted)throw e;}finally{player.stop();await context.close().catch(()=>{});if(this.abort===abort){this.abort=undefined;this.context=undefined;this.player=undefined;}}
  }
  async stop(){this.abort?.abort();this.player?.stop();await this.context?.close().catch(()=>{});this.abort=undefined;this.context=undefined;this.player=undefined;}
}
