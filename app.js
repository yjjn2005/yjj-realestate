/* 유재진 가족 부동산 관리 앱 */

const STORAGE_KEY = 'yjj_realestate_v1';
const SYNC_KEY = 'yjj_realestate_sync_v1';
const FILE_NAME = '유재진가족_부동산_데이터.json';
const GIST_FILENAME = 'yjj_realestate.json';
const PULL_INTERVAL_MS = 30000;
const PUSH_DEBOUNCE_MS = 2000;

function deepClone(o){return JSON.parse(JSON.stringify(o))}

let DATA = (()=>{
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){const p = JSON.parse(raw); if(p && p.parcels) return p;}
  }catch(e){}
  return deepClone(window.INITIAL_DATA);
})();

// ---------- 유틸 ----------
function escape(s){if(s==null) return '';return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmtKRW(n){if(!n) return '0';return Math.round(n).toLocaleString('ko-KR')}
function fmtShort(n){
  n = Math.round(n||0);
  const abs = Math.abs(n);
  if(abs>=1e8) return (n/1e8).toFixed(1)+'억';
  if(abs>=1e4) return (n/1e4).toFixed(0)+'만';
  return n.toLocaleString();
}
function fmtArea(n){return (Math.round((n||0)*100)/100).toLocaleString('ko-KR')}
function toPyeong(m2){return (m2 || 0) * 0.3025}

// ---------- 저장 ----------
function saveData(silent, opts){
  opts = opts || {};
  if(!opts.fromRemote){DATA.updatedAt = new Date().toISOString()}
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DATA));
    if(!silent) flashSync('saved');
  }catch(e){toast('저장 실패: 공간 부족', 'err')}
  if(!opts.fromRemote){
    const cfg = getSyncConfig();
    if(cfg.enabled && cfg.token && cfg.gistId) schedulePush();
  }
}
function flashSync(state){
  const dot = document.getElementById('syncDot');
  const txt = document.getElementById('syncText');
  if(!dot) return;
  if(state==='dirty'){dot.classList.add('dirty');txt.textContent='저장 중…'}
  else if(state==='syncing'){dot.classList.add('dirty');txt.textContent='동기화 중…'}
  else if(state==='cloud'){dot.classList.remove('dirty');txt.textContent='☁ 클라우드 동기화'}
  else{dot.classList.remove('dirty');txt.textContent='자동 저장됨'}
}

// ---------- 토스트 ----------
let toastTimer;
function toast(msg, kind){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (kind||'');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), 2400);
}

// ---------- 뷰 ----------
function showView(v){
  document.querySelectorAll('.view').forEach(el=>el.classList.remove('active'));
  document.getElementById('view-'+v).classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.toggle('active', t.dataset.view===v));
  window.scrollTo({top:0, behavior:'smooth'});
}
document.querySelectorAll('.nav-tab').forEach(t=>t.addEventListener('click', ()=>showView(t.dataset.view)));
document.getElementById('settingsBtn').addEventListener('click', ()=>showView('settings'));

// ---------- 연도 선택 ----------
function buildYearSelect(){
  const sel = document.getElementById('yearSelect');
  sel.innerHTML = DATA.meta.years.map(y=>`<option value="${y}">${y}년</option>`).join('');
  sel.value = DATA.appliedYear || '2025';
  document.getElementById('heroYear').textContent = sel.value + '년';
  sel.addEventListener('change', e=>{
    DATA.appliedYear = e.target.value;
    document.getElementById('heroYear').textContent = e.target.value + '년';
    saveData();
    rerenderAll();
  });
}

// ---------- 계산 ----------
function getPrice(p, kind){
  const y = DATA.appliedYear;
  return (p.prices && p.prices[y] && p.prices[y][kind]) || 0;
}
function parcelTotalOwnArea(p){
  return Object.values(p.ownership||{}).reduce((s,v)=>s+(+v||0), 0);
}
function parcelTotalValue(p, kind){
  const price = getPrice(p, kind);
  if(!price) return 0;
  return parcelTotalOwnArea(p) * price;
}
function memberAggregateAt(member){
  let area=0, gongsi=0, gamjeong=0;
  DATA.parcels.forEach(p=>{
    const own = (p.ownership && p.ownership[member]) || 0;
    if(!own) return;
    area += own;
    gongsi += own * getPrice(p,'gongsi');
    gamjeong += own * getPrice(p,'gamjeong');
  });
  (DATA.otherAssets||[]).forEach(o=>{
    const share = (o.owners && o.owners[member]) || 0;
    if(!share) return;
    gongsi += (o.values?.gongsi||0) * share;
    gamjeong += (o.values?.gamjeong||0) * share;
  });
  return {area, gongsi, gamjeong};
}
function totalAssets(){
  let gongsi=0, gamjeong=0, area=0;
  DATA.parcels.forEach(p=>{
    const own = parcelTotalOwnArea(p);
    area += own;
    gongsi += own * getPrice(p,'gongsi');
    gamjeong += own * getPrice(p,'gamjeong');
  });
  (DATA.otherAssets||[]).forEach(o=>{
    gongsi += o.values?.gongsi||0;
    gamjeong += o.values?.gamjeong||0;
  });
  return {area, gongsi, gamjeong};
}
function leaseSummary(){
  const ls = DATA.leases||[];
  return {
    deposit: ls.reduce((s,l)=>s+(+l.deposit||0),0),
    monthly: ls.reduce((s,l)=>s+(+l.monthly||0),0),
    annual: ls.reduce((s,l)=>s+(+l.annual||0),0),
    count: ls.length
  };
}
function loanSummary(){
  const lo = DATA.loans||[];
  return {
    loanActual: lo.filter(x=>x.type==='대출').reduce((s,l)=>s+(+l.actual||0),0),
    deposit: lo.filter(x=>x.type==='보증금').reduce((s,l)=>s+(+l.actual||0),0),
    monthly: lo.reduce((s,l)=>s+(+l.monthlyInterest||0),0)
  };
}
function giftSummary(){
  let gongsi=0, gamjeong=0, area=0;
  (DATA.giftParcels||[]).forEach(p=>{
    area += p.totalArea||0;
    gongsi += (p.totalArea||0) * getPrice(p,'gongsi');
    gamjeong += (p.totalArea||0) * getPrice(p,'gamjeong');
  });
  return {area, gongsi, gamjeong};
}

