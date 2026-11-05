import {createServer,type Server} from 'node:http';
import {afterEach,describe,it,expect} from 'vitest';
import {createHandler,API} from '../src/index.js';
import {resolveConfig} from '../src/config.js';
import type {Tunnel} from '../src/tunnel.js';
const servers:Server[]=[];
async function listen(handler:Parameters<typeof createServer>[0]){const server=createServer(handler);servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return {server,port:(server.address() as any).port as number};}
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
describe('host gateway boundary',()=>{
  it('rejects shell syntax and invalid VAD config',()=>{
    expect(()=>resolveConfig({sshHost:'host; touch /tmp/x'})).toThrow();expect(()=>resolveConfig({sshHost:'-oProxyCommand=x'})).toThrow();
    expect(()=>resolveConfig({remoteTaskName:'x & calc'})).toThrow();expect(()=>resolveConfig({silenceMs:0})).toThrow();
  });
  it('redacts secret configuration, rejects cross-site speech, and preserves streaming/auth',async()=>{
    let auth='',received='';const pcm=Buffer.from([0,0,255,127,0,128]);
    const remote=await listen(async(req,res)=>{auth=req.headers.authorization??'';for await(const c of req)received+=c;res.writeHead(200,{'content-type':'audio/pcm','x-sample-rate':'24000'});res.write(pcm.subarray(0,3));setTimeout(()=>res.end(pcm.subarray(3)),20);});
    const counts={active:0};const tunnel={async acquire(){counts.active++;return()=>{counts.active--;};}} as unknown as Tunnel;
    const config={localPort:remote.port,apiKey:'private-test-token'};
    const host=await listen((req,res)=>{const route=req.url!.slice(API.length+1);void createHandler(()=>config,tunnel,route)(req,res);});
    const base=`http://127.0.0.1:${host.port}${API}`;
    const publicConfig=await (await fetch(`${base}/config`)).json();expect(publicConfig.apiKey).toBeUndefined();expect(publicConfig.apiKeyConfigured).toBe(true);
    const denied=await fetch(`${base}/speech`,{method:'POST',headers:{origin:'https://attacker.invalid'},body:'{}'});expect(denied.status).toBe(403);
    const response=await fetch(`${base}/speech`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:'你好。'})});
    expect(Buffer.from(await response.arrayBuffer())).toEqual(pcm);expect(auth).toBe('Bearer private-test-token');expect(JSON.parse(received).input).toBe('你好。');expect(counts.active).toBe(0);
  });
  it('relays WAV multipart without persisting recordings',async()=>{
    let bytes=Buffer.alloc(0),type='';const remote=await listen(async(req,res)=>{type=req.headers['content-type']??'';const chunks=[];for await(const b of req)chunks.push(b);bytes=Buffer.concat(chunks);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({text:'测试语音'}));});
    const tunnel={async acquire(){return()=>{};}} as unknown as Tunnel;
    const host=await listen(createHandler(()=>({localPort:remote.port}),tunnel,'transcriptions'));
    const body=new FormData();body.append('file',new Blob(['RIFFfakewav']), 'utterance.wav');
    const response=await fetch(`http://127.0.0.1:${host.port}`,{method:'POST',body});expect((await response.json()).text).toBe('测试语音');expect(type).toContain('multipart/form-data');expect(bytes.toString()).toContain('RIFFfakewav');
  });
  it('closes the upstream synthesis request when local playback is aborted',async()=>{
    let closed=false;const remote=await listen((_req,res)=>{res.writeHead(200,{'content-type':'audio/pcm'});res.write(Buffer.alloc(240));res.on('close',()=>{closed=true;});});
    let released=false;const tunnel={async acquire(){return()=>{released=true;};}} as unknown as Tunnel;
    const host=await listen(createHandler(()=>({localPort:remote.port}),tunnel,'speech'));
    const abort=new AbortController();const response=await fetch(`http://127.0.0.1:${host.port}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:'长回答'}),signal:abort.signal});
    const reader=response.body!.getReader();await reader.read();abort.abort();await reader.cancel().catch(()=>{});
    for(let i=0;i<40&&!closed;i++)await new Promise(r=>setTimeout(r,10));
    expect(closed).toBe(true);expect(released).toBe(true);
  });
});

describe('workbench controls',()=>{
  it('previews a draft voice without changing the saved voice',async()=>{
    const received:any[]=[];
    const remote=await listen(async(req,res)=>{let data='';for await(const c of req)data+=c;received.push(JSON.parse(data));res.writeHead(200,{'content-type':'audio/pcm'});res.end(Buffer.from([0,0]));});
    const config={localPort:remote.port,instruction:'已保存的声音'};
    const tunnel={async acquire(){return()=>{};}} as unknown as Tunnel;
    const host=await listen(createHandler(()=>config,tunnel,'preview'));
    const response=await fetch(`http://127.0.0.1:${host.port}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:'试听文本',instruction:'低沉男声'})});
    expect(response.status).toBe(200);await response.arrayBuffer();
    expect(received[0].instructions).toBe('低沉男声');expect(config.instruction).toBe('已保存的声音');
  });
  it('syncs the configured idle policy and uses the server release endpoint',async()=>{
    const requests:any[]=[];
    const remote=await listen(async(req,res)=>{let body='';for await(const c of req)body+=c;requests.push({method:req.method,path:req.url,body:JSON.parse(body)});res.writeHead(200,{'content-type':'application/json'});res.end('{}');});
    const tunnel={async acquire(){return()=>{};}} as unknown as Tunnel;
    const config={localPort:remote.port,idleMinutes:3};
    const host=await listen((req,res)=>void createHandler(()=>config,tunnel,req.url!.slice(1))(req,res));
    const base=`http://127.0.0.1:${host.port}`;
    expect((await fetch(base+'/service-settings',{method:'POST',body:JSON.stringify({idle_seconds:99999})})).status).toBe(200);
    expect(requests[0]).toEqual({method:'PATCH',path:'/v1/settings',body:{idle_seconds:180}});
    expect((await fetch(base+'/release',{method:'POST'})).status).toBe(200);
    expect(requests[1]).toMatchObject({method:'POST',path:'/v1/models/unload'});
  });
  it('manages a local voice-session lease without opening the GPU connection',async()=>{
    let tunnelCalls=0;
    const tunnel={async acquire(){tunnelCalls++;return()=>{};}} as unknown as Tunnel;
    const manager={handle:(data:unknown)=>({accepted:data})};
    const host=await listen(createHandler(()=>({}),tunnel,'session',manager as any));
    const r=await fetch(`http://127.0.0.1:${host.port}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'start',sessionId:'session-A'})});
    expect(r.status).toBe(200);expect((await r.json()).accepted.sessionId).toBe('session-A');expect(tunnelCalls).toBe(0);
  });
});

describe('native ASR and stable voice integration',()=>{
  it('pins configured voice and ignores caller attempts to change conversation voice',async()=>{
    let received:any;const remote=await listen(async(req,res)=>{let data='';for await(const c of req)data+=c;received=JSON.parse(data);res.end('pcm');});
    const tunnel={async acquire(){return()=>{};}} as unknown as Tunnel;
    const id='a'.repeat(32);const host=await listen(createHandler(()=>({localPort:remote.port,voiceId:id}),tunnel,'speech'));
    const r=await fetch(`http://127.0.0.1:${host.port}`,{method:'POST',body:JSON.stringify({input:'第二句',voiceId:'b'.repeat(32),instruction:'different'})});await r.text();
    expect(received.voice).toBe(id);expect(received.design).toBe(false);
  });
  it('uses native registry without opening a remote tunnel and preserves cancellation signal',async()=>{
    const wav=Buffer.alloc(44+32000);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
    let tunnels=0;const tunnel={async acquire(){tunnels++;return()=>{};}} as unknown as Tunnel;
    const native={snapshot:()=>({providers:[{id:'sensevoice-local',languages:['zh'],preparation:{phase:'standby'}}]}),resolve:(r:any)=>{expect(Buffer.from(r.audio)).toEqual(wav);expect(r.providerId).toBe('sensevoice-local');return r;},transcribe:async(_r:unknown,signal:AbortSignal)=>{expect(signal.aborted).toBe(false);return{text:'原生识别结果'};}};
    const host=await listen(createHandler(()=>({asrEngine:'dsh'}),tunnel,'transcriptions',undefined,native));
    const form=new FormData();form.append('file',new Blob([wav]),'utterance.wav');
    const r=await fetch(`http://127.0.0.1:${host.port}`,{method:'POST',body:form});expect(r.status).toBe(200);expect((await r.json()).text).toBe('原生识别结果');expect(tunnels).toBe(0);
  });
  it('forwards saved hotwords while dropping untrusted multipart hotwords',async()=>{
    let captured='';const remote=await listen(async(req,res)=>{for await(const c of req)captured+=c;res.end('{}');});
    const tunnel={async acquire(){return()=>{};}} as unknown as Tunnel;
    const host=await listen(createHandler(()=>({localPort:remote.port,asrHotwords:'星河 语音'}),tunnel,'transcriptions'));
    const form=new FormData();form.append('file',new Blob(['RIFFtest']),'test.wav');form.append('hotwords','untrusted');
    const r=await fetch(`http://127.0.0.1:${host.port}`,{method:'POST',body:form});await r.text();expect(captured).toContain('星河 语音');expect(captured).not.toContain('untrusted');
  });
});
