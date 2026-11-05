// Production bundle in a browser with an isolated native configForms contract.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);let offline=false;const requests=[];let voices=[{id:'fixed_initial',name:'日常搭档',instruction:'自然普通话',reference_text:'你好，我在听。',duration:3.4}];
const html=`<!doctype html><meta charset="utf-8"><title>Breeze workbench acceptance</title><style>body{margin:0;font-family:system-ui;background:#f7f8f6}#root{height:100vh}</style><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.acceptance={config:{sshHost:'fixture',localPort:19899,apiKey:'fixture-secret',silenceMs:800,voiceId:'fixed_initial'},revision:1,mutations:[],slots:[]};let listeners=new Set();const scope={getSnapshot:()=>({value:acceptance.config,revision:acceptance.revision,writable:true}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},mutate:async(ops,rev)=>{if(rev!==undefined&&rev!==acceptance.revision)return false;acceptance.mutations.push(ops);for(const op of ops)acceptance.config[op.path[0]]=op.value;acceptance.revision++;listeners.forEach(fn=>fn());return true;}};
window.__ModuleLoader__={load({factory}){const jsx=(type,props,key)=>React.createElement(type,{...props,key});const plugin=factory(id=>{if(id==='react')return React;if(id==='react-dom')return ReactDOM;if(id==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:React.Fragment};throw Error(id)});const slots={inject:(_name,fn)=>fn(),register:(o,C)=>{acceptance.slots.push({name:o.name,id:o.id,key:o.key,label:o.label});if(o.name==='main')ReactDOM.createRoot(document.querySelector('#root')).render(React.createElement(C,o.inject()));return()=>{};}};plugin.apply({get:name=>({slots,configForms:{get:()=>scope},sessions:{binding:()=>{},scope:()=>{}}})[name]});}};
</script><script src="/client.js"></script>`;
const server=createServer(async(req,res)=>{
 const files={'/react.js':'node_modules/react/umd/react.production.min.js','/react-dom.js':'node_modules/react-dom/umd/react-dom.production.min.js','/client.js':'lib/client.js'};
 if(files[req.url]){res.setHeader('content-type','text/javascript');return res.end(await readFile(new URL(files[req.url],root)));}
 if(req.url==='/'){res.setHeader('content-type','text/html');return res.end(html);}
 if(req.url==='/offline'){offline=!offline;return res.end(String(offline));}
 if(req.url==='/metrics'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(requests));}
 let body='';for await(const b of req)body+=b;requests.push({path:req.url,method:req.method,...(body?{body:JSON.parse(body)}:{})});
 res.setHeader('content-type','application/json');
 if(offline){res.statusCode=503;return res.end(JSON.stringify({error:'模拟离线'}));}
 if(req.url.endsWith('/health'))return res.end(JSON.stringify({ready:false,tts:'unloaded',asr:'unloaded',idle_seconds:600,busy:false}));
 if(req.url.endsWith('/service-settings'))return res.end(JSON.stringify({idle_seconds:180}));
 if(req.url.endsWith('/release'))return res.end('{}');
 if(req.url.endsWith('/voices')){if(req.method==='POST'){const input=JSON.parse(body);const voice={id:'fixed_new',...input,duration:5};voices.push(voice);return res.end(JSON.stringify({voice}));}return res.end(JSON.stringify({voices,default_voice_id:'fixed_initial'}));}
 if(req.url.endsWith('/preview')){res.setHeader('content-type','audio/pcm');res.setHeader('x-sample-rate','24000');const pcm=Buffer.alloc(12000);for(let i=0;i<6000;i++)pcm.writeInt16LE(Math.sin(i/24000*Math.PI*660)*1000,i*2);return res.end(pcm);}
 res.statusCode=404;res.end('{}');
});server.listen(19892,'127.0.0.1',()=>console.log('Isolated workbench fixture on 19892'));