// ---------- 렌더: 대시보드 ----------
function renderDash(){
  document.getElementById('updatedDate').textContent = DATA.updated || '';
  document.getElementById('totalParcels').textContent = DATA.parcels.length;
  document.getElementById('totalMembers').textContent = DATA.meta.members.length;
  document.getElementById('totalLeases').textContent = (DATA.leases||[]).length;

  const t = totalAssets();
  document.getElementById('kpiGongsi').textContent = fmtShort(t.gongsi) + '원';
  document.getElementById('kpiGamjeong').textContent = fmtShort(t.gamjeong) + '원';
  const ls = leaseSummary();
  document.getElementById('kpiLease').textContent = fmtShort(ls.annual) + '원';
  document.getElementById('kpiLeaseMonth').textContent = fmtShort(ls.monthly) + '원';
  const lo = loanSummary();
  document.getElementById('kpiLoan').textContent = fmtShort(lo.loanActual) + '원';
  document.getElementById('kpiLoanMonth').textContent = fmtShort(lo.monthly) + '원';

  // 가족별
  const grid = document.getElementById('dashMemberGrid');
  const allG = DATA.meta.members.reduce((s,m)=>s+memberAggregateAt(m).gongsi,0);
  grid.innerHTML = DATA.meta.members.map(m=>{
    const a = memberAggregateAt(m);
    const pct = allG ? (a.gongsi/allG*100).toFixed(1) : '0';
    return `<div class="member-card" data-member="${escape(m)}">
      <div class="member-card-top"><div class="member-name">${escape(m)}</div><div class="member-pct">${pct}%</div></div>
      <div class="member-line area"><span>소유면적</span><b>${fmtArea(a.area)}㎡ (${fmtArea(toPyeong(a.area))}평)</b></div>
      <div class="member-line gongsi"><span>공시가격</span><b>${fmtShort(a.gongsi)}원</b></div>
      <div class="member-line gamjeong"><span>감정평가액</span><b>${fmtShort(a.gamjeong)}원</b></div>
      <div class="member-line total"><span>비중</span><b>${pct}%</b></div>
    </div>`;
  }).join('');
  grid.querySelectorAll('[data-member]').forEach(el=>{
    el.addEventListener('click', ()=>showView('members'));
  });

  // 필지 합계 테이블
  const tbody = document.querySelector('#dashParcelTable tbody');
  tbody.innerHTML = DATA.parcels.map(p=>{
    const own = parcelTotalOwnArea(p);
    const g = own * getPrice(p,'gongsi');
    const a = own * getPrice(p,'gamjeong');
    return `<tr><td><b>${escape(p.name)}</b></td><td>${escape(p.use)}</td><td style="text-align:right">${fmtArea(own)}</td><td style="text-align:right"><b style="color:var(--navy)">${fmtKRW(g)}</b></td><td style="text-align:right"><b style="color:var(--gold-deep)">${fmtKRW(a)}</b></td></tr>`;
  }).join('') + (DATA.otherAssets||[]).map(o=>{
    return `<tr><td><b>${escape(o.name)}</b></td><td>${escape(o.type)}</td><td style="text-align:right">-</td><td style="text-align:right"><b style="color:var(--navy)">${fmtKRW(o.values?.gongsi)}</b></td><td style="text-align:right"><b style="color:var(--gold-deep)">${fmtKRW(o.values?.gamjeong)}</b></td></tr>`;
  }).join('');
}

// ---------- 렌더: 필지별 ----------
function renderParcels(){
  const grid = document.getElementById('parcelGrid');
  grid.innerHTML = DATA.parcels.map(p=>{
    const own = parcelTotalOwnArea(p);
    const g = own * getPrice(p,'gongsi');
    const a = own * getPrice(p,'gamjeong');
    const cls = p.sharedOwnership ? '' : 'solo';
    const shares = p.ownership ? Object.entries(p.ownership).map(([m,v])=>`<div class="share-row"><span>${escape(m)}</span><b>${fmtArea(v)}㎡</b></div>`).join('') : '';
    return `<div class="parcel-card ${cls}" data-parcel-id="${p.id}">
      <div class="parcel-card-top"><div class="parcel-name">${escape(p.name)}</div><div class="parcel-use">${escape(p.use)}</div></div>
      <div class="parcel-area">전체 면적 <b>${fmtArea(p.totalArea)}㎡</b> · 소유 합계 <b>${fmtArea(own)}㎡</b></div>
      <div class="parcel-row gongsi"><span>공시지가/㎡</span><b>${fmtKRW(getPrice(p,'gongsi'))}원</b></div>
      <div class="parcel-row gongsi"><span>공시가격 합계</span><b>${fmtKRW(g)}원</b></div>
      <div class="parcel-row gamjeong"><span>감정가격/㎡</span><b>${fmtKRW(getPrice(p,'gamjeong'))}원</b></div>
      <div class="parcel-row gamjeong total"><span>감정평가액</span><b>${fmtKRW(a)}원</b></div>
      ${shares?`<div class="parcel-shares"><div class="parcel-shares-head">지분 (소유면적)</div>${shares}</div>`:''}
    </div>`;
  }).join('');
  grid.querySelectorAll('[data-parcel-id]').forEach(el=>{
    el.addEventListener('click', ()=>openParcelModal(parseInt(el.dataset.parcelId)));
  });

  const og = document.getElementById('otherAssetsGrid');
  og.innerHTML = (DATA.otherAssets||[]).map(o=>{
    const ownersText = Object.entries(o.owners||{}).map(([m,v])=>`<div class="share-row"><span>${escape(m)}</span><b>${(v*100).toFixed(0)}%</b></div>`).join('');
    return `<div class="parcel-card" data-other-id="${o.id}">
      <div class="parcel-card-top"><div class="parcel-name">${escape(o.name)}</div><div class="parcel-use">${escape(o.type)}</div></div>
      <div class="parcel-row gongsi"><span>공시가격</span><b>${fmtKRW(o.values?.gongsi)}원</b></div>
      <div class="parcel-row gamjeong total"><span>감정평가액</span><b>${fmtKRW(o.values?.gamjeong)}원</b></div>
      ${ownersText?`<div class="parcel-shares"><div class="parcel-shares-head">지분</div>${ownersText}</div>`:''}
      ${o.note?`<div style="margin-top:10px;padding:8px 12px;background:var(--surface-2);border-radius:8px;font-size:11.5px;color:var(--text-muted);line-height:1.5">${escape(o.note)}</div>`:''}
    </div>`;
  }).join('') || '<div class="empty">없음</div>';
}

