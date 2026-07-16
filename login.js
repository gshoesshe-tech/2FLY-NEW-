(() => {
  'use strict';
  const cfg=window.__2FLY_CONFIG__||{};
  const $=id=>document.getElementById(id);
  let supa;
  function setLoading(btn,on){ if(on){btn.dataset.old=btn.textContent;btn.disabled=true;btn.textContent='Signing in…';}else{btn.disabled=false;btn.textContent=btn.dataset.old||'Sign in';} }
  async function init(){
    if(!window.supabase||!cfg.SUPABASE_URL||!cfg.SUPABASE_ANON_KEY||cfg.SUPABASE_URL.includes('YOUR_PROJECT')){
      $('loginError').textContent='Open config.js and paste the URL and anon key from your NEW Supabase project.'; $('loginError').classList.remove('hidden'); return;
    }
    supa=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
    const {data:{session}}=await supa.auth.getSession(); if(session){location.replace('./dashboard.html');return;}
    $('loginForm').addEventListener('submit',async e=>{
      e.preventDefault(); const btn=e.submitter; setLoading(btn,true); $('loginError').classList.add('hidden');
      const {error}=await supa.auth.signInWithPassword({email:$('loginEmail').value.trim(),password:$('loginPassword').value});
      setLoading(btn,false); if(error){$('loginError').textContent=error.message;$('loginError').classList.remove('hidden');return;} location.replace('./dashboard.html');
    });
  }
  init();
})();
