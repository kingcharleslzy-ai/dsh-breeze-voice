import type { Context } from '@deepseek-ai/cordis';
import {VoiceWorkbench,VoiceIcon,type Scope} from './workbench.js';
import type { Conversation, SessionBinding } from './feed.js';
import {VoiceSessionView} from './voice-session.js';
import {VoiceCallButton,VoiceCallPanel} from './call-panel.js';
export const inject=['slots','sessions','conversation','configForms'];
interface Sessions {binding(id:string):SessionBinding|undefined;scope(id:string):{get(name:string):unknown}|undefined;}
interface Slots {register(options:object,component:unknown):()=>void;inject(name:string,create:()=>()=>void):void;}
export function apply(ctx:Context){
  const slots=ctx.get('slots') as Slots,sessions=ctx.get('sessions') as unknown as Sessions;
  const views=new Map<string,VoiceSessionView>();
  const injectView=(sessionId:string)=>{
    let view=views.get(sessionId);
    if(!view){view=new VoiceSessionView(sessions.binding(sessionId),sessions.scope(sessionId)?.get('conversation') as Conversation|undefined,()=>{if(views.get(sessionId)===view)views.delete(sessionId);});views.set(sessionId,view);}
    return {view};
  };
  slots.inject('conversation.input.right',()=>slots.register({name:'conversation.input.right',id:'breeze-voice-microphone',order:20,inject:injectView},VoiceCallButton));
  slots.inject('conversation.input.dock',()=>slots.register({name:'conversation.input.dock',id:'breeze-voice-call',order:10,inject:injectView},VoiceCallPanel));
  ctx.effect(()=>()=>{for(const view of views.values())view.dispose();views.clear();},'breeze-voice call views');
  const forms=ctx.get('configForms') as {get(id:string):Scope};
  slots.inject('plugins.bundle.config',()=>slots.register({name:'plugins.bundle.config',key:'dsh-breeze-voice',inject:()=>({scope:forms.get('breeze-voice')})},VoiceSettings));
  slots.inject('main',()=>slots.register({name:'main',key:'breeze-voice',inject:()=>({scope:forms.get('breeze-voice')})},VoiceWorkbench));
  slots.inject('sidebar.panellist',()=>slots.register({name:'sidebar.panellist',id:'breeze-voice',order:11,label:'语音'},VoiceIcon));
}
export function VoiceSettings({scope}:{scope?:Scope}){return <VoiceWorkbench scope={scope} compact/>;}