// ---------- 렌더: 구성원별 ----------
function renderMembers(){
  const cont = document.getElementById('membersContainer');
  cont.innerHTML = DATA.meta.members.map(m=>{
    const a = memberAggregateAt(m);
    const myParcels = DATA.parcels.filter(p=>(p.ownership||{})[m]>0);
    const myOther = (DATA.otherAssets||[]).filter(o=>(o.owners||{})[m]>0);
    return `<div class="panel">
      <div class="panel-head">
        <div class="panel-title"><span class="ic">${m[0]}</span>${escape(m)}</div>
        <div style="font-size:13px;color:var(--text-muted)">${myParcels.length + myOther.length}건</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px">
        <div><div style="font-size:11px;color:var(--text-muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:5px">소유면적</div><div style="font-family:'Noto Serif KR';font-size:22px;color:var(--text);font-weight:700">${fmtArea(a.area)}㎡</div><div style="font-size:11.5px;color:var(--text-muted)">${fmtArea(toPyeong(a.area))}평</div></div>
        <div><div style="font-size:11px;color:var(--text-muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:5px">공시가격</div><div style="font-family:'Noto Serif KR';font-size:22px;color:var(--navy);font-weight:700">${fmtShort(a.gongsi)}원</div></div>
        <div><div style="font-size:11px;color:var(--text-muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:5px">감정평가액</div><div style="font-family:'Noto Serif KR';font-size:22px;color:var(--gold-deep);font-weight:700">${fmtShort(a.gamjeong)}원</div></div>
      </div>
      <div class="data-table-wrap"><table class="data-table">
        <thead><tr><th>지번/자산</th><th>용도</th><th style="text-align:right">소유면적</th><th style="text-align:right">공시가격</th><th style="text-align:right">감정평가액</th></tr></thead>
        <tbody>
        ${myParcels.map(p=>{
          const own = (p.ownership||{})[m]||0;
          const g = own * getPrice(p,'gongsi');
          const ag = own * getPrice(p,'gamjeong');
          return `<tr data-parcel-id="${p.id}"><td><b>${escape(p.name)}</b></td><td>${escape(p.use)}</td><td style="text-align:right">${fmtArea(own)}㎡</td><td style="text-align:right">${fmtKRW(g)}원</td><td style="text-align:right">${fmtKRW(ag)}원</td></tr>`;
        }).join('')}
        ${myOther.map(o=>{
          const share = (o.owners||{})[m]||0;
          return `<tr><td><b>${escape(o.name)}</b></td><td>${escape(o.type)}</td><td style="text-align:right">${(share*100).toFixed(0)}%</td><td style="text-align:right">${fmtKRW((o.values?.gongsi||0)*share)}원</td><td style="text-align:right">${fmtKRW((o.values?.gamjeong||0)*share)}원</td></tr>`;
        }).join('')}
        </tbody>
      </table></div>
    </div>`;
  }).join('');
  cont.querySelectorAll('[data-parcel-id]').forEach(el=>{
    el.addEventListener('click', ()=>openParcelModal(parseInt(el.dataset.parcelId)));
  });
}

