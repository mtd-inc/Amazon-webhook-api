(function(){
  'use strict';
  var root = 'aoi-demo-v12:';
  var fallback = {};
  function readSet(name){
    try {var v=localStorage.getItem(root+name);return new Set(v?JSON.parse(v):[]);}
    catch(e){return new Set(fallback[name]||[]);}
  }
  function saveSet(name,set){
    var arr=Array.from(set);
    fallback[name]=arr;
    try {localStorage.setItem(root+name,JSON.stringify(arr));}catch(e){}
  }
  function readBool(name,def){
    try {var v=localStorage.getItem(root+name);return v===null?def:v==='true';}
    catch(e){return fallback[name]===undefined?def:fallback[name];}
  }
  function saveBool(name,val){
    fallback[name]=val;try {localStorage.setItem(root+name,String(val));}catch(e){}
  }
  var favorites=readSet('favorites');
  var coupons=readSet('coupons');
  var notifications=readBool('notifications',false);
  var category='all';
  var input=document.getElementById('shopSearch');
  var count=document.getElementById('filterCount');
  var favBtn=document.getElementById('modalFav');
  var savedBox=document.getElementById('savedList');
  var emptyBox=document.getElementById('savedEmpty');
  var tags=[].slice.call(document.querySelectorAll('[data-category-filter]'));
  var known=['nodelab','iseya','seika','bakery','crepe','flower','ikkyu','deli'];

  function filterStores(){
    var q=(input&&input.value||'').trim().toLocaleLowerCase('ja');
    var visible=0;
    document.querySelectorAll('.storeCard').forEach(function(card){
      var matched=(category==='all'||card.getAttribute('data-category')===category) &&
         (!q||card.textContent.toLocaleLowerCase('ja').indexOf(q)>=0);
      card.style.display=matched?'grid':'none';
      if(matched)visible++;
    });
    if(count)count.textContent=visible+'店舗を表示（提案デモの掲載分）';
  }
  tags.forEach(function(button){
    button.addEventListener('click',function(){
      category=button.getAttribute('data-category-filter');
      tags.forEach(function(b){var active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
      filterStores();
    });
  });
  if(input)input.addEventListener('input',filterStores);
  filterStores();

  function updateProfile(){
    var n=document.querySelectorAll('.profileStats b');
    if(n.length>=3){n[0].textContent=favorites.size;n[1].textContent=coupons.size;n[2].textContent=notifications?'ON':'OFF';}
    var a=document.getElementById('myFavorites');
    var b=document.getElementById('myCoupons');
    var c=document.getElementById('mySettings');
    if(a)a.querySelector('small').textContent=favorites.size+'件 ›';
    if(b)b.querySelector('small').textContent=coupons.size+'件 ›';
    if(c)c.querySelector('small').textContent=(notifications?'ON':'OFF')+' ›';
  }
  function updateModal(){
    if(!favBtn||!known.includes(currentStore))return;
    var selected=favorites.has(currentStore);
    favBtn.textContent=selected?'♥ お気に入り登録済み':'♡ お気に入りに追加';
    favBtn.setAttribute('aria-pressed',String(selected));
  }
  function renderSaved(){
    if(!savedBox)return;
    savedBox.textContent='';
    var saved=known.filter(function(k){return favorites.has(k) && stores[k];});
    if(emptyBox)emptyBox.hidden=saved.length!==0;
    saved.forEach(function(k){
      var b=document.createElement('button');
      b.type='button';b.className='savedStore';
      var title=document.createElement('strong');title.textContent='♥ '+stores[k].name;
      var sub=document.createElement('span');sub.textContent=stores[k].cat+'　→ 詳細を見る';
      b.appendChild(title);b.appendChild(sub);
      b.addEventListener('click',function(){openStore(k);updateModal();});
      savedBox.appendChild(b);
    });
  }
  if(favBtn){
    favBtn.onclick=function(){
      if(!stores[currentStore])return;
      if(favorites.has(currentStore))favorites.delete(currentStore);else favorites.add(currentStore);
      saveSet('favorites',favorites);
      updateModal();updateProfile();renderSaved();
      showToast(favorites.has(currentStore)?'お気に入りに保存しました（この端末のデモ内のみ）':'お気に入りを解除しました');
    };
  }
  document.querySelectorAll('[data-store]').forEach(function(b){
    b.addEventListener('click',updateModal);
  });
  updateModal();

  document.querySelectorAll('[data-demo-coupon]').forEach(function(button){
    var k=button.getAttribute('data-demo-coupon');
    function sync(){
      var on=coupons.has(k);
      button.textContent=on?'保存済み ✓':'デモ券を保存';
      button.setAttribute('aria-pressed',String(on));
    }
    button.addEventListener('click',function(){
      if(coupons.has(k))coupons.delete(k);else coupons.add(k);
      saveSet('coupons',coupons);sync();updateProfile();
      showToast(coupons.has(k)?'デモ券を保存しました（実際には使えません）':'デモ券を解除しました');
    });
    sync();
  });
  function openPage(name){if(name==='saved')renderSaved();go(name);}
  function bindClick(id,cb){var el=document.getElementById(id);if(el)el.onclick=cb;}
  bindClick('coupon',function(){openPage('coupons');});
  bindClick('favorite',function(){openPage('saved');});
  bindClick('eventJump',function(){openPage('eventsPage');});
  bindClick('bell',function(){openPage('eventsPage');showToast('公式イベントと構想中の企画を分けて表示しています');});
  bindClick('myFavorites',function(){openPage('saved');});
  bindClick('myCoupons',function(){openPage('coupons');});
  bindClick('mySettings',function(){openPage('settings');});
  bindClick('eventCalendar',function(){openPage('eventsPage');});

  var opt=document.getElementById('demoNotifyToggle');
  var optStatus=document.getElementById('demoNotifyStatus');
  function updateNotify(){
    if(opt)opt.checked=notifications;
    if(optStatus)optStatus.textContent=notifications?'ON（画面内のデモ設定）':'OFF（画面内のデモ設定）';
    updateProfile();
  }
  if(opt)opt.addEventListener('change',function(){notifications=opt.checked;saveBool('notifications',notifications);updateNotify();});
  updateNotify();
  bindClick('demoReset',function(){
    favorites.clear();coupons.clear();notifications=false;category='all';
    saveSet('favorites',favorites);saveSet('coupons',coupons);saveBool('notifications',false);
    tags.forEach(function(b){var active=b.getAttribute('data-category-filter')==='all';b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    if(input)input.value='';
    document.querySelectorAll('[data-demo-coupon]').forEach(function(button){
      button.textContent='デモ券を保存';button.setAttribute('aria-pressed','false');
    });
    filterStores();renderSaved();updateNotify();updateModal();showToast('デモ保存データをリセットしました');
  });
  updateProfile();
  renderSaved();
})();
