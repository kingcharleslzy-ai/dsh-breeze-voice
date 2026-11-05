import {describe,it,expect} from 'vitest';
import {ReplyFeed,type EventEntry,type EventSnapshot} from '../src/client/feed.js';
const entry=(type:string,seq:number,data:any={},surfaceOp?:string):EventEntry=>({event:{type,seq,data,...(surfaceOp?{surfaceOp}:{})}});
const snap=(entries:EventEntry[],kind='append'):EventSnapshot=>({revision:1,entries,change:{kind,entries}});
describe('native DSH reply feed',()=>{
  it('speaks only own new turn text, ignores history/reasoning/tool args and durable duplicates',()=>{
    const spoken:string[]=[];let ended=0;const feed=new ReplyFeed(t=>spoken.push(t),()=>ended++);
    feed.reset([entry('assistant/message',1,{turn:1,step:1,message:{content:[{type:'text',text:'旧回答'}]}},'append')]);
    feed.accept(snap([entry('assistant/message',2,{turn:1,step:1,message:{content:[{type:'text',text:'迟到的旧回答'}]}},'append')]));
    feed.accept(snap([entry('turn/start',3,{turn:2})]));
    feed.accept(snap([entry('assistant/live-chunk',3.5,{turn:2,step:1,attemptId:'a',chunk:{type:'reasoning-delta',text:'私有推理。'}})]));
    feed.accept(snap([entry('assistant/live-chunk',3.66,{turn:2,step:1,attemptId:'a',chunk:{type:'tool-call-delta',argumentsDelta:'secret'}})]));
    const live=entry('assistant/live-chunk',3.75,{turn:2,step:1,attemptId:'a',chunk:{type:'text-delta',text:'你好。下一句'}});
    feed.accept(snap([live]));feed.accept(snap([live]));
    feed.accept(snap([entry('assistant/message',4,{turn:2,step:1,message:{content:[{type:'text',text:'你好。下一句结束。'}]}},'append')]));
    feed.accept(snap([entry('turn/end',5,{turn:2})]));
    expect(spoken).toEqual(['你好。','下一句结束。']);expect(ended).toBe(1);
  });
  it('handles durable-only reconnect and strips fenced code/link targets',()=>{
    const spoken:string[]=[];const feed=new ReplyFeed(t=>spoken.push(t),()=>{});feed.reset([]);
    feed.accept(snap([entry('turn/start',0,{turn:1}),entry('assistant/message',1,{turn:1,step:1,message:{content:[{type:'text',text:'请看[说明](https://example.com)。\n```js\nsecret();\n```\n完成。'}]}},'append')],'replace'));
    expect(spoken).toEqual(['请看说明。','完成。']);
  });
  it('does not speak history prepends or other turns',()=>{
    const spoken:string[]=[];const feed=new ReplyFeed(t=>spoken.push(t),()=>{});feed.reset([]);
    feed.accept(snap([entry('turn/start',1,{turn:2})]));
    feed.accept(snap([entry('assistant/message',2,{turn:3,step:1,message:{content:[{type:'text',text:'wrong'}]}},'append')]));
    feed.accept(snap([entry('assistant/message',3,{turn:2,step:1,message:{content:[{type:'text',text:'history'}]}},'append')],'prepend'));
    expect(spoken).toEqual([]);
  });
});
