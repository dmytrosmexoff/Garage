startI18n();
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const TOKEN=location.pathname.split('/')[2]||'',today=()=>new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
let PIN='',SNAP=null,ENT={},STATUS='',VEH={},REQS=[],INFO=null,tt;
const toast=m=>{const e=$('toast');e.textContent=trStr(m);e.className='toast show';clearTimeout(tt);tt=setTimeout(()=>e.className='toast',3200)};
const tn=it=>(it.names&&(it.names[LANG]||it.names.ru))||trName(it.name,LANG);
const locked=()=>Object.values(ENT).some(e=>e&&e.state==='done');
const TYPE_NAMES={moto:'Мотоцикл',car:'Автомобиль',moped:'Мопед / скутер',boat:'Моторная лодка',sail:'Парусная яхта',jet:'Гидроцикл',other:'Другое'};
async function call(path,body,raw,hdr){
  const r=await fetch('/api/m/'+TOKEN+'/'+path,{method:body||raw?'POST':'GET',headers:Object.assign(body?{'Content-Type':'application/json'}:{},hdr||{}),body:raw||(body?JSON.stringify(body):undefined)});
  let j={};try{j=await r.json()}catch(e){}
  if(!r.ok){const e=new Error(j.error||'Не удалось сохранить. Проверьте связь.');e.left=j.left;throw e}
  return j;
}
async function shrink(file){
  try{const b=await createImageBitmap(file),k=Math.min(1,1600/Math.max(b.width,b.height)),c=document.createElement('canvas');
    c.width=Math.round(b.width*k);c.height=Math.round(b.height*k);c.getContext('2d').drawImage(b,0,0,c.width,c.height);
    return await new Promise(r=>c.toBlob(x=>r(x||file),'image/jpeg',.82))}catch(e){return file}
}
const langSel=()=>`<select id="lg" style="width:auto" aria-label="Language">${LANGS.map(l=>`<option value="${l[0]}" ${l[0]===LANG?'selected':''}>${l[1]}</option>`).join('')}</select>`;
function bindLang(){const s=$('lg');if(s)s.onchange=()=>{LANG=s.value;SNAP?render():showPin()}}
function showMsg(t){$('app').innerHTML=`<div class="top"><h1>Garage Journal</h1>${langSel()}</div><div class="msg">${t}</div>`;bindLang()}
function showPin(err){
  const info=INFO?`<p><b>${esc(INFO.name)}</b> · ${esc(trStr(TYPE_NAMES[INFO.type]||''))}</p>`:'';
  $('app').innerHTML=`<div class="top"><h1>Чек-лист для мастера</h1>${langSel()}</div>
  <div class="msg">${info}<p>Введите PIN-код с листа</p><input class="pin" id="pin" inputmode="numeric" maxlength="4" autocomplete="off" autofocus>
  <div class="err" id="err">${err?esc(trStr(err)):''}</div><button class="p" id="go" style="width:100%">Открыть</button></div>`;
  bindLang();
  const go=async()=>{PIN=$('pin').value.trim();if(PIN.length!==4)return;try{await load()}catch(e){showPin(e.message)}};
  $('go').onclick=go;$('pin').onkeydown=e=>{if(e.key==='Enter')go()};
}
async function loadInfo(){
  try{const r=await fetch('/api/m/'+TOKEN+'/info');if(!r.ok)throw r.status;INFO=await r.json();return true}
  catch(e){showMsg('Ссылка не найдена или закрыта.');return false}
}
async function load(){
  const r=await call('open',{pin:PIN});
  if(r.status==='closed')return showMsg('Ссылка закрыта владельцем.');
  if(r.status==='accepted')return showMsg('Работа принята владельцем. Спасибо!');
  SNAP=r.snapshot;ENT=r.entries||{};STATUS=r.status;VEH=r.vehicle||{};REQS=r.requests||[];
  if(SNAP.lang)LANG=SNAP.lang;render();
}
const unit=()=>({km:RT[LANG].km,mi:UNITMI[LANG],h:RT[LANG].h})[SNAP.vehicle.unit]||'km';
function card(it){
  const e=ENT[it.key]||{},st=e.state||'',c=CK[LANG],tag={must:'tagM',opt:'tagO',nod:'tagN',extra:'tagE',custom:'tagE'}[it.kind];
  const ro=STATUS!=='open';
  const ex=(it.ex||[]).map(x=>`<label>${esc(x.label)}<input data-x="${x.k}" value="${esc((e.x||{})[x.k]||'')}" placeholder="${esc(x.ph||'')}"></label>`).join('');
  return `<div class="card ${it.kind}" id="c_${it.key}" data-s="${st}">
  <div class="hd"><b>${esc(tn(it))}</b><span class="tag ${it.kind==='must'?'must':''}">${c[tag]||''}</span></div>
  <small>${esc(trName(it.cat,LANG))}</small>
  ${it.why?`<div class="why">${esc(it.why)}</div>`:''}${it.prev?`<div class="meta">Прошлая замена: ${esc(it.prev)}</div>`:''}
  ${e.review==='rejected'?`<div class="rej">Владелец вернул: ${esc(e.ownerNote||'')}</div>`:''}
  <div class="seg"><button class="${st==='done'?'on':''}" data-st="${it.key}|done" ${ro?'disabled':''}>Сделано</button><button class="${st==='skip'?'on':''}" data-st="${it.key}|skip" ${ro?'disabled':''}>Не делал</button></div>
  <div class="form" ${st?'':'hidden'}>
   <label>Дата<input name="date" type="date" value="${esc(e.date||today())}"></label>
   <label>Пробег<input name="km" type="number" inputmode="numeric" value="${e.km!=null?e.km:SNAP.vehicle.odo}"></label>
   <label class="w">Стоимость, ${esc(SNAP.vehicle.cc||'')}<input name="cost" type="number" inputmode="decimal" value="${e.cost!=null?e.cost:''}"></label>
   ${ex?`<div class="w form" style="margin:0">${ex}</div>`:''}
   <label class="w">Комментарий<textarea name="note" rows="2">${esc(e.note||'')}</textarea></label>
   <label class="w">Фото<input name="ph" type="file" accept="image/*" multiple></label>
   <div class="thumbs w" data-ph="${(e.ph||[]).join(',')}"></div>
   <div class="row w"><button class="p" data-save="${it.key}" ${ro?'disabled':''}>Сохранить</button><span class="ok">${e.state?'✓':''}</span></div>
  </div></div>`;
}
function reqRow(q){
  const cls=q.status==='pending'?'wait':q.status==='accepted'?'ok':'no';
  const txt=q.status==='pending'?'ожидает одобрения':q.status==='accepted'?'принято':'отклонено';
  return `<div class="card"><div class="hd"><b>${esc(q.kind==='add'?'Добавить':'Убрать')}: ${esc(trStr(q.name))}</b><span class="st ${cls}">${txt}</span></div>
  ${q.price>0?`<div class="meta">Цена: ${esc(q.price)}</div>`:''}${q.note?`<div class="meta">${esc(q.note)}</div>`:''}
  ${q.owner_note?`<div class="meta">Ответ владельца: ${esc(q.owner_note)}</div>`:''}</div>`;
}
function vehBlock(){
  const v=VEH||{},rows=[];
  if(v.eng)rows.push(`<div><b>Объём:</b> ${esc(v.eng)} см³</div>`);
  if(v.plate)rows.push(`<div><b>Госномер:</b> ${esc(v.plate)}</div>`);
  if(v.frame)rows.push(`<div><b>Номер рамы:</b> ${esc(v.frame)}</div>`);
  if(v.tiLast)rows.push(`<div><b>Техосмотр пройден:</b> ${esc(String(v.tiLast).slice(0,10))}</div>`);
  if(v.insEnd)rows.push(`<div><b>Страховка до:</b> ${esc(String(v.insEnd).slice(0,10))}</div>`);
  return rows.length?`<div class="veh">${rows.join('')}</div>`:'';
}
function render(){
  const v=SNAP.vehicle,c=CK[LANG],items=SNAP.items||[];
  const block=(kinds,title)=>{const l=items.filter(i=>kinds.includes(i.kind));return l.length?`<h2>${title}</h2>`+l.map(card).join(''):''};
  $('app').innerHTML=`<div class="top"><h1>${c.title}</h1>${langSel()}</div>
  <div class="meta">${esc(v.name)} · ${c.mil}: ${Number(v.odo).toLocaleString()} ${unit()}</div>
  ${vehBlock()}
  ${SNAP.note?`<h2>${c.wish}</h2><div class="note">${esc(SNAP.note)}</div>`:''}
  <p class="meta">${STATUS==='open'?'Отметьте результат по каждой позиции и нажмите «Сохранить». Новые работы предлагайте через «Добавить свою позицию»: владелец подтвердит их в приложении. Когда всё готово, нажмите «Работа окончена».':'Отправлено владельцу. Ждёт подтверждения.'}</p>
  ${block(['must'],c.must)}${block(['opt'],c.opt)}${block(['nod'],c.nod)}${block(['extra','custom'],c.tagE)}
  ${STATUS==='open'?`<h2>Запросы изменений</h2>
  <div class="card"><b>Добавить свою позицию</b>
    <div class="rqf form"><label class="w">Название работы<input id="newName"></label>
    <label>Цена, ${esc(v.cc||'')} (0 — бесплатно)<input id="newPrice" type="number" min="0" inputmode="decimal" value="0"></label>
    <label class="w">Комментарий<textarea id="newNote" rows="2"></textarea></label>
    <div class="w"><button id="addItem" class="p">Отправить запрос</button></div></div></div>`:''}
  ${REQS.length?`<h2>Ваши запросы</h2>${REQS.map(reqRow).join('')}`:''}
  ${STATUS==='open'?'<div style="margin-top:18px"><button class="p" id="fin" style="width:100%;padding:14px">Работа окончена</button></div>':''}`;
  bindLang();wire();thumbs();
}
function wire(){
  document.querySelectorAll('[data-st]').forEach(b=>b.onclick=()=>{
    const [k,s]=b.dataset.st.split('|'),c=$('c_'+k);c.dataset.s=s;
    c.querySelectorAll('[data-st]').forEach(x=>x.classList.toggle('on',x===b));c.querySelector('.form').hidden=false;
  });
  document.querySelectorAll('[data-save]').forEach(b=>b.onclick=()=>save(b.dataset.save,b));
  const ai=$('addItem');if(ai)ai.onclick=async()=>{
    const name=$('newName').value.trim(),price=+$('newPrice').value||0,note=$('newNote').value.trim();
    if(!name)return toast('Введите название');
    if(price>0&&!note)return toast('Напишите комментарий: за платную работу нужно объяснение');
    try{await call('add',{pin:PIN,item:{name},price,note});toast('Запрос отправлен владельцу');await load()}catch(e){toast(e.message)}
  };
  const f=$('fin');if(f)f.onclick=async()=>{
    if(!confirm('Завершить работу и отправить владельцу?'))return;
    try{await call('finish',{pin:PIN});STATUS='done';render();window.scrollTo(0,0)}catch(e){toast(e.message)}
  };
}
async function thumbs(){
  for(const box of document.querySelectorAll('.thumbs[data-ph]')){
    for(const id of (box.dataset.ph||'').split(',').filter(Boolean)){
      try{const r=await fetch(`/api/m/${TOKEN}/photo/${id}`,{headers:{'X-Pin':PIN}});if(!r.ok)continue;
        const i=document.createElement('img');i.src=URL.createObjectURL(await r.blob());box.appendChild(i)}catch(e){}
    }
  }
}
async function save(key,btn){
  const c=$('c_'+key),g=n=>c.querySelector('[name='+n+']'),old=ENT[key]||{};
  const e={state:c.dataset.s,date:g('date').value,km:g('km').value,cost:g('cost').value,note:g('note').value,x:{},ph:(old.ph||[]).slice()};
  if(!e.state)return toast('Выберите: «Сделано» или «Не делал»');
  if(e.state==='skip'&&!e.note.trim())return toast('Напишите, почему работа не сделана');
  c.querySelectorAll('[data-x]').forEach(i=>{if(i.value.trim())e.x[i.dataset.x]=i.value.trim()});
  btn.disabled=true;
  try{
    for(const f of [...g('ph').files]){
      const b=await shrink(f),r=await fetch(`/api/m/${TOKEN}/photo`,{method:'POST',headers:{'Content-Type':b.type||'image/jpeg','X-Pin':PIN},body:b});
      const j=await r.json();if(!r.ok)throw new Error(j.error);e.ph.push(j.id);
    }
    await call('entry',{pin:PIN,key,entry:e});
    ENT[key]=Object.assign({},e,{review:'pending'});
    const it=SNAP.items.find(i=>i.key===key);c.outerHTML=card(it);wire();thumbs();toast('Сохранено');
  }catch(err){btn.disabled=false;toast(err.message)}
}
(async()=>{ if(await loadInfo())showPin(); })();
