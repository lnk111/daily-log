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
    if(currentView==="ledger") renderLedger();
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
    document.querySelectorAll(".bnav-item").forEach(t=>t.classList.toggle("active", t.dataset.view===v));
    document.querySelectorAll(".view").forEach(s=>s.classList.toggle("active", s.id==="view-"+v));
    if(v==="record") requestAnimationFrame(growAll);   // 탭으로 돌아오면 숨김 상태에서 접힌 칸을 다시 펼침
    if(v==="calendar") renderCalendar();
    if(v==="review") renderReview();
    if(v==="ledger") renderLedger();
    checkDue();
    window.scrollTo({top:0,behavior:"auto"});
  }
  document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>setView(t.dataset.view));
  document.querySelectorAll(".bnav-item").forEach(t=>t.onclick=()=>setView(t.dataset.view));

  /* ===================== SUB-SEGMENT (모바일 기록 탭) ===================== */
  let currentSeg="log";
  function setSubSeg(seg){
    currentSeg=seg;
    document.querySelectorAll(".sub-tab").forEach(b=>b.classList.toggle("active",b.dataset.seg===seg));
    document.querySelectorAll("#view-record .sub-view").forEach(v=>v.classList.toggle("active",v.dataset.seg===seg));
    if(seg==="log"||seg==="kpt") requestAnimationFrame(growAll);
  }
  document.querySelectorAll(".sub-tab").forEach(b=>b.onclick=()=>setSubSeg(b.dataset.seg));
  setSubSeg("log");

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

  /* ===================== LEDGER (가계부) ===================== */
  let ledMode="month";                // 'week' | 'month'
  let ledAnchor=parseYmd(current);    // 활성 기간 안의 임의 날짜
  function ledRange(){
    if(ledMode==="week"){
      const s=new Date(ledAnchor); s.setDate(s.getDate()-s.getDay()); s.setHours(0,0,0,0);
      const e=new Date(s); e.setDate(e.getDate()+6);
      return {start:s,end:e};
    }
    const s=new Date(ledAnchor.getFullYear(),ledAnchor.getMonth(),1);
    const e=new Date(ledAnchor.getFullYear(),ledAnchor.getMonth()+1,0);
    return {start:s,end:e};
  }
  function ledLabel(r){
    if(ledMode==="week"){
      const sameMonth=r.start.getMonth()===r.end.getMonth();
      const a=(r.start.getMonth()+1)+"월 "+r.start.getDate()+"일";
      const b=(sameMonth?"":(r.end.getMonth()+1)+"월 ")+r.end.getDate()+"일";
      return a+" – "+b;
    }
    return ledAnchor.getFullYear()+"년 "+(ledAnchor.getMonth()+1)+"월";
  }

  /* 내용(label) 키워드 기반 자동 분류 — 데이터 구조 변경 없음 */
  const CAT_RULES=[
    {cat:"식비",     kw:["밥","점심","저녁","아침","커피","카페","스벅","스타벅스","배달","식당","마트","편의점","음식","간식","치킨","분식","피자","버거","술","맥주","회식","브런치","디저트","빵","김밥","라면"]},
    {cat:"교통",     kw:["택시","버스","지하철","기차","ktx","srt","주유","기름","카카오t","교통","주차","톨게이트","하이패스","항공","비행기","렌터카"]},
    {cat:"주거·통신", kw:["월세","관리비","전기","가스","수도","인터넷","통신","핸드폰","휴대폰","요금","공과금","렌트","보증금","도시가스"]},
    {cat:"생활",     kw:["다이소","쿠팡","생필품","세제","휴지","생활","이케아","잡화","마켓컬리"]},
    {cat:"건강",     kw:["병원","약국","약","헬스","운동","치과","한의원","진료","영양제","pt","필라테스","요가"]},
    {cat:"문화·여가", kw:["영화","책","넷플릭스","구독","게임","여행","공연","전시","유튜브","티빙","웨이브","콘서트","노래방","숙박","호텔"]},
    {cat:"쇼핑",     kw:["옷","의류","신발","쇼핑","화장품","가방","무신사","백화점","올리브영","악세"]},
    {cat:"경조사",   kw:["축의금","조의금","경조사","선물","용돈","기부","부의"]}
  ];
  function catOf(label){
    const s=String(label||"").toLowerCase();
    for(const r of CAT_RULES){ for(const k of r.kw){ if(s.indexOf(k)>=0) return r.cat; } }
    return "기타";
  }
  const CAT_COLORS={ "식비":"#d9694f","교통":"#3f7cc0","주거·통신":"#5b5bd6","생활":"#8C7459","건강":"#2f9e69","문화·여가":"#c05fa8","쇼핑":"#d98a2b","경조사":"#7a8a99","기타":"#a1a1aa" };

  // 수입원 자동 분류 (N잡러용) — 더 구체적인 규칙을 앞에 두어 먼저 매칭시킴
  const INC_CAT_RULES=[
    {cat:"애드센스",  kw:["애드센스","adsense","애드핏","구글광고","구글 광고"]},
    {cat:"협찬",      kw:["협찬","스폰서","ppl","광고비","제품제공","브랜디드"]},
    {cat:"블로그 광고",kw:["블로그광고","블로그 광고","체험단","원고료","포스팅비","기자단"]},
    {cat:"블로그",    kw:["블로그","포스팅","네이버 블로그","티스토리","브런치"]},
    {cat:"유튜브",    kw:["유튜브","youtube","슈퍼챗","멤버십","쇼츠","조회수 수익"]},
    {cat:"배달",      kw:["배달","배민","배달의민족","쿠팡이츠","쿠팡플렉스","라이더","배달대행","딜리버리","요기요"]},
    {cat:"부업",      kw:["부업","사이드","스마트스토어","스토어","셀러","중고판매","당근","번개장터","외주","프리랜스","용역","강의","과외"]},
    {cat:"월급",      kw:["월급","급여","봉급","상여","보너스","성과급","연봉","본업","페이","임금","salary"]}
  ];
  function incCatOf(label){
    const s=String(label||"").toLowerCase();
    for(const r of INC_CAT_RULES){ for(const k of r.kw){ if(s.indexOf(k.toLowerCase())>=0) return r.cat; } }
    return "기타";
  }
  const INC_CAT_COLORS={ "월급":"#2f9e69","부업":"#3f7cc0","배달":"#d98a2b","유튜브":"#d9694f","블로그":"#5b5bd6","블로그 광고":"#9b6dd6","협찬":"#c05fa8","애드센스":"#14b8a6","기타":"#a1a1aa" };
  const INC_ORDER=["월급","부업","배달","유튜브","협찬","애드센스","블로그 광고","블로그","기타"];   // 스택 쌓는 순서(아래→위)

  function renderLedger(){
    const r=ledRange();
    document.getElementById("ledTitle").textContent=ledLabel(r);
    let inc=0,exp=0,buy=0,sav=0, daysRec=0;
    const dayExp={};      // ds -> 지출 합계
    const catSum={};      // cat -> 지출 합계
    const incCatSum={};   // cat -> 수입원별 합계
    const items=[];       // {date,kind,label,amount}
    const cur=new Date(r.start);
    while(cur<=r.end){
      const ds=ymd(cur), o=entries[ds], f=o&&o.fin;
      let dEx=0;
      if(f){
        inc+=finSum(f.inc); exp+=finSum(f.exp); buy+=finSum(f.buy); sav+=finSum(f.sav);
        dEx=finSum(f.exp);
        if(finHasContent(f)) daysRec++;
        (f.inc||[]).forEach(x=>{ const a=+x.amount||0; items.push({date:ds,kind:"inc",label:x.label||"수입",amount:a}); const ic=incCatOf(x.label); incCatSum[ic]=(incCatSum[ic]||0)+a; });
        (f.exp||[]).forEach(x=>{ const a=+x.amount||0; items.push({date:ds,kind:"exp",label:x.label||"지출",amount:a}); const c=catOf(x.label); catSum[c]=(catSum[c]||0)+a; });
      }
      dayExp[ds]=dEx;
      cur.setDate(cur.getDate()+1);
    }
    const net=inc-exp;
    const span=ledMode==="week"?7:r.end.getDate();
    document.getElementById("ledStat").innerHTML="이 기간 <b>"+daysRec+"</b>일 기록 · 총 "+span+"일";

    const up=net>=0;
    const trendSvg=up
      ? '<svg class="lh-trend up" viewBox="0 0 48 28" width="48" height="28" fill="none" aria-hidden="true">'
        +'<path d="M2 24 L14 16 L26 19 L46 4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
        +'<path d="M38 4 L46 4 L46 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg class="lh-trend down" viewBox="0 0 48 28" width="48" height="28" fill="none" aria-hidden="true">'
        +'<path d="M2 4 L14 12 L26 9 L46 24" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
        +'<path d="M38 24 L46 24 L46 16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    document.getElementById("ledSummary").innerHTML=
      '<div class="led-hero '+(up?"pos":"neg")+'">'
      +'<div class="lh-main">'
      +'<div class="lh-lab">이 기간 순저축 <span>수입 − 지출</span></div>'
      +'<div class="lh-num">'+won(Math.abs(net))+'</div>'
      +'</div>'
      +trendSvg
      +'</div>'
      +'<div class="fin-cards4">'
      +revFinCard("수입",inc)+revFinCard("지출",exp)+revFinCard("투자 매수",buy)+revFinCard("적금",sav)
      +'</div>';

    renderIncTrend();
    renderLedBars(r,dayExp);
    renderCatBreakdown("ledIncCats",incCatSum,inc,INC_CAT_COLORS,"아직 수입 내역이 없어요.");
    renderCatBreakdown("ledCats",catSum,exp,CAT_COLORS,"아직 지출 내역이 없어요.");
    renderLedList(items);
  }

  function jumpToDay(ds){ current=ds; renderDate(); loadDayFromCache(); setView("record"); setSubSeg("ledger"); }

  function renderLedBars(r,dayExp){
    const box=document.getElementById("ledBars"); box.innerHTML="";
    let max=0; for(const k in dayExp) if(dayExp[k]>max) max=dayExp[k];
    if(max===0){ box.innerHTML='<div class="kempty">이 기간 지출 기록이 없어요.</div>'; return; }
    const today=todayStr();
    const frag=document.createDocumentFragment();
    const cur=new Date(r.start);
    while(cur<=r.end){
      const ds=ymd(cur), v=dayExp[ds]||0, h=Math.round(v/max*100);
      const dow=cur.getDay();
      const col=document.createElement("div");
      col.className="lbar-col"+(ds===today?" today":"")+(dow===0?" sun":"")+(dow===6?" sat":"");
      col.innerHTML='<div class="lbar-track"><div class="lbar-fill" style="height:'+h+'%"></div></div>'
        +'<div class="lbar-day">'+(ledMode==="week"?WD[dow]:cur.getDate())+'</div>';
      if(v>0) col.title=won(v);
      col.onclick=(function(d){ return ()=>jumpToDay(d); })(ds);
      frag.appendChild(col);
      cur.setDate(cur.getDate()+1);
    }
    box.appendChild(frag);
    box.classList.toggle("dense", ledMode==="month");
  }

  function renderCatBreakdown(boxId,catSum,total,colors,emptyMsg){
    const box=document.getElementById(boxId); box.innerHTML="";
    const arr=Object.keys(catSum).map(c=>({cat:c,val:catSum[c]})).sort((a,b)=>b.val-a.val);
    if(!arr.length){ box.innerHTML='<div class="kempty">'+emptyMsg+'</div>'; return; }
    const frag=document.createDocumentFragment();
    arr.forEach(it=>{
      const pct=total>0?Math.round(it.val/total*100):0;
      const col=colors[it.cat]||colors["기타"]||"#a1a1aa";
      const row=document.createElement("div"); row.className="lcat";
      row.innerHTML='<div class="lcat-top"><span class="lcat-dot" style="background:'+col+'"></span>'
        +'<span class="lcat-name"></span>'
        +'<span class="lcat-pct">'+pct+'%</span>'
        +'<span class="lcat-val">'+won(it.val)+'</span></div>'
        +'<div class="lcat-track"><div class="lcat-fill" style="width:'+pct+'%;background:'+col+'"></div></div>';
      row.querySelector(".lcat-name").textContent=it.cat;
      frag.appendChild(row);
    });
    box.appendChild(frag);
  }

  // 최근 N개 기간(월간=6개월 / 주간=8주)의 시작·끝·라벨 배열. 현재 기간이 마지막.
  function incTrendPeriods(){
    const periods=[];
    if(ledMode==="week"){
      const base=new Date(ledAnchor); base.setDate(base.getDate()-base.getDay()); base.setHours(0,0,0,0);
      for(let i=7;i>=0;i--){
        const s=new Date(base); s.setDate(s.getDate()-i*7);
        const e=new Date(s); e.setDate(e.getDate()+6);
        periods.push({start:s,end:e,label:(s.getMonth()+1)+"/"+s.getDate()});
      }
    } else {
      const y=ledAnchor.getFullYear(), m=ledAnchor.getMonth();
      for(let i=5;i>=0;i--){
        const s=new Date(y,m-i,1), e=new Date(y,m-i+1,0);
        periods.push({start:s,end:e,label:(s.getMonth()+1)+"월"});
      }
    }
    return periods;
  }
  // 한 기간의 수입원별 합계 + 총합
  function incByCat(start,end){
    const byCat={}; let total=0; const cur=new Date(start);
    while(cur<=end){
      const f=(entries[ymd(cur)]||{}).fin;
      if(f&&f.inc) f.inc.forEach(x=>{ const a=+x.amount||0; if(!a)return; const c=incCatOf(x.label); byCat[c]=(byCat[c]||0)+a; total+=a; });
      cur.setDate(cur.getDate()+1);
    }
    return {byCat,total};
  }
  function renderIncTrend(){
    const box=document.getElementById("ledIncTrend"); if(!box) return; box.innerHTML="";
    const hint=document.getElementById("ledIncTrendHint");
    if(hint) hint.textContent=ledMode==="week"?"최근 8주":"최근 6개월";
    const rows=incTrendPeriods().map(p=>({label:p.label,...incByCat(p.start,p.end)}));
    if(rows.every(r=>r.total===0)){ box.innerHTML='<div class="kempty">아직 수입 추이가 없어요.</div>'; return; }
    const maxT=Math.max(1,...rows.map(r=>r.total));
    const H=150;
    const chart=document.createElement("div"); chart.className="inc-trend";
    rows.forEach((r,i)=>{
      const col=document.createElement("div"); col.className="itr-col";
      const stack=document.createElement("div"); stack.className="itr-stack";
      stack.style.height=Math.max(3,r.total/maxT*H)+"px";
      INC_ORDER.forEach(src=>{ const v=r.byCat[src]||0; if(!v||r.total<=0) return;
        const seg=document.createElement("div"); seg.className="itr-seg";
        seg.style.height=(v/r.total*100)+"%"; seg.style.background=INC_CAT_COLORS[src];
        seg.title=src+" "+won(v); stack.appendChild(seg);
      });
      col.appendChild(stack);
      const lab=document.createElement("div"); lab.className="itr-lab"+(i===rows.length-1?" cur":"");
      lab.textContent=r.label; col.appendChild(lab);
      col.title=r.label+" 수입 "+won(r.total);
      chart.appendChild(col);
    });
    box.appendChild(chart);
    // 범례 — 전체 기간 합산 큰 순서
    const grand={}; rows.forEach(r=>{ for(const c in r.byCat) grand[c]=(grand[c]||0)+r.byCat[c]; });
    const cats=Object.keys(grand).sort((a,b)=>grand[b]-grand[a]);
    if(cats.length){
      const lg=document.createElement("div"); lg.className="inc-legend";
      cats.forEach(c=>{ const el=document.createElement("span"); el.className="inc-lg";
        el.innerHTML='<span class="inc-lg-dot" style="background:'+(INC_CAT_COLORS[c]||INC_CAT_COLORS["기타"])+'"></span>';
        el.appendChild(document.createTextNode(c)); lg.appendChild(el);
      });
      box.appendChild(lg);
    }
  }

  function renderLedList(items){
    const box=document.getElementById("ledList"); box.innerHTML="";
    if(!items.length){ box.innerHTML='<div class="kempty">이 기간 가계부 내역이 없어요.</div>'; return; }
    const byDate={};
    items.forEach(it=>{ (byDate[it.date]=byDate[it.date]||[]).push(it); });
    const dates=Object.keys(byDate).sort((a,b)=> a<b?1:-1);   // 최신 날짜 먼저
    const frag=document.createDocumentFragment();
    dates.forEach(ds=>{
      const d=parseYmd(ds);
      const head=document.createElement("div"); head.className="lday-h";
      head.textContent=(d.getMonth()+1)+"월 "+d.getDate()+"일 "+WD[d.getDay()];
      head.onclick=(function(x){ return ()=>jumpToDay(x); })(ds);
      frag.appendChild(head);
      byDate[ds].sort((a,b)=>b.amount-a.amount).forEach(it=>{
        const isInc=it.kind==="inc";
        const cat=isInc?incCatOf(it.label):catOf(it.label);
        const col=isInc?(INC_CAT_COLORS[cat]||INC_CAT_COLORS["기타"]):(CAT_COLORS[cat]||CAT_COLORS["기타"]);
        const row=document.createElement("div"); row.className="lrow";
        row.innerHTML='<span class="lrow-cat" style="color:'+col+'">'+cat+'</span>'
          +'<span class="lrow-lab"></span>'
          +'<span class="lrow-amt '+(isInc?"pos":"neg")+'">'+(isInc?"＋":"－")+won(it.amount)+'</span>';
        row.querySelector(".lrow-lab").textContent=it.label;
        frag.appendChild(row);
      });
    });
    box.appendChild(frag);
  }

  function setLedMode(m){ ledMode=m;
    document.getElementById("ledWeek").setAttribute("aria-selected",m==="week");
    document.getElementById("ledMonth").setAttribute("aria-selected",m==="month");
    renderLedger();
  }
  document.getElementById("ledWeek").onclick=()=>setLedMode("week");
  document.getElementById("ledMonth").onclick=()=>setLedMode("month");
  document.getElementById("ledPrev").onclick=()=>{ if(ledMode==="week")ledAnchor.setDate(ledAnchor.getDate()-7); else ledAnchor.setMonth(ledAnchor.getMonth()-1); renderLedger(); };
  document.getElementById("ledNext").onclick=()=>{ if(ledMode==="week")ledAnchor.setDate(ledAnchor.getDate()+7); else ledAnchor.setMonth(ledAnchor.getMonth()+1); renderLedger(); };

  /* ===================== 월간 리포트 ===================== */
  const FIXED_CATS=new Set(["주거·통신"]);   // 고정비로 분류할 지출 카테고리
  function manW(n){ return Math.round(n/10000).toLocaleString("ko-KR")+"만"; }
  // 선택 기간 집계
  function aggPeriod(r){
    let inc=0,exp=0,buy=0,sav=0,daysRec=0; const incCat={},expCat={};
    const cur=new Date(r.start);
    while(cur<=r.end){
      const f=(entries[ymd(cur)]||{}).fin;
      if(f){
        if(finHasContent(f)) daysRec++;
        (f.inc||[]).forEach(x=>{ const a=+x.amount||0; if(!a)return; inc+=a; const c=incCatOf(x.label); incCat[c]=(incCat[c]||0)+a; });
        (f.exp||[]).forEach(x=>{ const a=+x.amount||0; if(!a)return; exp+=a; const c=catOf(x.label); expCat[c]=(expCat[c]||0)+a; });
        buy+=finSum(f.buy); sav+=finSum(f.sav);
      }
      cur.setDate(cur.getDate()+1);
    }
    return {inc,exp,buy,sav,daysRec,incCat,expCat};
  }
  // 상위 n개 + 나머지 '기타'로 합치기 → [{label,val,color}]
  function topWithRest(catObj,colors,n,restLabel){
    const arr=Object.keys(catObj).map(c=>({label:c,val:catObj[c]})).filter(o=>o.val>0).sort((a,b)=>b.val-a.val);
    const head=arr.slice(0,n), rest=arr.slice(n);
    const out=head.map(o=>({label:o.label,val:o.val,color:colors[o.label]||colors["기타"]||"#a1a1aa"}));
    const restSum=rest.reduce((s,o)=>s+o.val,0);
    if(restSum>0) out.push({label:restLabel,val:restSum,color:colors["기타"]||"#a1a1aa"});
    return out;
  }
  // 가로형 산키 SVG (금액=높이, 좌→우 흐름 · 한 화면에 맞춤)
  const SK_W=12;   // 노드 막대 두께
  function buildSankeySVG(a){
    const inc=a.inc, exp=a.exp, net=Math.max(0,inc-exp);
    if(inc<=0) return '<div class="kempty">이 달 수입 내역이 없어요.</div>';
    // 컬럼 데이터
    const income=topWithRest(a.incCat,INC_CAT_COLORS,4,"기타 수입");
    const T={label:"총수입",val:inc,color:"#4f5bd5"};
    const SAV={label:"순저축",val:net,color:"#2f9e69"};
    const EXP={label:"지출",val:exp,color:"#d9694f"};
    const expLeaves=topWithRest(a.expCat,CAT_COLORS,3,"기타 지출");
    // 순저축 하위 = 투자/적금/현금 (높이 합은 net에 맞춤; 초과 시 축소, 라벨은 실제값)
    let savLeaves=[], savOverflow=false;
    if(net>0){
      const raw=[{label:"투자 매수",val:a.buy,color:"#2f9e69"},{label:"적금",val:a.sav,color:"#57b98a"}].filter(o=>o.val>0);
      const sumSav=raw.reduce((s,o)=>s+o.val,0);
      if(sumSav<=net){ savLeaves=raw.map(o=>({...o,h:o.val})); const cash=net-sumSav; if(cash>0) savLeaves.push({label:"남은 현금",val:cash,color:"#9bd3b5",h:cash}); }
      else { savOverflow=true; const k=net/sumSav; savLeaves=raw.map(o=>({...o,h:o.val*k})); }
    }
    expLeaves.forEach(o=>{ o.h=o.val; });          // 레이아웃 대상과 리본 대상이 같은 객체여야 함
    const leaves=savLeaves.concat(expLeaves);
    // 레이아웃 (좌→우 4컬럼 · 화면 너비에 맞춤)
    const W=560, H=380, Cy=190, gap=7;
    const sy=(H-36-5*gap)/inc;                 // 잎 최대 6노드 기준 세로 스케일
    const colX=[104,238,372,456];
    const cols=[income,[T],[SAV,EXP],leaves];
    cols.forEach((col,ci)=>{
      const span=col.reduce((s,n)=>s+val(n)*sy,0)+(col.length-1)*gap;
      let y=Cy-span/2;
      col.forEach(n=>{ n.x=colX[ci]; n.hpx=val(n)*sy; n.y=y; n.outY=y; n.inY=y; y+=n.hpx+gap; });
    });
    function val(n){ return n.h!=null?n.h:n.val; }
    let rib="",nod="",lab="";
    income.forEach(s=>{ rib+=skRibbon(s,T,s.val*sy,"#97a1b2",0.32); });
    rib+=skRibbon(T,SAV,net*sy,"#2f9e69",0.30);
    rib+=skRibbon(T,EXP,exp*sy,"#d9694f",0.30);
    savLeaves.forEach(l=>{ rib+=skRibbon(SAV,l,l.hpx,l.color,0.42); });
    expLeaves.forEach(l=>{ rib+=skRibbon(EXP,l,l.hpx,l.color,0.42); });
    [].concat(income,[T,SAV,EXP],leaves).forEach(n=>{ nod+=skBar(n); });
    // 라벨: 수입원(왼쪽) · 총수입/순저축/지출(가운데 위) · 잎(오른쪽)
    income.forEach(n=>{ lab+=skSide(n.x-9,n.y+n.hpx/2,"end",n.label,manW(n.val)+"원"); });
    lab+=skTxt(T.x+SK_W/2,T.y-8,"middle","총수입","var(--ink)",13);
    lab+=skTxt(T.x+SK_W/2,T.y+T.hpx+16,"middle",manW(inc)+"원","var(--sub)",11.5);
    lab+=skTxt(SAV.x+SK_W/2,SAV.y-7,"middle","순저축 "+manW(net)+"원","#2f9e69",11.5);
    lab+=skTxt(EXP.x+SK_W/2,EXP.y-7,"middle","지출 "+manW(exp)+"원","#d9694f",11.5);
    leaves.forEach(n=>{ lab+=skSide(n.x+SK_W+9,n.y+n.hpx/2,"start",n.label,manW(n.val)+"원"); });
    const svg='<svg viewBox="0 0 '+W+' '+H+'" width="100%" role="img" aria-label="자금 흐름 산키">'+rib+nod+lab+'</svg>';
    const note=savOverflow?'<div class="rpt-note">* 투자·적금 합계가 순저축을 초과 — 일부는 기존 자산에서 나갔어요.</div>':'';
    return svg+note;
  }
  function skRibbon(s,t,th,color,op){
    const x0=s.x+SK_W, x1=t.x, y0=s.outY, y1=t.inY, xm=(x0+x1)/2;
    s.outY+=th; t.inY+=th;
    return '<path d="M'+x0+','+y0.toFixed(1)+' C'+xm+','+y0.toFixed(1)+' '+xm+','+y1.toFixed(1)+' '+x1+','+y1.toFixed(1)
      +' L'+x1+','+(y1+th).toFixed(1)+' C'+xm+','+(y1+th).toFixed(1)+' '+xm+','+(y0+th).toFixed(1)+' '+x0+','+(y0+th).toFixed(1)+' Z" fill="'+color+'" opacity="'+op+'"/>';
  }
  function skBar(n){
    return '<rect x="'+n.x+'" y="'+n.y.toFixed(1)+'" width="'+SK_W+'" height="'+Math.max(2,n.hpx).toFixed(1)+'" rx="3" fill="'+n.color+'"><title>'+esc(n.label+" "+won(n.val))+'</title></rect>';
  }
  function skSide(x,cy,anchor,name,amt){
    return '<text x="'+x.toFixed(1)+'" y="'+(cy-2).toFixed(1)+'" text-anchor="'+anchor+'" font-size="12" font-weight="700" fill="var(--ink)" font-family="Pretendard,sans-serif">'+esc(name)+'</text>'
      +'<text x="'+x.toFixed(1)+'" y="'+(cy+11).toFixed(1)+'" text-anchor="'+anchor+'" font-size="10.5" fill="var(--sub)" font-family="Pretendard,sans-serif">'+esc(amt)+'</text>';
  }
  function skTxt(x,y,anchor,t,fill,size){
    return '<text x="'+x.toFixed(1)+'" y="'+y+'" text-anchor="'+anchor+'" font-size="'+size+'" font-weight="700" fill="'+fill+'" font-family="Pretendard,sans-serif">'+esc(t)+'</text>';
  }
  // 수입/지출 분석용 항목 바 리스트
  function rptBreak(list,total){
    if(!list.length) return '<div class="kempty">내역이 없어요.</div>';
    const max=list[0].val;
    return list.map(it=>{ const pct=total>0?Math.round(it.val/total*100):0; const w=max>0?Math.round(it.val/max*100):0;
      return '<div class="lcat"><div class="lcat-top"><span class="lcat-dot" style="background:'+it.color+'"></span>'
        +'<span class="lcat-name">'+esc(it.label)+'</span><span class="lcat-pct">'+pct+'%</span>'
        +'<span class="lcat-val">'+won(it.val)+'</span></div>'
        +'<div class="lcat-track"><div class="lcat-fill" style="width:'+w+'%;background:'+it.color+'"></div></div></div>';
    }).join("");
  }
  function renderMonthReport(){
    const r=ledRange(), a=aggPeriod(r);
    const net=a.inc-a.exp;
    const rate=a.inc>0?Math.round(net/a.inc*1000)/10:0;
    const span=ledMode==="week"?7:r.end.getDate();
    const avg=span>0?Math.round(a.exp/span):0;
    document.getElementById("reportTitle").textContent=ledLabel(r)+" 결산";
    document.getElementById("reportSub").textContent="이 기간 "+a.daysRec+"일 기록 · 총 "+span+"일 · 자동 생성";
    const incAll=Object.keys(a.incCat).map(c=>({label:c,val:a.incCat[c],color:INC_CAT_COLORS[c]||INC_CAT_COLORS["기타"]})).sort((x,y)=>y.val-x.val);
    const expAll=Object.keys(a.expCat).map(c=>({label:c,val:a.expCat[c],color:CAT_COLORS[c]||CAT_COLORS["기타"]})).sort((x,y)=>y.val-x.val);
    let fixed=0; for(const c in a.expCat) if(FIXED_CATS.has(c)) fixed+=a.expCat[c];
    const variable=a.exp-fixed;
    const pctOf=(v,t)=>t>0?Math.round(v/t*100):0;
    const html=
      // 산키
      '<section class="rpt-sec"><div class="rpt-h"><span class="rpt-n">🌊</span>자금 흐름<small>금액 = 너비</small></div>'
        +'<div class="rpt-sankey">'+buildSankeySVG(a)+'</div>'
        +'<div class="rpt-legend">'+incAll.slice(0,6).map(o=>'<span class="rpt-lg"><i style="background:'+o.color+'"></i>'+esc(o.label)+'</span>').join("")+'</div></section>'
      // ① 핵심 지표
      +'<section class="rpt-sec"><div class="rpt-h"><span class="rpt-n">1</span>핵심 지표</div>'
        +'<div class="rpt-kpis">'
        +'<div class="rpt-kpi hero"><div class="kl">순저축 · 수입 − 지출</div><div class="kv '+(net>=0?"pos":"neg")+'">'+(net>=0?"＋":"－")+won(Math.abs(net))+'</div></div>'
        +'<div class="rpt-kpi"><div class="kl">저축률</div><div class="kv">'+rate+'%</div></div>'
        +'<div class="rpt-kpi"><div class="kl">일평균 지출</div><div class="kv">'+won(avg)+'</div></div>'
        +'<div class="rpt-kpi"><div class="kl">총수입</div><div class="kv">'+won(a.inc)+'</div></div>'
        +'<div class="rpt-kpi"><div class="kl">총지출</div><div class="kv">'+won(a.exp)+'</div></div>'
        +'</div></section>'
      // ② 손익 개요
      +'<section class="rpt-sec"><div class="rpt-h"><span class="rpt-n">2</span>손익 개요<small>수입 → 지출 → 순저축</small></div>'
        +plRow("총수입",a.inc,a.inc,"#2f9e69","")
        +plRow("총지출",a.exp,a.inc,"#d9694f","−")
        +plRow("순저축",Math.max(0,net),a.inc,"#4f5bd5","")
        +'</section>'
      // ③ 수입 분석
      +'<section class="rpt-sec"><div class="rpt-h"><span class="rpt-n">3</span>수입 분석<small>수입원 자동 분류</small></div>'
        +rptBreak(incAll,a.inc)+'</section>'
      // ④ 지출 분석
      +'<section class="rpt-sec"><div class="rpt-h"><span class="rpt-n">4</span>지출 분석<small>내용으로 자동 분류</small></div>'
        +rptBreak(expAll,a.exp)
        +'<div class="rpt-fv"><div class="rpt-fvc"><div class="l">고정비</div><div class="v" style="color:#3f7cc0">'+won(fixed)+'</div><div class="p">'+pctOf(fixed,a.exp)+'%</div></div>'
        +'<div class="rpt-fvc"><div class="l">변동비</div><div class="v" style="color:#d9694f">'+won(variable)+'</div><div class="p">'+pctOf(variable,a.exp)+'%</div></div></div></section>'
      // 투자·적금 배분
      +'<section class="rpt-sec"><div class="rpt-h"><span class="rpt-n">＋</span>투자·적금 배분<small>이 달 자산 형성</small></div>'
        +'<div class="rpt-fv"><div class="rpt-fvc"><div class="l">투자 매수</div><div class="v" style="color:#2f9e69">'+won(a.buy)+'</div><div class="p">'+pctOf(a.buy,a.buy+a.sav)+'%</div></div>'
        +'<div class="rpt-fvc"><div class="l">적금</div><div class="v" style="color:#57b98a">'+won(a.sav)+'</div><div class="p">'+pctOf(a.sav,a.buy+a.sav)+'%</div></div></div></section>';
    document.getElementById("reportBody").innerHTML=html;
  }
  function plRow(name,val,total,color,sign){
    const w=total>0?Math.round(val/total*100):0;
    return '<div class="rpt-pl"><div class="rpt-pltop"><span>'+name+'</span><span style="color:'+color+'">'+sign+won(val)+'</span></div>'
      +'<div class="rpt-plbar"><div style="width:'+w+'%;background:'+color+'"></div></div></div>';
  }
  function openReport(){ renderMonthReport(); const v=document.getElementById("reportView"); v.hidden=false; v.scrollTop=0; document.body.style.overflow="hidden"; }
  function closeReport(){ document.getElementById("reportView").hidden=true; document.body.style.overflow=""; }
  document.getElementById("ledReportBtn").onclick=openReport;
  document.getElementById("reportClose").onclick=closeReport;

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
    const nameEl=document.getElementById("sidebarName");
    if(user){
      if(user.photoURL){ av.style.backgroundImage="url('"+user.photoURL+"')"; inner.textContent=""; }
      else { av.style.backgroundImage="none"; inner.textContent=((user.email||user.displayName||"·")[0]||"·").toUpperCase(); }
      av.title=(user.email||user.displayName||"내 계정")+" · 누르면 로그아웃";
      av.classList.add("on");
      if(nameEl) nameEl.textContent=user.displayName||(user.email||"내 계정").split("@")[0];
    } else {
      av.classList.remove("on"); av.style.backgroundImage="none"; inner.textContent="";
      if(nameEl) nameEl.textContent="";
    }
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
  // 금액 입력칸: 타이핑 중 천 단위 콤마 표기 (1709000 → 1,709,000). 저장은 parseAmt가 콤마를 걸러냄.
  function commafyInput(inp){
    const digits=(inp.value||"").replace(/[^0-9]/g,"");
    inp.value=digits?Number(digits).toLocaleString("ko-KR"):"";
  }
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
        +'<div class="acct-card-hd"><span class="acct-name">'+esc(acct)+'</span><span class="acct-x" data-i="'+i+'" aria-label="계좌 삭제">✕</span></div>'
        +'<span class="acct-mid" id="acctMid'+i+'"></span>'
        +'<div class="acct-bar"><div class="acct-bar-fill" id="acctBar'+i+'"></div></div>'
        +'<input class="acct-alloc" data-i="'+i+'" inputmode="numeric" placeholder="계획 금액"'+(a?' value="'+num(a)+'"':'')+' />'
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
    I.per.forEach((p,i)=>{
      const m=gid("acctMid"+i); if(m) m.textContent="배정 "+num(p.a)+" · 매수 "+num(p.buy)+" · 대기 "+num(p.wait);
      const b=gid("acctBar"+i); if(b) b.style.width=(p.a>0?Math.max(0,Math.min(100,p.buy/p.a*100)):0)+"%";
    });
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
  gid("sheetAmt").addEventListener("input",e=>commafyInput(e.target));
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
    commafyInput(inp);
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
