import {defineTool} from '@deepseek-ai/dsh-tools';
import type {Context} from '@deepseek-ai/cordis';
import {VoiceChatControl} from './chat-control.js';
const output={schema:{type:'object' as const,properties:{result:{type:'string' as const,required:true as const}},additionalProperties:false},render:(_args:unknown,value:{result:string})=>[{type:'text' as const,text:value.result}]};
const fields={
  instruction:{type:'string',description:'1–1000 字，新音色描述草稿；不改变固定音色。要切换声音用 breeze_voice_voices。'},
  asrEngine:{type:'string',enum:['server','dsh'],description:'server 为 4090 中文识别；dsh 为已准备好的原生语音输入。切换前结束通话。'},
  asrHotwords:{type:'string',description:'识别热词，上限 2000 字。'},
  reviewBeforeSend:{type:'boolean',description:'识别后人工确认再发送；下次通话生效。'},
  silenceMs:{type:'integer',description:'断句停顿 400–3000 毫秒，下次通话生效。'},
  bargeIn:{type:'boolean',description:'允许说话打断朗读，下次通话生效。'},
  idleMinutes:{type:'integer',description:'闲置释放模型：0–120 分钟，0 为保持加载。自动同步服务器并返回确认结果。'},
  voicePromptEnabled:{type:'boolean'},voicePrompt:{type:'string',description:'语音模式默认提示词，最多 6000 字，只作用于正在语音连接的会话。'},
  personaEnabled:{type:'boolean'},personaName:{type:'string',description:'当前语音角色名称，最多 80 字。'},personaPrompt:{type:'string',description:'当前语音角色提示词，最多 6000 字；保存一个当前角色，不是多角色库。'},
} as const;
export function voiceToolDefinitions(control:VoiceChatControl){return [
  defineTool({name:'breeze_voice_settings',description:'读取或修改 Breeze 语音插件设置。get 读取 revision；用户明确要求修改时 update，只传要修改的 patch 字段及 revision。与原生侧栏共用持久配置，写后回读；不需要重启或编辑 YAML。作用于当前 profile 的所有语音通话。检查 saved、server_sync 和 effect 后报告结果。音色切换使用 breeze_voice_voices。',timeoutMs:120000,parameters:{action:{type:'string',enum:['get','update']},revision:{type:'integer'},patch:{type:'object',properties:fields,additionalProperties:false}},output,
    async execute(args,exec){const action=args.action??'get';if(action==='get'){if(args.patch!==undefined)throw Error('读取操作不能带 patch');return {result:JSON.stringify(control.snapshot())};}return {result:JSON.stringify(await control.update(args.patch,args.revision!,exec.signal))};}}),
  defineTool({name:'breeze_voice_voices',description:'管理 Breeze 固定参考音色：list 读取真实音色及设置 revision；select 用列表真实 voice_id 和 revision 持久选择，下一段新合成生效；create 按 name/instruction 创建并保存固定参考声音，耗用服务器 GPU，但不自动选中。只在用户要求时 create/select；已有合适音色直接选择。创建超时先 list 核实，禁止自动重试生成。',timeoutMs:240000,parameters:{action:{type:'string',enum:['list','select','create']},voice_id:{type:'string'},revision:{type:'integer'},name:{type:'string'},instruction:{type:'string'}},output,async execute(args,exec){return {result:JSON.stringify(await control.voices(args,exec.signal))};}}),
  defineTool({name:'breeze_voice_service',description:'Breeze 语音服务器：status 检查连接和模型状态；sync_idle 将当前已保存空闲策略同步服务器并验证；release 在用户要求且无通话时释放本插件的语音模型，忙碌时拒绝。通过已有私有连接工作。不会修改连接凭证或其他服务，不启动麦克风，不替用户发消息。',timeoutMs:120000,parameters:{action:{type:'string',enum:['status','sync_idle','release']}},output,async execute(args,exec){return {result:JSON.stringify(await control.service(args.action,exec.signal))};}}),
];}
export function registerVoiceTools(ctx:Context,control:VoiceChatControl){for(const tool of voiceToolDefinitions(control))ctx.tools.register(tool);}
