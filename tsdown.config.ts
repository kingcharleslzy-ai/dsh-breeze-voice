import type {UserConfig} from 'tsdown';
const external=['react','react/jsx-runtime','react-dom','@deepseek-ai/cordis'];
const host:UserConfig={entry:['lib/types/index.js'],outDir:'lib',format:'esm',platform:'node',external:[/^@deepseek-ai\//],target:'es2024',fixedExtension:false,dts:false,clean:false};
const client:UserConfig={entry:{client:'lib/types/client/index.js'},outDir:'lib',format:'cjs',platform:'browser',target:'es2022',dts:false,clean:false,external,noExternal:id=>external.includes(id)?undefined:true,define:{'process.env.NODE_ENV':JSON.stringify('production')},outputOptions:{entryFileNames:'client.js',banner:'window.__ModuleLoader__.load({id:"dsh-breeze-voice",factory:(require)=>{',footer:'return module.exports;}});',intro:'var module={exports:{}};var exports=module.exports;'}};
export default [host,client];
