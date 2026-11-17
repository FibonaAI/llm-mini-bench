import { expect, test } from 'bun:test';
import { AssessmentBudget, run_assessment_sample, type RunnerTask } from '../calibrate_assessment.ts';
import type { GatewayResponse } from './client.ts';
import { load_assessment_bank } from './assessment_bank.ts';
const tool=(id:string)=>({type:'function_call',call_id:id,name:'fixed',arguments:'{}'});
const payload={status:'completed',usage:{input_tokens:10,output_tokens:5},output:[tool('one'),tool('two')]};
const config={max_output_tokens:null,max_turns:null,max_tool_calls:null,timeout:1,timeout_scope:'sample' as const,max_api_retries:0};
const pricing={prompt:0,completion:0};

function fixture(){
 let tools=0,requests=0;const rows:any[]=[];
 const task:RunnerTask={id:'batch',domain:'test',kind:'tool',prompt:'fixed simulator only',tools:[],make_simulator:()=>({call:()=>({sequence:++tools}),grade:()=>({content_score:1})})};
 const client={post_responses_stream:()=>{requests++;return [200,0,{},requests===1?payload:{...payload,output:[],output_text:'done'}] as GatewayResponse;}};
 return {task,client,rows,tools:()=>tools,requests:()=>requests};
}

test('released inventory task accepts two legal transfers in one response and grades the final impossibility report',async()=>{
 const task=load_assessment_bank().tasks.find(task=>task.id==='T02_Inventory_Impossible')!;
 const bodies:any[]=[];let calls=0;
 const client={post_responses_stream:(body:any)=>{
  bodies.push(structuredClone(body));calls++;
  const output=calls===1?[{...tool('inspect'),name:'inspect_inventory'}]:calls===2?[
   {...tool('transfer-a'),name:'transfer_stock',arguments:'{"source":"A","destination":"C","units":1}'},
   {...tool('transfer-b'),name:'transfer_stock',arguments:'{"source":"B","destination":"C","units":1}'}
  ]:[];
  return [200,0,{}, {...payload,output,...(calls===3?{output_text:'{"status":"impossible","max_C":3}'}:{})}] as GatewayResponse;
 }};
 const result=await run_assessment_sample(client,task,{model:'fixture',thinking:'default'},1,config,pricing,new AssessmentBudget(null,null),{write(){}});
 expect(result.status).toBe('completed');expect(result.grade?.content_score).toBe(1);expect(result.tool_trace).toHaveLength(3);
 expect(result.tool_trace.slice(1).map(step=>(step.result.stock as any).C)).toEqual([2,3]);
 expect(bodies.every(body=>!Object.hasOwn(body,'parallel_tool_calls'))).toBe(true);
 expect(bodies[2].input.filter((row:any)=>row.type==='function_call_output').slice(-2).map((row:any)=>row.call_id)).toEqual(['transfer-a','transfer-b']);
});

test('a journal failure between batched tool results stops remaining tools and any continuation',async()=>{
 for(const failAt of [0,1,2]){
  const f=fixture();let results=0;
  await expect(run_assessment_sample(f.client,f.task,{model:'fixture',thinking:'default'},1,config,pricing,new AssessmentBudget(null,null),{write(row){
   if(failAt===0&&row.type==='call'||row.type==='tool_result'&&++results===failAt)throw Error('disk');
   f.rows.push(row);
  }})).rejects.toThrow('disk');
  expect(f.tools()).toBe(failAt);expect(f.requests()).toBe(1);
 }
});

test('cancellation after the first tool prevents the second tool and model continuation',async()=>{
 const f=fixture();
 const observation=await run_assessment_sample(f.client,f.task,{model:'fixture',thinking:'default'},1,config,pricing,new AssessmentBudget(null,null),{write:r=>f.rows.push(r)},()=>f.tools()>0);
 expect(observation.status).toBe('cancelled');expect(f.tools()).toBe(1);expect(f.requests()).toBe(1);expect(observation.tool_trace).toHaveLength(1);
});

test('the sample deadline is checked between tools in the same response',async()=>{
 const f=fixture();let calls=0;
 f.task.make_simulator=()=>({call(){calls++;Bun.sleepSync(20);return {ok:true};},grade:()=>({})});
 const observation=await run_assessment_sample(f.client,f.task,{model:'fixture',thinking:'default'},1,{...config,timeout:.01},pricing,new AssessmentBudget(null,null),{write:r=>f.rows.push(r)});
 expect(observation.status).toBe('api_failure');expect(observation.runner_error).toBe('SampleTimeout');expect(calls).toBe(1);expect(f.requests()).toBe(1);
});

test('recorded legacy tool caps reject an oversized batch before partial simulator changes',async()=>{
 const f=fixture();
 const observation=await run_assessment_sample(f.client,f.task,{model:'fixture',thinking:'default'},1,{...config,max_tool_calls:1},pricing,new AssessmentBudget(null,null),{write:r=>f.rows.push(r)});
 expect(observation.status).toBe('tool_call_limit');expect(f.tools()).toBe(0);expect(f.requests()).toBe(1);
});

test('a transient continuation retry replays both tool outputs without executing their actions again',async()=>{
 const f=fixture(),bodies:any[]=[];let requests=0;
 const client={post_responses_stream:(body:any)=>{bodies.push(structuredClone(body));requests++;return [requests===2?503:200,0,{},requests===1?payload:requests===2?{error:'temporary'}:{...payload,output:[],output_text:'done'}] as GatewayResponse;}};
 const observation=await run_assessment_sample(client,f.task,{model:'fixture',thinking:'default'},1,{...config,max_api_retries:3},pricing,new AssessmentBudget(null,null),{write:r=>f.rows.push(r)},undefined,async()=>{});
 expect(observation.status).toBe('completed');expect(f.tools()).toBe(2);expect(requests).toBe(3);expect(bodies[1]).toEqual(bodies[2]);
 expect(bodies[1].input.filter((row:any)=>row.type==='function_call_output').map((row:any)=>row.call_id)).toEqual(['one','two']);
});
