// Isolated acceptance fixture. Uses the production client bundle, synthetic input,
// a native-contract session fake, and a local PCM/ASR gateway. Never calls an LLM.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const events=[];let asr=0,tts=0,aborted=0;
const html=`<!doctype html><meta charset="utf-8"><title>Breeze voice acceptance</title>
<style>body{font-family:system-ui;margin:0;padding:32px;color:#242424;background:#f5f5f3}#root{position:absolute;bottom:80px;right:40px}button:focus-visible{outline:2px solid #147a64;outline-offset:3px}</style><h2>Isolated voice acceptance</h2><p>Synthetic microphone · fake DSH session · streamed PCM gateway</p><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.metrics={send:[],cancel:0,tracks:[],events:[]};
let revision=0,entries=[],listeners=new Set(),running=false,turn=0,seq=0,timers=[];
const eventSource={getSnapshot:()=>({revision,entries,change:{kind:'replace',entries}}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}};
function emit(type,data,surfaceOp){const event={type,seq:++seq,data,...(surfaceOp?{surfaceOp}:{})};const entry={event};entries.push(entry);revision++;eventSource.getSnapshot=()=>({revision,entries,change:{kind:'append',entries:[entry]}});for(const fn of listeners)fn();metrics.events.push(type);}
const binding={sessionId:'fixture',eventSource,session:{getSnapshot:()=>({running}),subscribe:()=>()=>{}}};
const conversation={async send(text){metrics.send.push(text);running=true;turn++;let t=turn;emit('turn/start',{turn:t});timers.push(setTimeout(()=>emit('assistant/live-chunk',{turn:t,step:1,attemptId:String(t),chunk:{type:'text-delta',text:'这是实时语音回答。'}}),100));timers.push(setTimeout(()=>{emit('assistant/message',{turn:t,step:1,message:{content:[{type:'text',text:'这是实时语音回答。'}]}},'append');running=false;emit('turn/end',{turn:t});},8000));},async cancel(){metrics.cancel++;timers.forEach(clearTimeout);timers=[];running=false;emit('turn/end',{turn});}};
window.syntheticSpeech=async()=>{let c=new AudioContext();await c.resume();let dest=c.createMediaStreamDestination(),osc=c.createOscillator(),gain=c.createGain();osc.frequency.value=230;gain.gain.value=.12;osc.connect(gain);gain.connect(dest);window.synthetic={c,dest,osc,gain};return dest.stream;};
Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{const stream=await syntheticSpeech();metrics.tracks=stream.getTracks();return stream;}});
window.speak=async(ms=700)=>{synthetic.osc.start();setTimeout(()=>synthetic.osc.stop(),ms);};
window.speakAgain=async(ms=700)=>{const osc=synthetic.c.createOscillator();osc.frequency.value=260;osc.connect(synthetic.gain);osc.start();setTimeout(()=>osc.stop(),ms);};
window.__ModuleLoader__={load({factory}){const jsx=(type,props,key)=>React.createElement(type,{...props,key});const plugin=factory(id=>{if(id==='react')return React;if(id==='react-dom')return ReactDOM;if(id==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:React.Fragment};throw Error(id)});const slots={inject:(name,fn)=>fn(),register:(o,C)=>{if(o.name==='conversation.input.right'){const props=o.inject('fixture');ReactDOM.createRoot(document.querySelector('#root')).render(React.createElement(C,props));}return()=>{};}};const services={slots,sessions:{binding:()=>binding,scope:()=>({get:()=>conversation})},configForms:{get:()=>({getSnapshot:()=>({}),mutate:async()=>true})}};plugin.apply({get:name=>services[name]});}};
</script><script src="/client.js"></script>`;
const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('content-type','text/html');return res.end(html);}
  const files={'/react.js':'node_modules/react/umd/react.production.min.js','/react-dom.js':'node_modules/react-dom/umd/react-dom.production.min.js','/client.js':'lib/client.js'};
  if(files[req.url]){res.setHeader('content-type','text/javascript');return res.end(await readFile(new URL(files[req.url],root)));}
  if(req.url==='/metrics'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({asr,tts,aborted,events}));}
  if(req.url==='/api/breeze-voice/config'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({silenceMs:500,vadThreshold:.018,bargeIn:true}));}
  if(req.url==='/api/breeze-voice/health'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({ready:true}));}
  if(req.url==='/api/breeze-voice/transcriptions'){let data=[];for await(const b of req)data.push(b);const wav=Buffer.concat(data);asr++;events.push({wav: wav.includes(Buffer.from('RIFF')),length:wav.length});res.setHeader('content-type','application/json');return res.end(JSON.stringify({text:'请用语音回答测试。'}));}
  if(req.url==='/api/breeze-voice/speech'){let data='';for await(const b of req)data+=b;tts++;events.push({input:JSON.parse(data).input});res.writeHead(200,{'content-type':'audio/pcm','x-sample-rate':'24000'});let at=0;const interval=setInterval(()=>{const buffer=Buffer.alloc(4800);for(let i=0;i<2400;i++)buffer.writeInt16LE(Math.sin((at+i)/24000*2*Math.PI*330)*3000,i*2);at+=2400;res.write(buffer);if(at>=24000*10){clearInterval(interval);res.end();}},80);res.on('close',()=>{clearInterval(interval);if(!res.writableEnded)aborted++;});return;}
  res.writeHead(404);res.end();
});
server.listen(19892,'127.0.0.1',()=>process.stdout.write('Synthetic voice fixture on 19892\n'));
