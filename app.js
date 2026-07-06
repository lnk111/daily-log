(function(){
  "use strict";

  /* ====================================================================
     CONFIG — 배포 후 이 두 값만 채우면 폰 푸시가 켜집니다.
     WORKER_URL    : 배포한 Cloudflare Worker 주소 (끝에 / 없이)
     VAPID_PUBLIC  : 생성한 VAPID 공개키 (worker와 같은 값)
  ==================================================================== */
  const WORKER_URL  = "https://daily-log-push.YOUR-SUBDOMAIN.workers.dev";
  const VAPID_PUBLIC = "PASTE_YOUR_VAPID_PUBLIC_KEY";
  const PUSH_READY = WORKER_URL.indexOf("YOUR-SUBDOMAIN")<0 && VAPID_PUBLIC.indexOf("PASTE_")<0;

  /* ---------- storage: window.storage → localStorage ---------- */
  const store = {
    async get(k){ if(window.storage){try{const r=await window.storage.get(k);return r?r.value:null;}catch(e){return null;}} try{return localStorage.getItem(k);}catch(e){return null;} },
    async set(k,v){ if(window.storage){try{await window.storage.set(k,v);return;}catch(e){}} try{localStorage.setItem(k,v);}catch(e){} },
    async list(p){ if(window.storage){try{const r=await window.storage.list(p);return (r&&r.keys)||[];}catch(e){return [];}} const a=[];try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k&&k.indexOf(p)===0)a.push(k);}}catch(e){} return a; }
  };

  const FIELDS=["morning","work","evening","keep","problem","try"];
  const els={}; document.querySelectorAll("[data-field]").forEach(t=>els[t.dataset.field]=t);

  let entries={};        // { 'YYYY-MM-DD': {morning,...} }  in-memory cache
  let current=todayStr();
  let currentView="record";
  let loading=false, saveTimer=null;
  let fb=null;           // firebase database ref (logs/{code}) when connected
  let curFin=emptyFin(); // finance entries for the day on screen
  let allocs={};         // { 'YYYY-MM': 투자 배정금액 }

  /* ---------- date helpers ---------- */
  const WD=["일","월","화","수","목","금","토"];
  function pad(n){return String(n).padStart(2,"0");}
  function ymd(d){return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());}
  function parseYmd(s){const[a,b,c]=s.split("-").map(Number);return new Date(a,b-1,c);}
  function todayStr(){return ymd(new Date());}
  function hasContent(o){return o&&FIELDS.some(f=>(o[f]||"").trim());}

  /* ===================== RECORD ===================== */
  function renderDate(){
    const d=parseYmd(current);
    document.getElementById("dMain").textContent=(d.getMonth()+1)+"월 "+d.getDate()+"일";
    document.getElementById("dSub").textContent=d.getFullYear()+" · "+WD[d.getDay()]+"요일";
    document.getElementById("datePicker").value=current;
    document.getElementById("headDate").textContent=d.getFullYear()+". "+pad(d.getMonth()+1)+". "+pad(d.getDate())+" ("+WD[d.getDay()]+")";
  }
  function grow(t){t.style.height="auto";const min=t.classList.contains("kpt-line")?24:120;t.style.height=Math.max(t.scrollHeight,min)+"px";}
  function growAll(){ FIELDS.forEach(f=>{ if(els[f]) grow(els[f]); }); }

  function loadDayFromCache(){
    loading=true;
    const data=entries[current]||{};
    FIELDS.forEach(f=>{els[f].value=data[f]||"";grow(els[f]);});
    curFin=cloneFin(data.fin);
    renderFinance();
    loading=false; checkDue();
  }

  /* Reflect remote (Firebase) changes for the current date WITHOUT redrawing
     the whole sheet — only touch fields whose text actually changed and that
     aren't currently being edited. This removes the flicker. */
  function syncDayIntoDOM(){
    const data=entries[current]||{};
    const active=document.activeElement;
    FIELDS.forEach(f=>{
      const el=els[f];
      if(el===active) return;            // never disturb the field being typed in
      const nv=data[f]||"";
      if(el.value!==nv){ el.value=nv; grow(el); }   // update only if different
    });
    const editingFin=active&&active.closest&&active.closest(".fin-add, .fin-alloc, .acct-alloc, .fin-acct-edit, #finAcctList");
    if(!editingFin){ curFin=cloneFin(data.fin); renderFinance(); }
    checkDue();
  }

  function persistDay(date,data,empty){
    const key="log:"+date;
    if(empty){ delete entries[date]; store.set(key,""); if(fb) fb.child(date).remove(); }
    else { entries[date]=data; store.set(key,JSON.stringify(data)); if(fb) fb.child(date).set(data); }
  }
  function flushSave(){
    const data={}; let empty=true;
    FIELDS.forEach(f=>{const v=els[f].value;data[f]=v;if(v.trim())empty=false;});
    if(finHasContent(curFin)){ data.fin=curFin; empty=false; }
    persistDay(current,data,empty);
    showChip(fb?"동기화됨":"저장됨", fb?"cloud":"check");
    checkDue();
    if(currentView==="calendar") renderCalendar();
    if(currentView==="review") renderReview();
  }
  function queueSave(){ if(loading)return; showChip("저장 중…","check",true); clearTimeout(saveTimer); saveTimer=setTimeout(flushSave,600); }

  let chipTimer=null;
  function showChip(text,icon,sticky){
    const chip=document.getElementById("chip");
    document.getElementById("chipText").textContent=text;
    document.getElementById("chipIcon").innerHTML = icon==="cloud"
      ? '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>'
      : '<polyline points="20 6 9 17 4 12"/>';
    chip.classList.toggle("cloud", icon==="cloud");
    chip.classList.add("show");
    clearTimeout(chipTimer);
    if(!sticky) chipTimer=setTimeout(()=>chip.classList.remove("show"),1500);
  }

  function checkDue(){
    const banner=document.getElementById("dueBanner");
    const show = currentView==="record" && current===todayStr() && !hasContent(collect());
    banner.classList.toggle("hidden",!show);
  }
  function collect(){const o={};FIELDS.forEach(f=>o[f]=els[f].value);return o;}

  async function go(dateStr){ clearTimeout(saveTimer); flushSave(); current=dateStr; renderDate(); loadDayFromCache(); }
  function shift(n){const d=parseYmd(current);d.setDate(d.getDate()+n);go(ymd(d));}

  document.getElementById("prev").onclick=()=>shift(-1);
  document.getElementById("next").onclick=()=>shift(1);
  document.getElementById("todayBtn").onclick=()=>go(todayStr());
  document.getElementById("datePicker").onchange=e=>{if(e.target.value)go(e.target.value);};
  document.addEventListener("keydown",e=>{
    if(e.target.tagName==="TEXTAREA"||e.target.tagName==="INPUT"||currentView!=="record")return;
    if(e.key==="ArrowLeft")shift(-1); if(e.key==="ArrowRight")shift(1);
  });
  FIELDS.forEach(f=>els[f].addEventListener("input",()=>{grow(els[f]);queueSave();}));
  window.addEventListener("beforeunload",()=>{clearTimeout(saveTimer);flushSave();});

  /* ===================== TABS ===================== */
  function setView(v){
    if(v!==currentView){ clearTimeout(saveTimer); flushSave(); }
    currentView=v;
    document.querySelectorAll(".tab").forEach(t=>t.setAttribute("aria-selected", t.dataset.view===v));
    document.querySelectorAll(".view").forEach(s=>s.classList.toggle("active", s.id==="view-"+v));
    if(v==="record") requestAnimationFrame(growAll);   // 탭으로 돌아오면 숨김 상태에서 접힌 칸을 다시 펼침
    if(v==="calendar") renderCalendar();
    if(v==="review") renderReview();
    checkDue();
    window.scrollTo({top:0,behavior:"auto"});
  }
  document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>setView(t.dataset.view));

  /* ===================== CALENDAR ===================== */
  let calMonth=(function(){const d=parseYmd(current);d.setDate(1);return d;})();
  function renderCalendar(){
    const grid=document.getElementById("calGrid"); grid.innerHTML="";
    const y=calMonth.getFullYear(), m=calMonth.getMonth();
    document.getElementById("calTitle").textContent=y+"년 "+(m+1)+"월";
    const first=new Date(y,m,1), startDow=first.getDay();
    const daysInMonth=new Date(y,m+1,0).getDate();
    const today=todayStr();
    let recorded=0;
    const totalCells=Math.ceil((startDow+daysInMonth)/7)*7;
    for(let i=0;i<totalCells;i++){
      const dayNum=i-startDow+1;
      const cell=document.createElement("div");
      if(dayNum<1||dayNum>daysInMonth){ cell.className="cell empty"; grid.appendChild(cell); continue; }
      const ds=y+"-"+pad(m+1)+"-"+pad(dayNum);
      const has=hasContent(entries[ds]);
      if(has) recorded++;
      cell.className="cell"+(has?" has":"")+(ds===today?" today":"")+(ds===current?" sel":"");
      cell.innerHTML='<span class="num">'+dayNum+'</span><span class="mark"></span>';
      cell.onclick=()=>{ current=ds; renderDate(); loadDayFromCache(); setView("record"); };
      grid.appendChild(cell);
    }
    document.getElementById("calStat").innerHTML="이 달에 <span>"+recorded+"일</span> 기록했어요.";
  }
  document.getElementById("calPrev").onclick=()=>{calMonth.setMonth(calMonth.getMonth()-1);renderCalendar();};
  document.getElementById("calNext").onclick=()=>{calMonth.setMonth(calMonth.getMonth()+1);renderCalendar();};
  document.getElementById("calToday").onclick=()=>{const d=new Date();d.setDate(1);calMonth=d;renderCalendar();};

  /* ===================== REVIEW ===================== */
  let revMode="week";                 // 'week' | 'month'
  let revAnchor=parseYmd(current);    // a date inside the active period
  function periodRange(){
    if(revMode==="week"){
      const s=new Date(revAnchor); s.setDate(s.getDate()-s.getDay()); s.setHours(0,0,0,0);
      const e=new Date(s); e.setDate(e.getDate()+6);
      return {start:s,end:e};
    }
    const s=new Date(revAnchor.getFullYear(),revAnchor.getMonth(),1);
    const e=new Date(revAnchor.getFullYear(),revAnchor.getMonth()+1,0);
    return {start:s,end:e};
  }
  function periodLabel(r){
    if(revMode==="week"){
      const sameMonth=r.start.getMonth()===r.end.getMonth();
      const a=(r.start.getMonth()+1)+"월 "+r.start.getDate()+"일";
      const b=(sameMonth? "" : (r.end.getMonth()+1)+"월 ")+r.end.getDate()+"일";
      return a+" – "+b;
    }
    return revAnchor.getFullYear()+"년 "+(revAnchor.getMonth()+1)+"월";
  }
  function renderReview(){
    const r=periodRange();
    document.getElementById("revTitle").textContent=periodLabel(r);
    const buckets={keep:[],problem:[],try:[]};
    let days=0;
    let fInc=0,fExp=0,fBuy=0,fSav=0;
    const cur=new Date(r.start);
    while(cur<=r.end){
      const ds=ymd(cur), o=entries[ds];
      if(hasContent(o)){
        days++;
        ["keep","problem","try"].forEach(k=>{ const v=(o[k]||"").trim(); if(v) buckets[k].push({date:ds,text:v}); });
      }
      const f=o&&o.fin;
      if(f){ fInc+=finSum(f.inc); fExp+=finSum(f.exp); fBuy+=finSum(f.buy); fSav+=finSum(f.sav); }
      cur.setDate(cur.getDate()+1);
    }
    const span=revMode==="week"?7:(r.end.getDate());
    document.getElementById("revStat").innerHTML="이 기간 <b>"+days+"</b>일 기록 · 총 "+span+"일 중";
    document.getElementById("revFinCards").innerHTML=
      revFinCard("수입",fInc)+revFinCard("지출",fExp)+revFinCard("투자 매수",fBuy)+revFinCard("적금",fSav);
    fill("revKeep",buckets.keep); fill("revProblem",buckets.problem); fill("revTry",buckets.try);
  }
  function revFinCard(label,val){
    return '<div class="fin-card"><div class="fl">'+label+'</div><div class="fv" style="font-size:15px">'+won(val)+'</div></div>';
  }
  function fill(id,list){
    const box=document.getElementById(id); box.innerHTML="";
    if(!list.length){ box.innerHTML='<div class="kempty">아직 없어요.</div>'; return; }
    list.forEach(it=>{
      const d=parseYmd(it.date);
      const row=document.createElement("div"); row.className="kentry";
      row.innerHTML='<span class="when">'+(d.getMonth()+1)+'/'+d.getDate()+' '+WD[d.getDay()]+'</span><span class="what"></span>';
      row.querySelector(".what").textContent=it.text;
      row.querySelector(".when").addEventListener("click",()=>{},{passive:true});
      row.style.cursor="pointer";
      row.onclick=()=>{ current=it.date; renderDate(); loadDayFromCache(); setView("record"); };
      box.appendChild(row);
    });
  }
  function setRevMode(mode){ revMode=mode;
    document.getElementById("segWeek").setAttribute("aria-selected",mode==="week");
    document.getElementById("segMonth").setAttribute("aria-selected",mode==="month");
    renderReview();
  }
  document.getElementById("segWeek").onclick=()=>setRevMode("week");
  document.getElementById("segMonth").onclick=()=>setRevMode("month");
  document.getElementById("revPrev").onclick=()=>{ revAnchor.setDate(revAnchor.getDate()-(revMode==="week"?7:0)); if(revMode==="month")revAnchor.setMonth(revAnchor.getMonth()-1); renderReview(); };
  document.getElementById("revNext").onclick=()=>{ revAnchor.setDate(revAnchor.getDate()+(revMode==="week"?7:0)); if(revMode==="month")revAnchor.setMonth(revAnchor.getMonth()+1); renderReview(); };

  /* ===================== REMINDER ===================== */
  const remToggle=document.getElementById("remToggle"), remTime=document.getElementById("remTime"),
        remNote=document.getElementById("remNote"), bell=document.getElementById("bell");
  let remTimer=null;
  document.getElementById("bell").onclick=()=>{ document.getElementById("syncPanel").classList.remove("open"); document.getElementById("remPanel").classList.toggle("open"); };
  function setNote(){
    if(!("Notification" in window)){ remNote.textContent="이 브라우저는 알림을 지원하지 않아, 화면 안내로만 알려드려요."; return; }
    if(!remToggle.checked){ remNote.textContent="알림이 꺼져 있어요."; return; }
    const p=Notification.permission;
    if(p==="granted") remNote.textContent="매일 "+remTime.value+"에 알림을 보내드릴게요. (앱이 실행 중일 때)";
    else if(p==="denied") remNote.textContent="브라우저에서 알림이 차단돼 있어요. 사이트 권한에서 알림을 허용해 주세요. 그 전까진 화면 안내로 알려드려요.";
    else remNote.textContent="알림 권한을 요청할게요…";
  }
  function msUntil(hhmm){const[h,m]=hhmm.split(":").map(Number);const now=new Date();const t=new Date(now);t.setHours(h,m,0,0);if(t<=now)t.setDate(t.getDate()+1);return t-now;}
  function fire(){
    const done=hasContent(entries[todayStr()]);
    if(("Notification" in window)&&Notification.permission==="granted"){
      try{ new Notification(done?"오늘 한 줄 더 남겨볼까요? ✍️":"오늘 로그를 기록할 시간이에요 ✍️",{body:done?"Daily Log · 회고까지 채우면 완성!":"아침·회사·저녁 그리고 KPT 회고까지.",tag:"daily-log"}); }catch(e){}
    }
    schedule();
  }
  function schedule(){ clearTimeout(remTimer); if(!remToggle.checked)return; remTimer=setTimeout(fire,msUntil(remTime.value)); }
  async function saveRem(){ await store.set("settings:reminder",JSON.stringify({enabled:remToggle.checked,time:remTime.value})); bell.classList.toggle("on",remToggle.checked); }
  remToggle.addEventListener("change",async()=>{ if(remToggle.checked&&("Notification" in window)&&Notification.permission==="default"){try{await Notification.requestPermission();}catch(e){}} setNote();schedule();saveRem(); });
  remTime.addEventListener("change",()=>{setNote();schedule();saveRem(); if(pushSub) subscribePush(true);});
  async function loadRem(){ const raw=await store.get("settings:reminder"); if(raw){try{const s=JSON.parse(raw);remToggle.checked=!!s.enabled;if(s.time)remTime.value=s.time;}catch(e){}} bell.classList.toggle("on",remToggle.checked); setNote();schedule(); }
  document.addEventListener("visibilitychange",()=>{ if(!document.hidden){schedule();checkDue();} });

  /* ===================== BACKGROUND PUSH (Service Worker + Web Push) ===================== */
  const pushStatus=document.getElementById("pushStatus"), pushNote=document.getElementById("pushNote");
  let swReg=null, pushSub=null;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul";

  function setPush(text,cls){ pushStatus.textContent="폰 푸시: "+text; pushStatus.className="sync-status "+cls; }
  function urlB64ToU8(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4)s+="="; const r=atob(s); const u=new Uint8Array(r.length); for(let i=0;i<r.length;i++)u[i]=r.charCodeAt(i); return u; }

  async function registerSW(){
    if(!("serviceWorker" in navigator)) return null;
    try{ swReg = await navigator.serviceWorker.register("sw.js"); return swReg; }catch(e){ return null; }
  }

  async function subscribePush(silent){
    if(!PUSH_READY){ setPush("설정 필요","off"); pushNote.innerHTML="배포 후 코드 상단의 <b>WORKER_URL</b>과 <b>VAPID_PUBLIC</b>을 채우면 켤 수 있어요."; return; }
    if(!("Notification" in window)||!("PushManager" in window)){ setPush("이 기기 미지원","err"); return; }
    const reg = swReg || await registerSW();
    if(!reg){ setPush("서비스워커 실패","err"); return; }
    let perm = Notification.permission;
    if(perm==="default") perm = await Notification.requestPermission();
    if(perm!=="granted"){ setPush("권한 거부됨","err"); pushNote.textContent="기기 설정에서 이 앱의 알림을 허용해 주세요."; return; }
    try{
      pushSub = await reg.pushManager.getSubscription();
      if(!pushSub){ pushSub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: urlB64ToU8(VAPID_PUBLIC) }); }
      const res = await fetch(WORKER_URL+"/subscribe",{ method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ subscription: pushSub.toJSON(), time: remTime.value, tz }) });
      if(!res.ok) throw new Error("server "+res.status);
      await store.set("settings:push", JSON.stringify({on:true}));
      setPush("켜짐 · 매일 "+remTime.value,"ok");
      if(!silent) pushNote.textContent="이제 앱을 닫아도 매일 "+remTime.value+"에 폰으로 알림이 와요. 알림을 누르면 오늘 기록 화면이 열립니다.";
    }catch(e){ setPush("연결 실패","err"); pushNote.textContent="네트워크 또는 Worker 주소를 확인해 주세요."; }
  }

  async function unsubscribePush(){
    try{
      const reg = swReg || await registerSW();
      const sub = reg && await reg.pushManager.getSubscription();
      if(sub){ try{ await fetch(WORKER_URL+"/unsubscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({endpoint:sub.endpoint})}); }catch(e){} await sub.unsubscribe(); }
    }catch(e){}
    pushSub=null; await store.set("settings:push", JSON.stringify({on:false}));
    setPush("꺼짐","off");
  }

  document.getElementById("pushOn").onclick=()=>subscribePush(false);
  document.getElementById("pushOff").onclick=()=>unsubscribePush();

  async function loadPush(){
    await registerSW();
    const raw=await store.get("settings:push");
    let on=false; if(raw){try{on=!!JSON.parse(raw).on;}catch(e){}}
    if(on && PUSH_READY){ subscribePush(true); }
    else { setPush(PUSH_READY?"꺼짐":"설정 필요", "off"); }
  }

  /* ===================== FIREBASE LOGIN + SYNC ===================== */
  const FB_CONFIG={
    apiKey:"AIzaSyAJiSnaGl7Tr3d4uAYcSbvkOIe40IbmnMw",
    authDomain:"daily-log-6cd4c.firebaseapp.com",
    databaseURL:"https://daily-log-6cd4c-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId:"daily-log-6cd4c",
    storageBucket:"daily-log-6cd4c.firebasestorage.app",
    messagingSenderId:"148402603863",
    appId:"1:148402603863:web:b18d88d97f18b9e9c5e012"
  };
  const syncStatus=document.getElementById("syncStatus"), gear=document.getElementById("gear");
  document.getElementById("gear").onclick=()=>{ document.getElementById("remPanel").classList.remove("open"); document.getElementById("syncPanel").classList.toggle("open"); };
  function setSyncStatus(text,cls){ syncStatus.textContent=text; syncStatus.className="sync-status "+cls; gear.classList.toggle("on",cls==="ok"); }

  function attachListener(ref){
    if(fb){ try{fb.off();}catch(e){} }
    fb=ref;
    fb.on("value",snap=>{
      const val=snap.val()||{};
      allocs=val._alloc||{}; delete val._alloc;
      const savedAccts=val._accts; delete val._accts;
      entries=val;
      if(Array.isArray(savedAccts)&&savedAccts.length){ acctList=savedAccts; }
      else {
        acctList=deriveAccts();                         // 저장된 계좌가 없으면 기존 매수·배정 기록에서 복원
        if(acctList.length && fb) fb.child("_accts").set(acctList);   // 복원한 계좌를 한 번 저장
      }
      store.set("alloc",JSON.stringify(allocs)); store.set("accts",JSON.stringify(acctList));
      if(currentView==="record") syncDayIntoDOM();
      if(currentView==="calendar") renderCalendar();
      if(currentView==="review") renderReview();
      checkDue();
    },err=>{ setSyncStatus("동기화 오류: "+err.code+" · DB 규칙을 확인하세요","err"); });
  }

  let fbReady=false;
  function initFirebase(){
    if(fbReady) return true;
    if(typeof firebase==="undefined"){ setSyncStatus("이 환경에선 Firebase를 못 불러와요. 호스팅 페이지에서 동작합니다.","err"); return false; }
    if(!firebase.apps.length) firebase.initializeApp(FB_CONFIG);
    fbReady=true; return true;
  }

  function setAvatar(user){
    const av=document.getElementById("avatar"), inner=document.getElementById("avatarInner");
    if(user){
      if(user.photoURL){ av.style.backgroundImage="url('"+user.photoURL+"')"; inner.textContent=""; }
      else { av.style.backgroundImage="none"; inner.textContent=((user.email||user.displayName||"·")[0]||"·").toUpperCase(); }
      av.title=(user.email||user.displayName||"내 계정")+" · 누르면 로그아웃";
      av.classList.add("on");
    } else { av.classList.remove("on"); av.style.backgroundImage="none"; inner.textContent=""; }
  }

  async function onLogin(user){
    const db=firebase.database();
    attachListener(db.ref("logs/"+user.uid));
    document.getElementById("loginBtn").style.display="none";
    document.getElementById("logoutBtn").style.display="";
    setSyncStatus("로그인됨: "+(user.email||user.displayName||"내 계정")+" · 실시간 동기화 중","ok");
    setAvatar(user);
  }
  function onLogout(){
    if(fb){ try{fb.off();}catch(e){} fb=null; }
    document.getElementById("loginBtn").style.display="";
    document.getElementById("logoutBtn").style.display="none";
    setSyncStatus("로그인 안 됨 · 이 기기에만 저장돼요","off");
    setAvatar(null);
    clearLocalDisplay();   // 로그아웃 상태가 되면 화면(생활비·투자·적금·배정)을 즉시 비움
    clearLocalStore();     // 이 기기에 남은 복사본도 비움 (Firebase의 내 기록은 그대로)
  }
  // 프로필 동그라미를 누르면 동기화 패널을 열어 로그아웃 버튼을 보여줌
  document.getElementById("avatar").onclick=()=>{
    document.getElementById("remPanel").classList.remove("open");
    document.getElementById("syncPanel").classList.add("open");
  };

  document.getElementById("loginBtn").onclick=async()=>{
    if(!initFirebase()) return;
    const provider=new firebase.auth.GoogleAuthProvider();
    setSyncStatus("로그인 창을 여는 중…","ok");
    try{
      await firebase.auth().signInWithPopup(provider);
    }catch(e){
      if(e&&(e.code==="auth/popup-blocked"||e.code==="auth/operation-not-supported-in-this-environment"||e.code==="auth/cancelled-popup-request")){
        try{ await firebase.auth().signInWithRedirect(provider); return; }
        catch(e2){ setSyncStatus("로그인 실패: "+(e2.code||e2.message),"err"); return; }
      }
      if(e&&e.code==="auth/unauthorized-domain"){ setSyncStatus("승인된 도메인에 lnk111.github.io를 추가하세요","err"); return; }
      setSyncStatus("로그인 실패: "+(e.code||e.message),"err");
    }
  };
  // 화면을 즉시 빈 상태로 (생활비·투자·적금·배정 모두 0/빈칸)
  function clearLocalDisplay(){
    entries={}; allocs={}; acctList=[]; curFin=emptyFin();
    loadDayFromCache();
    if(currentView==="calendar") renderCalendar();
    if(currentView==="review") renderReview();
  }
  // 이 기기에 저장된 복사본 비움 (Firebase의 내 기록은 그대로 안전)
  async function clearLocalStore(){
    try{ const keys=await store.list("log:"); for(const k of keys){ await store.set(k,""); } }catch(e){}
    try{ await store.set("alloc",""); await store.set("accts",""); }catch(e){}
  }
  document.getElementById("logoutBtn").onclick=async()=>{
    try{ await firebase.auth().signOut(); }catch(e){}   // 로그아웃 → onLogout이 화면·저장본을 비움
  };

  async function loadSync(){
    if(!initFirebase()) return;
    try{ await firebase.auth().getRedirectResult(); }catch(e){}   // 모바일 리다이렉트 로그인 결과 처리
    firebase.auth().onAuthStateChanged(user=>{ if(user) onLogin(user); else onLogout(); });
  }


  /* ===================== 가계부 (FINANCE) ===================== */
  function gid(id){ return document.getElementById(id); }
  function emptyFin(){ return {inc:[],exp:[],buy:[],sell:[],sav:[]}; }
  function cloneFin(f){ return f ? {inc:(f.inc||[]).slice(),exp:(f.exp||[]).slice(),buy:(f.buy||[]).slice(),sell:(f.sell||[]).slice(),sav:(f.sav||[]).slice()} : emptyFin(); }
  function finSum(arr){ let s=0; if(arr) for(const e of arr) s+=(+e.amount||0); return s; }
  function finHasContent(f){ return !!(f && (finSum(f.inc)||finSum(f.exp)||finSum(f.buy)||finSum(f.sell)||finSum(f.sav))); }
  function won(n){ return Math.round(n||0).toLocaleString("ko-KR")+"원"; }
  function num(n){ return Math.round(n||0).toLocaleString("ko-KR"); }
  function parseAmt(s){ return Math.round(Math.abs(parseFloat(String(s).replace(/[^0-9.]/g,""))||0)); }
  function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
  const isDate=(d)=>/^\d{4}-\d{2}-\d{2}$/.test(d);

  const DEFAULT_ACCTS=["키움증권","한국투자 ISA","한국투자 연금저축","CMA"];
  let acctList=[];   // 기본값은 비움 — 로그인해서 데이터/저장된 계좌가 있을 때만 채워짐
  function deriveAccts(){
    const set=new Set();
    for(const d in entries){ const f=entries[d]&&entries[d].fin; if(!f) continue;
      (f.buy||[]).forEach(e=>{ if(e.acct) set.add(e.acct); });
      (f.sell||[]).forEach(e=>{ if(e.acct) set.add(e.acct); }); }
    for(const ym in allocs){ const m=allocs[ym]; if(m&&typeof m==="object") for(const k in m) set.add(k); }
    return Array.from(set);
  }

  function balanceThrough(dateStr){
    let bal=0;
    for(const d in entries){ if(!isDate(d)||d>dateStr) continue; const f=entries[d]&&entries[d].fin; if(f) bal+=finSum(f.inc)-finSum(f.exp); }
    return bal;
  }
  function monthSum(ym,kind){
    let s=0;
    for(const d in entries){ if(!isDate(d)||d.slice(0,7)!==ym) continue; const f=entries[d]&&entries[d].fin; if(f&&f[kind]) s+=finSum(f[kind]); }
    return s;
  }
  function monthSumAcct(ym,kind,acct){
    let s=0;
    for(const d in entries){ if(!isDate(d)||d.slice(0,7)!==ym) continue; const f=entries[d]&&entries[d].fin;
      if(f&&f[kind]) for(const e of f[kind]) if((e.acct||"")===acct) s+=(+e.amount||0); }
    return s;
  }
  function getAlloc(ym,acct){ const m=allocs[ym]; return (m&&typeof m==="object")?(+m[acct]||0):0; }
  function allocTotal(ym){ const m=allocs[ym]; let s=0; if(m&&typeof m==="object") for(const k in m) s+=(+m[k]||0); return s; }
  function allocCumThrough(ym){ let s=0; for(const m in allocs){ if(m<=ym){ const o=allocs[m]; if(o&&typeof o==="object") for(const k in o) s+=(+o[k]||0); } } return s; }
  function cumKind(dateStr,kind){ let s=0; for(const d in entries){ if(!isDate(d)||d>dateStr) continue; const f=entries[d]&&entries[d].fin; if(f&&f[kind]) s+=finSum(f[kind]); } return s; }

  // 종목(계좌+이름) 정확 매칭으로 이번 달 매도 손익 = Σ(매도합 − 매수합), 매도가 있는 종목만
  function profitMonth(ym){
    const b={}, s={};
    for(const d in entries){ if(!isDate(d)||d.slice(0,7)!==ym) continue; const f=entries[d]&&entries[d].fin; if(!f) continue;
      if(f.buy) for(const e of f.buy){ const k=(e.acct||"")+"│"+(e.label||""); b[k]=(b[k]||0)+(+e.amount||0); }
      if(f.sell) for(const e of f.sell){ const k=(e.acct||"")+"│"+(e.label||""); s[k]=(s[k]||0)+(+e.amount||0); }
    }
    let p=0; for(const k in s) p+=s[k]-(b[k]||0);
    return p;
  }
  function computeInvest(ym){
    let totAlloc=0, totExecCap=0, totWaitBudget=0; const per=[];
    acctList.forEach(acct=>{
      const a=getAlloc(ym,acct), buy=monthSumAcct(ym,"buy",acct);
      const wait=Math.max(0, a-buy);                 // 대기는 0 밑으로 안 내려감
      totAlloc+=a; totExecCap+=Math.min(buy,a); totWaitBudget+=wait;
      per.push({acct,a,buy,wait});
    });
    const profit=profitMonth(ym);
    const investWait=Math.max(0, totWaitBudget+profit);  // 투자대기금 = 미집행 + 손익 (0 바닥)
    return {totAlloc,totExecCap,investWait,profit,per};
  }

  function finRow(label,amtText,cls,kind,idx){
    return '<div class="fin-row"><span class="fin-lab">'+esc(label)+'</span>'
         +'<span class="fin-amt '+cls+'">'+amtText+'</span>'
         +'<span class="x" data-k="'+kind+'" data-i="'+idx+'" aria-label="삭제">✕</span></div>';
  }

  function renderFinance(){
    const ym=current.slice(0,7);
    entries[current]=entries[current]||{};
    entries[current].fin=curFin;                    // keep cache in sync for live calc

    // 오늘 내역 (수입·지출·매수·매도·적금 합본)
    let L="";
    curFin.inc.forEach((e,i)=>{ L+=finRow(e.label||"수입","＋"+won(e.amount),"pos","inc",i); });
    curFin.exp.forEach((e,i)=>{ L+=finRow(e.label||"지출","－"+won(e.amount),"neg","exp",i); });
    curFin.buy.forEach((e,i)=>{ L+=finRow("매수 · "+(e.acct?e.acct+" · ":"")+(e.label||""),"＋"+won(e.amount),"buyc","buy",i); });
    curFin.sell.forEach((e,i)=>{ L+=finRow("매도 · "+(e.acct?e.acct+" · ":"")+(e.label||""),"＋"+won(e.amount),"sellc","sell",i); });
    curFin.sav.forEach((e,i)=>{ L+=finRow("적금"+(e.label?" · "+e.label:""),"＋"+won(e.amount),"acc","sav",i); });
    gid("finTodayList").innerHTML=L||'<div class="fin-empty">오늘 내역이 없어요. 아래 ＋기록하기로 추가하세요.</div>';

    // 투자 — 계좌별 행 (집행은 실제 매수액, 대기는 0 바닥)
    let rows="";
    acctList.forEach((acct,i)=>{
      const a=getAlloc(ym,acct);
      rows+='<div class="acct-row">'
        +'<span class="acct-name">'+esc(acct)+'</span>'
        +'<span class="acct-mid" id="acctMid'+i+'"></span>'
        +'<input class="acct-alloc" data-i="'+i+'" inputmode="numeric" placeholder="계획 금액"'+(a?' value="'+num(a)+'"':'')+' />'
        +'<span class="acct-x" data-i="'+i+'" aria-label="계좌 삭제">✕</span>'
        +'</div>';
    });
    gid("finAcctList").innerHTML=rows||(
      '<div class="acct-empty">'
      +'<div class="ae-title">증권·연금 계좌를 추가해 보세요</div>'
      +'<div class="ae-desc">계좌를 만들면 계좌별로 이번 달 <b>계획</b>과 <b>실제</b> 매수·<b>남음</b>을 따로 관리할 수 있어요.</div>'
      +'<div class="ae-steps">'
        +'<div class="ae-step"><span class="ae-n">1</span><span>아래 칸에 계좌 이름을 적고 <b>＋계좌</b></span></div>'
        +'<div class="ae-step"><span class="ae-n">2</span><span>계좌 옆 <b>계획 금액</b>에 이번 달 목표를 입력</span></div>'
        +'<div class="ae-step"><span class="ae-n">3</span><span><b>＋기록하기 → 매수</b>로 실제 매수를 기록</span></div>'
      +'</div>'
      +'<div class="ae-ex">예시: 키움증권 · 한국투자 ISA · 연금저축 · CMA · 토스증권</div>'
      +'</div>'
    );

    // 기록 시트의 계좌 선택지
    const prev=gid("sheetAcct").value;
    gid("sheetAcct").innerHTML=acctList.map(a=>'<option>'+esc(a)+'</option>').join("");
    if(acctList.indexOf(prev)>=0) gid("sheetAcct").value=prev;

    refreshNumbers();
  }

  // 행을 다시 그리지 않고 숫자만 갱신 (배정 입력 중에도 안전)
  function refreshNumbers(){
    const ym=current.slice(0,7);
    const I=computeInvest(ym);
    const bal=balanceThrough(current);
    const sav=monthSum(ym,"sav");
    const carve=cumKind(current,"sav")+allocCumThrough(ym);   // 적금(누적) + 투자 배정 누적(계획금액) · 매수·매도와 무관
    const spend=bal-carve;

    gid("finBalance").textContent=won(spend);
    gid("finCarry").textContent="수입−지출 "+num(bal)+" 중";
    gid("finSave").textContent=won(sav);
    if(gid("finCarveAmt")) gid("finCarveAmt").textContent=won(carve);
    if(gid("finSpendAmt")) gid("finSpendAmt").textContent=won(spend);

    gid("finInvest").innerHTML=num(I.totExecCap)+'<span class="sub"> / '+num(I.totAlloc)+'</span>';
    const fw=gid("finWait"); if(fw) fw.textContent="대기금 "+num(I.investWait);
    gid("invAllocTotal").textContent=num(I.totAlloc);
    const pl=gid("invProfit");
    if(pl){ pl.textContent="수익 "+(I.profit>=0?"＋":"－")+num(Math.abs(I.profit))+"원";
      pl.className="fin-profit "+(I.profit>0?"pos":I.profit<0?"neg":"zero"); }
    const pct=I.totAlloc>0?Math.max(0,Math.min(100,I.totExecCap/I.totAlloc*100)):0;
    gid("finBarFill").style.width=pct+"%";
    gid("finExec").textContent="실제 "+num(I.totExecCap)+(I.totAlloc>0?" ("+Math.round(pct)+"%)":"");
    gid("finWait2").textContent="남음 "+num(I.investWait);
    const st=gid("savTag"); if(st) st.textContent="이번 달 "+won(sav);
    I.per.forEach((p,i)=>{ const m=gid("acctMid"+i); if(m) m.textContent="실제 "+num(p.buy)+" · 남음 "+num(p.wait); });
  }

  function finChanged(){
    entries[current]=entries[current]||{}; entries[current].fin=curFin;
    renderFinance(); queueSave();
    if(currentView==="review") renderReview();
  }
  function addFin(kind,label,amtStr,acct){
    const amount=parseAmt(amtStr); if(!amount) return;
    if(kind==="sell") curFin.sell.push({label:label||"",amount,acct:acct||""});
    else if(kind==="buy") curFin.buy.push({label:label||"",amount,acct:acct||""});
    else curFin[kind].push({label:label||"",amount});
    finChanged();
  }
  function persistAllocs(){ store.set("alloc",JSON.stringify(allocs)); if(fb) fb.child("_alloc").set(allocs); }
  function persistAccts(){ store.set("accts",JSON.stringify(acctList)); if(fb) fb.child("_accts").set(acctList); }

  // 오늘 내역 삭제
  gid("finTodayList").addEventListener("click",e=>{
    const x=e.target.closest(".x"); if(!x) return;
    const k=x.dataset.k, i=+x.dataset.i;
    if(curFin[k]) curFin[k].splice(i,1);
    finChanged();
  });

  // 투자 자세히 펼치기/접기
  gid("invToggle").onclick=()=>{
    const d=gid("invDetail"); const open=d.hidden;
    d.hidden=!open; gid("invToggle").setAttribute("aria-expanded",open?"true":"false");
    gid("invChev").classList.toggle("up",open);
  };

  // 기록하기 바텀시트
  const SHEET_PH={inc:"내용 (예: 월급)",exp:"내용 (예: 점심)",buy:"종목 (예: 삼성전자)",sell:"종목 (예: 삼성전자)",sav:"내용 (예: 정기적금)"};
  let sheetKind="exp";
  function setSheetKind(k){
    sheetKind=k;
    document.querySelectorAll("#addSeg button").forEach(b=>b.classList.toggle("on",b.dataset.kind===k));
    gid("sheetAcctRow").hidden=!(k==="buy"||k==="sell");
    gid("sheetLabel").placeholder=SHEET_PH[k]||"내용";
  }
  function openSheet(){
    gid("sheetBack").hidden=false; gid("addSheet").hidden=false;
    requestAnimationFrame(()=>gid("addSheet").classList.add("up"));
    setTimeout(()=>gid("sheetLabel").focus(),140);
  }
  function closeSheet(){
    gid("addSheet").classList.remove("up"); gid("sheetBack").hidden=true;
    setTimeout(()=>{ gid("addSheet").hidden=true; },220);
  }
  gid("addOpen").onclick=openSheet;
  gid("sheetBack").onclick=closeSheet;
  gid("sheetClose").onclick=closeSheet;
  document.getElementById("addSeg").addEventListener("click",e=>{ const b=e.target.closest("button[data-kind]"); if(b) setSheetKind(b.dataset.kind); });
  function sheetAddFn(){
    const acct=(sheetKind==="buy"||sheetKind==="sell")?gid("sheetAcct").value:"";
    addFin(sheetKind, gid("sheetLabel").value.trim(), gid("sheetAmt").value, acct);
    gid("sheetLabel").value=""; gid("sheetAmt").value=""; gid("sheetLabel").focus();
  }
  gid("sheetAdd").addEventListener("mousedown",e=>e.preventDefault());   // 버튼이 포커스를 안 뺏게 → 한글 유지
  gid("sheetAdd").onclick=sheetAddFn;
  gid("sheetAmt").addEventListener("keydown",e=>{ if(e.key==="Enter") sheetAddFn(); });
  gid("sheetLabel").addEventListener("keydown",e=>{ if(e.key==="Enter") gid("sheetAmt").focus(); });
  setSheetKind("exp");

  // 계좌별 배정 입력 (타이핑 중엔 행을 다시 그리지 않고 숫자만 갱신, 저장은 디바운스)
  let allocTimer=null;
  gid("finAcctList").addEventListener("input",e=>{
    const inp=e.target.closest(".acct-alloc"); if(!inp) return;
    const ym=current.slice(0,7); const acct=acctList[+inp.dataset.i]; if(!acct) return;
    if(!allocs[ym]||typeof allocs[ym]!=="object") allocs[ym]={};
    const v=parseAmt(inp.value);
    if(v) allocs[ym][acct]=v; else delete allocs[ym][acct];
    refreshNumbers();
    clearTimeout(allocTimer); allocTimer=setTimeout(persistAllocs,600);
  });
  gid("finAcctList").addEventListener("blur",e=>{
    const inp=e.target&&e.target.closest&&e.target.closest(".acct-alloc"); if(!inp) return;
    const ym=current.slice(0,7); const acct=acctList[+inp.dataset.i];
    const v=getAlloc(ym,acct);
    inp.value=v?num(v):"";                 // 입력 끝나면 콤마로 정리
    clearTimeout(allocTimer); persistAllocs();
  },true);
  // 계좌 삭제
  gid("finAcctList").addEventListener("click",e=>{
    const x=e.target.closest(".acct-x"); if(!x) return;
    const acct=acctList[+x.dataset.i]; if(!acct) return;
    if(!confirm('"'+acct+'" 계좌를 목록에서 뺄까요?\n(이미 기록한 거래는 그대로 남아요)')) return;
    acctList=acctList.filter(a=>a!==acct);
    persistAccts(); renderFinance();
  });
  // 계좌 추가
  gid("acctAdd").onclick=()=>{
    const v=gid("acctNew").value.trim(); if(!v) return;
    if(acctList.indexOf(v)<0) acctList.push(v);
    gid("acctNew").value=""; persistAccts(); renderFinance();
  };
  gid("acctNew").addEventListener("keydown",e=>{ if(e.key==="Enter") gid("acctAdd").click(); });

  /* ===================== INIT ===================== */
  async function loadAllLocal(){
    entries={};
    const keys=await store.list("log:");
    for(const k of keys){ const v=await store.get(k); if(v){ try{ entries[k.slice(4)]=JSON.parse(v); }catch(e){} } }
    const a=await store.get("alloc"); if(a){ try{ allocs=JSON.parse(a)||{}; }catch(e){} }
    const ac=await store.get("accts"); if(ac){ try{ const x=JSON.parse(ac); if(Array.isArray(x)&&x.length) acctList=x; }catch(e){} }
  }
  (async function init(){
    // open today's record when launched from a push notification
    try{ const u=new URLSearchParams(location.search); if(u.get("src")==="push") current=todayStr(); }catch(e){}
    renderDate();
    await loadAllLocal();
    loadDayFromCache();
    await loadRem();
    await loadPush();
    await loadSync();   // if previously connected, Firebase snapshot overrides cache
    requestAnimationFrame(growAll);
    setTimeout(growAll,300);                 // 폰트·동기화 반영 후 한 번 더 펼침
  })();

  window.addEventListener("resize",()=>{ if(currentView==="record") growAll(); });
  window.addEventListener("load",growAll);

})();
