import {useEffect,useRef,useState} from 'react';
import type {VoiceConfig,VoiceProfile} from '../config.js';
import {DEFAULT_INSTRUCTION,DEFAULT_VOICE_PROMPT,VOICE_PRESETS,PERSONA_PRESETS} from '../voice-defaults.js';
import {API,responseOrThrow} from './controller.js';
import {VoicePreview} from './preview.js';
import {WORKBENCH_STYLE} from './workbench-style.js';
export interface Scope {
  getSnapshot():{value?:VoiceConfig;revision?:number;writable?:boolean};
  subscribe(fn:()=>void):()=>void;
  mutate(ops:{op:'set';path:string[];value:unknown}[],revision?:number):Promise<boolean>;
}
const defaults:Required<VoiceConfig>={sshHost:'',remotePort:8870,localPort:19889,apiKey:'',remoteTaskName:'',instruction:DEFAULT_INSTRUCTION,voiceId:'',asrHotwords:'',asrEngine:'server',reviewBeforeSend:false,silenceMs:1200,vadThreshold:.018,bargeIn:true,idleMinutes:10,activeVoiceId:'custom',voiceProfiles:[],voicePromptEnabled:true,voicePrompt:DEFAULT_VOICE_PROMPT,personaEnabled:false,personaName:'',personaPrompt:''};
interface Health {ready?:boolean;tts?:string;asr?:string;busy?:boolean;idle_seconds?:number;idle_remaining_seconds?:number|null;version?:string;}
interface ServerVoice {id:string;name:string;instruction:string;reference_text?:string;duration?:number;}
type Tab='voice'|'persona'|'interaction'|'connection';
const labels:{id:Tab;label:string;icon:string}[]=[{id:'voice',label:'音色',icon:'voice'},{id:'persona',label:'对话角色',icon:'person'},{id:'interaction',label:'交互与资源',icon:'sliders'},{id:'connection',label:'服务连接',icon:'server'}];
export function VoiceIcon({size=16}:{size?:number}){return <Icon name="voice" size={size}/>;}
function Icon({name,size=16}:{name:string;size?:number}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{name==='voice'?<><path d="M5 9v6m4-10v14m3-17v20m3-17v14m4-10v6"/></>:name==='person'?<><circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></>:name==='sliders'?<><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--bv-surface,#fff)"/><circle cx="16" cy="17" r="3" fill="var(--bv-surface,#fff)"/></>:name==='play'?<path d="m8 4 12 8-12 8Z"/>:name==='stop'?<rect x="5" y="5" width="14" height="14" rx="2"/>:name==='refresh'?<><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/></>:<><rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M13 6.5h4M13 17.5h4"/></>}</svg>;
}
function modelLabel(value?:string){return value==='ready'?'已加载':value==='loading'?'加载中':value==='failed'?'加载失败':value==='unloaded'?'未加载':'尚未检测';}
function minutesLabel(seconds?:number){return seconds===undefined?'尚未同步':seconds===0?'不自动卸载':`${seconds/60} 分钟`;}
export function validateDraft(value:Required<VoiceConfig>){
  if(!Number.isInteger(value.idleMinutes)||value.idleMinutes<0||value.idleMinutes>120)throw Error('空闲卸载时间请输入 0–120 分钟的整数');
  if(!Number.isFinite(value.silenceMs)||value.silenceMs<400||value.silenceMs>3000)throw Error('自动发送停顿请输入 400–3000 毫秒');
  if(!Number.isFinite(value.vadThreshold)||value.vadThreshold<.005||value.vadThreshold>.2)throw Error('音量阈值请输入 0.005–0.2');
  if(value.instruction.length>1000||value.voicePrompt.length>6000||value.personaPrompt.length>6000)throw Error('描述或提示词超过允许长度');
  if(value.voiceProfiles.length>40)throw Error('最多保存 40 个音色');
}
export function VoiceWorkbench({scope,compact=false}:{scope?:Scope;compact?:boolean}){
  const [tab,setTab]=useState<Tab>('voice');
  const [value,setValue]=useState<Required<VoiceConfig>>(()=>({...defaults,...scope?.getSnapshot().value}));
  const [dirty,setDirty]=useState<Record<string,unknown>>({});
  const dirtyRef=useRef(dirty);dirtyRef.current=dirty;
  const revision=useRef<number|undefined>();
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState(false);
  const [health,setHealth]=useState<Health>(),[checking,setChecking]=useState(false),[connectionError,setConnectionError]=useState('');
  const [nativeAsr,setNativeAsr]=useState<{available:boolean;ready:boolean;phase:string;message:string}>(),[nativeChecking,setNativeChecking]=useState(false);
  const [serverVoices,setServerVoices]=useState<ServerVoice[]>([]),[serverDefault,setServerDefault]=useState(''),[voicesBusy,setVoicesBusy]=useState(false);
  const [voiceName,setVoiceName]=useState(''),[sample,setSample]=useState('你好，我在听。今天想一起完成什么？我们可以慢慢聊，也可以直接开始。');
  const [previewing,setPreviewing]=useState(false),[previewPhase,setPreviewPhase]=useState(''),[previewError,setPreviewError]=useState('');
  const preview=useRef(new VoicePreview());
  const previewGeneration=useRef(0);
  useEffect(()=>scope?.subscribe(()=>{const next=scope.getSnapshot();setValue(old=>({...defaults,...next.value,...Object.fromEntries(Object.keys(dirtyRef.current).map(k=>[k,old[k as keyof VoiceConfig]]))}));}),[scope]);
  useEffect(()=>()=>{previewGeneration.current++;void preview.current.stop();},[]);
  const change=(key:keyof VoiceConfig,v:unknown)=>{
    if(!Object.keys(dirtyRef.current).length)revision.current=scope?.getSnapshot().revision;
    setValue(s=>({...s,[key]:v}));setDirty(s=>({...s,[key]:v}));setNotice('');
  };
  const changes=(patch:Partial<VoiceConfig>)=>{
    if(!Object.keys(dirtyRef.current).length)revision.current=scope?.getSnapshot().revision;
    setValue(s=>({...s,...patch}));setDirty(s=>({...s,...patch}));setNotice('');
  };
  async function healthCheck(){
    setChecking(true);setConnectionError('');
    try{const response=await fetch(`${API}/health`,{signal:AbortSignal.timeout(30000)}).then(responseOrThrow);const result:Health=await response.json();setHealth(result);return result;}
    catch(e){setConnectionError(e instanceof Error?e.message:String(e));return undefined;}finally{setChecking(false);}
  }
  async function syncService(){const response=await fetch(`${API}/service-settings`,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(30000)}).then(responseOrThrow);return response.json() as Promise<{idle_seconds?:number}>;}
  async function save(){
    setBusy(true);setNotice('');setError(false);let localSaved=false;
    try{
      if(!scope)throw Error('DSH 配置服务尚未就绪，请重新打开语音页面');
      validateDraft(value);
      const updates=Object.entries(dirty);
      if(updates.length){const ok=await scope.mutate(updates.map(([key,v])=>({op:'set',path:[key],value:v})),revision.current);if(!ok)throw Error('设置已被其他窗口修改，请重新打开页面核对后保存');}
      localSaved=true;setDirty({});revision.current=undefined;setValue({...defaults,...scope.getSnapshot().value});
      const synced=await syncService();setHealth(old=>old?{...old,...synced}:old);
      setNotice('已保存，服务器空闲设置已同步。音色与角色从下一次回复生效；麦克风参数在下次开启语音时生效。');
    }catch(e){setError(true);setNotice(`${localSaved?'本机已保存，服务器同步失败：':''}${e instanceof Error?e.message:String(e)}`);}finally{setBusy(false);}
  }
  async function audition(){
    if(previewing){previewGeneration.current++;await preview.current.stop();setPreviewing(false);setPreviewPhase('已停止');return;}
    if(!sample.trim()||sample.length>140){setPreviewError('试听文字请输入 1–140 字');return;}
    const generation=++previewGeneration.current;setPreviewing(true);setPreviewError('');
    try{
      let voiceId=value.voiceId||serverDefault;
      if(!voiceId){setPreviewPhase('正在读取默认音色…');const r=await fetch(`${API}/voices`,{signal:AbortSignal.timeout(30000)}).then(responseOrThrow);const data=await r.json();setServerVoices(data.voices??[]);setServerDefault(data.default_voice_id??'');voiceId=data.default_voice_id??'';}
      if(generation!==previewGeneration.current)return;
      if(!voiceId)throw Error('服务器还没有固定音色，请先生成并保存一个声音。');
      await preview.current.play(sample.trim(),value.instruction.trim(),phase=>{if(generation===previewGeneration.current)setPreviewPhase(phase);},voiceId);
    }
    catch(e){if(generation===previewGeneration.current)setPreviewError(e instanceof Error?e.message:String(e));}
    finally{if(generation===previewGeneration.current)setPreviewing(false);}
  }
  async function checkNativeAsr(){
    setNativeChecking(true);
    try{const r=await fetch(`${API}/native-asr`,{signal:AbortSignal.timeout(10000)}).then(responseOrThrow);setNativeAsr(await r.json());}
    catch(e){setNativeAsr({available:false,ready:false,phase:'error',message:e instanceof Error?e.message:String(e)});}finally{setNativeChecking(false);}
  }
  async function loadVoices(){
    setVoicesBusy(true);setNotice('');setError(false);
    try{const r=await fetch(`${API}/voices`,{signal:AbortSignal.timeout(30000)}).then(responseOrThrow);const data=await r.json();if(!Array.isArray(data.voices))throw Error('服务器没有返回音色列表');setServerVoices(data.voices);setServerDefault(data.default_voice_id??'');}
    catch(e){setError(true);setNotice(e instanceof Error?e.message:String(e));}finally{setVoicesBusy(false);}
  }
  async function createFixedVoice(){
    if(!voiceName.trim()||!value.instruction.trim()){setNotice('请先填写音色描述与名称');setError(true);return;}
    setVoicesBusy(true);setNotice('正在生成固定音色参考片段，首次可能需要加载模型…');setError(false);
    try{const r=await fetch(`${API}/voices`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:voiceName.trim(),instruction:value.instruction.trim()}),signal:AbortSignal.timeout(180000)}).then(responseOrThrow);const data=await r.json();const voice:ServerVoice=data.voice??data;if(!voice.id)throw Error('服务器没有返回新音色标识');setServerVoices(old=>[...old.filter(v=>v.id!==voice.id),voice]);change('voiceId',voice.id);setNotice('固定音色已在服务器生成。可先试听，点击「保存设置」后用于会话。');}
    catch(e){setError(true);setNotice(e instanceof Error?e.message:String(e));}finally{setVoicesBusy(false);}
  }
  function saveVoice(update=false){
    const name=voiceName.trim();if(!name||name.length>80){setNotice('请填写 1–80 字的音色名称');setError(true);return;}
    if(!value.instruction.trim()){setNotice('请先填写音色描述');setError(true);return;}
    const id=update?value.activeVoiceId:`voice_${crypto.randomUUID().replaceAll('-','')}`;
    const voice:VoiceProfile={id,name,instruction:value.instruction.trim()};
    const profiles=update?value.voiceProfiles.map(v=>v.id===id?voice:v):[...value.voiceProfiles,voice];
    if(profiles.length>40){setNotice('最多保存 40 个音色');setError(true);return;}
    changes({voiceProfiles:profiles,activeVoiceId:id});setNotice('描述已加入草稿，点击「保存设置」后保留。');setError(false);
  }
  function selectVoice(voice:{id:string;name:string;instruction:string}){changes({activeVoiceId:voice.id,instruction:voice.instruction});setVoiceName(value.voiceProfiles.some(v=>v.id===voice.id)?voice.name:'');}
  async function release(){
    setChecking(true);setNotice('');setError(false);
    try{await fetch(`${API}/release`,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(30000)}).then(responseOrThrow);setHealth(old=>({...old,ready:false,tts:'unloaded',asr:'unloaded',busy:false,idle_remaining_seconds:null}));setNotice('语音模型已卸载并释放显存，下次使用会重新加载。');}
    catch(e){setError(true);setNotice(e instanceof Error?e.message:String(e));}finally{setChecking(false);}
  }
  const selectedName=serverVoices.find(v=>v.id===(value.voiceId||serverDefault))?.name??[...VOICE_PRESETS,...value.voiceProfiles].find(v=>v.id===value.activeVoiceId)?.name??(value.voiceId?'已选固定音色':'服务器默认音色');
  const savedSelected=value.voiceProfiles.some(v=>v.id===value.activeVoiceId);
  const effectivePrompt=[value.voicePromptEnabled&&value.voicePrompt.trim()?`【语音交流方式】\n${value.voicePrompt.trim()}`:'',value.personaEnabled&&value.personaPrompt.trim()?`【对话角色${value.personaName?`：${value.personaName}`:''}】\n${value.personaPrompt.trim()}`:''].filter(Boolean).join('\n\n');
  const VoiceCard=(voice:{id:string;name:string;instruction:string;tag?:string})=><button type="button" key={voice.id} className="bv-voice-card" role="radio" aria-checked={value.activeVoiceId===voice.id} onClick={()=>selectVoice(voice)}><span className="bv-voice-name">{voice.name}</span><span className="bv-voice-tag">{voice.tag??'描述草稿'}</span></button>;
  return <div className={`bv-page${compact?' bv-compact':''}`}><style>{WORKBENCH_STYLE}</style><div className="bv-inner">
    <header className="bv-header"><div><h1>语音</h1><p>设置音色、对话方式和语音服务。</p></div><div className="bv-save-group"><span className="bv-dirty">{Object.keys(dirty).length?'有未保存的更改':''}</span><button className="bv-button bv-button-primary" disabled={busy||!scope} onClick={()=>void save()}>{busy?'保存中…':'保存设置'}</button></div></header>
    <div className="bv-statusbar"><span className={`bv-statusdot${health?.busy?' busy':health?' ready':''}`}/><strong>{checking?'正在连接…':connectionError?'连接失败':health?health.busy?'语音服务使用中':health.ready?'语音服务已就绪':'服务已连接，模型按需加载':'私有语音服务'}</strong><span className="bv-muted">{health?`TTS ${modelLabel(health.tts)} · 识别 ${modelLabel(health.asr)}`:'尚未检测，不会自动加载模型'}</span><button className="bv-button" aria-label="检测语音服务连接" disabled={checking} onClick={()=>void healthCheck()}><Icon name="refresh"/>{health?'刷新':'检测连接'}</button></div>
    {connectionError&&<div role="alert" className="bv-notice error">{connectionError}</div>}
    <nav className="bv-tabs" role="tablist" aria-label="语音设置分类">{labels.map(t=><button className="bv-tab" type="button" role="tab" id={`bv-tab-${t.id}`} aria-selected={tab===t.id} aria-controls={`bv-panel-${t.id}`} key={t.id} onClick={()=>setTab(t.id)}><Icon name={t.icon}/>{t.label}</button>)}</nav>
    {notice&&<div role={error?'alert':'status'} className={`bv-notice${error?' error':''}`}>{notice}</div>}
    <section role="tabpanel" id={`bv-panel-${tab}`} aria-labelledby={`bv-tab-${tab}`}>
    {tab==='voice'&&<>
      <section className="bv-card">
        <div className="bv-section-head"><div><h2>会话音色</h2><p className="bv-muted">选定后保存，后续回复会使用同一个声音。</p></div><button className="bv-button" disabled={voicesBusy} onClick={()=>void loadVoices()}><Icon name="refresh"/>{voicesBusy?'读取中…':'刷新音色库'}</button></div>
        <div className="bv-form-body">
          <label className="bv-field">会话使用的固定音色<select value={value.voiceId} onChange={e=>change('voiceId',e.target.value)}>
            <option value="">服务器默认音色{serverVoices.find(v=>v.id===serverDefault)?.name?` · ${serverVoices.find(v=>v.id===serverDefault)!.name}`:''}</option>
            {value.voiceId&&!serverVoices.some(v=>v.id===value.voiceId)&&<option value={value.voiceId}>已配置的音色 · {value.voiceId}</option>}
            {serverVoices.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
          </select></label>
          <div className="bv-preview">
            <label className="bv-field">试听文字<textarea value={sample} maxLength={140} onChange={e=>setSample(e.target.value)}/><span className="bv-help">{sample.length} / 140 字 · 当前音色：{selectedName}</span></label>
            <div className="bv-preview-toolbar"><button className="bv-button" onClick={()=>void audition()}><Icon name={previewing?'stop':'play'}/>{previewing?'停止试听':'生成并试听'}</button><p className="bv-muted" role="status">{previewPhase||'首次试听需要等待模型加载。'}</p></div>
            {previewError&&<div role="alert" className="bv-notice error">{previewError}</div>}
          </div>
        </div>
      </section>
      <details className="bv-fold"><summary><span>创建音色<small>通过描述生成一个新声音，试听后再用于对话。</small></span></summary><div className="bv-fold-body">
        <div className="bv-voice-grid" role="radiogroup" aria-label="预设音色">{VOICE_PRESETS.map(VoiceCard)}</div>
        <div className="bv-form-body"><label className="bv-field">音色描述<textarea maxLength={1000} value={value.instruction} onChange={e=>changes({instruction:e.target.value,activeVoiceId:savedSelected?value.activeVoiceId:'custom'})}/><span className="bv-help">例如：温暖的成年男声，普通话清晰，语速舒缓。修改描述后需重新生成音色。</span></label>
        <label className="bv-field">新音色名称<input maxLength={80} value={voiceName} onChange={e=>setVoiceName(e.target.value)} placeholder="例如：我的日常搭档"/></label>
        <div className="bv-actions"><button className="bv-button bv-button-primary" disabled={voicesBusy} onClick={()=>void createFixedVoice()}>生成并保存固定音色</button><button className="bv-button" onClick={()=>saveVoice(false)}>保存描述草稿</button>{savedSelected&&<button className="bv-button" onClick={()=>saveVoice(true)}>更新描述草稿</button>}</div></div>
        {value.voiceProfiles.length>0&&<><div className="bv-divider"/><h3 className="bv-section-title">描述草稿</h3><div className="bv-voice-grid" role="radiogroup" aria-label="保存的描述">{value.voiceProfiles.map(VoiceCard)}</div>{savedSelected&&<button className="bv-button bv-button-danger" onClick={()=>changes({voiceProfiles:value.voiceProfiles.filter(v=>v.id!==value.activeVoiceId),activeVoiceId:'custom'})}>移除描述草稿</button>}</>}
      </div></details>
    </>}
    {tab==='persona'&&<div className="bv-grid"><div><section className="bv-card"><h2>语音模式默认提示词</h2><p className="bv-muted">决定回答如何组织，适合听而不是只适合读。</p><label className="bv-switchline"><input type="checkbox" checked={value.voicePromptEnabled} onChange={e=>change('voicePromptEnabled',e.target.checked)}/><span>使用语音交流提示词<small>仅在打开语音的聊天中生效；静音或收起面板仍算通话中。</small></span></label><label className="bv-field">默认提示词<textarea style={{minHeight:180}} maxLength={6000} value={value.voicePrompt} onChange={e=>change('voicePrompt',e.target.value)}/></label><button className="bv-button" style={{marginTop:12}} onClick={()=>change('voicePrompt',DEFAULT_VOICE_PROMPT)}>恢复默认提示词</button></section><section className="bv-card"><h2>对话角色</h2><p className="bv-muted">定义交流风格与关注重点。原有会话的工具和审批保持有效。</p><label className="bv-switchline"><input type="checkbox" checked={value.personaEnabled} onChange={e=>change('personaEnabled',e.target.checked)}/><span>启用语音角色<small>结束通话后停止添加角色提示词；已产生的聊天记录仍保留。</small></span></label><div className="bv-chiprow">{PERSONA_PRESETS.map(p=><button className="bv-chip" key={p.name} onClick={()=>changes({personaEnabled:true,personaName:p.name,personaPrompt:p.prompt})}>{p.name}</button>)}</div><label className="bv-field">角色名称<input maxLength={80} value={value.personaName} onChange={e=>change('personaName',e.target.value)} placeholder="例如：工作搭档"/></label><label className="bv-field">角色提示词<textarea style={{minHeight:140}} maxLength={6000} value={value.personaPrompt} onChange={e=>change('personaPrompt',e.target.value)} placeholder="你希望它以什么方式与你交流？"/></label></section></div><details className="bv-fold"><summary>预览当前提示词</summary><div className="bv-fold-body"><p className="bv-muted">保存后用于后续语音回复。</p><div className="bv-divider"/><div className="bv-prompt-preview">{effectivePrompt||'两个开关都关闭时，沿用 DSH 原有会话提示词。'}</div><div className="bv-divider"/><p className="bv-muted">这些提示词只在语音通话期间生效。</p></div></details></div>}
    {tab==='interaction'&&<div className="bv-grid"><div><section className="bv-card"><h2>语音识别</h2><label className="bv-field">识别引擎<select value={value.asrEngine} onChange={e=>change('asrEngine',e.target.value)}><option value="server">私有服务器识别</option><option value="dsh" disabled={!nativeAsr?.ready&&value.asrEngine!=='dsh'}>DSH 自带 SenseVoice（本机）</option></select><span className="bv-help">本机识别复用 DSH 已准备的模型；只替换识别环节，录音、打断和语音回答继续由本插件处理。</span></label><button className="bv-button" style={{marginTop:12}} disabled={nativeChecking} onClick={()=>void checkNativeAsr()}>{nativeChecking?'检测中…':'检测 DSH 原生识别'}</button><p className="bv-muted" role="status">{nativeAsr?.message??'先在 DSH 插件中启用「语音输入」，在原生语音输入设置完成 SenseVoice 准备，再检测并选择。不会自动下载或修改原生设置。'}</p><div className="bv-divider"/><h2>说话与打断</h2><p className="bv-muted">根据停顿习惯调整。外放时可关闭自动打断，使用「打断回答」按钮。</p><div className="bv-field-row"><label className="bv-field">停顿多久自动发送<input type="number" min={400} max={3000} step={100} value={value.silenceMs} onChange={e=>change('silenceMs',Number(e.target.value))}/><span className="bv-help">毫秒 · 默认 1200，较大数值可以留出思考时间。</span></label><div className="bv-field">本机语音检测<p className="bv-muted">自动区分人声与环境声音，确认你在说话后才触发打断。</p></div></div><label className="bv-switchline"><input type="checkbox" checked={value.bargeIn} onChange={e=>change('bargeIn',e.target.checked)}/><span>允许开口打断回答<small>你再次开口时停止播报并取消当前语音回复。建议佩戴耳机。</small></span></label><label className="bv-switchline"><input type="checkbox" checked={value.reviewBeforeSend} onChange={e=>change('reviewBeforeSend',e.target.checked)}/><span>发送前确认识别内容<small>识别后暂停收音，可以修改文字再发送，适合专有名词较多的对话。</small></span></label><label className="bv-field">中文识别热词<textarea maxLength={2000} value={value.asrHotwords} onChange={e=>change('asrHotwords',e.target.value)} placeholder="例如：星河语音，Breeze，DSH，Qwen，住院医师"/><span className="bv-help">填写常见人名、项目名和术语，用逗号分隔。仅用于服务器识别；DSH 原生识别暂不支持传入热词。</span></label><p className="bv-muted">麦克风参数在下一次开启语音时生效。每段录音最长 24 秒。</p></section><section className="bv-card"><h2>空闲释放显存</h2><p className="bv-muted">语音暂时不用时，让 GPU 腾出空间做其他工作。</p><label className="bv-field">空闲自动卸载间隔<input type="number" min={0} max={120} step={1} value={value.idleMinutes} onChange={e=>change('idleMinutes',Number(e.target.value))}/><span className="bv-help">分钟 · 默认 10；填写 0 表示不自动卸载。保存会同步到服务器。</span></label><div className="bv-chiprow">{[1,5,10,30,0].map(n=><button className="bv-chip" key={n} onClick={()=>change('idleMinutes',n)}>{n?`${n} 分钟`:'不自动卸载'}</button>)}</div></section></div><aside className="bv-card"><h2>服务器资源</h2><p className="bv-muted">读取真实网关状态，不会为了查看而加载模型。</p><div className="bv-kv"><span>语音合成</span><strong>{modelLabel(health?.tts)}</strong></div><div className="bv-kv"><span>语音识别</span><strong>{modelLabel(health?.asr)}</strong></div><div className="bv-kv"><span>服务器卸载间隔</span><strong>{minutesLabel(health?.idle_seconds)}</strong></div><div className="bv-kv"><span>预计空闲卸载</span><strong>{health?.idle_remaining_seconds!=null?`${Math.ceil(health.idle_remaining_seconds/60)} 分钟内`:'—'}</strong></div><div className="bv-actions"><button className="bv-button" disabled={checking} onClick={()=>void healthCheck()}>刷新状态</button><button className="bv-button" disabled={checking||health?.busy} onClick={()=>void release()}>立即释放显存</button></div><p className="bv-muted" style={{marginTop:14}}>只卸载语音模型；服务保持可连接。正在识别或合成时不会强制中断。</p></aside></div>}
    {tab==='connection'&&<div className="bv-grid"><section className="bv-card"><h2>语音服务器</h2><p className="bv-muted">设置会继续使用已有值。SSH 隧道仅在语音需要服务时建立。</p><label className="bv-field">SSH 主机别名<input value={value.sshHost} onChange={e=>change('sshHost',e.target.value)} placeholder="留空使用已建立的本机转发"/></label><label className="bv-field">Windows 网关任务名<input value={value.remoteTaskName} onChange={e=>change('remoteTaskName',e.target.value)} placeholder="可选；连接时启动已部署的计划任务"/></label><div className="bv-field-row"><label className="bv-field">服务器端口<input type="number" min={1024} max={65535} value={value.remotePort} onChange={e=>change('remotePort',Number(e.target.value))}/></label><label className="bv-field">本机转发端口<input type="number" min={1024} max={65535} value={value.localPort} onChange={e=>change('localPort',Number(e.target.value))}/></label></div><label className="bv-field">语音服务密钥<input type="password" autoComplete="new-password" value={value.apiKey} onChange={e=>change('apiKey',e.target.value)}/><span className="bv-help">密钥保存在本机 DSH 配置中，不会写入分享的音色描述。</span></label><div className="bv-actions"><button className="bv-button" disabled={busy} onClick={()=>void save()}>保存并同步服务器</button><button className="bv-button" disabled={checking} onClick={()=>void healthCheck()}>测试已保存的连接</button></div></section><aside className="bv-card"><h2>如何开始</h2><div className="bv-kv"><span>01</span><strong>保存设置并确认连接</strong></div><div className="bv-kv"><span>02</span><strong>回到你正在使用的会话</strong></div><div className="bv-kv"><span>03</span><strong>点击输入框旁的「语音」</strong></div><div className="bv-divider"/><p className="bv-muted">首次开启会预热语音模型，然后请求麦克风访问。识别文本与回答继续保存在原来的会话里。</p><p className="bv-muted">语音在你的服务器处理；DSH 的语言模型请求继续使用当前会话配置。</p></aside></div>}
    </section>
  </div></div>;
}
