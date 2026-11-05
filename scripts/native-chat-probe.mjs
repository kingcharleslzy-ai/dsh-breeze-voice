// Loaded only by the isolated acceptance profile, never by the desktop profile.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
export const inject=['tools','skills','settings','webServer'];
export function apply(ctx){
  if(!process.env.DSH_HOME?.endsWith('/voice-chat-acceptance-home'))throw Error('Acceptance probe refuses non-isolated profile');
  const voiceId='1234567890abcdef1234567890abcdef';
  const requests=[];
  const gateway=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-secret');
    let raw='';for await(const chunk of req)raw+=chunk;
    requests.push({method:req.method,path:req.url,body:raw?JSON.parse(raw):null});
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify(req.url==='/v1/voices'?{voices:[{id:voiceId,name:'测试沉稳男声'}],default_voice_id:voiceId}:req.url==='/v1/settings'?JSON.parse(raw):{ready:true}));
  });
  gateway.listen(19892,'127.0.0.1');
  ctx.effect(()=>()=>{gateway.closeAllConnections();gateway.close();});
  const report=process.env.DSH_HOME+'/report.json';
  setTimeout(()=>void run().catch(async e=>{await writeFile(report,JSON.stringify({ok:false,error:e.stack},null,2));}),1500);
  async function run(){
    const names=['breeze_voice_settings','breeze_voice_voices','breeze_voice_service'];
    for(const name of names)assert(ctx.tools.get(name),name+' registered');
    const wire=ctx.tools.wireSchemas();
    for(const name of names)assert(wire.schemas.some(t=>t.name===name),'model sees '+name);
    const skill=await ctx.skills.get('breeze-voice');assert(skill?.content.includes('breeze_voice_settings'));assert(skill.invocation.modelInvocable&&skill.invocation.userInvocable);
    let updated=0;ctx.on('settings/updated',ns=>{if(ns==='breeze-voice')updated++;});
    const calls=[];
    async function invoke(name,args){
      const result=await ctx.tools.execute({name,arguments:args,callId:'acceptance-'+calls.length,signal:new AbortController().signal});
      calls.push({name,result});
      if(result.isError||result.error)throw Error(JSON.stringify(result));
      const value=result.value??result.output;
      if(value?.result)return JSON.parse(value.result);
      const text=result.content?.find(c=>c.type==='text')?.text;
      if(text)return JSON.parse(text);
      throw Error('Unexpected tool result '+JSON.stringify(result));
    }
    const initial=await invoke(names[0],{action:'get'});assert(!JSON.stringify(initial).includes('fixture-secret'));
    const saved=await invoke(names[0],{action:'update',revision:initial.revision,patch:{silenceMs:2000,idleMinutes:5,personaEnabled:true,personaName:'英语老师',personaPrompt:'请耐心帮助我练习英语。'}});
    assert(saved.saved);assert.equal(saved.server_sync.ok,true);assert.equal(saved.settings.silenceMs,2000);assert(updated>0,'native forms receive update');
    const current=ctx.settings.describe({redactSecrets:false}).find(d=>d.ns==='breeze-voice');
    assert.equal(current.value.apiKey,'fixture-secret');assert.equal(current.value.asrHotwords,'既有热词');
    const bad=await ctx.tools.execute({name:names[0],arguments:{action:'update',revision:initial.revision,patch:{personaName:'过期覆盖'}},callId:'stale',signal:new AbortController().signal});
    assert(bad.isError||bad.error||JSON.stringify(bad).includes('revision'),'stale write rejected');
    const voices=await invoke(names[1],{action:'list'});assert.equal(voices.voices[0].id,voiceId);
    const selected=await invoke(names[1],{action:'select',voice_id:voiceId,revision:voices.revision});assert(selected.saved);
    const status=await invoke(names[2],{action:'status'});assert(status.server.ready);
    const reset=await invoke(names[0],{action:'update',revision:selected.revision,patch:{idleMinutes:10,silenceMs:1200,personaEnabled:false,personaName:'',personaPrompt:''}});assert(reset.saved);
    await writeFile(report,JSON.stringify({ok:true,nativeRuntime:'0.2.1-rc.5',modelTools:names,skill:{name:skill.name,modelInvocable:skill.invocation.modelInvocable,userInvocable:skill.invocation.userInvocable},nativeSettingsPersisted:true,nativeSettingsEvents:updated,secretPreserved:true,unrelatedSettingsPreserved:true,staleRevisionRejected:true,fixedVoiceSelection:true,remoteIdleConfirmed:true,requests},null,2));
  }
}
