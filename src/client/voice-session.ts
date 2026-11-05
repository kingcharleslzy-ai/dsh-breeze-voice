import {VoiceController,type VoiceState} from './controller.js';
import type {Conversation,SessionBinding} from './feed.js';
export interface CallView {voice:VoiceState;open:boolean;minimized:boolean;}
/** One controller shared by the native composer button and its inline dock. */
export class VoiceSessionView {
  private view:CallView={voice:{active:false,phase:'语音对话',transcript:'',error:'',level:0,cold:false},open:false,minimized:false};
  private listeners=new Set<()=>void>();
  private refs=0;
  private disposed=false;
  readonly controller?:VoiceController;
  constructor(binding:SessionBinding|undefined,conversation:Conversation|undefined,private onDispose:()=>void){
    if(binding&&conversation)this.controller=new VoiceController(binding,conversation,voice=>this.set({voice}));
  }
  snapshot=()=>this.view;
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private set(patch:Partial<CallView>){if(this.disposed)return;this.view={...this.view,...patch};this.listeners.forEach(fn=>fn());}
  retain(){this.refs++;return()=>{this.refs--;queueMicrotask(()=>{if(this.refs===0)this.dispose();});};}
  dispose(){if(this.disposed)return;this.disposed=true;void this.controller?.stop();this.listeners.clear();this.onDispose();}
  show(){this.set({open:true,minimized:false});}
  minimize(){this.set({minimized:true});}
  dismiss(){if(this.view.voice.active){this.minimize();return;}this.set({open:false});}
  async start(){
    this.show();
    if(!this.controller){this.set({voice:{...this.view.voice,error:'当前会话尚未就绪，请重新打开此会话'}});return;}
    try{await this.controller.start();}catch(e){this.set({voice:{...this.view.voice,error:e instanceof Error?e.message:String(e)}});}
  }
  async end(){await this.controller?.stop();this.set({open:false,minimized:false});}
}
