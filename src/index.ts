import {VoiceChatControl,remoteControl,type VoiceSettings} from './chat-control.js';
import {registerVoiceTools} from './chat-tools.js';
import {bundledVoiceSkill} from './skill.js';
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Config, resolveConfig, type VoiceConfig } from './config.js';
import {lookupNativeAsr,recognizeNativeAsr} from './native-asr.js';
import { Tunnel } from './tunnel.js';
import { installVoicePromptSessions, type VoicePromptSessions } from './prompt-session.js';
export { Config };
export const name = 'breeze-voice';
export const inject = ['webServer', 'systemPrompt'];
export const API = '/api/breeze-voice';

export async function readBody(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Error('录音过长，请分段说话');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function validOrigin(req: IncomingMessage) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
export function createHandler(current: () => VoiceConfig, tunnel: Tunnel, route: string, sessions?: Pick<VoicePromptSessions, 'handle'>, nativeSource?: Parameters<typeof lookupNativeAsr>[0]) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const json = (code: number, value: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const controller = new AbortController();
    const closed = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', closed);
    let release: (() => void) | undefined;
    try {
      if (!validOrigin(req)) return json(403, { error: '禁止跨站访问语音服务' });
      const c = resolveConfig(current());
      if (route === 'config' && req.method === 'GET') {
        const { apiKey, ...publicConfig } = c;
        return json(200, { ...publicConfig, apiKeyConfigured: Boolean(apiKey) });
      }
      if(route === 'native-asr') {
        if(req.method !== 'GET') return json(405,{error:'请求方法不支持'});
        return json(200,lookupNativeAsr(nativeSource));
      }
      if (route === 'session') {
        if(req.method !== 'POST') return json(405, {error:'请求方法不支持'});
        if(!sessions) return json(503, {error:'会话提示词服务尚未就绪'});
        try {
          const data=JSON.parse((await readBody(req,16384)).toString());
          return json(200, sessions.handle(data));
        } catch(e) { return json(400, {error:e instanceof Error ? e.message : '会话请求无效'}); }
      }
      const expectedMethod = route === 'health' || (route === 'voices' && req.method === 'GET') ? 'GET' : 'POST';
      if (req.method !== expectedMethod) return json(405, { error: '请求方法不支持' });
      let body: Buffer | string | FormData | undefined;
      let contentType = req.headers['content-type'] ?? '';
      if (route === 'speech' || route === 'preview') {
        const data = JSON.parse((await readBody(req, 65536)).toString());
        if (typeof data.input !== 'string' || !data.input.trim() || data.input.length > 2000) return json(400, { error: '朗读文本须为 1–2000 字' });
        if(route === 'preview' && !data.voiceId && (typeof data.instruction !== 'string' || !data.instruction.trim() || data.instruction.length > 1000)) return json(400,{error:'试听需要 1–1000 字的音色描述'});
        const voice = route === 'preview' ? data.voiceId : c.voiceId;
        if(voice && (typeof voice !== 'string' || !/^[a-f0-9]{32}$/.test(voice))) return json(400,{error:'音色 ID 无效'});
        body = JSON.stringify({ input: data.input, instructions: route === 'preview' && !voice ? data.instruction.trim() : c.instruction, voice:voice || undefined, design:route === 'preview' && !voice, response_format: 'pcm' });
        contentType = 'application/json';
      } else if (route === 'transcriptions') {
        if (!contentType.startsWith('multipart/form-data;')) return json(400, { error: '需要 WAV 录音' });
        const incoming = await readBody(req, 4 * 1024 * 1024);
        const form = await new Response(incoming, {headers:{'content-type':contentType}}).formData();
        const file = form.get('file');
        if(!(file instanceof Blob)) return json(400,{error:'需要 WAV 录音'});
        if(c.asrEngine === 'dsh') {
          try {return json(200,await recognizeNativeAsr(nativeSource,new Uint8Array(await file.arrayBuffer()),controller.signal));}
          catch(e){return json(503,{error:e instanceof Error?e.message:'原生语音识别失败'});}
        }
        body = new FormData(); body.append('file',file,'utterance.wav');
        body.set('hotwords',c.asrHotwords); contentType='';
      } else if (route === 'voices') {
        if(expectedMethod === 'POST') {
          const data=JSON.parse((await readBody(req,16384)).toString());
          if(typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80 || typeof data.instruction !== 'string' || !data.instruction.trim() || data.instruction.length > 1000) return json(400,{error:'请填写音色名称和描述'});
          body=JSON.stringify({name:data.name,instruction:data.instruction}); contentType='application/json';
        }
      } else if (route === 'voice-default') {
        const data=JSON.parse((await readBody(req,4096)).toString());
        if(typeof data.voiceId !== 'string' || !/^[a-f0-9]{32}$/.test(data.voiceId)) return json(400,{error:'音色 ID 无效'});
        body=JSON.stringify({voice_id:data.voiceId}); contentType='application/json';
      } else if (route === 'service-settings') {
        body=JSON.stringify({idle_seconds:c.idleMinutes*60}); contentType='application/json';
      } else if (route === 'warmup' || route === 'release') {
        body = route === 'warmup' ? JSON.stringify({asr:c.asrEngine!=='dsh'}) : '{}'; contentType = 'application/json';
      } else if (route !== 'health') return json(404, { error: '未知语音接口' });
      release = await tunnel.acquire(c);
      if (controller.signal.aborted) return;
      const remotePath=route === 'voices' ? '/v1/voices' : route === 'voice-default' ? '/v1/voices/default' : route === 'health' ? '/health' : route === 'service-settings' ? '/v1/settings' : route === 'release' ? '/v1/models/unload' : `/v1/audio/${route === 'preview' ? 'speech' : route}`;
      const upstream = await fetch(`http://127.0.0.1:${c.localPort}${remotePath}`, {
        method: route === 'service-settings' ? 'PATCH' : expectedMethod,
        headers: { ...(contentType ? { 'content-type': contentType } : {}), ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
        ...(body === undefined ? {} : { body: body as BodyInit }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(route === 'health' ? 15000 : 180000)]),
      });
      if (!upstream.ok) {
        const error = await upstream.text();
        let message = `语音服务返回 ${upstream.status}`;
        try { const parsed = JSON.parse(error); message = String(parsed.error?.message ?? parsed.error ?? parsed.detail ?? message); } catch { /* Do not expose arbitrary remote traces. */ }
        return json(upstream.status, { error: message.slice(0,500) });
      }
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-sample-rate': upstream.headers.get('x-sample-rate') ?? '24000',
      });
      if (upstream.body) for await (const chunk of upstream.body) {
        if (controller.signal.aborted) break;
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      res.end();
    } catch (e) {
      if (!res.headersSent && !res.destroyed) json(502, { error: e instanceof Error && e.message !== 'fetch failed' ? e.message : '无法连接语音网关，请检查服务器任务、SSH 别名和端口。' });
      else if (!res.destroyed) res.destroy();
    } finally { release?.(); res.off('close', closed); }
  };
}
export const VAD_ASSETS:Record<string,string> = {
  'ort.wasm.min.js':'text/javascript', 'ort-wasm-simd-threaded.mjs':'text/javascript',
  'ort-wasm-simd-threaded.wasm':'application/wasm', 'silero_vad_v5.onnx':'application/octet-stream',
  'vad.worklet.bundle.min.js':'text/javascript',
};
export function assetHandler(filename:string) {
  return async(req:IncomingMessage,res:ServerResponse)=>{
    if(!Object.hasOwn(VAD_ASSETS,filename) || !validOrigin(req)) {res.writeHead(403);res.end();return;}
    if(req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405);res.end();return;}
    try {
      const location=new URL('../assets/vad/'+filename,import.meta.url);
      const info=await stat(location);
      res.writeHead(200,{'content-type':VAD_ASSETS[filename], 'content-length':info.size, 'cache-control':'no-cache'});
      if(req.method==='HEAD') {res.end();return;}
      const stream=createReadStream(location);
      res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
    } catch {if(!res.headersSent)res.writeHead(404);res.end();}
  };
}
export function apply(ctx: Context, config: VoiceConfig = {}) {
  const tunnel = new Tunnel();
  const current = () => Object.fromEntries(Object.entries(config).map(([key, value]) => [key,
    value && typeof value === 'object' && 'get' in value ? (value as {get(): unknown}).get() : value])) as VoiceConfig;
  const sessions=installVoicePromptSessions(ctx,current);
  const injectServices=ctx.inject as unknown as (names:string[],callback:(owner:Context)=>void)=>void;
  injectServices.call(ctx,['tools','settings'],owner=>{
    const control=new VoiceChatControl(current,owner.get('settings') as VoiceSettings,remoteControl(current,tunnel),()=>sessions.activeCount(),()=>lookupNativeAsr(ctx).ready);
    registerVoiceTools(owner,control);
  });
  injectServices.call(ctx,['skills'],owner=>{
    const skills=owner.get('skills') as {register(skill:object):()=>void};
    owner.effect(()=>skills.register(bundledVoiceSkill()),'breeze-voice chat skill');
  });
  const web = ctx.get('webServer') as { register(options: object): () => void };
  ctx.effect(()=>web.register({kind:'exact',path:`${API}/capabilities`,handler:async(req:IncomingMessage,res:ServerResponse)=>{
    if(!validOrigin(req)||req.method!=='GET'){res.writeHead(403);res.end();return;}
    const tools=ctx.get('tools') as {get(name:string):unknown}|undefined;
    const skills=ctx.get('skills') as {get(name:string):Promise<unknown>}|undefined;
    const skill=skills?await skills.get('breeze-voice').catch(()=>undefined):undefined;
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({tools:['breeze_voice_settings','breeze_voice_voices','breeze_voice_service'].filter(name=>Boolean(tools?.get(name))),skill:skill?'breeze-voice':null,active_calls:sessions.activeCount()}));
  }}),'breeze-voice capabilities');
  for (const route of ['config', 'health', 'warmup', 'speech', 'transcriptions', 'preview', 'release', 'service-settings', 'session', 'voices', 'voice-default', 'native-asr']) ctx.effect(() => web.register({
    kind: 'exact', path: `${API}/${route}`, handler: createHandler(current, tunnel, route, sessions, ctx),
  }), `breeze-voice ${route}`);
  for(const filename of Object.keys(VAD_ASSETS)) ctx.effect(()=>web.register({kind:'exact',path:`${API}/assets/${filename}`,handler:assetHandler(filename)}),`breeze-voice asset ${filename}`);
  ctx.effect(() => () => tunnel.close(), 'breeze-voice owned SSH');
}
