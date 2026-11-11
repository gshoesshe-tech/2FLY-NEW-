(() => {
  'use strict';
  const TF = window.TwoFly;
  let D;
  let records = [];
  let selectedId = null;
  let sourceOrders = new Map();
  let itemMap = new Map();
  let issueRows = [];

  function stageLabel(stage){ return D.stageLabel(stage); }
  function canPack(){ return Boolean(D.state.me?.canPack); }
  function canShip(){ return Boolean(D.state.me?.canShip); }
  function itemLabel(item){
    const cat=TF.state.categoryById.get(item.category_id);
    return cat?.name || item.product_name || item.sku || 'Item';
  }
  function sourcePayload(order){ return order ? {
    order_id:order.id,order_number:order.order_number,customer_name:order.customer_name||'',fulfillment_method:order.fulfillment_method||'',created_at:order.created_at||order.order_date,status:order.status||'',payment_status:order.payment_status||'',tracking_number:order.tracking_number||''
  }:null; }

  async function loadSourceOrders(){
    const r=await TF.state.supa.from('v_daily_ops_orders_v16').select('*').order('created_at',{ascending:false}).limit(10000);
    if(r.error)throw r.error; sourceOrders=new Map((r.data||[]).map(o=>[o.id,o]));
    const ids=[...sourceOrders.keys()]; itemMap=new Map();
    for(let i=0;i<ids.length;i+=150){
      const ir=await TF.state.supa.from('order_items').select('order_id,category_id,product_name,sku,quantity,line_number').in('order_id',ids.slice(i,i+150)).order('line_number');
      if(ir.error)throw ir.error;(ir.data||[]).forEach(item=>{const list=itemMap.get(item.order_id)||[];list.push(item);itemMap.set(item.order_id,list);});
    }
  }

  async function syncAll(){
    const button=TF.$('dispatchSyncBtn');TF.setLoading(button,true,'Syncing…');
    try{await D.syncOrders([...sourceOrders.values()]);TF.toast('Dispatch synced');await loadDispatch();}
    catch(e){TF.fail(e,'Dispatch sync failed');}
    finally{TF.setLoading(button,false);}
  }

  function filteredRecords(){
    const q=TF.$('dispatchSearch').value.trim().toLowerCase(),stage=TF.$('dispatchStageFilter').value;
    return records.filter(r=>(stage==='all'||r.stage===stage)&&(!q||[r.order_number,r.customer_name,r.tracking].join(' ').toLowerCase().includes(q)));
  }

  function renderCounts(){
    const n=s=>records.filter(r=>r.stage===s).length;
    TF.$('dispatchNeedsCount').textContent=n('needs_packing');TF.$('dispatchPackingCount').textContent=n('packing');TF.$('dispatchPackedCount').textContent=n('packed');TF.$('dispatchReadyCount').textContent=n('ready_for_pickup');TF.$('dispatchShippedCount').textContent=n('shipped');
  }

  function renderTable(){
    const rows=filteredRecords();
    if(!rows.some(r=>r.order_id===selectedId))selectedId=rows[0]?.order_id||null;
    TF.$('dispatchTable').innerHTML=`<table><thead><tr><th>Order</th><th>Customer</th><th>Entered</th><th>Dispatch status</th><th>Staff</th><th>Tracking</th><th>Missing</th></tr></thead><tbody>${rows.map(r=>`<tr data-dispatch-row="${TF.esc(r.order_id)}" class="${r.order_id===selectedId?'selected-row':''}"><td><strong>${TF.esc(r.order_number)}</strong></td><td>${TF.esc(r.customer_name||'—')}</td><td>${TF.formatDateTime(r.queued_at)}</td><td>${D.stagePill(r.stage)}</td><td>${TF.esc(r.claimed_name||r.packed_name||r.ready_name||r.shipped_name||'—')}</td><td>${TF.esc(r.tracking||'—')}</td><td>${Number(r.open_issue_count||0)?`<span class="pill danger">${r.open_issue_count} open</span>`:'—'}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">No Dispatch orders match this filter.</td></tr>'}</tbody></table>`;
    TF.$('dispatchTable').querySelectorAll('[data-dispatch-row]').forEach(row=>row.addEventListener('click',()=>{selectedId=row.dataset.dispatchRow;renderTable();renderDetail();}));
    renderDetail();
  }

  async function photoGallery(data){
    const el=TF.$('dispatchPhotoHistory');if(!el)return;
    D.revokeObjectUrls();const photos=data.photos||[];
    if(!photos.length){el.innerHTML='<div class="empty">No photos saved yet.</div>';return;}
    el.innerHTML=photos.map((p,i)=>`<button type="button" class="dispatch-photo-card" data-p="${i}"><span>Loading…</span><small>${TF.esc(p.stage)} • ${TF.esc(p.owner_name||'')}</small></button>`).join('');
    await Promise.all(photos.map(async(p,i)=>{try{const url=await D.photoObjectUrl(p.path),b=el.querySelector(`[data-p="${i}"]`);if(!b)return;b.innerHTML=`<img src="${TF.esc(url)}" alt="Dispatch proof"><small>${TF.esc(String(p.stage).replaceAll('_',' '))} • ${TF.esc(p.owner_name||'')}<br>${TF.formatDateTime(p.created_at)}</small>`;b.onclick=()=>window.open(url,'_blank','noopener');}catch{}}));
  }

  function itemOptions(orderId){return (itemMap.get(orderId)||[]).map((item,i)=>`<option value="${i}">${TF.esc(itemLabel(item))} — ${TF.num(item.quantity)} pcs</option>`).join('');}

  async function renderDetail(){
    const el=TF.$('dispatchDetail');if(!selectedId){el.innerHTML='<div class="empty">Select an order.</div>';return;}
    try{
      const data=await D.detail(selectedId),r=data.order,src=sourceOrders.get(selectedId);if(!r){el.innerHTML='<div class="empty">Dispatch record not found.</div>';return;}
      const mine=r.claimed_by===TF.state.session.user.id;
      const stageAction=r.stage==='needs_packing'&&canPack()?`<button class="btn primary" id="dispatchClaim">Start packing</button>`:'';
      const packAction=r.stage==='packing'&&mine&&canPack()?`<form id="packProofForm" class="dispatch-action-form"><label>First parcel photo<input id="packingPhoto" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required></label><button class="btn primary">Save packing proof</button><small>Only after the photo saves will this become Packed.</small></form>`:'';
      const packOther=r.stage==='packing'&&!mine?`<div class="notice info">Packing — ${TF.esc(r.claimed_name||'another staff member')}</div>`:'';
      const waybillAction=r.stage==='packed'&&canShip()?`<form id="waybillProofForm" class="dispatch-action-form"><label>Waybill photo<input id="waybillPhoto" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required></label><label>Tracking number <small>(optional)</small><input id="waybillTracking" value="${TF.esc(r.tracking||'')}" placeholder="Can be added later"></label><button class="btn primary">Save waybill proof</button></form>`:'';
      const readyAction=r.stage==='ready_for_pickup'&&canShip()?`<div class="dispatch-action-stack"><form id="trackingForm" class="dispatch-action-form"><label>Tracking number <small>(optional until available)</small><input id="dispatchTracking" value="${TF.esc(r.tracking||'')}"></label><button class="btn">Save tracking</button></form><button class="btn success" id="confirmHandover">Confirm courier handover → Shipped</button><small>A waybill photo alone does not mark this shipped.</small></div>`:'';
      const shippedTracking=r.stage==='shipped'&&canShip()?`<form id="trackingForm" class="dispatch-action-form"><label>Tracking number<input id="dispatchTracking" value="${TF.esc(r.tracking||'')}" placeholder="Add later if needed"></label><button class="btn">Save tracking</button></form>`:'';
      const additional=(canPack()||canShip())?`<form id="additionalProofForm" class="dispatch-action-form"><label>Additional photo<input id="additionalPhoto" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required></label><label>Note<input id="additionalNote" placeholder="Optional"></label><button class="btn">Add photo</button></form>`:'';
      const missing=(canPack()||canShip())?`<form id="missingIssueForm" class="dispatch-action-form"><h4>Report missing item</h4><label>Missing item<select id="missingItem" required><option value="">Select item</option>${itemOptions(selectedId)}</select></label><label>Missing quantity<input id="missingQty" type="number" min="1" step="1" required></label><label>Note<textarea id="missingNote" required placeholder="What is missing / what happened?"></textarea></label><label>Photo<input id="missingPhoto" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required></label><button class="btn danger">Save missing-item report</button></form>`:'';
      el.innerHTML=`<div class="dispatch-detail-head"><div><h3>${TF.esc(r.order_number)}</h3><p>${TF.esc(r.customer_name||'—')}</p></div>${D.stagePill(r.stage)}</div><div class="dispatch-detail-meta"><div><span>Queued</span><strong>${TF.formatDateTime(r.queued_at)}</strong></div><div><span>Fulfillment</span><strong>${TF.esc(r.fulfillment_method||'—')}</strong></div><div><span>Tracking</span><strong>${TF.esc(r.tracking||'Not added yet')}</strong></div><div><span>Claimed by</span><strong>${TF.esc(r.claimed_name||'—')}</strong></div><div><span>Handover</span><strong>${TF.esc(r.shipped_at_ph||'—')}</strong></div><div><span>Confirmed by</span><strong>${TF.esc(r.shipped_name||'—')}</strong></div></div>${stageAction}${packOther}${packAction}${waybillAction}${readyAction}${shippedTracking}<section class="dispatch-detail-section"><h4>Order items</h4><div class="simple-lines">${(itemMap.get(selectedId)||[]).map(i=>`<div class="simple-line"><strong>${TF.esc(itemLabel(i))}</strong><span>${TF.num(i.quantity)} pcs</span></div>`).join('')||'<div class="empty">No item lines loaded.</div>'}</div></section><section class="dispatch-detail-section"><h4>Photo history</h4><div class="dispatch-photo-strip" id="dispatchPhotoHistory"></div>${additional}</section><section class="dispatch-detail-section"><h4>Event history</h4><div class="timeline">${(data.events||[]).map(e=>`<div class="timeline-item"><span></span><div><strong>${TF.esc(String(e.event_type||'').replaceAll('_',' '))}</strong><small>${TF.formatDateTime(e.event_at)} • ${TF.esc(e.actor_name||'System')}</small>${e.note?`<p>${TF.esc(e.note)}</p>`:''}</div></div>`).join('')||'<div class="empty">No events yet.</div>'}</div></section><section class="dispatch-detail-section"><h4>Orders with Missing Items</h4>${(data.issues||[]).map(issue=>`<article class="dispatch-issue ${issue.status}"><div><strong>${TF.esc(issue.item_label)} × ${issue.missing_quantity}</strong>${TF.statusPill(issue.status==='open'?'unpaid':'paid')}</div><p>${TF.esc(issue.note||'')}</p><small>${TF.formatDateTime(issue.created_at)} • ${TF.esc(issue.created_name||'')}</small>${issue.status==='open'?(canPack()||canShip()?`<form class="resolveIssueForm" data-issue="${TF.esc(issue.id)}"><label>Resolution note<textarea data-resolve-note placeholder="How was it resolved?"></textarea></label><label>Resolution photo <small>(optional)</small><input data-resolve-photo type="file" accept="image/jpeg,image/png,image/webp" capture="environment"></label><button class="btn success small">Resolve issue</button></form>`:''):issue.resolution_note?`<p><strong>Resolved:</strong> ${TF.esc(issue.resolution_note)}</p>`:''}</article>`).join('')||'<div class="empty">No missing-item reports.</div>'}${missing}</section>`;

      TF.$('dispatchClaim')?.addEventListener('click',async e=>{const b=e.currentTarget;TF.setLoading(b,true,'Claiming…');try{await D.api('/integrated/claim',{method:'POST',body:{order_id:selectedId}});TF.toast('Packing claimed');await refreshAll(true);}catch(x){TF.fail(x,'Could not start packing');}finally{TF.setLoading(b,false);}});
      TF.$('packProofForm')?.addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;TF.setLoading(b,true,'Saving…');try{const up=await D.uploadPhoto(selectedId,'packing',TF.$('packingPhoto').files[0]);await D.api('/integrated/packed',{method:'POST',body:{order_id:selectedId,photo_path:up.path}});TF.toast('Packed — shipment staff notified');await refreshAll(true);}catch(x){TF.fail(x,'Packing proof not saved');}finally{TF.setLoading(b,false);}});
      TF.$('waybillProofForm')?.addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;TF.setLoading(b,true,'Saving…');try{const up=await D.uploadPhoto(selectedId,'waybill',TF.$('waybillPhoto').files[0]);await D.api('/integrated/waybill',{method:'POST',body:{order_id:selectedId,photo_path:up.path,tracking:TF.$('waybillTracking').value.trim()}});TF.toast('Ready for pickup');await refreshAll(true);}catch(x){TF.fail(x,'Waybill proof not saved');}finally{TF.setLoading(b,false);}});
      TF.$('trackingForm')?.addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter,tracking=TF.$('dispatchTracking').value.trim();if(!tracking){TF.toast('Enter a tracking number first',true);return;}TF.setLoading(b,true,'Saving…');try{await D.api('/integrated/tracking',{method:'POST',body:{order_id:selectedId,tracking}});TF.toast('Tracking saved');await refreshAll(true);}catch(x){TF.fail(x,'Tracking not saved');}finally{TF.setLoading(b,false);}});
      TF.$('confirmHandover')?.addEventListener('click',async e=>{if(!confirm('Confirm the courier physically took this parcel? This is the step that marks it Shipped.'))return;const b=e.currentTarget;TF.setLoading(b,true,'Confirming…');try{await D.api('/integrated/handover',{method:'POST',body:{order_id:selectedId,tracking:TF.$('dispatchTracking')?.value.trim()||''}});TF.toast('Courier handover confirmed — Shipped');await refreshAll(true);}catch(x){TF.fail(x,'Handover not confirmed');}finally{TF.setLoading(b,false);}});
      TF.$('additionalProofForm')?.addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;TF.setLoading(b,true,'Adding…');try{const up=await D.uploadPhoto(selectedId,'additional',TF.$('additionalPhoto').files[0]);await D.api('/integrated/additional',{method:'POST',body:{order_id:selectedId,photo_path:up.path,note:TF.$('additionalNote').value.trim()}});TF.toast('Photo added');await renderDetail();}catch(x){TF.fail(x,'Photo not added');}finally{TF.setLoading(b,false);}});
      TF.$('missingIssueForm')?.addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter,index=TF.$('missingItem').value,item=(itemMap.get(selectedId)||[])[Number(index)];if(!item){TF.toast('Select the missing item',true);return;}TF.setLoading(b,true,'Saving…');try{const up=await D.uploadPhoto(selectedId,'missing_issue',TF.$('missingPhoto').files[0]);await D.api('/integrated/missing',{method:'POST',body:{order_id:selectedId,item_key:item.sku||String(index),item_label:itemLabel(item),missing_quantity:TF.num(TF.$('missingQty').value),note:TF.$('missingNote').value.trim(),photo_path:up.path}});TF.toast('Missing-item report opened');await refreshAll(true);}catch(x){TF.fail(x,'Missing-item report not saved');}finally{TF.setLoading(b,false);}});
      el.querySelectorAll('.resolveIssueForm').forEach(form=>form.addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;TF.setLoading(b,true,'Resolving…');try{const file=form.querySelector('[data-resolve-photo]').files?.[0];let path='';if(file){const up=await D.uploadPhoto(selectedId,'missing_resolution',file);path=up.path;}await D.api('/integrated/missing/resolve',{method:'POST',body:{issue_id:form.dataset.issue,note:form.querySelector('[data-resolve-note]').value.trim(),photo_path:path}});TF.toast('Missing-item report resolved');await refreshAll(true);}catch(x){TF.fail(x,'Issue not resolved');}finally{TF.setLoading(b,false);}}));
      await photoGallery(data);
    }catch(e){el.innerHTML=`<div class="notice danger">${TF.esc(e.message)}</div>`;}
  }

  async function loadMissing(){
    issueRows=await D.missingList({q:TF.$('missingSearch').value.trim(),status:TF.$('missingStatus').value,limit:500});
    const open=issueRows.filter(i=>i.status==='open').length;TF.$('missingTabCount').textContent=open?`(${open})`:'';
    TF.$('missingIssuesTable').innerHTML=`<table><thead><tr><th>Order</th><th>Customer</th><th>Missing item</th><th>Qty</th><th>Issue</th><th>Shipment</th><th>Created</th></tr></thead><tbody>${issueRows.map(i=>`<tr data-missing-order="${TF.esc(i.order_id)}"><td><strong>${TF.esc(i.order_number)}</strong></td><td>${TF.esc(i.customer_name||'—')}</td><td>${TF.esc(i.item_label)}</td><td>${i.missing_quantity}</td><td>${TF.statusPill(i.status==='open'?'unpaid':'paid')}</td><td>${D.stagePill(i.shipment_stage)}</td><td>${TF.formatDateTime(i.created_at)}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">No missing-item reports match.</td></tr>'}</tbody></table>`;
    TF.$('missingIssuesTable').querySelectorAll('[data-missing-order]').forEach(row=>row.addEventListener('click',()=>{selectedId=row.dataset.missingOrder;switchTab('queue');renderTable();renderDetail();}));
  }

  async function loadDispatch(){records=await D.list({limit:500});renderCounts();renderTable();await loadMissing();}
  async function refreshAll(sync=false){if(sync)await D.syncOrders([...sourceOrders.values()]);await loadDispatch();await D.loadNotifications();}
  function switchTab(name){TF.$('dispatchQueueTab').classList.toggle('hidden',name!=='queue');TF.$('dispatchMissingTab').classList.toggle('hidden',name!=='missing');TF.$$('[data-dispatch-tab]').forEach(b=>b.classList.toggle('active',b.dataset.dispatchTab===name));if(name==='missing')loadMissing().catch(e=>TF.fail(e,'Missing-item list failed'));}

  async function init(){
    await TF.ready; D=window.TwoFlyDispatch;if(!D)throw new Error('Dispatch client did not load.');
    if(!(await D.probe(true))){TF.$('dispatchSetupNotice').textContent='Dispatch backend check failed: '+(D.state.lastError||'Unknown backend error')+'. Existing Orders still works.';TF.$('dispatchSetupNotice').classList.remove('hidden');return;}
    await loadSourceOrders();await D.syncOrders([...sourceOrders.values()]);
    const params=new URLSearchParams(location.search);selectedId=params.get('order')||null;
    TF.$('dispatchSearch').addEventListener('input',renderTable);TF.$('dispatchStageFilter').addEventListener('change',renderTable);TF.$('dispatchSyncBtn').addEventListener('click',syncAll);TF.$('missingSearch').addEventListener('input',()=>loadMissing().catch(e=>TF.fail(e,'Missing list failed')));TF.$('missingStatus').addEventListener('change',()=>loadMissing().catch(e=>TF.fail(e,'Missing list failed')));TF.$$('[data-dispatch-tab]').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.dispatchTab)));TF.$$('[data-stage-card]').forEach(b=>b.addEventListener('click',()=>{TF.$('dispatchStageFilter').value=b.dataset.stageCard;switchTab('queue');renderTable();}));window.addEventListener('twofly:refresh',()=>refreshAll(true).catch(e=>TF.fail(e,'Dispatch refresh failed')));
    await loadDispatch();
  }
  init().catch(e=>TF.fail(e,'Dispatch failed'));
})();