// ---------- 렌더: 임대차 ----------
function renderLeases(){
  const s = leaseSummary();
  document.getElementById('leaseDeposit').textContent = fmtShort(s.deposit) + '원';
  document.getElementById('leaseMonthly').textContent = fmtShort(s.monthly) + '원';
  document.getElementById('leaseAnnual').textContent = fmtShort(s.annual) + '원';

  const tbody = document.querySelector('#leaseTable tbody');
  const today = new Date();
  tbody.innerHTML = (DATA.leases||[]).map(l=>{
    let status = '진행';
    let cls = 'lease-active';
    if(l.period){
      const m = l.period.match(/~(\d{4})\.(\d{2})\.(\d{2})/);
      if(m){
        const end = new Date(+m[1], +m[2]-1, +m[3]);
        const daysLeft = Math.floor((end-today)/86400000);
        if(daysLeft < 0){status='만료'; cls='lease-expiring'}
        else if(daysLeft < 90){status=`만료 ${daysLeft}일전`; cls='lease-expiring'}
      }
    }
    return `<tr data-lease-id="${l.id}">
      <td data-label="물건/임차인"><b>${escape(l.parcel)}</b><br><span style="font-size:11.5px;color:var(--text-muted)">${escape(l.tenant||'-')}</span></td>
      <td data-label="보증금" style="text-align:right"><b>${fmtKRW(l.deposit)}원</b></td>
      <td data-label="월세" style="text-align:right"><b>${fmtKRW(l.monthly)}원</b></td>
      <td data-label="연수입" style="text-align:right"><b style="color:var(--inc)">${fmtKRW(l.annual)}원</b></td>
      <td data-label="기간" style="font-size:12px;color:var(--text-muted)">${escape(l.period||'-')}</td>
      <td data-label="연락처" style="font-size:12px">${escape(l.contact||'')}<br><span style="color:var(--text-muted)">${escape(l.phone||'')}</span></td>
      <td data-label="상태"><span class="tag ${cls}">${status}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:30px">임대 계약 없음</td></tr>';
  tbody.querySelectorAll('[data-lease-id]').forEach(el=>{
    el.addEventListener('click', ()=>openLeaseModal(parseInt(el.dataset.leaseId)));
  });
}

// ---------- 렌더: 대출 ----------
function renderLoans(){
  const s = loanSummary();
  document.getElementById('loanActual').textContent = fmtShort(s.loanActual) + '원';
  document.getElementById('loanDeposit').textContent = fmtShort(s.deposit) + '원';
  document.getElementById('loanMonthly').textContent = fmtShort(s.monthly) + '원';

  const tbody = document.querySelector('#loanTable tbody');
  tbody.innerHTML = (DATA.loans||[]).map(l=>{
    const tag = l.type==='대출' ? 'loan' : 'deposit';
    return `<tr data-loan-id="${l.id}">
      <td data-label="구분/내용"><span class="tag ${tag}">${escape(l.type)}</span> <b style="margin-left:6px">${escape(l.name)}</b></td>
      <td data-label="채권최고액" style="text-align:right">${l.maxAmount?fmtKRW(l.maxAmount)+'원':'-'}</td>
      <td data-label="실대출/보증금" style="text-align:right"><b>${fmtKRW(l.actual)}원</b></td>
      <td data-label="이자율" style="text-align:right">${l.rate?(l.rate*100).toFixed(2)+'%':'-'}</td>
      <td data-label="만기일">${escape(l.due||'-')}</td>
      <td data-label="월이자" style="text-align:right">${l.monthlyInterest?fmtKRW(l.monthlyInterest)+'원':'-'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:30px">대출 없음</td></tr>';
  tbody.querySelectorAll('[data-loan-id]').forEach(el=>{
    el.addEventListener('click', ()=>openLoanModal(parseInt(el.dataset.loanId)));
  });
}

// ---------- 렌더: 증여예정 ----------
function renderGift(){
  const s = giftSummary();
  document.getElementById('giftGongsi').textContent = fmtShort(s.gongsi) + '원';
  document.getElementById('giftGamjeong').textContent = fmtShort(s.gamjeong) + '원';
  const grid = document.getElementById('giftGrid');
  grid.innerHTML = (DATA.giftParcels||[]).map(p=>{
    const g = (p.totalArea||0) * getPrice(p,'gongsi');
    const a = (p.totalArea||0) * getPrice(p,'gamjeong');
    return `<div class="parcel-card gift">
      <div class="parcel-card-top"><div class="parcel-name">${escape(p.name)}</div><div class="parcel-use">${escape(p.use)}</div></div>
      <div class="parcel-area">면적 <b>${fmtArea(p.totalArea)}㎡ (${fmtArea(toPyeong(p.totalArea))}평)</b></div>
      <div class="parcel-row"><span>현재 소유</span><b>${escape(p.currentOwner)}</b></div>
      <div class="parcel-row"><span>증여 예정</span><b style="color:var(--warn)">${escape(p.pendingFor)}</b></div>
      <div class="parcel-row gongsi"><span>공시지가/㎡</span><b>${fmtKRW(getPrice(p,'gongsi'))}원</b></div>
      <div class="parcel-row gongsi"><span>공시가격</span><b>${fmtKRW(g)}원</b></div>
      <div class="parcel-row gamjeong total"><span>감정평가액</span><b>${fmtKRW(a)}원</b></div>
      ${p.note?`<div style="margin-top:10px;padding:8px 12px;background:var(--warn-soft);border-radius:8px;font-size:11.5px;color:var(--warn);line-height:1.5">${escape(p.note)}</div>`:''}
    </div>`;
  }).join('') || '<div class="empty">증여예정 토지 없음</div>';
}

// ---------- 모달 ----------
let modalCtx = null;
function openModal(title, sub, html){
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalSub').textContent = sub;
  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('modalBg').classList.add('active');
  document.getElementById('btnDelete').style.display = modalCtx && modalCtx.id ? 'inline-flex' : 'none';
}
function closeModal(){
  document.getElementById('modalBg').classList.remove('active');
  modalCtx = null;
}
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalCancel').addEventListener('click', closeModal);
document.getElementById('modalBg').addEventListener('click', e=>{if(e.target.id==='modalBg') closeModal()});
document.addEventListener('keydown', e=>{if(e.key==='Escape') closeModal()});

function priceFieldsHTML(prices){
  return DATA.meta.years.map(y=>{
    const p = (prices && prices[y]) || {};
    return `<div class="field-row">
      <div class="field"><label>${y}년 공시지가/㎡</label><input type="text" inputmode="numeric" data-pf-gongsi="${y}" value="${p.gongsi||''}"></div>
      <div class="field"><label>${y}년 감정가격/㎡</label><input type="text" inputmode="numeric" data-pf-gamjeong="${y}" value="${p.gamjeong||''}"></div>
    </div>`;
  }).join('');
}

function openParcelModal(id){
  const p = id ? DATA.parcels.find(x=>x.id===id) : null;
  modalCtx = {kind:'parcel', id};
  const ownership = p?.ownership || {};
  const html = `
    <div class="field-row">
      <div class="field"><label>지번</label><input id="pf-name" type="text" value="${escape(p?.name||'')}"></div>
      <div class="field"><label>용도</label><select id="pf-use">${DATA.meta.uses.map(u=>`<option ${p?.use===u?'selected':''}>${u}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>전체 면적 (㎡)</label><input id="pf-totalArea" type="text" inputmode="decimal" value="${p?.totalArea||''}"></div>
    <div class="field"><label>구성원별 소유면적 (㎡) — 빈 칸은 미소유</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${DATA.meta.members.map(m=>`<div style="display:flex;align-items:center;gap:6px"><span style="font-size:12px;width:50px">${escape(m)}</span><input type="text" inputmode="decimal" data-own="${escape(m)}" value="${ownership[m]||''}" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-soft);font-size:13px"></div>`).join('')}
      </div>
    </div>
    ${priceFieldsHTML(p?.prices)}
  `;
  openModal(id?'필지 수정':'새 필지 추가', p?escape(p.name):'새 토지·아파트 등록', html);
}
function openLeaseModal(id){
  const l = id ? DATA.leases.find(x=>x.id===id) : null;
  modalCtx = {kind:'lease', id};
  const html = `
    <div class="field-row">
      <div class="field"><label>임대물건</label><input id="lf-parcel" type="text" value="${escape(l?.parcel||'')}"></div>
      <div class="field"><label>임차인</label><input id="lf-tenant" type="text" value="${escape(l?.tenant||'')}"></div>
    </div>
    <div class="field-row-3">
      <div class="field"><label>보증금 (원)</label><input id="lf-deposit" type="text" inputmode="numeric" value="${l?.deposit||0}"></div>
      <div class="field"><label>월세 (원)</label><input id="lf-monthly" type="text" inputmode="numeric" value="${l?.monthly||0}"></div>
      <div class="field"><label>연수입 (원)</label><input id="lf-annual" type="text" inputmode="numeric" value="${l?.annual||0}"></div>
    </div>
    <div class="field"><label>임대기간</label><input id="lf-period" type="text" value="${escape(l?.period||'')}" placeholder="2025.01.01~2027.12.31"></div>
    <div class="field-row">
      <div class="field"><label>담당자</label><input id="lf-contact" type="text" value="${escape(l?.contact||'')}"></div>
      <div class="field"><label>연락처</label><input id="lf-phone" type="text" value="${escape(l?.phone||'')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>사업자등록번호</label><input id="lf-businessNum" type="text" value="${escape(l?.businessNum||'')}"></div>
      <div class="field"><label>이메일</label><input id="lf-email" type="text" value="${escape(l?.email||'')}"></div>
    </div>
    <div class="field"><label>비고</label><textarea id="lf-note">${escape(l?.note||'')}</textarea></div>
  `;
  openModal(id?'임대차 수정':'새 임대차 추가', l?escape(l.parcel):'신규 임대 계약', html);
}
function openLoanModal(id){
  const l = id ? DATA.loans.find(x=>x.id===id) : null;
  modalCtx = {kind:'loan', id};
  const html = `
    <div class="field-row">
      <div class="field"><label>구분</label><select id="lo-type">${DATA.meta.loanTypes.map(t=>`<option ${l?.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label>내용</label><input id="lo-name" type="text" value="${escape(l?.name||'')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>채권최고액 (원)</label><input id="lo-maxAmount" type="text" inputmode="numeric" value="${l?.maxAmount||0}"></div>
      <div class="field"><label>실대출/보증금 (원)</label><input id="lo-actual" type="text" inputmode="numeric" value="${l?.actual||0}"></div>
    </div>
    <div class="field-row-3">
      <div class="field"><label>이자율 (예: 0.0512 = 5.12%)</label><input id="lo-rate" type="text" inputmode="decimal" value="${l?.rate||0}"></div>
      <div class="field"><label>만기일</label><input id="lo-due" type="text" value="${escape(l?.due||'')}" placeholder="2026.12.31"></div>
      <div class="field"><label>월이자 (원)</label><input id="lo-monthlyInterest" type="text" inputmode="numeric" value="${l?.monthlyInterest||0}"></div>
    </div>
  `;
  openModal(id?'대출 수정':'새 대출/보증금 추가', l?escape(l.name):'신규 등록', html);
}

document.getElementById('modalSave').addEventListener('click', ()=>{
  if(!modalCtx) return;
  const num = id => parseFloat(document.getElementById(id)?.value||0) || 0;
  const numI = id => parseInt(document.getElementById(id)?.value.replace(/[^\d.]/g,'')||0) || 0;
  const str = id => (document.getElementById(id)?.value||'').trim();

  flashSync('dirty');
  if(modalCtx.kind==='parcel'){
    const ownership = {};
    document.querySelectorAll('[data-own]').forEach(el=>{
      const v = parseFloat(el.value)||0;
      if(v>0) ownership[el.dataset.own] = v;
    });
    const prices = {};
    DATA.meta.years.forEach(y=>{
      prices[y] = {
        gongsi: parseFloat(document.querySelector(`[data-pf-gongsi="${y}"]`)?.value)||null,
        gamjeong: parseFloat(document.querySelector(`[data-pf-gamjeong="${y}"]`)?.value)||null
      };
    });
    const rec = {
      name: str('pf-name'),
      use: str('pf-use'),
      totalArea: num('pf-totalArea'),
      sharedOwnership: Object.keys(ownership).length > 1,
      ownership, prices
    };
    if(modalCtx.id){
      const i = DATA.parcels.findIndex(x=>x.id===modalCtx.id);
      Object.assign(DATA.parcels[i], rec);
    } else {
      rec.id = DATA.nextParcelId++;
      DATA.parcels.push(rec);
    }
  } else if(modalCtx.kind==='lease'){
    const rec = {
      parcel:str('lf-parcel'), tenant:str('lf-tenant'),
      deposit:numI('lf-deposit'), monthly:numI('lf-monthly'), annual:numI('lf-annual'),
      period:str('lf-period'), contact:str('lf-contact'), phone:str('lf-phone'),
      businessNum:str('lf-businessNum'), email:str('lf-email'), note:str('lf-note')
    };
    if(modalCtx.id){
      const i = DATA.leases.findIndex(x=>x.id===modalCtx.id);
      Object.assign(DATA.leases[i], rec);
    } else {
      rec.id = DATA.nextLeaseId++;
      DATA.leases.push(rec);
    }
  } else if(modalCtx.kind==='loan'){
    const rec = {
      type:str('lo-type'), name:str('lo-name'),
      maxAmount:numI('lo-maxAmount'), actual:numI('lo-actual'),
      rate:num('lo-rate'), due:str('lo-due'),
      monthlyInterest:numI('lo-monthlyInterest')
    };
    if(modalCtx.id){
      const i = DATA.loans.findIndex(x=>x.id===modalCtx.id);
      Object.assign(DATA.loans[i], rec);
    } else {
      rec.id = DATA.nextLoanId++;
      DATA.loans.push(rec);
    }
  }
  saveData();
  rerenderAll();
  closeModal();
  toast('저장됨', 'ok');
});

document.getElementById('btnDelete').addEventListener('click', ()=>{
  if(!modalCtx || !modalCtx.id) return;
  if(!confirm('정말 삭제하시겠습니까?')) return;
  flashSync('dirty');
  if(modalCtx.kind==='parcel') DATA.parcels = DATA.parcels.filter(x=>x.id!==modalCtx.id);
  else if(modalCtx.kind==='lease') DATA.leases = DATA.leases.filter(x=>x.id!==modalCtx.id);
  else if(modalCtx.kind==='loan') DATA.loans = DATA.loans.filter(x=>x.id!==modalCtx.id);
  saveData();
  rerenderAll();
  closeModal();
  toast('삭제됨', 'ok');
});

// FAB → 어떤 항목? 선택 후 모달
document.getElementById('fabAdd').addEventListener('click', ()=>{
  showView('input');
  document.getElementById('manualTypePick').style.display = 'block';
  document.getElementById('manualTypePick').scrollIntoView({behavior:'smooth'});
});
document.getElementById('imManual').addEventListener('click', ()=>{
  document.getElementById('manualTypePick').style.display = 'block';
  document.getElementById('manualTypePick').scrollIntoView({behavior:'smooth'});
});
document.querySelectorAll('[data-add]').forEach(b=>{
  b.addEventListener('click', ()=>{
    const k = b.dataset.add;
    if(k==='parcel') openParcelModal(null);
    else if(k==='lease') openLeaseModal(null);
    else if(k==='loan') openLoanModal(null);
  });
});

// 엑셀/스캔
document.getElementById('imExcel').addEventListener('click', ()=>document.getElementById('excelFile').click());
document.getElementById('imScan').addEventListener('click', ()=>document.getElementById('scanFile').click());
document.getElementById('excelFile').addEventListener('change', e=>{
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev)=>{
    try{
      const wb = XLSX.read(new Uint8Array(ev.target.result), {type:'array', cellDates:true});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, {defval:'', raw:false});
      if(!confirm(`엑셀에서 ${rows.length}개 행을 발견했습니다. 첫 시트의 행을 단가 갱신용으로 검토하시려면 OK를 누르세요. (자동 매칭 시도 — 지번 컬럼이 있고 공시지가/감정가격 컬럼이 있으면 자동 갱신됩니다)`)) return;
      let updated = 0;
      rows.forEach(r=>{
        const name = String(r['지번']||r['name']||'').trim();
        if(!name) return;
        const target = DATA.parcels.find(p=>p.name.replace(/[ ★]/g,'').includes(name.replace(/[ ★]/g,''))) ||
                       (DATA.giftParcels||[]).find(p=>p.name.includes(name));
        if(!target) return;
        const year = String(r['연도']||DATA.appliedYear||'2025');
        if(!target.prices[year]) target.prices[year] = {gongsi:null, gamjeong:null};
        const g = parseFloat(String(r['공시지가']||r['공시지가/㎡']||r['gongsi']||'').replace(/[^\d.]/g,''));
        const ga = parseFloat(String(r['감정가격']||r['감정가격/㎡']||r['gamjeong']||'').replace(/[^\d.]/g,''));
        if(g) target.prices[year].gongsi = g;
        if(ga) target.prices[year].gamjeong = ga;
        if(g||ga) updated++;
      });
      flashSync('dirty');
      saveData();
      rerenderAll();
      toast(`${updated}개 필지 단가 갱신됨`, 'ok');
    }catch(err){ toast('엑셀 읽기 실패: '+err.message, 'err'); }
  };
  reader.readAsArrayBuffer(file);
  e.target.value='';
});
document.getElementById('scanFile').addEventListener('change', e=>{
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev)=>{
    document.getElementById('scanImg').src = ev.target.result;
    document.getElementById('scanSection').style.display = 'block';
    document.getElementById('scanSection').scrollIntoView({behavior:'smooth'});
  };
  reader.readAsDataURL(file);
  e.target.value='';
});
document.getElementById('btnScanClose').addEventListener('click', ()=>{
  document.getElementById('scanSection').style.display = 'none';
});

// 전체 리렌더
function rerenderAll(){
  renderDash();
  renderParcels();
  renderMembers();
  renderLeases();
  renderLoans();
  renderGift();
}

// 백업/복원
document.getElementById('btnExport').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(DATA, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=FILE_NAME;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('JSON 다운로드 완료', 'ok');
});
document.getElementById('btnImport').addEventListener('click', ()=>document.getElementById('fileImport').click());
document.getElementById('fileImport').addEventListener('change', e=>{
  const file = e.target.files[0]; if(!file) return;
  const r = new FileReader();
  r.onload = ev=>{
    try{
      const p = JSON.parse(ev.target.result);
      if(!p.parcels) throw new Error('형식이 올바르지 않습니다');
      if(!confirm('현재 데이터를 덮어쓰시겠습니까?')) return;
      DATA = p; saveData(true); rerenderAll(); buildYearSelect();
      toast('가져오기 완료', 'ok');
    }catch(err){ toast('가져오기 실패: '+err.message, 'err'); }
  };
  r.readAsText(file, 'utf-8');
  e.target.value='';
});
document.getElementById('btnReset').addEventListener('click', ()=>{
  if(!confirm('초기 데이터로 복원합니다. 계속할까요?')) return;
  DATA = deepClone(window.INITIAL_DATA);
  saveData(true);
  rerenderAll(); buildYearSelect();
  toast('복원됨', 'ok');
});

// ============ GitHub Gist 동기화 ============
function getSyncConfig(){try{return JSON.parse(localStorage.getItem(SYNC_KEY)||'{}')}catch{return {}}}
function setSyncConfig(c){localStorage.setItem(SYNC_KEY, JSON.stringify(c))}
function encodeSyncCode(t,g){return 'realestateSync:'+btoa(unescape(encodeURIComponent(t+':'+g)))}
function decodeSyncCode(c){
  if(!c) return null;
  const m=String(c).trim().match(/^(?:realestateSync|dkbiSync|ledgerSync):(.+)$/);
  if(!m) return null;
  try{const r=decodeURIComponent(escape(atob(m[1])));const i=r.indexOf(':');return i<0?null:{token:r.slice(0,i),gistId:r.slice(i+1)}}catch{return null}
}
async function ghFetch(url, opts, token){
  opts=opts||{};
  opts.headers=Object.assign({'Accept':'application/vnd.github+json','Authorization':'token '+token}, opts.headers||{});
  const r=await fetch(url,opts);
  if(!r.ok){let m=r.status+' '+r.statusText;try{const j=await r.json();if(j.message)m+=' — '+j.message}catch{};throw new Error(m)}
  return r.json();
}
async function createGist(t,d){return ghFetch('https://api.github.com/gists',{method:'POST',body:JSON.stringify({description:'유재진 가족 부동산 자동 동기화 (private)',public:false,files:{[GIST_FILENAME]:{content:JSON.stringify(d,null,2)}}})},t)}
async function readGist(t,g){
  const j=await ghFetch('https://api.github.com/gists/'+encodeURIComponent(g),{},t);
  const f=j.files&&j.files[GIST_FILENAME]; if(!f) throw new Error('파일 없음');
  let c=f.content; if(f.truncated&&f.raw_url){const r=await fetch(f.raw_url);c=await r.text()}
  return JSON.parse(c);
}
async function updateGist(t,g,d){return ghFetch('https://api.github.com/gists/'+encodeURIComponent(g),{method:'PATCH',body:JSON.stringify({files:{[GIST_FILENAME]:{content:JSON.stringify(d,null,2)}}})},t)}

function setSyncBadge(s){const b=document.getElementById('syncStateBadge');if(!b)return;b.classList.remove('off','on','syncing');if(s==='on'){b.classList.add('on');b.textContent='ON'}else if(s==='syncing'){b.classList.add('syncing');b.textContent='SYNCING'}else{b.classList.add('off');b.textContent='OFF'}}
function setSyncStatusText(s){const e=document.getElementById('syncStatusText');if(e)e.textContent=s}
function setSyncLastTime(d){const e=document.getElementById('syncLastTime');if(!e)return;if(!d){e.textContent='-';return};const di=Date.now()-new Date(d).getTime();if(di<10000)e.textContent='방금 전';else if(di<60000)e.textContent=Math.floor(di/1000)+'초 전';else if(di<3600000)e.textContent=Math.floor(di/60000)+'분 전';else e.textContent=new Date(d).toLocaleString('ko-KR')}
function refreshSyncUI(){
  const c=getSyncConfig(); const s1=document.getElementById('syncStep1'); const s2=document.getElementById('syncStep2');
  if(c.enabled&&c.token&&c.gistId){s1.style.display='none';s2.style.display='block';document.getElementById('syncGistId').textContent=c.gistId.slice(0,8)+'...'+c.gistId.slice(-4);document.getElementById('syncCodeOut').value=encodeSyncCode(c.token,c.gistId);setSyncBadge('on');setSyncLastTime(c.lastSync);flashSync('cloud')}
  else{s1.style.display='block';s2.style.display='none';setSyncBadge('off')}
}
let pushTimer=null,pushInflight=false;
function schedulePush(){setSyncBadge('syncing');setSyncStatusText('업로드 대기 중…');clearTimeout(pushTimer);pushTimer=setTimeout(doPush,PUSH_DEBOUNCE_MS)}
async function doPush(){const c=getSyncConfig();if(!c.enabled||!c.token||!c.gistId)return;if(pushInflight){schedulePush();return}pushInflight=true;try{setSyncBadge('syncing');setSyncStatusText('업로드 중…');flashSync('syncing');await updateGist(c.token,c.gistId,DATA);c.lastSync=new Date().toISOString();setSyncConfig(c);setSyncBadge('on');setSyncStatusText('연결됨');setSyncLastTime(c.lastSync);flashSync('cloud')}catch(e){setSyncBadge('on');setSyncStatusText('실패: '+e.message);toast('업로드 실패: '+e.message,'err')}finally{pushInflight=false}}
let pullTimer=null,pullInflight=false;
async function doPull(silent){const c=getSyncConfig();if(!c.enabled||!c.token||!c.gistId)return;if(pullInflight)return;pullInflight=true;try{if(!silent){setSyncBadge('syncing');setSyncStatusText('확인 중…');flashSync('syncing')}const rem=await readGist(c.token,c.gistId);if(rem&&rem.updatedAt&&rem.updatedAt>(DATA.updatedAt||'')){DATA=rem;saveData(true,{fromRemote:true});rerenderAll();buildYearSelect();if(!silent)toast('변경사항 받음','ok')}c.lastSync=new Date().toISOString();setSyncConfig(c);setSyncBadge('on');setSyncStatusText('연결됨');setSyncLastTime(c.lastSync);flashSync('cloud')}catch(e){setSyncBadge('on');setSyncStatusText('실패: '+e.message);if(!silent)toast('확인 실패: '+e.message,'err')}finally{pullInflight=false}}
function startPullLoop(){clearInterval(pullTimer);pullTimer=setInterval(()=>doPull(true),PULL_INTERVAL_MS)}
function stopPullLoop(){clearInterval(pullTimer);pullTimer=null}
window.addEventListener('focus',()=>{const c=getSyncConfig();if(c.enabled) doPull(true)});

document.getElementById('btnSyncStart').addEventListener('click', async ()=>{
  const t=document.getElementById('ghToken').value.trim(); const c=document.getElementById('ghSyncCode').value.trim();
  const btn=document.getElementById('btnSyncStart'); btn.disabled=true; btn.textContent='연결 중…';
  try{
    let token, gistId;
    if(c){const d=decodeSyncCode(c);if(!d)throw new Error('동기화 코드 형식이 올바르지 않습니다');token=d.token;gistId=d.gistId;const rem=await readGist(token,gistId);if(rem&&rem.updatedAt&&rem.updatedAt>(DATA.updatedAt||'')){DATA=rem;saveData(true,{fromRemote:true});rerenderAll();buildYearSelect()}}
    else if(t){if(!/^gh[ps]_/.test(t)&&!/^github_pat_/.test(t)){if(!confirm('토큰 형식이 일반적이지 않습니다. 계속할까요?')){btn.disabled=false;btn.textContent='☁️ 동기화 시작';return}}token=t;const g=await createGist(token,DATA);gistId=g.id}
    else throw new Error('토큰 또는 동기화 코드를 입력하세요');
    setSyncConfig({enabled:true,token,gistId,lastSync:new Date().toISOString()});
    refreshSyncUI(); startPullLoop();
    toast('동기화 시작됨','ok');
    document.getElementById('ghToken').value=''; document.getElementById('ghSyncCode').value='';
  }catch(e){toast('실패: '+e.message,'err')}finally{btn.disabled=false;btn.textContent='☁️ 동기화 시작'}
});
document.getElementById('btnSyncStop').addEventListener('click',()=>{if(!confirm('동기화를 끄시겠습니까?'))return;setSyncConfig({});stopPullLoop();clearTimeout(pushTimer);refreshSyncUI();flashSync('saved');toast('동기화 꺼짐')});
document.getElementById('btnSyncNow').addEventListener('click',async()=>{await doPush();await doPull()});
document.getElementById('btnCopyCode').addEventListener('click',async()=>{const c=document.getElementById('syncCodeOut').value;try{await navigator.clipboard.writeText(c);toast('복사 완료','ok')}catch{document.getElementById('syncCodeOut').select();document.execCommand('copy');toast('복사 완료','ok')}});

(function bootSync(){const c=getSyncConfig();refreshSyncUI();if(c.enabled&&c.token&&c.gistId){doPull(true);startPullLoop()};setInterval(()=>{const x=getSyncConfig();if(x.enabled&&x.lastSync)setSyncLastTime(x.lastSync)},5000)})();

// 초기 부트
buildYearSelect();
rerenderAll();
if(!getSyncConfig().enabled) flashSync('saved');


/* ===================== 100세 캐시플로우 연동 (cashflow-hub-api) ===================== */
const CFHUB_API='https://cashflow-hub-api.yjjn2005.workers.dev';
const CFHUB_PIN_KEY='cfhub_pin';
function cfhubGetPin(){
  let p=localStorage.getItem(CFHUB_PIN_KEY);
  if(!p){
    p=prompt('100세 캐시플로우 동기화 PIN을 입력하세요 (캐시플로우 앱과 동일)');
    if(p&&p.trim().length>=4)localStorage.setItem(CFHUB_PIN_KEY,p.trim());
    else return null;
  }
  return localStorage.getItem(CFHUB_PIN_KEY);
}
async function exportRentToCashflow(){
  const ls=DATA.leases||[];
  if(!ls.length){toast('임대차 계약이 없습니다','warn');return;}
  // 월환산 합계: 월세가 있으면 월세, 연세 계약(월세 0)은 연액/12
  const grossWon=ls.reduce((s,l)=>{
    const m=+l.monthly||0, a=+l.annual||0;
    return s+(m>0?m:a/12);
  },0);
  const grossMan=Math.round(grossWon/1e4);
  const input=prompt(
    '캐시플로우 [부동산임대] 탭에 반영할 월액(만원)을 입력하세요.\n\n'
    +'· 전체 계약 월환산 합계: '+grossMan.toLocaleString('ko-KR')+'만원 ('+ls.length+'건, 연세 계약은 12분할)\n'
    +'· 공동사업자 본인 몫만 반영하려면 금액을 수정하세요 (예: 300)',
    grossMan);
  if(input===null)return;
  const amt=Math.round(parseFloat(input));
  if(isNaN(amt)||amt<0){toast('금액이 올바르지 않습니다','warn');return;}
  const pin=cfhubGetPin(); if(!pin)return;
  try{
    const res=await fetch(CFHUB_API+'/feed/'+encodeURIComponent(pin)+'/rent',{
      method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({amt:amt,src:'yjj-realestate'})});
    if(!res.ok)throw new Error(res.status);
    toast('✅ 캐시플로우로 내보냈습니다 ('+amt.toLocaleString('ko-KR')+'만/월)','ok');
  }catch(e){
    toast('❌ 내보내기 실패 — 네트워크/PIN 확인','warn');
    localStorage.removeItem(CFHUB_PIN_KEY);
  }
}
