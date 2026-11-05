import {describe,it,expect} from 'vitest';
import {VoicePromptSessions,installVoicePromptSessions} from '../src/prompt-session.js';
import {resolveConfig} from '../src/config.js';
describe('voice-only native prompt lease',()=>{
  it('scopes literal prompts to the exact live session and revokes on stop',()=>{
    const manager=new VoicePromptSessions(()=>({voicePrompt:'保留 {{literal}}。',personaEnabled:true,personaName:'搭档',personaPrompt:'直接回答。'}));
    const a={agent:{session:{header:{id:'session-A'}}}},b={agent:{session:{header:{id:'session-B'}}}};
    expect(manager.textFor(a)).toBe('');const lease=manager.handle({action:'start',sessionId:'session-A'});
    expect(manager.textFor(a)).toContain('{{literal}}');expect(manager.textFor(a)).toContain('搭档');expect(manager.textFor(b)).toBe('');
    expect(()=>manager.handle({action:'stop',sessionId:'session-A',leaseId:'other'})).toThrow();
    manager.handle({action:'stop',sessionId:'session-A',leaseId:lease.leaseId});expect(manager.textFor(a)).toBe('');
  });
  it('expires abandoned browser leases, renews live leases, and reads subsequent config',()=>{
    let now=0;let config={personaEnabled:false,personaPrompt:'务实'};
    const manager=new VoicePromptSessions(()=>config,()=>now),context={agent:{id:'one'}};
    const lease=manager.handle({action:'start',sessionId:'one'});now=80000;manager.handle({action:'keepalive',sessionId:'one',leaseId:lease.leaseId});now=100000;
    expect(manager.textFor(context)).not.toContain('务实');config={...config,personaEnabled:true};expect(manager.textFor(context)).toContain('务实');
    now=170000;expect(manager.textFor(context)).toBe('');expect(()=>manager.handle({action:'keepalive',sessionId:'one',leaseId:lease.leaseId})).toThrow('过期');
  });
  it('registers a non-interpolated native section and disposes leases',()=>{
    let section:any;const cleanups:(()=>void)[]=[];
    const ctx={get:()=>({getSectionOrder:()=>200,section:(s:unknown)=>{section=s;return()=>{};}}),effect:(fn:()=>()=>void)=>cleanups.push(fn())};
    const manager=installVoicePromptSessions(ctx as any,()=>({voicePrompt:'{{literal}}'}));manager.handle({action:'start',sessionId:'test'});
    expect(section.interpolate).toBe(false);expect(section.order).toBe(202);expect(section.text({agent:{id:'test'}})).toContain('{{literal}}');cleanups.forEach(fn=>fn());expect(section.text({agent:{id:'test'}})).toBe('');
  });
});
describe('portable settings upgrades',()=>{
  it('preserves explicitly configured pauses and descriptions with stable voice independent',()=>{
    const c=resolveConfig({silenceMs:800,instruction:'旧声音',voiceId:'fixed_1'});expect(c.silenceMs).toBe(800);expect(c.instruction).toBe('旧声音');expect(c.voiceId).toBe('fixed_1');expect(resolveConfig({}).silenceMs).toBe(1200);
    expect(()=>resolveConfig({silenceMs:3000,idleMinutes:0})).not.toThrow();expect(()=>resolveConfig({idleMinutes:1.5})).toThrow();
  });
  it('rejects malformed saved profiles and oversized prompt/hotwords',()=>{
    expect(()=>resolveConfig({voiceProfiles:[{id:'same',name:'a',instruction:'a'},{id:'same',name:'b',instruction:'b'}]})).toThrow();
    expect(()=>resolveConfig({voicePrompt:'x'.repeat(6001)})).toThrow();expect(()=>resolveConfig({asrHotwords:'x'.repeat(2001)})).toThrow();
  });
});
