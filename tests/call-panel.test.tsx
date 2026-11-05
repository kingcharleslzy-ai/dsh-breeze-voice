import {describe,it,expect,vi} from 'vitest';
import React from 'react';
import renderer,{act} from 'react-test-renderer';
const controllers:any[]=[];
vi.mock('../src/client/controller.js',()=>({VoiceController:class{
 state={active:false,phase:'语音对话',transcript:'',error:'',level:0,cold:false};
 constructor(_binding:unknown,_conversation:unknown,readonly changed:(s:unknown)=>void){controllers.push(this);}
 patch(p:object){this.state={...this.state,...p};this.changed(this.state);}
 start=vi.fn(async()=>this.patch({active:true,ready:true,phase:'正在听',startedAt:Date.now(),promptActive:true,personaName:'英语老师'}));
 stop=vi.fn(async()=>this.patch({active:false,ready:false,phase:'语音对话'}));
 setMuted=vi.fn((muted:boolean)=>this.patch({muted,phase:muted?'麦克风已静音':'正在听'}));
 stopReply=vi.fn();finishUtterance=vi.fn();setReviewText=vi.fn();sendReviewed=vi.fn();discardReview=vi.fn();
}}));
import {VoiceSessionView} from '../src/client/voice-session.js';
import {VoiceCallButton,VoiceCallPanel} from '../src/client/call-panel.js';
const button=(root:any,label:string)=>root.findAllByType('button').find((node:any)=>node.props['aria-label']===label);
describe('shared native composer voice view',()=>{
 it('opens inline, minimizes without ending, mutes, expands, and ends the same controller',async()=>{
  const disposed=vi.fn(),view=new VoiceSessionView({} as any,{} as any,disposed);let tree:any;
  await act(async()=>{tree=renderer.create(<><VoiceCallButton view={view}/><VoiceCallPanel view={view}/></>);});
  expect(tree.root.findAllByProps({role:'region'})).toHaveLength(0);
  await act(async()=>button(tree.root,'开始语音对话').props.onClick());
  expect(tree.root.findAllByProps({'aria-label':'语音通话面板'})).toHaveLength(1);
  expect(JSON.stringify(tree.toJSON())).toContain('英语老师');
  const c=controllers.at(-1);await act(async()=>button(tree.root,'收起语音通话面板').props.onClick());expect(c.stop).not.toHaveBeenCalled();expect(JSON.stringify(tree.toJSON())).toContain('通话仍在继续');
  await act(async()=>button(tree.root,'静音麦克风').props.onClick());expect(c.setMuted).toHaveBeenCalledWith(true);
  await act(async()=>button(tree.root,'展开语音通话面板').props.onClick());expect(button(tree.root,'取消麦克风静音')).toBeDefined();
  await act(async()=>button(tree.root,'结束语音对话').props.onClick());expect(c.stop).toHaveBeenCalledTimes(1);expect(tree.root.findAllByProps({role:'region'})).toHaveLength(0);
  await act(async()=>tree.unmount());expect(disposed).toHaveBeenCalledTimes(1);
 });
 it('keeps the call while one slot remounts, disposes when the conversation leaves',async()=>{
  const disposed=vi.fn(),view=new VoiceSessionView({} as any,{} as any,disposed);const releaseButton=view.retain(),releasePanel=view.retain();await view.start();const c=controllers.at(-1);
  releaseButton();await Promise.resolve();expect(c.stop).not.toHaveBeenCalled();const releaseAgain=view.retain();releasePanel();await Promise.resolve();expect(c.stop).not.toHaveBeenCalled();releaseAgain();await Promise.resolve();expect(c.stop).toHaveBeenCalledTimes(1);expect(disposed).toHaveBeenCalledTimes(1);
 });
 it('unmount/remount in the same tick does not revoke a live call',async()=>{
  const view=new VoiceSessionView({} as any,{} as any,()=>{});const release=view.retain();await view.start();const c=controllers.at(-1);release();const next=view.retain();await Promise.resolve();expect(c.stop).not.toHaveBeenCalled();next();await Promise.resolve();expect(c.stop).toHaveBeenCalledTimes(1);
 });
});
