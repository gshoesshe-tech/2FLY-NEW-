(() => {
  'use strict';
  const TF=window.TwoFly;
  const RULES=[
    [/^(AAPE|BAPE)(-|$)/i,'Bathing Ape / AAPE'],[/^(SUPREME|SUP|SBG|SRG)(-|$)/i,'Supreme'],
    [/^(CH|CHROME)(-|$)/i,'Chrome Hearts'],[/^CARHARTT(-|$)/i,'Carhartt'],[/^CORTEIZ(-|$)/i,'Corteiz'],
    [/^HELLSTAR(-|$)/i,'Hellstar'],[/^(HUMAN|HUMANMADE|HUMAN-MADE)(-|$)/i,'Human Made'],
    [/^STUSSY(-|$)/i,'Stussy'],[/^TRAPSTAR(-|$)/i,'Trapstar'],[/^BBC(-|$)/i,'Billionaire Boys Club'],
    [/^SHAKA(-|$)/i,'Shaka Wear'],[/^AND1(-|$)/i,'And1'],[/^STUNNA(-|$)/i,'Stunna'],
    [/^(JORDAN|JG|JR|JB)(-|$)/i,'Jordan'],[/^NIKE(-|$)/i,'Nike'],[/^(VERSACE|V)(-|$)/i,'Versace'],
    [/^(PC|PROCLUB|PRO-CLUB)(-|$)/i,'Pro Club'],[/^(LACOSTE|L)(-|$)/i,'Lacoste'],[/^CK(-|$)/i,'Calvin Klein'],[/^PLAYBOY(-|$)/i,'Playboy']
  ];
  const norm=v=>String(v||'').trim().toUpperCase().replace(/\s+/g,' ');
  function labelFor(sku){const c=norm(sku);if(c==='FP20')return'Fly Pack 20 (Mixed)';const h=RULES.find(([r])=>r.test(c));return h?h[1]:(c||'Unknown Design');}
  function source(raw){const t=String(raw||'').trim(),m=t.match(/\(([^)]*)\)\s*$/),o=m?m[1]:'';const z=(o.match(/(?:^|,)\s*Size\s*:\s*([^,]+)/i)||[])[1]||'';return{sku:norm(m?t.slice(0,m.index).trim():t),size:z.trim().toUpperCase()};}
  function parseOrder(o){const raw=String(o.raw_order_form||'');if(!raw)return[];let cat='';const out=[];for(const l of raw.split(/\r?\n/).map(x=>x.trim())){const h=l.match(/^\[([^\]]+)\]$/);if(h){cat=norm(h[1]);continue;}const m=l.match(/^[•*]\s*(.+?)\s+[–—-]\s*x\s*(\d+)\s*$/i);if(!m||!cat)continue;const s=source(m[1]),q=Number(m[2]||0);if(!s.sku||q<=0)continue;const b=cat==='BUSINESS BUNDLES',mult=b?(s.sku==='FP20'?20:10):1;out.push({date:String(o.order_date||'').slice(0,10),order_id:o.id,paid:isPaid(o),category:b?'BRANDED SHIRTS':cat,sku:s.sku,design:labelFor(s.sku),size:s.size,qty:q*mult});}return out;}
  const isActive=o=>!['cancelled','refunded'].includes(String(o.status||'').toLowerCase());
  const isPaid=o=>['paid','overpaid'].includes(String(o.payment_status||'').toLowerCase());
  async function fetch30(start,end){const all=[],size=1000;for(let from=0;from<100000;from+=size){const r=await TF.state.supa.from('v_daily_ops_orders_v16').select('*').gte('order_date',start).lte('order_date',end).order('order_date',{ascending:false}).order('created_at',{ascending:false}).range(from,from+size-1);if(r.error)throw r.error;const p=r.data||[];all.push(...p);if(p.length<size)break;}return all.filter(isActive);}
  function build(orders,date){const s7=TF.addDays(date,-6),map=new Map();let withDetail=0;for(const o of orders){const lines=parseOrder(o);if(lines.length)withDetail++;for(const x of lines){const k=x.category+'|'+x.design;if(!map.has(k))map.set(k,{design:x.design,category:x.category,day:0,paidDay:0,d7:0,paid7:0,d30:0,paid30:0,dayOrders:new Set(),d7Orders:new Set(),sizes:new Map(),skus:new Set()});const r=map.get(k);r.d30+=x.qty;if(x.paid)r.paid30+=x.qty;r.skus.add(x.sku);if(x.date>=s7){r.d7+=x.qty;if(x.paid)r.paid7+=x.qty;r.d7Orders.add(x.order_id);if(x.size)r.sizes.set(x.size,(r.sizes.get(x.size)||0)+x.qty);}if(x.date===date){r.day+=x.qty;if(x.paid)r.paidDay+=x.qty;r.dayOrders.add(x.order_id);}}}return{withDetail,rows:[...map.values()].sort((a,b)=>b.day-a.day||b.d7-a.d7||b.d30-a.d30||a.design.localeCompare(b.design))};}
  function sizes(m){const a=[...m.entries()].sort((x,y)=>y[1]-x[1]);return a.length?a.map(([s,q])=>s+' '+q).join(' · '):'—';}
  function signal(r){if(r.day>=10)return'Hot today';if(r.day>0&&r.day>=Math.max(2,(r.d7/7)*1.35))return'Rising';if(r.d7>=20)return'Fast mover';return'Watch';}
  window.TwoFlyRestockCore={fetch30,build,sizes,signal,isPaid};
})();