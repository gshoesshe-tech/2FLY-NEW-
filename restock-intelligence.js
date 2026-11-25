(() => {
  'use strict';
  const TF=window.TwoFly,Core=window.TwoFlyRestockCore;
  let rowsCache=[],paidOrders=[];
  function tableRows(rows){
    return rows.map(r=>'<tr><td><strong>'+TF.esc(r.design)+'</strong></td><td>'+TF.esc(r.category)+'</td><td><strong>'+r.day+'</strong></td><td><strong>'+r.d7+'</strong></td><td>'+r.d30+'</td><td>'+r.d7Orders.size+'</td><td><small>'+TF.esc(Core.sizes(r.sizes))+'</small></td><td><small>'+TF.esc([...r.skus].join(', '))+'</small></td></tr>').join('');
  }
  function renderFull(){
    const filter=TF.$('designCategoryFilter')?.value||'all';
    const rows=filter==='all'?rowsCache:rowsCache.filter(r=>r.category===filter);
    TF.$('designSalesTable').innerHTML='<table><thead><tr><th>Design</th><th>Category</th><th>Day</th><th>7D</th><th>30D</th><th>7D Orders</th><th>Sizes 7D</th><th>SKUs</th></tr></thead><tbody>'+(tableRows(rows)||'<tr><td colspan="8" class="empty">No design sales found.</td></tr>')+'</tbody></table>';
  }
  function render(date){
    const built=Core.build(paidOrders,date);rowsCache=built.rows;
    const cats=[...new Set(rowsCache.map(r=>r.category))].sort(),f=TF.$('designCategoryFilter'),keep=f?.value||'all';
    if(f){f.innerHTML='<option value="all">All categories</option>'+cats.map(c=>'<option value="'+TF.esc(c)+'">'+TF.esc(c)+'</option>').join('');f.value=keep==='all'||cats.includes(keep)?keep:'all';}
    const top=rowsCache.find(r=>r.day>0);if(TF.$('psTopDesign'))TF.$('psTopDesign').textContent=top?top.design+' · '+top.day:'—';
    TF.$('restockCoverage').textContent=built.withDetail+'/'+paidOrders.length+' paid orders with design detail';
    const p=rowsCache.filter(r=>r.day>0||r.d7>0).slice(0,20);
    TF.$('restockPriorityTable').innerHTML='<table><thead><tr><th>#</th><th>Design</th><th>Category</th><th>Day</th><th>7D</th><th>30D</th><th>Sizes 7D</th><th>Signal</th></tr></thead><tbody>'+(
      p.map((r,i)=>'<tr><td><strong>'+(i+1)+'</strong></td><td><strong>'+TF.esc(r.design)+'</strong><br><small>'+TF.esc([...r.skus].slice(0,4).join(', '))+'</small></td><td>'+TF.esc(r.category)+'</td><td><strong>'+r.day+'</strong><br><small>'+r.dayOrders.size+' orders</small></td><td><strong>'+r.d7+'</strong><br><small>'+r.d7Orders.size+' orders</small></td><td>'+r.d30+'</td><td><small>'+TF.esc(Core.sizes(r.sizes))+'</small></td><td><span class="pill">'+TF.esc(Core.signal(r))+'</span></td></tr>').join('')
      ||'<tr><td colspan="8" class="empty">No paid design sales found.</td></tr>')+'</tbody></table>';
    renderFull();
  }
  async function load(){
    const date=TF.$('productSalesDate').value||TF.today();
    paidOrders=await Core.fetch30(TF.addDays(date,-29),date);render(date);
  }
  function copyList(){
    const date=TF.$('productSalesDate').value||TF.today(),rows=rowsCache.filter(r=>r.day>0||r.d7>0).slice(0,20);
    const out=['2FLY RESTOCK LIST — '+TF.formatDate(date),''];
    rows.forEach((r,i)=>{const s=Core.sizes(r.sizes);out.push((i+1)+'. '+r.design+' — '+r.category,'Today: '+r.day+' | 7D: '+r.d7+' | 30D: '+r.d30+(s!=='—'?' | Sizes: '+s:''),'');});
    if(!rows.length)out.push('No paid design sales found.');TF.copyText(out.join('\n'),'Restock list copied');
  }
  async function init(){
    await TF.ready;if(!Core)throw new Error('Restock core did not load.');
    TF.$('designCategoryFilter')?.addEventListener('change',renderFull);TF.$('copyRestockBtn')?.addEventListener('click',copyList);
    TF.$('productSalesDate')?.addEventListener('change',()=>load().catch(e=>TF.fail(e,'Restock intelligence failed')));
    ['prevDayBtn','nextDayBtn','todaySalesBtn'].forEach(id=>TF.$(id)?.addEventListener('click',()=>setTimeout(()=>load().catch(e=>TF.fail(e,'Restock intelligence failed')),0)));
    window.addEventListener('twofly:refresh',()=>load().catch(e=>TF.fail(e,'Restock intelligence failed')));await load();
  }
  init().catch(e=>TF.fail(e,'Restock intelligence failed'));
})();