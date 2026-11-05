import {useEffect,useState,useSyncExternalStore,type CSSProperties} from 'react';
import {VoiceSessionView} from './voice-session.js';
import {callStyle} from './call-style.js';
export function CallIcon({kind}:{kind:'mic'|'muted'|'end'|'stop'|'collapse'|'expand'|'close'}){
 return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind==='mic'||kind==='muted'?<><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>{kind==='muted'&&<path d="m3 3 18 18"/>}</>:kind==='end'?<path d="M3 14c5-5 13-5 18 0v4h-5v-4a16 16 0 0 0-8 0v4H3z"/>:kind==='stop'?<rect x="6" y="6" width="12" height="12" rx="2"/>:kind==='close'?<path d="m6 6 12 12M18 6 6 18"/>:kind==='expand'?<path d="m7 14 5-5 5 5"/>:<path d="m7 10 5 5 5-5"/>}</svg>;
}
export function useCall(view:VoiceSessionView){useEffect(()=>view.retain(),[view]);return useSyncExternalStore(view.subscribe,view.snapshot,view.snapshot);}
export function VoiceCallButton({view}:{view:VoiceSessionView}){
 const {voice,open,minimized}=useCall(view);
 return <button type="button" aria-label={voice.active?'展开语音对话':'开始语音对话'} aria-pressed={voice.active} onClick={()=>voice.active?view.show():void view.start()} title={voice.active?'展开当前通话':'开始连续语音对话'} style={{display:'inline-flex',alignItems:'center',gap:5,border:'1px solid var(--dsw-alias-border-l2,#ddd)',borderRadius:20,padding:'5px 10px',fontSize:12,color:'var(--dsw-alias-label-primary,#222)',background:'var(--dsw-specific-selector,#f2f3f5)',cursor:'pointer'}}><CallIcon kind={voice.muted?'muted':'mic'}/>{voice.active?(open&&!minimized?'通话中':'展开语音'):'语音'}</button>;
}
export function VoiceCallPanel({view}:{view:VoiceSessionView}){
 const {voice:s,open,minimized}=useCall(view);const [now,setNow]=useState(Date.now());
 useEffect(()=>{if(!s.active)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[s.active]);
 if(!open)return null;
 const seconds=s.startedAt?Math.max(0,Math.floor((now-s.startedAt)/1000)):0;
 const clock=`${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
 const mode=!s.active?'ended':!s.ready?'connecting':s.phase.includes('回答')?'speaking':s.phase.includes('思考')||s.phase.includes('识别')?'thinking':s.muted?'muted':'listening';
 const prompt=s.personaName?`角色：${s.personaName}`:s.promptActive?'语音提示词已启用':'使用当前会话设定';
 return <section className="bv-call" role="region" aria-label="语音通话面板" data-mode={mode}>
  <style>{callStyle}</style>
  {minimized&&s.active?<div className="bv-call-mini"><CallIcon kind={s.muted?'muted':'mic'}/><button className="bv-expand" onClick={()=>view.show()} aria-label="展开语音通话面板">{s.phase}<small>{clock} · 通话仍在继续{s.muted?' · 麦克风已静音':''}</small></button><button className="bv-icon-btn" onClick={()=>view.controller?.setMuted(!s.muted)} aria-label={s.muted?'取消麦克风静音':'静音麦克风'} aria-pressed={Boolean(s.muted)} disabled={!s.ready}><CallIcon kind={s.muted?'muted':'mic'}/></button><button className="bv-call-control bv-call-end" style={{width:34,height:34}} onClick={()=>void view.end()} aria-label="结束语音对话"><CallIcon kind="end"/></button></div>:<>
   <header className="bv-call-head"><span className="bv-call-dot"/><strong>语音对话</strong><small>{s.active?(s.ready?clock:'正在连接'):'未连接'}</small><button className="bv-icon-btn" aria-label={s.active?'收起语音通话面板':'关闭语音通话面板'} title={s.active?'收起面板，通话继续':'关闭面板'} onClick={()=>view.dismiss()}><CallIcon kind={s.active?'collapse':'close'}/></button></header>
   <div className="bv-call-stage">
    <div className="bv-call-wave" aria-hidden="true">{[34,52,74,86,74,52,34].map((h,i)=><i key={i} style={{'--h':`${h}px`,'--gain':String(.22+Math.min(1,s.level*10)*.78),'--delay':`${i*-.12}s`} as CSSProperties}/>)}</div>
    <p className="bv-call-status" role="status" aria-live="polite">{s.error&&!s.active?'连接未完成':s.phase}</p>
    <p className="bv-call-hint">{!s.active?'重新连接后即可继续当前聊天。':!s.ready?(s.cold?'首次加载模型需要稍等，准备好后开始收音。':'正在准备语音服务与麦克风。'):s.reviewText!==undefined?'确认或修改识别结果后发送。':s.muted?'麦克风已静音，不会收取新语音。':mode==='speaking'?'正在为你朗读回复。':mode==='thinking'?'稍等，正在处理你的这句话。':'自然地说，停顿后自动发送。'}</p>
    {s.reviewText!==undefined?<div className="bv-call-review"><label>识别内容<textarea aria-label="识别内容" value={s.reviewText} onChange={e=>view.controller?.setReviewText(e.target.value)}/></label><div style={{display:'flex',gap:8}}><button className="bv-call-text-btn" disabled={!s.reviewText.trim()} onClick={()=>void view.controller?.sendReviewed()}>确认发送</button><button className="bv-call-text-btn" onClick={()=>view.controller?.discardReview()}>丢弃重说</button></div></div>:(s.transcript||s.replyText)&&<div className="bv-call-caption" aria-label="本轮语音文字">{s.transcript&&<p><small>你说</small>{s.transcript}</p>}{s.replyText&&<p><small>{mode==='speaking'?'正在朗读':'回复'}</small>{s.replyText}</p>}</div>}
    {s.error&&<p className="bv-call-error" role="alert">{s.error}</p>}
   </div>
   {s.active?<div className="bv-call-controls">
    <div className="bv-call-control-wrap"><button className="bv-call-control" aria-label={s.muted?'取消麦克风静音':'静音麦克风'} aria-pressed={Boolean(s.muted)} disabled={!s.ready} onClick={()=>view.controller?.setMuted(!s.muted)}><CallIcon kind={s.muted?'muted':'mic'}/></button><span>{s.muted?'取消静音':'静音'}</span></div>
    <div className="bv-call-control-wrap"><button className="bv-call-control" aria-label="打断当前回答" disabled={!s.ready} onClick={()=>view.controller?.stopReply()}><CallIcon kind="stop"/></button><span>打断</span></div>
    <div className="bv-call-control-wrap"><button className="bv-call-control bv-call-end" aria-label="结束语音对话" onClick={()=>void view.end()}><CallIcon kind="end"/></button><span>结束</span></div>
   </div>:<div className="bv-call-controls"><button className="bv-call-text-btn" onClick={()=>void view.start()}>重新连接</button></div>}
   <footer className="bv-call-foot"><span>{s.active&&s.ready?prompt:'语音只连接当前聊天'}</span>{s.active&&s.ready&&<><span>语音提示词仅在通话期间生效</span><button disabled={s.muted||s.reviewText!==undefined} onClick={()=>view.controller?.finishUtterance()}>说完了，立即发送</button></>}</footer>
  </>}
 </section>;
}
