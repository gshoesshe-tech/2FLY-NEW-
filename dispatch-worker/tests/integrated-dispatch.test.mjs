import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import worker from '../worker/worker-integrated.mjs';
globalThis.crypto ||= webcrypto;

const ORDER='22222222-2222-4222-8222-222222222222';
const PACK1='11111111-1111-4111-8111-111111111111';
const PACK2='33333333-3333-4333-8333-333333333333';
const SHIP='44444444-4444-4444-8444-444444444444';
const ORIGIN='https://2flynumbers.netlify.app';

function d1(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../setup/01_d1_schema.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../setup/02_integrated_dispatch_schema.sql',import.meta.url),'utf8'));
  return {
    raw:db,
    prepare(sql){let args=[];const exec=()=>db.prepare(sql);return {bind(...a){args=a;return this;},async first(){return exec().get(...args)||null;},async all(){return {results:exec().all(...args)};},async run(){return {meta:exec().run(...args)};}};},
    async batch(list){db.exec('BEGIN');try{const results=[];for(const s of list)results.push(await s.all());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}
  };
}

function identityForToken(token){
  if(token==='pack1-token-abcdefghijklmnopqrstuvwxyz')return {id:PACK1,email:'pack1@2fly.test',name:'Packing One',role:'staff',perms:{edit_orders:true,update_tracking:false}};
  if(token==='pack2-token-abcdefghijklmnopqrstuvwxyz')return {id:PACK2,email:'pack2@2fly.test',name:'Packing Two',role:'staff',perms:{edit_orders:true,update_tracking:false}};
  if(token==='ship-token-abcdefghijklmnopqrstuvwxyz')return {id:SHIP,email:'ship@2fly.test',name:'Shipment Staff',role:'staff',perms:{edit_orders:false,update_tracking:true}};
  return null;
}

function installSupabaseMock(env){
  const shippedCalls=[];
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=async(input,options={})=>{
    const url=typeof input==='string'?input:input.url;
    if(!url.startsWith(env.SUPABASE_URL))return nativeFetch(input,options);
    const token=new Headers(options.headers||{}).get('Authorization')?.replace(/^Bearer /,'')||'';
    const ident=identityForToken(token);
    if(url.endsWith('/auth/v1/user'))return ident?Response.json({id:ident.id,email:ident.email}):Response.json({message:'bad token'},{status:401});
    if(url.includes('/rest/v1/profiles?'))return ident?Response.json([{user_id:ident.id,email:ident.email,full_name:ident.name,role:ident.role,active:true}]):Response.json([], {status:401});
    if(url.endsWith('/rest/v1/rpc/get_daily_ops_permissions_v14'))return ident?Response.json(ident.perms):Response.json({}, {status:401});
    if(url.endsWith('/rest/v1/rpc/update_order_operations_v14')){
      if(!ident)return Response.json({message:'bad token'},{status:401});
      const payload=JSON.parse(options.body||'{}');
      shippedCalls.push({token,payload});
      return Response.json({ok:true});
    }
    return Response.json({message:'unhandled supabase mock '+url},{status:404});
  };
  return {shippedCalls,restore(){globalThis.fetch=nativeFetch;}};
}

function setup(){
  const DB=d1(),objects=new Map();
  const env={
    DB,
    PHOTOS:{async put(p,b){objects.set(p,b);},async get(p){return objects.has(p)?{body:objects.get(p)}:null;},async delete(p){objects.delete(p);}},
    objects,
    ALLOWED_ORIGIN:'https://old-tracker.example',
    ALLOWED_ORIGINS:ORIGIN,
    CLEANUP_ENABLED:'false',
    SUPABASE_URL:'https://supabase.example',
    SUPABASE_ANON_KEY:'anon-test'
  };
  const mock=installSupabaseMock(env);
  return {env,mock};
}

function req(path,{method='GET',body,token='pack1-token-abcdefghijklmnopqrstuvwxyz',origin=ORIGIN,contentType='application/json'}={}){
  const headers={Origin:origin,Authorization:'Bearer '+token};
  if(contentType)headers['Content-Type']=contentType;
  return new Request('https://worker.example'+path,{method,headers,body:body===undefined?undefined:body instanceof Uint8Array?body:JSON.stringify(body)});
}

const baseOrder={
  order_id:ORDER,
  order_number:'2FLY-20261111-1234',
  customer_name:'Backdated Test',
  fulfillment_method:'jnt',
  created_at:'2026-11-12T00:30:00.000Z',
  order_date:'2026-11-11',
  status:'ready_to_pack',
  payment_status:'paid',
  tracking_number:''
};

async function j(res){const data=await res.json().catch(()=>({}));return {status:res.status,data};}

async function upload(env,token,stage,byte=0){
  const r=await worker.fetch(req(`/integrated/photos?order_id=${ORDER}&stage=${stage}`,{method:'POST',token,contentType:'image/jpeg',body:new Uint8Array([255,216,255,byte])}),env);
  if(r.status!==200) throw new Error(`upload failed ${r.status}: ${await r.text()}`);
  return (await r.json()).path;
}

test('backdated eligible order queues once using app-entry timestamp; reading alert does not claim it',async()=>{
  const {env,mock}=setup();
  try{
    let r=await j(await worker.fetch(req('/integrated/sync',{method:'POST',body:baseOrder}),env));
    assert.equal(r.status,200);assert.equal(r.data.dispatch.stage,'needs_packing');assert.equal(r.data.dispatch.queued_at,baseOrder.created_at);
    r=await j(await worker.fetch(req('/integrated/sync',{method:'POST',body:baseOrder}),env));assert.equal(r.status,200);
    assert.equal(env.DB.raw.prepare('SELECT count(*) n FROM dispatch_orders').get().n,1);
    assert.equal(env.DB.raw.prepare('SELECT count(*) n FROM dispatch_notifications').get().n,1);
    r=await j(await worker.fetch(req('/integrated/notifications'),env));assert.equal(r.data.unread,1);const n=r.data.notifications[0];
    await worker.fetch(req('/integrated/notifications/read',{method:'POST',body:{id:n.id}}),env);
    const order=env.DB.raw.prepare('SELECT stage,claimed_by FROM dispatch_orders WHERE order_id=?').get(ORDER);assert.equal(order.stage,'needs_packing');assert.equal(order.claimed_by,null);
  }finally{mock.restore();}
});

test('only one packer can claim; packing photo is required before Packed; shipment alert is separate',async()=>{
  const {env,mock}=setup();
  try{
    await worker.fetch(req('/integrated/sync',{method:'POST',body:baseOrder}),env);
    let r=await j(await worker.fetch(req('/integrated/claim',{method:'POST',body:{order_id:ORDER},token:'pack1-token-abcdefghijklmnopqrstuvwxyz'}),env));assert.equal(r.status,200);assert.equal(r.data.order.claimed_name,'Packing One');
    r=await j(await worker.fetch(req('/integrated/claim',{method:'POST',body:{order_id:ORDER},token:'pack2-token-abcdefghijklmnopqrstuvwxyz'}),env));assert.equal(r.status,409);assert.match(r.data.error,/Packing One/);
    r=await j(await worker.fetch(req('/integrated/packed',{method:'POST',body:{order_id:ORDER,photo_path:''},token:'pack1-token-abcdefghijklmnopqrstuvwxyz'}),env));assert.equal(r.status,409);
    const path=await upload(env,'pack1-token-abcdefghijklmnopqrstuvwxyz','packing',1);
    r=await j(await worker.fetch(req('/integrated/packed',{method:'POST',body:{order_id:ORDER,photo_path:path},token:'pack1-token-abcdefghijklmnopqrstuvwxyz'}),env));assert.equal(r.status,200);assert.equal(r.data.order.stage,'packed');
    const photos=env.DB.raw.prepare("SELECT count(*) n FROM dispatch_photos WHERE order_id=? AND state='attached'").get(ORDER);assert.equal(photos.n,1);
    const alerts=env.DB.raw.prepare("SELECT count(*) n FROM dispatch_notifications WHERE audience='shipment'").get();assert.equal(alerts.n,1);
  }finally{mock.restore();}
});

test('waybill photo preserves packing photo, tracking may stay blank, and only handover marks Shipped',async()=>{
  const {env,mock}=setup();
  try{
    await worker.fetch(req('/integrated/sync',{method:'POST',body:baseOrder}),env);
    await worker.fetch(req('/integrated/claim',{method:'POST',body:{order_id:ORDER},token:'pack1-token-abcdefghijklmnopqrstuvwxyz'}),env);
    const first=await upload(env,'pack1-token-abcdefghijklmnopqrstuvwxyz','packing',2);
    await worker.fetch(req('/integrated/packed',{method:'POST',body:{order_id:ORDER,photo_path:first},token:'pack1-token-abcdefghijklmnopqrstuvwxyz'}),env);
    const second=await upload(env,'ship-token-abcdefghijklmnopqrstuvwxyz','waybill',3);
    let r=await j(await worker.fetch(req('/integrated/waybill',{method:'POST',body:{order_id:ORDER,photo_path:second,tracking:''},token:'ship-token-abcdefghijklmnopqrstuvwxyz'}),env));assert.equal(r.status,200);assert.equal(r.data.order.stage,'ready_for_pickup');assert.equal(r.data.order.tracking,'');
    let detail=await j(await worker.fetch(req(`/integrated/order?order_id=${ORDER}`,{token:'ship-token-abcdefghijklmnopqrstuvwxyz'}),env));assert.equal(detail.data.photos.length,2);assert.equal(detail.data.order.stage,'ready_for_pickup');
    r=await j(await worker.fetch(req('/integrated/handover',{method:'POST',body:{order_id:ORDER},token:'ship-token-abcdefghijklmnopqrstuvwxyz'}),env));assert.equal(r.status,200);assert.equal(r.data.order.stage,'shipped');assert.equal(r.data.order.shipped_name,'Shipment Staff');assert.equal(mock.shippedCalls.length,1);assert.equal(mock.shippedCalls[0].payload.p_status,'shipped');assert.equal(mock.shippedCalls[0].payload.p_tracking_number,'');
  }finally{mock.restore();}
});

test('missing-item report and resolution do not change shipment stage',async()=>{
  const {env,mock}=setup();
  try{
    await worker.fetch(req('/integrated/sync',{method:'POST',body:baseOrder}),env);
    await worker.fetch(req('/integrated/claim',{method:'POST',body:{order_id:ORDER},token:'pack1-token-abcdefghijklmnopqrstuvwxyz'}),env);
    const p=await upload(env,'pack1-token-abcdefghijklmnopqrstuvwxyz','packing',4);await worker.fetch(req('/integrated/packed',{method:'POST',body:{order_id:ORDER,photo_path:p},token:'pack1-token-abcdefghijklmnopqrstuvwxyz'}),env);
    const w=await upload(env,'ship-token-abcdefghijklmnopqrstuvwxyz','waybill',5);await worker.fetch(req('/integrated/waybill',{method:'POST',body:{order_id:ORDER,photo_path:w},token:'ship-token-abcdefghijklmnopqrstuvwxyz'}),env);await worker.fetch(req('/integrated/handover',{method:'POST',body:{order_id:ORDER},token:'ship-token-abcdefghijklmnopqrstuvwxyz'}),env);
    const issuePhoto=await upload(env,'pack1-token-abcdefghijklmnopqrstuvwxyz','missing_issue',6);
    let r=await j(await worker.fetch(req('/integrated/missing',{method:'POST',body:{order_id:ORDER,item_key:'BOXERS',item_label:'Boxers',missing_quantity:2,note:'2 pcs missing',photo_path:issuePhoto},token:'pack1-token-abcdefghijklmnopqrstuvwxyz'}),env));assert.equal(r.status,200);const issue=r.data.issue_id;
    assert.equal(env.DB.raw.prepare('SELECT stage FROM dispatch_orders WHERE order_id=?').get(ORDER).stage,'shipped');
    r=await j(await worker.fetch(req('/integrated/missing/resolve',{method:'POST',body:{issue_id:issue,note:'Replacement completed'},token:'ship-token-abcdefghijklmnopqrstuvwxyz'}),env));assert.equal(r.status,200);
    assert.equal(env.DB.raw.prepare('SELECT stage FROM dispatch_orders WHERE order_id=?').get(ORDER).stage,'shipped');assert.equal(env.DB.raw.prepare('SELECT status FROM dispatch_missing_issues WHERE id=?').get(issue).status,'resolved');
  }finally{mock.restore();}
});