// Cloudflare D1 + private R2. Deploy this entire file as the Worker entry point.
const LIMIT=600000, encoder=new TextEncoder();
const err=(message,status=400)=>Object.assign(new Error(message),{status});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const nowISO=()=>new Date().toISOString();
const uuid=()=>crypto.randomUUID();
const validID=s=>typeof s==='string'&&/^[a-f0-9-]{36}$/.test(s);
export async function hash(s){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function randomKey(){return [...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');}
const stmt=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
let integratedSchemaReady=false;
const INTEGRATED_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS dispatch_orders (
    order_id TEXT PRIMARY KEY,
    order_number TEXT NOT NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    fulfillment_method TEXT NOT NULL DEFAULT '',
    source_created_at TEXT NOT NULL,
    source_order_date TEXT NOT NULL DEFAULT '',
    late_input_days INTEGER NOT NULL DEFAULT 0,
    source_status TEXT NOT NULL DEFAULT '',
    source_payment_status TEXT NOT NULL DEFAULT '',
    tracking TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL DEFAULT 'needs_packing'
      CHECK(stage IN ('needs_packing','packing','packed','ready_for_pickup','shipped','cancelled')),
    queued_at TEXT NOT NULL,
    claimed_by TEXT,
    claimed_name TEXT,
    claimed_at TEXT,
    packed_by TEXT,
    packed_name TEXT,
    packed_at TEXT,
    ready_by TEXT,
    ready_name TEXT,
    ready_at TEXT,
    shipped_by TEXT,
    shipped_name TEXT,
    shipped_at TEXT,
    shipped_at_ph TEXT,
    updated_at TEXT NOT NULL,
    last_synced_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS dispatch_orders_stage_queue ON dispatch_orders(stage, queued_at, order_id)`,
  `CREATE INDEX IF NOT EXISTS dispatch_orders_search_order ON dispatch_orders(order_number)`,
  `CREATE INDEX IF NOT EXISTS dispatch_orders_search_customer ON dispatch_orders(customer_name)`,
  `CREATE INDEX IF NOT EXISTS dispatch_orders_tracking ON dispatch_orders(tracking)`,
  `CREATE TABLE IF NOT EXISTS dispatch_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES dispatch_orders(order_id) ON DELETE CASCADE,
    issue_id TEXT,
    event_type TEXT NOT NULL,
    actor_user_id TEXT,
    actor_name TEXT,
    event_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    photo_path TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS dispatch_events_order ON dispatch_events(order_id, event_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS photo_budget (
    id INTEGER PRIMARY KEY CHECK(id=1),
    used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
    max_bytes INTEGER NOT NULL DEFAULT 8000000000
  )`,
  `INSERT OR IGNORE INTO photo_budget(id) VALUES(1)`,
  `CREATE TABLE IF NOT EXISTS dispatch_photos (
    path TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    issue_id TEXT,
    owner_user_id TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 600000),
    stage TEXT NOT NULL CHECK(stage IN ('packing','waybill','additional','missing_issue','missing_resolution')),
    state TEXT NOT NULL CHECK(state IN ('uploading','uploaded','attached','deleting','deleted')),
    created_at TEXT NOT NULL,
    attached_at TEXT,
    deleted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS dispatch_photos_order ON dispatch_photos(order_id, created_at, path)`,
  `CREATE INDEX IF NOT EXISTS dispatch_photos_issue ON dispatch_photos(issue_id, created_at, path)`,
  `CREATE INDEX IF NOT EXISTS dispatch_photos_state_date ON dispatch_photos(state, created_at)`,
  `CREATE TABLE IF NOT EXISTS dispatch_missing_issues (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES dispatch_orders(order_id) ON DELETE CASCADE,
    item_key TEXT NOT NULL DEFAULT '',
    item_label TEXT NOT NULL,
    missing_quantity INTEGER NOT NULL CHECK(missing_quantity > 0),
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
    created_by TEXT NOT NULL,
    created_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_by TEXT,
    resolved_name TEXT,
    resolved_at TEXT,
    resolution_note TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS dispatch_missing_order_status ON dispatch_missing_issues(order_id, status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS dispatch_notifications (
    id TEXT PRIMARY KEY,
    dedup_key TEXT NOT NULL UNIQUE,
    audience TEXT NOT NULL CHECK(audience IN ('packing','shipment')),
    order_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS dispatch_notifications_audience_date ON dispatch_notifications(audience, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS dispatch_notification_reads (
    notification_id TEXT NOT NULL REFERENCES dispatch_notifications(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY(notification_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS dispatch_push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    can_pack INTEGER NOT NULL DEFAULT 0 CHECK(can_pack IN (0,1)),
    can_ship INTEGER NOT NULL DEFAULT 0 CHECK(can_ship IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS dispatch_push_user ON dispatch_push_subscriptions(user_id, active)`,
  `CREATE TRIGGER IF NOT EXISTS dispatch_photo_reserve
    BEFORE INSERT ON dispatch_photos
    BEGIN
      SELECT CASE WHEN (SELECT used_bytes + NEW.bytes > max_bytes FROM photo_budget WHERE id=1)
        THEN RAISE(ABORT,'PHOTO_BUDGET_FULL') END;
      UPDATE photo_budget SET used_bytes = used_bytes + NEW.bytes WHERE id=1;
    END`,
  `CREATE TRIGGER IF NOT EXISTS dispatch_photo_release
    AFTER UPDATE OF state ON dispatch_photos
    WHEN NEW.state='deleted' AND OLD.state<>'deleted'
    BEGIN
      UPDATE photo_budget SET used_bytes = used_bytes - NEW.bytes WHERE id=1;
    END`
];
async function ensureIntegratedSchema(env){
  if(integratedSchemaReady)return;
  for(const sql of INTEGRATED_SCHEMA_STATEMENTS) await env.DB.prepare(sql).run();
  const cols=await env.DB.prepare("PRAGMA table_info(dispatch_orders)").all();
  const names=new Set((cols.results||[]).map(x=>x.name));
  if(!names.has('source_order_date')) await env.DB.prepare("ALTER TABLE dispatch_orders ADD COLUMN source_order_date TEXT NOT NULL DEFAULT ''").run();
  if(!names.has('late_input_days')) await env.DB.prepare("ALTER TABLE dispatch_orders ADD COLUMN late_input_days INTEGER NOT NULL DEFAULT 0").run();
  integratedSchemaReady=true;
}
async function bodyBytes(req,max){const reader=req.body?.getReader();if(!reader)throw err('Request body required.');const chunks=[];let n=0;while(true){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>max){await reader.cancel();throw err('Upload or request is too large.',413);}chunks.push(value);}const out=new Uint8Array(n);let at=0;for(const c of chunks){out.set(c,at);at+=c.length;}return out;}
async function bodyJSON(req){return bodyJSONSized(req,24000);}
async function bodyJSONSized(req,max=24000){try{return JSON.parse(new TextDecoder().decode(await bodyBytes(req,max)));}catch(e){if(e.status)throw e;throw err('Invalid JSON.');}}
async function limited(env,key,max){const now=Math.floor(Date.now()/1000),window=Math.floor(now/900),k=await hash(key+':'+window);const r=await stmt(env,'INSERT INTO login_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',k,now+1800).first();if(r.count>max)throw err('Too many sign-in attempts. Wait 15 minutes and try again.',429);}
async function login(req,env){const d=await bodyJSON(req);const email=String(d.email||'').trim().toLowerCase();await limited(env,'ip:'+req.headers.get('CF-Connecting-IP'),30);await limited(env,'email:'+email,10);
 const key=String(d.password||'');if(email.length>254||!/^[a-f0-9]{64}$/.test(key))throw err('Incorrect email or staff access key.',401);
 const digest=await hash(key);const s=await stmt(env,'SELECT id,name,key_hash FROM staff WHERE email=? AND key_hash=? AND active=1',email,digest).first();if(!s)throw err('Incorrect email or staff access key.',401);
 const token=randomKey(),expires=Math.floor(Date.now()/1000)+43200;
 await stmt(env,'INSERT INTO sessions(token_hash,staff_id,key_hash,expires_at) VALUES(?,?,?,?)',await hash(token),s.id,s.key_hash,expires).run();
 return json({access_token:token,expires_at:expires,user:{id:s.id}});
}
async function auth(req,env){const token=req.headers.get('Authorization')?.replace(/^Bearer /,'');if(!/^[a-f0-9]{64}$/.test(token||''))throw err('Please sign in.',401);const digest=await hash(token);const s=await stmt(env,'SELECT s.id,s.name FROM sessions t JOIN staff s ON s.id=t.staff_id AND s.key_hash=t.key_hash WHERE t.token_hash=? AND t.expires_at>? AND s.active=1',digest,Math.floor(Date.now()/1000)).first();if(!s)throw err('Session expired or staff access revoked. Sign in again.',401);return {...s,tokenHash:digest};}
function text(d,key,max,required=false){const v=String(d[key]??'').trim();if(v.length>max||(required&&!v))throw err('Check '+key+' (maximum '+max+' characters).');return v;}
export function transition(r,action,id,d,staff,at=nowISO()){
 if(!validID(id)||!['create','update','dispatch','followup','resolve'].includes(action))throw err('Invalid operation.');
 const operation=text(d,'operation_id',100,true);if(r?.history.some(h=>h.operation_id===operation))return {record:r,replayed:true};
 if(action==='create'&&r){if(r.created_by===staff.id)return {record:r,replayed:true};throw err('Record ID already exists.',409);}
 if(action!=='create'&&!r)throw err('Record not found.',404);
 if(action==='create'){
  if(!['shipped','missing'].includes(d.kind))throw err('Invalid record type.');
  r={id,kind:d.kind,status:d.kind==='shipped'?'packed':'pending',customer:text(d,'customer',150,true),reference:text(d,'reference',100,true),missing:text(d,'missing',4000,d.kind==='missing'),courier:'',tracking:'',notes:text(d,'notes',4000),ship_date:null,retention_from:null,photos:[],history:[],created_by:staff.id,staff:staff.name,created_at:at};
 }else r=structuredClone(r);
 const tracking=text(d,'tracking',150),courier=text(d,'courier',40),notes=text(d,'notes',4000),stage=d.stage||'additional';
 if(!['','J&T Express','Lalamove','Other'].includes(courier))throw err('Invalid courier.');
 if(action==='dispatch'&&(r.kind!=='shipped'||!['packed','waybill'].includes(r.status)))throw err('Parcel is already shipped or cannot be dispatched.',409);
 if(action==='followup'&&(r.kind!=='missing'||r.status!=='pending'))throw err('Refresh: this missing-item record has changed.',409);
 if(action==='resolve'&&(r.kind!=='missing'||r.status!=='followup'))throw err('Record a follow-up shipment first.',409);
 let photos=[];
 if(['create','update','followup'].includes(action)){
  photos=d.photos??[];if(!Array.isArray(photos)||photos.length>4||(action!=='update'&&!photos.length))throw err('Attach 1–4 photos per upload.');
  if(action==='update'&&!['parcel','waybill','additional'].includes(stage))throw err('Invalid photo type.');
  if(action==='update'&&!photos.length&&(stage==='waybill'||(!tracking&&!notes)))throw err('Add proof, tracking or a note. Waybill stage requires a photo.');
  const paths=photos.map(p=>p.path);if(new Set(paths).size!==paths.length||paths.some(p=>typeof p!=='string'||!/^r2\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.jpg$/.test(p)))throw err('Invalid photo paths.');
  if(r.photos.length+photos.length>500)throw err('This record has reached 500 photos. Create a related record using the same reference.');
  photos=photos.map(p=>({path:p.path,stage:action==='create'?'original':action==='followup'?'followup':stage,staff:staff.name,user_id:staff.id,at}));r.photos.push(...photos);
 }
 if(['dispatch','followup'].includes(action)){
  const date=String(d.ship_date||'');const parsed=new Date(date+'T00:00:00Z');const today=new Date(Date.parse(at)+8*3600000).toISOString().slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(+parsed)||parsed.toISOString().slice(0,10)!==date||date>today)throw err('Enter a valid shipment date.');r.ship_date=date;
 }
 if(action==='dispatch'){r.status='shipped';r.retention_from=new Date(Date.parse(r.ship_date+'T00:00:00+08:00')+86400000).toISOString();}
 if(action==='followup')r.status='followup';
 if(action==='resolve'){r.status='resolved';r.retention_from=at;}
 if(action==='update'&&stage==='waybill'&&r.status==='packed')r.status='waybill';
 if(tracking)r.tracking=tracking;if(courier)r.courier=courier;
 const description=action==='create'?(r.kind==='shipped'?'Parcel packed — shop photos added':'Missing items reported'):action==='update'?(stage==='waybill'?'Waybill attached — proof added':'Photos / tracking updated'):action==='dispatch'?'Handed to courier':action==='followup'?'Missing items shipped':'Marked resolved';
 r.history.push({at,staff:staff.name,action:description,courier,tracking,notes,operation_id:operation});
 if(r.history.length>1000)throw err('Record history limit reached. Create a related record with the same reference.');
 return {record:r,photos,replayed:false};
}
async function save(req,env,s){const {p_action:action,p_id:id,p_data:d}=await bodyJSON(req);if(!d||typeof d!=='object')throw err('Invalid record.');const old=await stmt(env,'SELECT data,version FROM records WHERE id=?',String(id)).first();const result=transition(old?JSON.parse(old.data):null,action,id,d,s);if(result.replayed)return json(id);
 for(const p of result.photos||[]){const found=await stmt(env,"SELECT path FROM photos WHERE path=? AND owner_id=? AND state='uploaded' AND record_id IS NULL",p.path,s.id).first();if(!found)throw err('Photo is unavailable or already used. Remove it and upload again.',409);}
 const data=JSON.stringify(result.record);if(encoder.encode(data).length>1500000)throw err('Record is full. Create a related record with the same order reference.');
 try{if(!old)await stmt(env,'INSERT INTO records(id,data) VALUES(?,?)',id,data).run();else{const update=await stmt(env,'UPDATE records SET data=?,version=version+1 WHERE id=? AND version=?',data,id,old.version).run();if(!update.meta.changes)throw err('Another staff member updated this record. Retry to merge your upload.',409);}}
 catch(e){if(e.status)throw e;if(String(e).includes('PHOTO_NOT_READY'))throw err('Photo expired or was already attached. Upload it again.',409);if(String(e).includes('UNIQUE'))throw err('Record changed. Refresh and check before retrying.',409);throw e;}
 return json(id);
}
async function list(env,url){const id=url.searchParams.get('id'),ref=url.searchParams.get('reference');if(id){const r=await stmt(env,'SELECT data FROM records WHERE id=?',id).first();return json(r?[JSON.parse(r.data)]:[]);}
 if(ref){const rows=await stmt(env,'SELECT data FROM records WHERE reference=? AND id<>? ORDER BY created_at DESC LIMIT 50',ref,url.searchParams.get('exclude')||'').all();return json(rows.results.map(r=>JSON.parse(r.data)));}
 const kind=url.searchParams.get('kind')||'shipped',status=url.searchParams.get('status')||'all',q=(url.searchParams.get('q')||'').slice(0,150),offset=Math.max(0,Math.min(1000000,parseInt(url.searchParams.get('offset'))||0));
 let where='kind=?',args=[kind];if(status!=='all'){where+=' AND status=?';args.push(status);}if(q){where+=' AND (instr(lower(customer),lower(?))>0 OR instr(lower(reference),lower(?))>0 OR instr(lower(tracking),lower(?))>0)';args.push(q,q,q);}
 const [count,rows]=await env.DB.batch([stmt(env,'SELECT count(*) AS n FROM records WHERE '+where,...args),stmt(env,'SELECT data FROM records WHERE '+where+' ORDER BY created_at DESC,id DESC LIMIT 30 OFFSET ?',...args,offset)]);
 return json({total:count.results[0].n,records:rows.results.map(r=>JSON.parse(r.data))});
}
async function upload(req,env,s){const bytes=await bodyBytes(req,LIMIT);if(bytes.length<4||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw err('Use the website to upload a compressed JPG.');const path=`r2/${s.id}/${uuid()}.jpg`;
 try{await stmt(env,"INSERT INTO photos(path,owner_id,bytes,state,created_at) VALUES(?,?,?,'uploading',?)",path,s.id,bytes.length,nowISO()).run();}catch(e){if(String(e).includes('PHOTO_BUDGET_FULL'))throw err('Photo storage safety limit reached (8 GB). Contact the owner.',409);throw e;}
 await env.PHOTOS.put(path,bytes,{httpMetadata:{contentType:'image/jpeg'}});await stmt(env,"UPDATE photos SET state='uploaded' WHERE path=? AND state='uploading'",path).run();return json({path,bytes:bytes.length});
}
async function photo(env,url,s){const path=url.searchParams.get('path')||'';const p=await stmt(env,'SELECT state,owner_id FROM photos WHERE path=?',path).first();if(!p)throw err('Photo not found.',404);if(['deleting','deleted'].includes(p.state))throw err('Photo removed after the retention period.',410);if(p.state!=='attached'&&p.owner_id!==s.id)throw err('Photo is not attached.',403);const o=await env.PHOTOS.get(path);if(!o)throw err('Photo unavailable.',404);return new Response(o.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}

// ============================================================================
// Integrated 2FLY Numbers Dispatch API.
// This section uses the EXISTING Supabase session for identity/permissions,
// while Dispatch workflow state lives in D1 and photo bytes live in private R2.
// Legacy standalone tracker endpoints above remain unchanged.
// ============================================================================
function allowedOrigins(env){
 const values=[];
 if(env.ALLOWED_ORIGIN)values.push(env.ALLOWED_ORIGIN);
 if(env.ALLOWED_ORIGINS)values.push(...String(env.ALLOWED_ORIGINS).split(',').map(x=>x.trim()).filter(Boolean));
 return [...new Set(values.map(x=>x.replace(/\/$/,'')))];
}
function permissionValue(p,key){return Boolean(p?.[key]??p?.['can_'+key]);}
function phDate(at=nowISO()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));}
function phDateTime(at=nowISO()){return new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true}).format(new Date(at));}
function integratedStageLabel(stage){return ({needs_packing:'Needs packing',packing:'Packing',packed:'Packed',ready_for_pickup:'Ready for pickup',shipped:'Shipped',cancelled:'Cancelled'})[stage]||stage;}
async function supaFetch(env,token,path,options={}){
 if(!env.SUPABASE_URL||!env.SUPABASE_ANON_KEY)throw err('Integrated Dispatch is not configured. Add SUPABASE_URL and SUPABASE_ANON_KEY to the Worker.',503);
 const base=String(env.SUPABASE_URL).replace(/\/$/,'');
 const headers=new Headers(options.headers||{});headers.set('apikey',env.SUPABASE_ANON_KEY);headers.set('Authorization','Bearer '+token);
 if(options.body&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
 return fetch(base+path,{...options,headers});
}
async function supabaseAuth(req,env){
 const token=req.headers.get('Authorization')?.replace(/^Bearer\s+/,'')||'';
 if(token.length<20)throw err('Please sign in to 2FLY Numbers.',401);
 const userRes=await supaFetch(env,token,'/auth/v1/user');
 if(!userRes.ok)throw err('2FLY Numbers session expired. Sign in again.',401);
 const user=await userRes.json();if(!user?.id)throw err('2FLY Numbers session is invalid.',401);
 const profileRes=await supaFetch(env,token,`/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}&select=user_id,email,full_name,role,active&limit=1`);
 if(!profileRes.ok)throw err('Could not read the 2FLY staff profile.',503);
 const profiles=await profileRes.json(),profile=profiles?.[0];
 if(!profile||profile.active===false)throw err('This 2FLY staff account is inactive.',403);
 let permissions={};
 if(!['owner','admin'].includes(profile.role)){
  const permRes=await supaFetch(env,token,'/rest/v1/rpc/get_daily_ops_permissions_v14',{method:'POST',body:'{}'});
  if(!permRes.ok)throw err('Could not read the staff permissions.',503);
  permissions=await permRes.json()||{};
 }
 const management=['owner','admin'].includes(profile.role);
 return {id:user.id,email:profile.email||user.email||'',name:profile.full_name||profile.email||user.email||'2FLY Staff',role:profile.role||'staff',token,
  canPack:management||permissionValue(permissions,'edit_orders'),
  canShip:management||permissionValue(permissions,'update_tracking'),
  management};
}
function requirePack(s){if(!s.canPack)throw err('This account does not have packing permission.',403);}
function requireShip(s){if(!s.canShip)throw err('This account does not have shipment permission.',403);}
function validOrderId(v){return typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);}
function normalizeFulfillment(v){const raw=String(v||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');if(raw==='jnt'||raw==='jt')return'jnt';if(raw==='lalamove')return'lalamove';if(raw==='walkin'||raw==='pickup'||raw==='walkinpickup')return'walk_in';return String(v||'').trim().toLowerCase();}
function dispatchEligible(d){
 const status=String(d.status||d.source_status||'').toLowerCase(),method=normalizeFulfillment(d.fulfillment_method);
 return ['jnt','lalamove'].includes(method)&&!['cancelled','refunded','shipped','delivered'].includes(status);
}
function lateInputDays(orderDate,createdAt){
 const d=String(orderDate||'').slice(0,10);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!createdAt)return 0;
 const entered=phDate(createdAt);
 const a=Date.parse(d+'T00:00:00Z'),b=Date.parse(entered+'T00:00:00Z');
 return Number.isFinite(a)&&Number.isFinite(b)?Math.max(0,Math.floor((b-a)/86400000)):0;
}
function cleanDispatchInput(d){
 const order_id=String(d.order_id||d.id||'');if(!validOrderId(order_id))throw err('Invalid order ID.');
 const order_number=String(d.order_number||'').trim().slice(0,100);if(!order_number)throw err('Order number is required.');
 const source_created_at=String(d.created_at||d.source_created_at||'').trim();if(!source_created_at||!Number.isFinite(Date.parse(source_created_at)))throw err('Order entry time is required.');
 const source_order_date=String(d.order_date||d.source_order_date||'').trim().slice(0,10);
 return {order_id,order_number,customer_name:String(d.customer_name||'').trim().slice(0,150),fulfillment_method:normalizeFulfillment(d.fulfillment_method),source_created_at,source_order_date,
  source_status:String(d.status||d.source_status||'').toLowerCase(),source_payment_status:String(d.payment_status||d.source_payment_status||'').toLowerCase(),tracking:String(d.tracking_number||d.tracking||'').trim().slice(0,150)};
}
async function insertEvent(env,orderId,type,s,note='',photoPath='',issueId=null,at=nowISO()){
 await stmt(env,'INSERT INTO dispatch_events(order_id,issue_id,event_type,actor_user_id,actor_name,event_at,note,photo_path) VALUES(?,?,?,?,?,?,?,?)',orderId,issueId,type,s?.id||null,s?.name||'System',at,String(note||'').slice(0,4000),photoPath||null).run();
}
async function insertNotification(env,audience,orderId,orderNumber,type,ctx,bodyOverride=''){
 const dedup=`${type}:${orderId}`,id=uuid(),at=nowISO();
 const body=bodyOverride||(type==='packing'?`New order ${orderNumber} needs packing`:`Order ${orderNumber} packed — ready for waybill`);
 const title=type==='late_input'?'2FLY URGENT':'2FLY Dispatch';
 const result=await stmt(env,'INSERT OR IGNORE INTO dispatch_notifications(id,dedup_key,audience,order_id,title,body,created_at) VALUES(?,?,?,?,?,?,?)',id,dedup,audience,orderId,title,body,at).run();
 if(result.meta?.changes){const work=pushAudience(env,audience,{title,body,order_id:orderId}).catch(e=>console.error('Push delivery failed',String(e)));if(ctx?.waitUntil)ctx.waitUntil(work);else work.catch(()=>{});}
}
async function syncDispatchOne(env,s,input,ctx){
 const d=cleanDispatchInput(input),at=nowISO(),lateDays=lateInputDays(d.source_order_date,d.source_created_at);
 let row=await stmt(env,'SELECT * FROM dispatch_orders WHERE order_id=?',d.order_id).first();
 const terminal=['cancelled','refunded'].includes(d.source_status)?'cancelled':['shipped','delivered'].includes(d.source_status)?'shipped':null;
 if(!row){
  if(!dispatchEligible(d)||terminal)return null;
  await stmt(env,`INSERT INTO dispatch_orders(order_id,order_number,customer_name,fulfillment_method,source_created_at,source_order_date,late_input_days,source_status,source_payment_status,tracking,stage,queued_at,updated_at,last_synced_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,'needs_packing',?,?,?)`,d.order_id,d.order_number,d.customer_name,d.fulfillment_method,d.source_created_at,d.source_order_date,lateDays,d.source_status,d.source_payment_status,d.tracking,d.source_created_at,at,at).run();
  const paid=['paid','overpaid'].includes(d.source_payment_status);
  const lateNote=lateDays>0?` Late input by ${lateDays} day${lateDays===1?'':'s'}.`:'';
  await insertEvent(env,d.order_id,'queued',s,`Entered Needs packing from 2FLY Numbers.${lateNote}`,'',null,at);
  if(lateDays>0){
   const dateLabel=d.source_order_date||'earlier date';
   const paymentNote=paid?'':' — PAYMENT PENDING';
   await insertNotification(env,'packing',d.order_id,d.order_number,'late_input',ctx,`🚨 LATE INPUT: Order ${d.order_number} dated ${dateLabel} was entered ${lateDays} day${lateDays===1?'':'s'} late — PRIORITIZE PACKING${paymentNote}`);
  }else{
   const body=paid?`New order ${d.order_number} needs packing`:`New order ${d.order_number} added — PAYMENT PENDING, prepare for packing`;
   await insertNotification(env,'packing',d.order_id,d.order_number,'new_order',ctx,body);
  }
  row=await stmt(env,'SELECT * FROM dispatch_orders WHERE order_id=?',d.order_id).first();return row;
 }
 let nextStage=row.stage;
 if(terminal==='cancelled'&&row.stage!=='shipped')nextStage='cancelled';
 if(terminal==='shipped')nextStage='shipped';
 await stmt(env,`UPDATE dispatch_orders SET order_number=?,customer_name=?,fulfillment_method=?,source_order_date=?,late_input_days=?,source_status=?,source_payment_status=?,tracking=CASE WHEN ?<>'' THEN ? ELSE tracking END,stage=?,updated_at=?,last_synced_at=?,version=version+1 WHERE order_id=?`,
  d.order_number,d.customer_name,d.fulfillment_method,d.source_order_date,lateDays,d.source_status,d.source_payment_status,d.tracking,d.tracking,nextStage,at,at,d.order_id).run();
 return stmt(env,'SELECT * FROM dispatch_orders WHERE order_id=?',d.order_id).first();
}
async function integratedSync(req,env,s,ctx){const d=await bodyJSONSized(req,60000);const row=await syncDispatchOne(env,s,d,ctx);return json({ok:true,dispatch:row});}
async function integratedSyncMany(req,env,s,ctx){const d=await bodyJSONSized(req,600000),rows=Array.isArray(d.orders)?d.orders:[];if(rows.length>300)throw err('Sync at most 300 orders at a time.');let created=0,seen=0;for(const item of rows){const before=await stmt(env,'SELECT 1 AS x FROM dispatch_orders WHERE order_id=?',String(item.order_id||item.id||'')).first();const r=await syncDispatchOne(env,s,item,ctx);if(r){seen++;if(!before)created++;}}return json({ok:true,created,seen});}
async function integratedList(env,url){
 const q=String(url.searchParams.get('q')||'').trim().slice(0,150),stage=String(url.searchParams.get('stage')||'all'),limit=Math.max(1,Math.min(500,parseInt(url.searchParams.get('limit'))||200));let where='1=1',args=[];
 if(stage!=='all'){where+=' AND d.stage=?';args.push(stage);}if(q){where+=' AND (instr(lower(d.order_number),lower(?))>0 OR instr(lower(d.customer_name),lower(?))>0 OR instr(lower(d.tracking),lower(?))>0)';args.push(q,q,q);}
 const sql=`SELECT d.*,(SELECT count(*) FROM dispatch_photos p WHERE p.order_id=d.order_id AND p.state='attached') AS photo_count,(SELECT count(*) FROM dispatch_missing_issues i WHERE i.order_id=d.order_id AND i.status='open') AS open_issue_count FROM dispatch_orders d WHERE ${where} ORDER BY CASE WHEN d.stage='needs_packing' THEN 0 WHEN d.stage='packing' THEN 1 WHEN d.stage='packed' THEN 2 WHEN d.stage='ready_for_pickup' THEN 3 WHEN d.stage='shipped' THEN 4 ELSE 5 END,CASE WHEN d.stage='needs_packing' THEN d.late_input_days ELSE 0 END DESC,d.queued_at ASC,d.updated_at DESC LIMIT ?`;
 args.push(limit);const rows=await stmt(env,sql,...args).all();return json({records:rows.results});
}
async function integratedGet(env,url){const id=String(url.searchParams.get('order_id')||'');if(!validOrderId(id))throw err('Invalid order ID.');const order=await stmt(env,'SELECT * FROM dispatch_orders WHERE order_id=?',id).first();if(!order)return json({order:null,photos:[],events:[],issues:[]});const [photos,events,issues]=await env.DB.batch([
 stmt(env,"SELECT path,order_id,issue_id,owner_user_id,owner_name,bytes,stage,state,created_at,attached_at FROM dispatch_photos WHERE order_id=? AND state='attached' ORDER BY created_at,path",id),
 stmt(env,'SELECT * FROM dispatch_events WHERE order_id=? ORDER BY event_at DESC,id DESC LIMIT 500',id),
 stmt(env,'SELECT * FROM dispatch_missing_issues WHERE order_id=? ORDER BY created_at DESC,id DESC',id)
 ]);return json({order,photos:photos.results,events:events.results,issues:issues.results});}
async function integratedClaim(req,env,s){requirePack(s);const d=await bodyJSON(req),id=String(d.order_id||'');if(!validOrderId(id))throw err('Invalid order ID.');const at=nowISO();const claimed=await stmt(env,`UPDATE dispatch_orders SET stage='packing',claimed_by=?,claimed_name=?,claimed_at=?,updated_at=?,version=version+1 WHERE order_id=? AND stage='needs_packing' AND claimed_by IS NULL RETURNING *`,s.id,s.name,at,at,id).first();
 if(claimed){await insertEvent(env,id,'packing_started',s,`Packing — ${s.name}`,'',null,at);return json({ok:true,order:claimed});}
 const current=await stmt(env,'SELECT * FROM dispatch_orders WHERE order_id=?',id).first();if(!current)throw err('Dispatch order not found.',404);if(current.stage==='packing'){if(current.claimed_by===s.id)return json({ok:true,order:current});throw err(`Already being packed by ${current.claimed_name||'another staff member'}.`,409);}throw err(`Order is already ${integratedStageLabel(current.stage)}.`,409);
}
async function integratedUpload(req,env,s,url){
 const orderId=String(url.searchParams.get('order_id')||''),stage=String(url.searchParams.get('stage')||'additional');if(!validOrderId(orderId))throw err('Invalid order ID.');if(!['packing','waybill','additional','missing_issue','missing_resolution'].includes(stage))throw err('Invalid photo stage.');
 if(stage==='packing')requirePack(s);else if(stage==='waybill')requireShip(s);else if(!s.canPack&&!s.canShip)throw err('This account cannot upload Dispatch proof.',403);
 const exists=await stmt(env,'SELECT order_id FROM dispatch_orders WHERE order_id=?',orderId).first();if(!exists)throw err('Dispatch order not found.',404);
 const bytes=await bodyBytes(req,LIMIT);if(bytes.length<4||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw err('Use the website to upload a compressed JPG.');const path=`integrated/${orderId}/${uuid()}.jpg`,at=nowISO();
 try{await stmt(env,"INSERT INTO dispatch_photos(path,order_id,owner_user_id,owner_name,bytes,stage,state,created_at) VALUES(?,?,?,?,?,?,'uploading',?)",path,orderId,s.id,s.name,bytes.length,stage,at).run();}catch(e){if(String(e).includes('PHOTO_BUDGET_FULL'))throw err('Photo storage safety limit reached (8 GB). Contact the owner.',409);throw e;}
 try{await env.PHOTOS.put(path,bytes,{httpMetadata:{contentType:'image/jpeg'}});await stmt(env,"UPDATE dispatch_photos SET state='uploaded' WHERE path=? AND state='uploading'",path).run();}catch(e){console.error('Integrated photo upload failed',String(e));throw err('Photo upload failed. Try again.',503);}return json({path,bytes:bytes.length});
}
async function assertUploadedPhoto(env,path,orderId,s,expectedStage){const p=await stmt(env,"SELECT * FROM dispatch_photos WHERE path=? AND order_id=? AND owner_user_id=? AND state='uploaded'",path,orderId,s.id).first();if(!p)throw err('Photo is unavailable, expired, or already attached.',409);if(expectedStage&&p.stage!==expectedStage)throw err('Photo was uploaded for a different step.',409);return p;}
async function attachPhoto(env,path,issueId=null,at=nowISO()){await stmt(env,"UPDATE dispatch_photos SET state='attached',issue_id=?,attached_at=? WHERE path=? AND state='uploaded'",issueId,at,path).run();}
async function integratedPacked(req,env,s,ctx){requirePack(s);const d=await bodyJSON(req),id=String(d.order_id||''),path=String(d.photo_path||'');if(!validOrderId(id))throw err('Invalid order ID.');const order=await stmt(env,'SELECT * FROM dispatch_orders WHERE order_id=?',id).first();if(!order)throw err('Dispatch order not found.',404);if(order.stage==='packed'||order.stage==='ready_for_pickup'||order.stage==='shipped')return json({ok:true,order});if(order.stage!=='packing'||order.claimed_by!==s.id)throw err(order.stage==='packing'?`Packing is assigned to ${order.claimed_name||'another staff member'}.`:'Start packing before saving the parcel proof.',409);await assertUploadedPhoto(env,path,id,s,'packing');const at=nowISO();await attachPhoto(env,path,null,at);const updated=await stmt(env,`UPDATE dispatch_orders SET stage='packed',packed_by=?,packed_name=?,packed_at=?,updated_at=?,version=version+1 WHERE order_id=? AND stage='packing' AND claimed_by=? RETURNING *`,s.id,s.name,at,at,id,s.id).first();if(!updated)throw err('Order changed. Refresh before retrying.',409);await insertEvent(env,id,'packed',s,'Packing proof saved.',path,null,at);await insertNotification(env,'shipment',id,updated.order_number,'shipment',ctx);return json({ok:true,order:updated});}
async function integratedWaybill(req,env,s){requireShip(s);const d=await bodyJSON(req),id=String(d.order_id||''),path=String(d.photo_path||''),tracking=String(d.tracking||'').trim().slice(0,150);if(!validOrderId(id))throw err('Invalid order ID.');const order=await stmt(env,'SELECT * FROM dispatch_orders WHERE order_id=?',id).first();if(!order)throw err('Dispatch order not found.',404);if(!['packed','ready_for_pickup'].includes(order.stage))throw err(`Order is ${integratedStageLabel(order.stage)}. It must be Packed before adding the waybill.`,409);if(path){await assertUploadedPhoto(env,path,id,s,'waybill');await attachPhoto(env,path,null,nowISO());}else if(order.stage==='packed')throw err('Add the waybill photo first.');const at=nowISO();const updated=await stmt(env,`UPDATE dispatch_orders SET stage='ready_for_pickup',tracking=CASE WHEN ?<>'' THEN ? ELSE tracking END,ready_by=COALESCE(ready_by,?),ready_name=COALESCE(ready_name,?),ready_at=COALESCE(ready_at,?),updated_at=?,version=version+1 WHERE order_id=? RETURNING *`,tracking,tracking,s.id,s.name,at,at,id).first();await insertEvent(env,id,path?'waybill_added':'tracking_updated',s,tracking?`Tracking: ${tracking}`:'Waybill proof saved.',path||'',null,at);return json({ok:true,order:updated});}
async function integratedAttachAdditional(req,env,s){
 const d=await bodyJSON(req),id=String(d.order_id||''),path=String(d.photo_path||''),note=String(d.note||'').trim().slice(0,4000);
 if(!s.canPack&&!s.canShip)throw err('This account cannot add Dispatch proof.',403);if(!validOrderId(id)||!path)throw err('Order ID and photo are required.');
 const order=await stmt(env,'SELECT * FROM dispatch_orders WHERE order_id=?',id).first();if(!order)throw err('Dispatch order not found.',404);
 await assertUploadedPhoto(env,path,id,s,'additional');const at=nowISO();await attachPhoto(env,path,null,at);await insertEvent(env,id,'additional_proof_added',s,note||'Additional Dispatch proof added.',path,null,at);return json({ok:true});
}
async function integratedMissingList(env,url){
 const q=String(url.searchParams.get('q')||'').trim().slice(0,150),status=String(url.searchParams.get('status')||'all'),limit=Math.max(1,Math.min(500,parseInt(url.searchParams.get('limit'))||200));let where='1=1',args=[];
 if(status!=='all'){where+=' AND i.status=?';args.push(status);}if(q){where+=' AND (instr(lower(d.order_number),lower(?))>0 OR instr(lower(d.customer_name),lower(?))>0 OR instr(lower(d.tracking),lower(?))>0 OR instr(lower(i.item_label),lower(?))>0)';args.push(q,q,q,q);}
 const rows=await stmt(env,`SELECT i.*,d.order_number,d.customer_name,d.tracking,d.stage AS shipment_stage,d.fulfillment_method FROM dispatch_missing_issues i JOIN dispatch_orders d ON d.order_id=i.order_id WHERE ${where} ORDER BY CASE WHEN i.status='open' THEN 0 ELSE 1 END,i.created_at ASC LIMIT ?`,...args,limit).all();return json({issues:rows.results});
}
async function integratedTracking(req,env,s){requireShip(s);const d=await bodyJSON(req),id=String(d.order_id||''),tracking=String(d.tracking||'').trim().slice(0,150);if(!validOrderId(id)||!tracking)throw err('Order ID and tracking number are required.');const at=nowISO();const updated=await stmt(env,'UPDATE dispatch_orders SET tracking=?,updated_at=?,version=version+1 WHERE order_id=? RETURNING *',tracking,at,id).first();if(!updated)throw err('Dispatch order not found.',404);await insertEvent(env,id,'tracking_updated',s,`Tracking: ${tracking}`,'',null,at);return json({ok:true,order:updated});}
async function markSupabaseShipped(env,s,order){
 const payload={p_order_id:order.order_id,p_status:'shipped',p_fulfillment_method:order.fulfillment_method,p_tracking_number:order.tracking||'',p_actual_courier_cost:null,p_shipped_date:phDate(),p_delivered_date:null,p_customer_update_note:'',p_status_note:`Courier handover confirmed by ${s.name} through Dispatch`};
 const response=await supaFetch(env,s.token,'/rest/v1/rpc/update_order_operations_v14',{method:'POST',body:JSON.stringify(payload)});if(!response.ok){const t=await response.text();throw err('Could not mark the order shipped in 2FLY Numbers: '+(t||response.statusText),409);}return true;
}
async function integratedHandover(req,env,s){requireShip(s);const d=await bodyJSON(req),id=String(d.order_id||'');if(!validOrderId(id))throw err('Invalid order ID.');let order=await stmt(env,'SELECT * FROM dispatch_orders WHERE order_id=?',id).first();if(!order)throw err('Dispatch order not found.',404);if(order.stage==='shipped')return json({ok:true,order});if(order.stage!=='ready_for_pickup')throw err('Add the waybill proof before confirming courier handover.',409);if(!['paid','overpaid'].includes(String(order.source_payment_status||'').toLowerCase()))throw err('Payment is not verified yet. Confirm payment before courier handover.',409);if(d.tracking){const tracking=String(d.tracking).trim().slice(0,150);await stmt(env,'UPDATE dispatch_orders SET tracking=?,updated_at=? WHERE order_id=?',tracking,nowISO(),id).run();order={...order,tracking};}
 await markSupabaseShipped(env,s,order);const at=nowISO();const phAt=phDateTime(at);const updated=await stmt(env,`UPDATE dispatch_orders SET stage='shipped',source_status='shipped',shipped_by=?,shipped_name=?,shipped_at=?,shipped_at_ph=?,updated_at=?,last_synced_at=?,version=version+1 WHERE order_id=? RETURNING *`,s.id,s.name,at,phAt,at,at,id).first();await insertEvent(env,id,'handed_to_courier',s,`Courier handover confirmed — ${phAt} Philippine time.`,'',null,at);return json({ok:true,order:updated});}
async function integratedIssueCreate(req,env,s){if(!s.canPack&&!s.canShip)throw err('This account cannot report missing items.',403);const d=await bodyJSON(req),orderId=String(d.order_id||''),photo=String(d.photo_path||''),qty=parseInt(d.missing_quantity);if(!validOrderId(orderId)||!Number.isInteger(qty)||qty<=0)throw err('Order and missing quantity are required.');const order=await stmt(env,'SELECT * FROM dispatch_orders WHERE order_id=?',orderId).first();if(!order)throw err('Dispatch order not found.',404);await assertUploadedPhoto(env,photo,orderId,s,'missing_issue');const id=uuid(),at=nowISO(),itemKey=String(d.item_key||'').slice(0,200),itemLabel=String(d.item_label||'').trim().slice(0,300),note=String(d.note||'').trim().slice(0,4000);if(!itemLabel||!note)throw err('Select the missing item and add a note.');await attachPhoto(env,photo,id,at);await stmt(env,`INSERT INTO dispatch_missing_issues(id,order_id,item_key,item_label,missing_quantity,note,status,created_by,created_name,created_at) VALUES(?,?,?,?,?,?,'open',?,?,?)`,id,orderId,itemKey,itemLabel,qty,note,s.id,s.name,at).run();await insertEvent(env,orderId,'missing_item_reported',s,`${qty} × ${itemLabel}: ${note}`,photo,id,at);return json({ok:true,issue_id:id});}
async function integratedIssueResolve(req,env,s){if(!s.canPack&&!s.canShip)throw err('This account cannot resolve missing items.',403);const d=await bodyJSON(req),issueId=String(d.issue_id||''),note=String(d.note||'').trim().slice(0,4000),photo=String(d.photo_path||'');const issue=await stmt(env,"SELECT * FROM dispatch_missing_issues WHERE id=? AND status='open'",issueId).first();if(!issue)throw err('Open missing-item report not found.',404);const at=nowISO();if(photo){await assertUploadedPhoto(env,photo,issue.order_id,s,'missing_resolution');await attachPhoto(env,photo,issueId,at);}await stmt(env,`UPDATE dispatch_missing_issues SET status='resolved',resolved_by=?,resolved_name=?,resolved_at=?,resolution_note=? WHERE id=? AND status='open'`,s.id,s.name,at,note,issueId).run();await insertEvent(env,issue.order_id,'missing_item_resolved',s,note||'Missing-item report resolved.',photo,issueId,at);return json({ok:true});}
async function integratedPhoto(env,url,s){const path=String(url.searchParams.get('path')||'');const p=await stmt(env,'SELECT state,owner_user_id FROM dispatch_photos WHERE path=?',path).first();if(!p)throw err('Photo not found.',404);if(['deleting','deleted'].includes(p.state))throw err('Photo removed after the retention period.',410);if(p.state!=='attached'&&p.owner_user_id!==s.id)throw err('Photo is not attached.',403);const o=await env.PHOTOS.get(path);if(!o)throw err('Photo unavailable.',404);return new Response(o.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
function notificationAudiences(s){const a=[];if(s.canPack)a.push('packing');if(s.canShip)a.push('shipment');return a;}
async function integratedNotifications(env,s,url){const audiences=notificationAudiences(s);if(!audiences.length)return json({unread:0,notifications:[]});const limit=Math.max(1,Math.min(100,parseInt(url.searchParams.get('limit'))||30)),placeholders=audiences.map(()=>'?').join(',');const rows=await stmt(env,`SELECT n.*,CASE WHEN r.user_id IS NULL THEN 0 ELSE 1 END AS is_read FROM dispatch_notifications n LEFT JOIN dispatch_notification_reads r ON r.notification_id=n.id AND r.user_id=? WHERE n.audience IN (${placeholders}) ORDER BY n.created_at DESC LIMIT ?`,s.id,...audiences,limit).all();const unread=rows.results.filter(x=>!x.is_read).length;return json({unread,notifications:rows.results});}
async function integratedNotificationRead(req,env,s){const d=await bodyJSON(req),ids=(Array.isArray(d.ids)?d.ids:[d.id]).filter(Boolean).slice(0,100),at=nowISO();for(const id of ids)await stmt(env,'INSERT OR IGNORE INTO dispatch_notification_reads(notification_id,user_id,read_at) VALUES(?,?,?)',String(id),s.id,at).run();return json({ok:true});}
async function integratedPushConfig(env){return json({enabled:Boolean(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_KEY&&env.VAPID_SUBJECT),publicKey:env.VAPID_PUBLIC_KEY||''});}
async function integratedPushSubscribe(req,env,s){const d=await bodyJSONSized(req,60000),sub=d.subscription||d,endpoint=String(sub.endpoint||'').slice(0,2000),p256dh=String(sub.keys?.p256dh||'').slice(0,500),authKey=String(sub.keys?.auth||'').slice(0,500);if(!/^https:\/\//.test(endpoint)||!p256dh||!authKey)throw err('Invalid push subscription.');const at=nowISO();await stmt(env,`INSERT INTO dispatch_push_subscriptions(endpoint,user_id,p256dh,auth,can_pack,can_ship,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,can_pack=excluded.can_pack,can_ship=excluded.can_ship,active=1,updated_at=excluded.updated_at`,endpoint,s.id,p256dh,authKey,s.canPack?1:0,s.canShip?1:0,at,at).run();return json({ok:true});}
async function integratedPushUnsubscribe(req,env,s){const d=await bodyJSONSized(req,60000),endpoint=String(d.endpoint||'');await stmt(env,'UPDATE dispatch_push_subscriptions SET active=0,updated_at=? WHERE endpoint=? AND user_id=?',nowISO(),endpoint,s.id).run();return json({ok:true});}
async function pushAudience(env,audience,n){
 if(!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_KEY||!env.VAPID_SUBJECT)return;
 let sender;try{({sendPushNotification:sender}=await import('@mmmike/web-push/send'));}catch(e){console.error('Web Push package unavailable',String(e));return;}
 const col=audience==='packing'?'can_pack':'can_ship';const rows=await stmt(env,`SELECT endpoint,p256dh,auth FROM dispatch_push_subscriptions WHERE active=1 AND ${col}=1`).all();
 const payload={title:n.title||'2FLY Dispatch',body:n.body||'New Dispatch update',url:`/dispatch.html?order=${encodeURIComponent(n.order_id||'')}`};
 await Promise.all(rows.results.map(async sub=>{try{const ok=await sender({endpoint:sub.endpoint,expirationTime:null,keys:{p256dh:sub.p256dh,auth:sub.auth}},payload,{publicKey:env.VAPID_PUBLIC_KEY,privateKey:env.VAPID_PRIVATE_KEY,subject:env.VAPID_SUBJECT});if(!ok)await stmt(env,'UPDATE dispatch_push_subscriptions SET active=0,updated_at=? WHERE endpoint=?',nowISO(),sub.endpoint).run();}catch(e){console.error('Push send failed',String(e));}}));
}
async function cleanupIntegrated(env){
 if(env.CLEANUP_ENABLED!=='true')return;const installed=await stmt(env,"SELECT name FROM sqlite_master WHERE type='table' AND name='dispatch_photos'").first();if(!installed)return;const cutoff=new Date(Date.now()-60*86400000).toISOString(),orphan=new Date(Date.now()-2*86400000).toISOString();
 const rows=await stmt(env,`UPDATE dispatch_photos SET state='deleting' WHERE path IN (
  SELECT p.path FROM dispatch_photos p
  LEFT JOIN dispatch_orders d ON d.order_id=p.order_id
  LEFT JOIN dispatch_missing_issues i ON i.id=p.issue_id
  WHERE p.state='deleting'
   OR (p.state IN ('uploading','uploaded') AND p.attached_at IS NULL AND p.created_at<?)
   OR (p.state='attached' AND p.stage IN ('packing','waybill','additional') AND d.stage='shipped' AND d.shipped_at IS NOT NULL AND d.shipped_at<? AND p.created_at<? AND NOT EXISTS(SELECT 1 FROM dispatch_missing_issues x WHERE x.order_id=p.order_id AND x.status='open'))
   OR (p.state='attached' AND p.stage IN ('missing_issue','missing_resolution') AND i.status='resolved' AND i.resolved_at IS NOT NULL AND i.resolved_at<? AND p.created_at<?)
  ORDER BY p.created_at LIMIT 20) RETURNING path`,orphan,cutoff,cutoff,cutoff,cutoff).all();
 for(const p of rows.results){try{await env.PHOTOS.delete(p.path);await stmt(env,"UPDATE dispatch_photos SET state='deleted',deleted_at=? WHERE path=? AND state='deleting'",nowISO(),p.path).run();}catch{console.error('Integrated photo cleanup failed; will retry.');}}
}

export async function cleanup(env){const now=Math.floor(Date.now()/1000);await env.DB.batch([stmt(env,'DELETE FROM sessions WHERE expires_at<?',now),stmt(env,'DELETE FROM login_limits WHERE expires_at<?',now)]);if(env.CLEANUP_ENABLED!=='true')return;
 const cutoff=new Date(Date.now()-60*86400000).toISOString(),orphan=new Date(Date.now()-2*86400000).toISOString();
 const rows=await stmt(env,`UPDATE photos SET state='deleting' WHERE path IN (
 SELECT p.path FROM photos p LEFT JOIN records r ON p.record_id=r.id
 WHERE p.state='deleting' OR (p.state IN ('uploading','uploaded') AND p.record_id IS NULL AND p.created_at<?)
 OR (p.state='attached' AND r.status IN ('shipped','resolved') AND r.retention_from IS NOT NULL AND r.retention_from<? AND p.created_at<?
 AND NOT EXISTS(SELECT 1 FROM records issue WHERE issue.reference=r.reference AND issue.kind='missing' AND issue.status<>'resolved'))
 ORDER BY p.created_at LIMIT 20) RETURNING path`,orphan,cutoff,cutoff).all();
 for(const p of rows.results){try{await env.PHOTOS.delete(p.path);await stmt(env,"UPDATE photos SET state='deleted',deleted_at=? WHERE path=? AND state='deleting'",nowISO(),p.path).run();}catch{console.error('Photo cleanup failed; will retry.');}}
 await cleanupIntegrated(env);
}
export default {
 async fetch(req,env,ctx){let res;const origin=(req.headers.get('Origin')||'').replace(/\/$/,''),allowed=allowedOrigins(env),originAllowed=allowed.includes(origin);
 try{
  if(!env.DB||!env.PHOTOS||!allowed.length)throw err('Worker setup is incomplete. Add DB, PHOTOS and an allowed origin.',503);
  if(!originAllowed)throw err('Origin not allowed.',403);
  if(req.method==='OPTIONS')res=new Response(null,{status:204});
  else{
   const url=new URL(req.url);
   if(url.pathname==='/login'&&req.method==='POST')res=await login(req,env);
   else if(url.pathname.startsWith('/integrated/')){
    await ensureIntegratedSchema(env);
    const s=await supabaseAuth(req,env);
    if(url.pathname==='/integrated/me'&&req.method==='GET')res=json({id:s.id,name:s.name,email:s.email,role:s.role,canPack:s.canPack,canShip:s.canShip});
    else if(url.pathname==='/integrated/sync'&&req.method==='POST')res=await integratedSync(req,env,s,ctx);
    else if(url.pathname==='/integrated/sync-many'&&req.method==='POST')res=await integratedSyncMany(req,env,s,ctx);
    else if(url.pathname==='/integrated/dispatch'&&req.method==='GET')res=await integratedList(env,url);
    else if(url.pathname==='/integrated/order'&&req.method==='GET')res=await integratedGet(env,url);
    else if(url.pathname==='/integrated/claim'&&req.method==='POST')res=await integratedClaim(req,env,s);
    else if(url.pathname==='/integrated/photos'&&req.method==='POST')res=await integratedUpload(req,env,s,url);
    else if(url.pathname==='/integrated/photo'&&req.method==='GET')res=await integratedPhoto(env,url,s);
    else if(url.pathname==='/integrated/packed'&&req.method==='POST')res=await integratedPacked(req,env,s,ctx);
    else if(url.pathname==='/integrated/waybill'&&req.method==='POST')res=await integratedWaybill(req,env,s);
    else if(url.pathname==='/integrated/additional'&&req.method==='POST')res=await integratedAttachAdditional(req,env,s);
    else if(url.pathname==='/integrated/missing/list'&&req.method==='GET')res=await integratedMissingList(env,url);
    else if(url.pathname==='/integrated/tracking'&&req.method==='POST')res=await integratedTracking(req,env,s);
    else if(url.pathname==='/integrated/handover'&&req.method==='POST')res=await integratedHandover(req,env,s);
    else if(url.pathname==='/integrated/missing'&&req.method==='POST')res=await integratedIssueCreate(req,env,s);
    else if(url.pathname==='/integrated/missing/resolve'&&req.method==='POST')res=await integratedIssueResolve(req,env,s);
    else if(url.pathname==='/integrated/notifications'&&req.method==='GET')res=await integratedNotifications(env,s,url);
    else if(url.pathname==='/integrated/notifications/read'&&req.method==='POST')res=await integratedNotificationRead(req,env,s);
    else if(url.pathname==='/integrated/push/config'&&req.method==='GET')res=await integratedPushConfig(env);
    else if(url.pathname==='/integrated/push/subscribe'&&req.method==='POST')res=await integratedPushSubscribe(req,env,s);
    else if(url.pathname==='/integrated/push/unsubscribe'&&req.method==='POST')res=await integratedPushUnsubscribe(req,env,s);
    else throw err('Not found.',404);
   }else{
    const s=await auth(req,env);
    if(url.pathname==='/me'&&req.method==='GET')res=json({name:s.name,id:s.id,active:true});
    else if(url.pathname==='/logout'&&req.method==='POST'){await stmt(env,'DELETE FROM sessions WHERE token_hash=?',s.tokenHash).run();res=json({ok:true});}
    else if(url.pathname==='/records'&&req.method==='GET')res=await list(env,url);
    else if(url.pathname==='/save'&&req.method==='POST')res=await save(req,env,s);
    else if(url.pathname==='/photos'&&req.method==='POST')res=await upload(req,env,s);
    else if(url.pathname==='/photo'&&req.method==='GET')res=await photo(env,url,s);
    else if(url.pathname==='/health'&&req.method==='GET')res=json({ok:true,cleanupEnabled:env.CLEANUP_ENABLED==='true'});
    else throw err('Not found.',404);
   }
  }
 }catch(e){
  if(!e.status)console.error('Tracker service error',String(e),e?.stack||'');
  const safeMessage=e?.status
    ? e.message
    : ('Service unavailable: '+String(e?.message||e||'Unknown backend error').replace(/https?:\/\/\S+/g,'[url]').slice(0,220));
  res=json({error:safeMessage},e.status||503);
 }
 const h=new Headers(res.headers);h.set('Vary','Origin');h.set('X-Content-Type-Options','nosniff');if(originAllowed){h.set('Access-Control-Allow-Origin',origin);h.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');h.set('Access-Control-Allow-Headers','Authorization, Content-Type');h.set('Access-Control-Max-Age','600');}return new Response(res.body,{status:res.status,headers:h});
 },
 scheduled(event,env,ctx){ctx.waitUntil(cleanup(env));}
};