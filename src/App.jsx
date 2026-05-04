import { useState, useRef, useCallback } from "react";

// ============================================================
// API 키 설정
// ============================================================
const KEYS = {
  vworld: "5D97E619-1378-3DAD-829C-908B0B8A4FF1",
  dataGoKr: "973bc86e940cf92a5a5d04b8caf77c6a4165a1fcd77f15d13fcb28afa1edb865",
};

// ============================================================
// UTILITIES
// ============================================================

function getDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
// API SERVICE
// ============================================================

async function callBuildingAPI(functionName, sigunguCode, bjdongCd5, jibun) {
  const [mainNo, subNo] = jibun.split("-");
  const url = `/api/building/${functionName}?serviceKey=${KEYS.dataGoKr}&sigunguCd=${sigunguCode}&bjdongCd=${bjdongCd5}&platGbCd=0&bun=${(mainNo || "").padStart(4, "0")}&ji=${(subNo || "0").padStart(4, "0")}&numOfRows=100&pageNo=1&_type=json`;
  console.log(`[API] ${functionName}: sigungu=${sigunguCode}, bjdong=${bjdongCd5}, jibun=${jibun}`);
  const res = await fetch(url);
  const text = await res.text();
  console.log(`[API] ${functionName} 응답(200자):`, text.substring(0, 200));
  try {
    const data = JSON.parse(text);
    const items = data?.response?.body?.items?.item;
    if (items) return Array.isArray(items) ? items : [items];
    if (data?.response?.body?.totalCount == 0) return [];
    throw new Error("데이터 없음");
  } catch (e) {
    try {
      const parser = new DOMParser();
      const xml = parser.parseFromString(text, "text/xml");
      const items = xml.querySelectorAll("item");
      if (items.length > 0) return Array.from(items).map(item => { const o = {}; item.childNodes.forEach(n => { if (n.nodeType === 1) o[n.tagName] = n.textContent; }); return o; });
    } catch (x) {}
    throw new Error("API 응답 파싱 실패");
  }
}

const API = {
  async geocode(address) {
    let lat, lng, fwd = {};
    for (const t of ["PARCEL", "ROAD"]) {
      try {
        const p = new URLSearchParams({ service: "address", request: "getcoord", version: "2.0", crs: "epsg:4326", address, format: "json", type: t, key: KEYS.vworld });
        const d = await (await fetch(`/api/vworld/req/address?${p}`)).json();
        if (d.response?.status === "OK" && d.response?.result?.point) {
          lat = parseFloat(d.response.result.point.y); lng = parseFloat(d.response.result.point.x); fwd = d.response.refined?.structure || {}; break;
        }
      } catch (e) {}
    }
    if (!lat || !lng) throw new Error("주소를 찾을 수 없습니다. 정확한 도로명 또는 지번 주소를 입력해주세요.");
    let dc = "", dn = "", jibun = "";
    try {
      const p = new URLSearchParams({ service: "address", request: "getAddress", version: "2.0", crs: "epsg:4326", point: `${lng},${lat}`, format: "json", type: "PARCEL", key: KEYS.vworld });
      const d = await (await fetch(`/api/vworld/req/address?${p}`)).json();
      const res = Array.isArray(d.response?.result) ? d.response.result[0] : d.response?.result;
      if (res) { const s = res.structure || {}; dc = s.level4LC || ""; dn = s.level4L || ""; jibun = s.level5 || ""; }
    } catch (e) { dc = fwd.level4LC || ""; dn = fwd.level4L || ""; jibun = fwd.level5 || ""; }
    if (!jibun) jibun = fwd.level5 || "";
    let roadAddr = "";
    try {
      const p = new URLSearchParams({ service: "address", request: "getAddress", version: "2.0", crs: "epsg:4326", point: `${lng},${lat}`, format: "json", type: "ROAD", key: KEYS.vworld });
      const d = await (await fetch(`/api/vworld/req/address?${p}`)).json();
      const res = Array.isArray(d.response?.result) ? d.response.result[0] : d.response?.result;
      if (res) roadAddr = res.text || "";
    } catch (e) {}
    const parcelAddr = `${fwd.level1 || ""} ${fwd.level2 || ""} ${dn} ${jibun}`.trim();
    console.log(`[지오코딩 최종] 시군구:${dc.substring(0,5)} 법정동5:${dc.substring(5,10)} 법정동명:${dn} 지번:${jibun}`);
    return { lat, lng, dongCode: dc, sigunguCode: dc.substring(0, 5), bjdongCd5: dc.substring(5, 10), jibun, sido: fwd.level1 || "", sigungu: fwd.level2 || "", dong: dn, roadAddr, parcelAddr };
  },

  async getZoningInfo(sigunguCode, bjdongCd5, jibun, lat, lng) {
    // 1순위: 건축물대장 API
    try {
      const items = await callBuildingAPI("getBrJijiguInfo", sigunguCode, bjdongCd5, jibun);
      if (items.length > 0) {
        const zones = items.map(item => item.jijiguNm || item.etcJijigu || item.jijiguCdNm || "").filter(Boolean);
        if (zones.length > 0) { console.log("[용도지역] 건축물API 성공"); return zones; }
      }
    } catch (e) { console.log("[용도지역] 건축물API 실패:", e.message); }

    // 2순위: VWorld /req/data (좌표 기반 POINT 필터)
    try {
      const p = new URLSearchParams({ service: "data", request: "GetFeature", data: "LT_C_UQ111", key: KEYS.vworld, geometry: "false", attribute: "true", size: "10", page: "1", geomFilter: `POINT(${lng} ${lat})` });
      const res = await fetch(`/api/vworld/req/data?${p}`);
      const data = await res.json();
      console.log("[VWorld data] 응답:", JSON.stringify(data?.response?.record));
      const features = data?.response?.result?.featureCollection?.features || [];
      if (features.length > 0) {
        const zones = features.map(f => f.properties?.uname || "").filter(Boolean);
        if (zones.length > 0) { console.log("[용도지역] VWorld data 성공:", zones); return zones; }
      }
    } catch (e) { console.log("[용도지역] VWorld data 실패:", e.message); }

    // 3순위: LURIS API (PNU 기반)
    try {
      const [mainNo, subNo] = jibun.split("-");
      const pnu = `${sigunguCode}${bjdongCd5}0${(mainNo || "").padStart(4, "0")}${(subNo || "0").padStart(4, "0")}`;
      console.log("[LURIS] PNU:", pnu);
      const res = await fetch(`/api/luris/getLandUseAttr?serviceKey=${KEYS.dataGoKr}&pnu=${pnu}&format=json`);
      const text = await res.text();
      console.log("[LURIS] 응답:", text.substring(0, 300));
      const data = JSON.parse(text);
      const raw = data?.landUseAttr?.field || data?.landUseAttr || data?.response?.body?.items?.item;
      if (raw) {
        const items = Array.isArray(raw) ? raw : [raw];
        const zones = items.map(i => i.prposAreaDstrcNm || "").filter(Boolean);
        if (zones.length > 0) { console.log("[용도지역] LURIS 성공:", zones); return zones; }
      }
    } catch (e) { console.log("[용도지역] LURIS 실패:", e.message); }

    throw new Error("용도지역 정보를 조회할 수 없습니다 (3개 API 모두 시도)");
  },

  async getBuildingInfo(sigunguCode, bjdongCd5, jibun) {
    for (const fn of ["getBrBasisOulnInfo", "getBrRecapTitleInfo", "getBrTitleInfo"]) {
      try {
        const items = await callBuildingAPI(fn, sigunguCode, bjdongCd5, jibun);
        if (items.length === 0) continue;
        const item = items[0];
        const r = { bldNm: item.bldNm || "", mainPurpsCdNm: item.mainPurpsCdNm || "", etcPurps: item.etcPurps || "", totArea: parseFloat(item.totArea) || 0, platArea: parseFloat(item.platArea) || 0, useAprDay: item.useAprDay || "", strctCdNm: item.strctCdNm || "", grndFlrCnt: parseInt(item.grndFlrCnt) || 0, ugrndFlrCnt: parseInt(item.ugrndFlrCnt) || 0, bcRat: parseFloat(item.bcRat) || 0, vlRat: parseFloat(item.vlRat) || 0, source: fn };
        if (r.mainPurpsCdNm || r.totArea > 0 || r.strctCdNm) return r;
        console.log(`[건축물대장] ${fn} 값 비어있음, 다음 시도`);
      } catch (e) { console.log(`[건축물대장] ${fn} 실패:`, e.message); }
    }
    throw new Error("건축물 정보를 찾을 수 없습니다 (3개 API 모두 시도)");
  },

  async searchSchools(lat, lng) {
    const schools = []; const delta = 0.004;
    const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;
    for (const kw of ["초등학교", "중학교", "고등학교"]) {
      try {
        const p = new URLSearchParams({ service: "search", request: "search", version: "2.0", crs: "EPSG:4326", query: kw, type: "place", bbox, format: "json", size: "50", key: KEYS.vworld });
        const d = await (await fetch(`/api/vworld/req/search?${p}`)).json();
        const items = d.response?.result?.items;
        if (items && Array.isArray(items)) schools.push(...items.map(item => ({ name: item.title || "", type: kw, distance: Math.round(getDistanceMeters(lat, lng, parseFloat(item.point?.y||0), parseFloat(item.point?.x||0))) })));
      } catch (e) {}
    }
    return schools.sort((a, b) => a.distance - b.distance);
  },
};

// ============================================================
// JUDGMENT
// ============================================================

const ZONING_OPTIONS = [
  { label: "중심상업", ok: true }, { label: "일반상업", ok: true }, { label: "근린상업", ok: true }, { label: "유통상업", ok: true },
  { label: "준주거", ok: true, note: "사업계획승인 필요" },
  { label: "제1종일반주거", ok: true, note: "사업계획승인+추가기준" }, { label: "제2종일반주거", ok: true, note: "사업계획승인+추가기준" },
  { label: "제3종일반주거", ok: true, note: "사업계획승인+추가기준" }, { label: "일반주거", ok: true, note: "사업계획승인+추가기준" },
  { label: "전용주거", ok: false }, { label: "준공업", ok: true, note: "사업계획승인 필요" }, { label: "자연녹지", ok: true, note: "사업계획승인, 제한적" },
];

function judgeZoning(zones) {
  if (!zones || zones.length === 0) return { status: "pending", label: "확인 필요", note: "", isCulturalDistrict: false };
  const isCulturalDistrict = zones.some(z => z.includes("문화지구"));
  let r = { status: "warning", label: zones[0], note: "수동 확인 필요", isCulturalDistrict };
  for (const z of zones) {
    const m = ZONING_OPTIONS.find(o => z.includes(o.label));
    if (m) {
      if (!m.ok) { r = { status: "fail", label: z, note: "관광숙박시설 설치 불가 (국토계획법)", isCulturalDistrict }; break; }
      let extra = "";
      if (z === "일반주거지역" && !z.includes("제")) extra = " (종 구분은 토지이음 eum.go.kr에서 확인)";
      r = m.note
        ? { status: "warning", label: z + extra, note: m.note, isCulturalDistrict }
        : { status: "pass", label: z, note: "관광숙박시설 설치 가능 (관광진흥법 제16조)", isCulturalDistrict };
      break;
    }
  }
  if (isCulturalDistrict) r.status = "fail";
  return r;
}

function judgeSchool(schools) {
  if (!schools || schools.length === 0) return { status: "pass", msg: "반경 500m 내 학교 없음 -- 제한 없음" };
  const n = schools[0];
  if (n.distance <= 50) return { status: "fail", msg: `절대정화구역 (${n.name}, ${n.distance}m) -- 숙박시설 설립 불가` };
  if (n.distance <= 200) return { status: "warning", msg: `상대정화구역 (${n.name}, ${n.distance}m) -- 심의 필요` };
  return { status: "pass", msg: `정화구역 외 (가장 가까운: ${n.name}, ${n.distance}m) -- 제한 없음` };
}

function judgeBuilding(info) {
  if (!info) return { status: "pending" };
  const p = (info.mainPurpsCdNm || "") + " " + (info.etcPurps || "");
  let ct = "확인 필요 -- 관할 구청 건축과 문의";
  if (/근린생활|음식|소매|사무|업무/.test(p)) ct = "용도변경 허가 필요 (건축법 제19조 제1항)";
  if (/숙박|판매시설|위락/.test(p)) ct = "건축물대장 기재변경 -- 같은 시설군 (건축법 제19조 제3항)";
  const a = info.useAprDay || "";
  return {
    status: info.mainPurpsCdNm || info.totArea > 0 ? "pass" : "warning", changeType: ct,
    purpose: info.mainPurpsCdNm, etcPurps: info.etcPurps, bldNm: info.bldNm,
    area: Math.round(info.totArea), platArea: Math.round(info.platArea), structure: info.strctCdNm,
    floors: info.grndFlrCnt > 0 ? `지상 ${info.grndFlrCnt}층 / 지하 ${info.ugrndFlrCnt}층` : "",
    approvalDate: a.length >= 8 ? `${a.substring(0,4)}.${a.substring(4,6)}.${a.substring(6,8)}` : a,
    bcRat: info.bcRat, vlRat: info.vlRat, source: info.source,
  };
}

function getSprinklerType(area) {
  if (area >= 600) return { type: "스프링클러(정식)", desc: "600㎡ 이상: 정식 스프링클러 의무 (예상 수천만원)", st: "fail" };
  if (area >= 300) return { type: "간이스프링클러", desc: "300~600㎡: 간이스프링클러 의무 (예상 수백~1천만원)", st: "warning" };
  return { type: "스프링클러 불요", desc: "300㎡ 미만: 설치 의무 없음", st: "pass" };
}

// ============================================================
// UI
// ============================================================

const C = { pass: "#16a34a", warning: "#d97706", fail: "#dc2626", pending: "#9ca3af", loading: "#2563eb", border: "#e2e8f0", text: "#1e293b", sub: "#64748b" };

const StatusLabel = ({ status }) => {
  const m = { pass:{t:"적합",bg:"#dcfce7",c:"#16a34a",b:"#bbf7d0"}, warning:{t:"조건부",bg:"#fef9c3",c:"#a16207",b:"#fde68a"}, fail:{t:"부적합",bg:"#fee2e2",c:"#dc2626",b:"#fecaca"}, pending:{t:"대기",bg:"#f1f5f9",c:"#64748b",b:"#e2e8f0"}, loading:{t:"조회 중...",bg:"#dbeafe",c:"#2563eb",b:"#bfdbfe"}, error:{t:"실패",bg:"#fee2e2",c:"#dc2626",b:"#fecaca"} }[status] || {t:"대기",bg:"#f1f5f9",c:"#64748b",b:"#e2e8f0"};
  return <span style={{fontSize:12,fontWeight:700,color:m.c,padding:"3px 12px",borderRadius:4,background:m.bg,border:`1px solid ${m.b}`}}>{m.t}</span>;
};
const StatusDot = ({status}) => <span style={{width:10,height:10,borderRadius:"50%",background:C[status]||C.pending,display:"inline-block"}}/>;
const Section = ({title,status,children,show=true}) => { if(!show) return null; return <div style={{background:"#f8fafc",border:`1px solid ${C.border}`,borderRadius:10,marginBottom:14}}><div style={{display:"flex",alignItems:"center",gap:10,padding:"14px 20px",borderBottom:`1px solid ${C.border}`}}><span style={{flex:1,fontSize:15,fontWeight:700,color:C.text}}>{title}</span><StatusLabel status={status}/></div><div style={{padding:"12px 20px 16px"}}>{children}</div></div>; };
const Tag = ({children,type="info"}) => { const s={info:{bg:"#eff6ff",c:"#2563eb",b:"#bfdbfe"},warn:{bg:"#fef9c3",c:"#a16207",b:"#fde68a"},danger:{bg:"#fee2e2",c:"#dc2626",b:"#fecaca"}}[type]||{bg:"#eff6ff",c:"#2563eb",b:"#bfdbfe"}; return <span style={{display:"inline-block",padding:"4px 10px",margin:"3px 4px 3px 0",borderRadius:6,fontSize:12,fontWeight:600,color:s.c,background:s.bg,border:`1px solid ${s.b}`}}>{children}</span>; };
const Row = ({label,value}) => <div style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${C.border}`}}><span style={{fontSize:13,color:C.sub}}>{label}</span><span style={{fontSize:13,fontWeight:600,color:C.text}}>{value||"--"}</span></div>;
const Alert = ({type,children}) => { const c={pass:{bg:"#f0fdf4",b:"#bbf7d0",c:"#166534"},warning:{bg:"#fffbeb",b:"#fde68a",c:"#92400e"},fail:{bg:"#fef2f2",b:"#fecaca",c:"#991b1b"},info:{bg:"#eff6ff",b:"#bfdbfe",c:"#1e40af"}}[type]||{bg:"#f1f5f9",b:"#e2e8f0",c:"#475569"}; return <div style={{padding:"12px 16px",background:c.bg,border:`1px solid ${c.b}`,borderRadius:8,fontSize:13,color:c.c,lineHeight:1.7,marginTop:8}}>{children}</div>; };
const Check = ({label,checked,onChange}) => <label style={{display:"flex",alignItems:"center",gap:10,padding:"7px 12px",borderRadius:6,cursor:"pointer",background:checked?"#f0fdf4":"#f8fafc",border:`1px solid ${checked?"#86efac":C.border}`,marginBottom:4,fontSize:13,color:C.text}}><input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)} style={{accentColor:"#16a34a"}}/>{label}</label>;

async function downloadPNG(el, name) {
  if (!window.html2canvas) { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"; document.head.appendChild(s); await new Promise(r => { s.onload = r; }); }
  const canvas = await window.html2canvas(el, { scale: 2, backgroundColor: "#ffffff" });
  const link = document.createElement("a"); link.download = name; link.href = canvas.toDataURL("image/png"); link.click();
}

// ============================================================
// MAIN APP
// ============================================================

export default function App() {
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(0);
  const [geo, setGeo] = useState(null);
  const [zoning, setZoning] = useState(null);
  const [zoningJudge, setZoningJudge] = useState(null);
  const [zoningError, setZoningError] = useState(null);
  const [schools, setSchools] = useState(null);
  const [schoolJudge, setSchoolJudge] = useState(null);
  const [building, setBuilding] = useState(null);
  const [buildingJudge, setBuildingJudge] = useState(null);
  const [buildingError, setBuildingError] = useState(null);
  const [error, setError] = useState(null);
  const [fc, setFc] = useState({ sprinkler:false, detector:false, alarm:false, extinguisher:false, exitSign:false, emergencyLight:false, corridorWidth:false, evacuationStairs:false, fireCompartment:false, setback15m:false, setbackMemo:"", entryWidth:false, noiseCheck:false, plumbingCheck:false });
  const [p2, setP2] = useState({ dormPrice:20000, privatePrice:80000, occupancy:70, scenario:1, interior:0, furniture:0, rent:0, labor:0, utilities:0 });
  const resultRef = useRef(null);
  const printRef = useRef(null);

  const runAll = async () => {
    if (!address.trim()) return;
    setLoading(true); setStep(1); setError(null);
    setGeo(null); setZoning(null); setZoningJudge(null); setZoningError(null);
    setSchools(null); setSchoolJudge(null); setBuilding(null); setBuildingJudge(null); setBuildingError(null);
    let g;
    try { g = await API.geocode(address.trim()); setGeo(g); } catch(e) { setError(e.message); setLoading(false); return; }
    setStep(2);
    try { const z = await API.getZoningInfo(g.sigunguCode, g.bjdongCd5, g.jibun, g.lat, g.lng); setZoning(z); setZoningJudge(judgeZoning(z)); } catch(e) { setZoningError(e.message); setZoning([]); setZoningJudge({status:"error",label:"조회 실패",note:e.message,isCulturalDistrict:false}); }
    setStep(3);
    try { const s = await API.searchSchools(g.lat, g.lng); setSchools(s); setSchoolJudge(judgeSchool(s)); } catch(e) { setSchools([]); setSchoolJudge({status:"warning",msg:`검색 실패: ${e.message}`}); }
    setStep(4);
    try { const b = await API.getBuildingInfo(g.sigunguCode, g.bjdongCd5, g.jibun); setBuilding(b); setBuildingJudge(judgeBuilding(b)); } catch(e) { setBuildingError(e.message); setBuildingJudge({status:"error",changeType:"조회 실패"}); }
    setStep(5); setLoading(false);
    setTimeout(() => resultRef.current?.scrollIntoView({behavior:"smooth"}), 300);
  };

  const area = building ? Math.round(building.totArea) : 0;
  const pkReq = area > 0 ? Math.ceil(area / 134) : 0;
  const spr = area > 0 ? getSprinklerType(area) : null;

  // Phase 2 calculations
  const usableArea = area * 0.65;
  const scenarios = [
    { name: "도미토리 중심", dormRatio: 0.8, privateRatio: 0.2, desc: "80% 도미 / 20% 프라이빗" },
    { name: "혼합형", dormRatio: 0.55, privateRatio: 0.45, desc: "55% 도미 / 45% 프라이빗" },
    { name: "프라이빗 중심", dormRatio: 0.25, privateRatio: 0.75, desc: "25% 도미 / 75% 프라이빗" },
  ].map(s => ({
    ...s,
    dormBeds: Math.floor(usableArea * s.dormRatio / 4),
    privateRooms: Math.floor(usableArea * s.privateRatio / 12),
  }));
  const sel = scenarios[p2.scenario];
  const monthlyRevenue = sel ? Math.round(
    sel.dormBeds * p2.dormPrice * 30 * (p2.occupancy / 100) +
    sel.privateRooms * p2.privatePrice * 30 * (p2.occupancy / 100)
  ) : 0;
  const sprCost = area >= 600 ? 30000000 : area >= 300 ? 5000000 : 0;
  const totalInitial = sprCost + (p2.interior || 0) + (p2.furniture || 0);
  const monthlyOps = (p2.rent || 0) + (p2.labor || 0) + (p2.utilities || 0);
  const monthlyNet = monthlyRevenue - monthlyOps;
  const roiMonths = totalInitial > 0 && monthlyNet > 0 ? Math.ceil(totalInitial / monthlyNet) : null;
  const fmt = (n) => n.toLocaleString("ko-KR");
  const fKeys = ["sprinkler","detector","alarm","extinguisher","exitSign","emergencyLight","corridorWidth","evacuationStairs","fireCompartment","setback15m","entryWidth","noiseCheck","plumbingCheck"];
  const fDone = fKeys.filter(k => fc[k]).length;
  const fSt = fDone === fKeys.length ? "pass" : fDone > 0 ? "warning" : "pending";
  const overall = step >= 5 ? (zoningJudge?.status==="fail"||schoolJudge?.status==="fail" ? "fail" : zoningJudge?.status==="warning"||schoolJudge?.status==="warning"||zoningJudge?.status==="error" ? "warning" : "pass") : "pending";

  return (
    <div style={{minHeight:"100vh",background:"#fff",color:C.text,fontFamily:"'Pretendard',-apple-system,sans-serif"}}>
      <div style={{background:"#fff",borderBottom:`1px solid ${C.border}`,padding:"20px 32px"}}>
        <div style={{maxWidth:900,margin:"0 auto"}}>
          <h1 style={{fontSize:20,fontWeight:800,margin:"0 0 4px"}}>호스텔 용도변경 타당성 분석기</h1>
          <p style={{fontSize:12,color:C.sub,margin:"0 0 16px"}}>Phase 1 -- 용도변경 가능성 자동 검토 (v0.6)</p>
          <div style={{display:"flex",gap:10}}>
            <input value={address} onChange={e=>setAddress(e.target.value)} onKeyDown={e=>e.key==="Enter"&&runAll()} placeholder="주소를 입력하고 Enter (도로명 또는 지번)" disabled={loading} style={{flex:1,padding:"12px 16px",borderRadius:8,background:"#fff",border:`1px solid ${C.border}`,color:C.text,fontSize:14,outline:"none"}} onFocus={e=>e.target.style.borderColor="#2563eb"} onBlur={e=>e.target.style.borderColor=C.border}/>
            <button onClick={runAll} disabled={loading||!address.trim()} style={{padding:"12px 24px",borderRadius:8,border:"none",background:loading?"#93c5fd":"#2563eb",color:"#fff",fontSize:14,fontWeight:700,cursor:loading?"wait":"pointer",opacity:!address.trim()?0.4:1,whiteSpace:"nowrap"}}>{loading?`검토 중 (${step}/4)`:"전체 검토 시작"}</button>
          </div>
        </div>
      </div>

      <div style={{maxWidth:900,margin:"0 auto",padding:"24px 32px"}} ref={resultRef}>
        {error && <Alert type="fail">{error}<br/>주소를 다시 입력해주세요. 도로명과 지번 모두 가능합니다.</Alert>}
        {step===1&&!geo&&!error && <div style={{padding:"20px 0",color:C.loading,fontSize:14}}>주소 검색 중...</div>}

        {geo && <div ref={printRef} style={{background:"#fff"}}>
          {/* 주소 표시 (적합/부적합 없음) */}
          <div style={{padding:"12px 16px",background:"#f8fafc",border:`1px solid ${C.border}`,borderRadius:10,marginBottom:14}}>
            {geo.roadAddr && <div style={{fontSize:14,fontWeight:600,color:C.text}}>도로명: {geo.roadAddr}</div>}
            <div style={{fontSize:13,color:C.sub,marginTop:geo.roadAddr?4:0}}>지  번: {geo.parcelAddr}</div>
          </div>

          {step>=5 && <div style={{padding:"16px 24px",borderRadius:10,marginBottom:20,background:overall==="pass"?"#f0fdf4":overall==="warning"?"#fffbeb":"#fef2f2",border:`2px solid ${overall==="pass"?"#86efac":overall==="warning"?"#fde68a":"#fecaca"}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{fontSize:17,fontWeight:800,color:overall==="pass"?"#166534":overall==="warning"?"#92400e":"#991b1b"}}>{overall==="pass"?"[적합] 용도변경 가능성 높음":overall==="warning"?"[조건부] 추가 검토 필요":"[부적합] 용도변경 불가"}</div>
            <div style={{display:"flex",gap:14}}>{[{s:zoningJudge?.status,l:"용도지역"},{s:schoolJudge?.status,l:"학교"},{s:buildingJudge?.status==="error"?"warning":buildingJudge?.status,l:"건축물"}].map((x,i)=><div key={i} style={{textAlign:"center"}}><StatusDot status={x.s||"pending"}/><div style={{fontSize:10,color:C.sub,marginTop:4}}>{x.l}</div></div>)}</div>
          </div>}

          {/* 1. 용도지역 */}
          <Section title="1. 용도지역" status={zoningJudge?.status||(step===2?"loading":"pending")} show={step>=2}>
            {step===2&&!zoning&&<div style={{color:C.loading,fontSize:13}}>지역지구구역 조회 중...</div>}
            {zoning&&zoning.length>0&&<>
              <div style={{marginBottom:8}}>{zoning.map((z,i)=><Tag key={i} type={z.includes("문화지구")?"danger":ZONING_OPTIONS.find(o=>z.includes(o.label))?.ok===false?"danger":"info"}>{z}</Tag>)}</div>
              {zoningJudge&&zoningJudge.status!=="error"&&<Alert type={zoningJudge.status}><strong>{zoningJudge.label}</strong> -- {zoningJudge.note}</Alert>}
              {zoningJudge?.isCulturalDistrict&&<Alert type="fail"><strong>[문화지구 해당]</strong> 이 물건은 문화지구 내에 위치합니다. 문화예술진흥법 제8조의3 및 서울시 문화지구 조례에 따라 문화지구 내 숙박시설 영업이 제한됩니다. 인사동 문화지구는 예외적으로 허용되나, 대학로 등 기타 문화지구에서는 숙박업이 불허업종에 해당합니다. 관할 구청 문화과에 사전 확인이 필요합니다.</Alert>}
            </>}
            {zoningError&&<Alert type="warning">조회 실패: {zoningError}</Alert>}
          </Section>

          {/* 2. 학교 */}
          <Section title="2. 학교환경위생정화구역" status={schoolJudge?.status||(step===3?"loading":"pending")} show={step>=3}>
            {step===3&&!schools&&<div style={{color:C.loading,fontSize:13}}>학교 검색 중...</div>}
            {schools&&<>
              {schoolJudge&&<Alert type={schoolJudge.status}>{schoolJudge.msg}</Alert>}
              {schools.length>0&&<div style={{marginTop:10,maxHeight:200,overflowY:"auto"}}>{schools.slice(0,10).map((s,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 12px",background:s.distance<=200?"#fffbeb":"#fff",border:`1px solid ${s.distance<=50?"#fecaca":s.distance<=200?"#fde68a":C.border}`,borderRadius:6,marginBottom:4,fontSize:12}}><span>{s.name} <span style={{color:C.sub}}>({s.type})</span></span><span style={{fontWeight:700,color:s.distance<=50?"#dc2626":s.distance<=200?"#d97706":"#16a34a"}}>{s.distance}m</span></div>)}</div>}
            </>}
          </Section>

          {/* 3. 건축물대장 */}
          <Section title="3. 건축물대장" status={buildingJudge?.status==="error"?"warning":buildingJudge?.status||(step===4?"loading":"pending")} show={step>=4}>
            {step===4&&!building&&!buildingError&&<div style={{color:C.loading,fontSize:13}}>건축물대장 조회 중...</div>}
            {building&&buildingJudge&&<>
              {buildingJudge.bldNm&&<Row label="건물명" value={buildingJudge.bldNm}/>}
              <Row label="주용도" value={buildingJudge.purpose||"(정보 없음)"}/>
              {buildingJudge.etcPurps&&<Row label="기타용도" value={buildingJudge.etcPurps}/>}
              <Row label="연면적" value={buildingJudge.area?`${buildingJudge.area} ㎡`:"(정보 없음)"}/>
              {buildingJudge.platArea>0&&<Row label="대지면적" value={`${buildingJudge.platArea} ㎡`}/>}
              <Row label="구조" value={buildingJudge.structure||"(정보 없음)"}/>
              <Row label="층수" value={buildingJudge.floors||"(정보 없음)"}/>
              <Row label="사용승인일" value={buildingJudge.approvalDate||"(정보 없음)"}/>
              {buildingJudge.bcRat>0&&<Row label="건폐율" value={`${buildingJudge.bcRat}%`}/>}
              {buildingJudge.vlRat>0&&<Row label="용적률" value={`${buildingJudge.vlRat}%`}/>}
              {buildingJudge.source&&buildingJudge.source!=="getBrBasisOulnInfo"&&<div style={{marginTop:6,fontSize:11,color:C.sub}}>* 기본개요 데이터 없음, {buildingJudge.source==="getBrRecapTitleInfo"?"총괄표제부":"표제부"}에서 조회</div>}
              <div style={{marginTop:10,padding:12,background:"#eff6ff",borderRadius:8,border:"1px solid #bfdbfe"}}><div style={{fontSize:14,fontWeight:700,color:"#1e40af"}}>용도변경 절차: {buildingJudge.changeType}</div></div>
              {spr&&<div style={{marginTop:10,padding:12,borderRadius:8,background:spr.st==="pass"?"#f0fdf4":spr.st==="warning"?"#fffbeb":"#fef2f2",border:`1px solid ${spr.st==="pass"?"#bbf7d0":spr.st==="warning"?"#fde68a":"#fecaca"}`}}>
                <div style={{fontSize:13,fontWeight:700,color:spr.st==="pass"?"#166534":spr.st==="warning"?"#92400e":"#991b1b"}}>소방설비: {spr.type} (연면적 {area}㎡ 기준)</div>
                <div style={{fontSize:12,color:C.sub,marginTop:4}}>{spr.desc}</div>
                <div style={{fontSize:11,color:C.sub,marginTop:2}}>근거: 소방시설법 시행령 별표4</div>
              </div>}
            </>}
            {buildingError&&<Alert type="warning">조회 실패: {buildingError}<br/>정부24(gov.kr)에서 직접 확인하세요.</Alert>}
          </Section>

          {/* 4. 소방/주차/임장 */}
          <Section title="4. 소방 / 주차 / 현장 확인" status={fSt} show={step>=5}>
            <Alert type="info">아래 항목은 현장 방문(임장) 시 직접 확인이 필요합니다. 관할 소방서 사전 상담을 권장합니다.</Alert>
            <div style={{marginTop:14}}>
              <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:8}}>소방시설</div>
              {[["sprinkler","간이스프링클러 설치 가능 여부"],["detector","자동화재탐지설비"],["alarm","비상방송/경보설비"],["extinguisher","소화기 (층마다)"],["exitSign","유도등/유도표지"],["emergencyLight","비상조명등"]].map(([k,l])=><Check key={k} label={l} checked={fc[k]} onChange={v=>setFc(c=>({...c,[k]:v}))}/>)}
            </div>
            <div style={{marginTop:14}}>
              <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:8}}>피난 / 방화</div>
              {[["corridorWidth","복도 폭 1.8m 이상 (양측 거실 기준)"],["evacuationStairs","피난계단 확보 (3층 이상)"],["fireCompartment","방화구획 가능 여부"]].map(([k,l])=><Check key={k} label={l} checked={fc[k]} onChange={v=>setFc(c=>({...c,[k]:v}))}/>)}
            </div>
            <div style={{marginTop:14}}>
              <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:8}}>현장 확인 (임장)</div>
              <Check label="인접 대지 이격거리 1.5m 이상 (창문이 있는 면)" checked={fc.setback15m} onChange={v=>setFc(c=>({...c,setback15m:v}))}/>
              {!fc.setback15m&&<div style={{marginLeft:4,marginBottom:8}}>
                <div style={{fontSize:11,color:C.sub,marginBottom:4}}>* 불가 시 해결방안 메모:</div>
                <textarea value={fc.setbackMemo} onChange={e=>setFc(c=>({...c,setbackMemo:e.target.value}))} placeholder="예: 창문 폐쇄, 불투명 유리 교체, 이격거리 확보 방안 등" style={{width:"100%",minHeight:50,padding:10,borderRadius:6,border:`1px solid ${C.border}`,fontSize:12,fontFamily:"inherit",outline:"none",resize:"vertical",background:"#fff",boxSizing:"border-box"}}/>
              </div>}
              <Check label="건물 출입구 폭 확인 (피난 동선)" checked={fc.entryWidth} onChange={v=>setFc(c=>({...c,entryWidth:v}))}/>
              <Check label="주변 소음/유흥시설 확인" checked={fc.noiseCheck} onChange={v=>setFc(c=>({...c,noiseCheck:v}))}/>
              <Check label="급수/배수 상태 확인" checked={fc.plumbingCheck} onChange={v=>setFc(c=>({...c,plumbingCheck:v}))}/>
            </div>
            {area>0&&<div style={{marginTop:16}}>
              <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:8}}>부설주차장</div>
              <div style={{display:"flex",justifyContent:"space-between",padding:"12px 16px",background:"#eff6ff",borderRadius:8,border:"1px solid #bfdbfe"}}><span style={{fontSize:13,color:"#1e40af"}}>필요 주차대수 (서울, 134㎡당 1대)</span><span style={{fontSize:20,fontWeight:800,color:"#2563eb"}}>{pkReq}대</span></div>
              <div style={{fontSize:11,color:C.sub,marginTop:6}}>* 사용승인 후 5년 + 연면적 1,000㎡ 미만이면 면제 가능</div>
            </div>}
          </Section>

          {/* ── Phase 2 ──────────────────────────────────────── */}

          {/* 5. 객실 배치 시나리오 */}
          <Section title="5. 객실 배치 시나리오" status={step>=5&&area>0?"pass":"pending"} show={step>=5&&area>0}>
            <div style={{fontSize:12,color:C.sub,marginBottom:10}}>사용가능면적 = 연면적 {area}㎡ × 65% = <strong>{Math.round(usableArea)}㎡</strong> (도미토리 4㎡/침대, 프라이빗 12㎡/객실 기준)</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
              {scenarios.map((s, i) => (
                <div key={i} onClick={()=>setP2(p=>({...p,scenario:i}))} style={{padding:14,borderRadius:10,border:`2px solid ${p2.scenario===i?"#2563eb":"#e2e8f0"}`,background:p2.scenario===i?"#eff6ff":"#f8fafc",cursor:"pointer"}}>
                  <div style={{fontSize:13,fontWeight:700,color:p2.scenario===i?"#1e40af":C.text,marginBottom:4}}>{s.name}</div>
                  <div style={{fontSize:11,color:C.sub,marginBottom:8}}>{s.desc}</div>
                  <div style={{fontSize:13,color:C.text}}>침대 <strong style={{color:"#2563eb"}}>{s.dormBeds}개</strong></div>
                  <div style={{fontSize:13,color:C.text}}>객실 <strong style={{color:"#7c3aed"}}>{s.privateRooms}실</strong></div>
                </div>
              ))}
            </div>
          </Section>

          {/* 6. 매출 시뮬레이션 */}
          <Section title="6. 매출 시뮬레이션" status={step>=5&&area>0?"pass":"pending"} show={step>=5&&area>0}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
              <div>
                <div style={{fontSize:12,color:C.sub,marginBottom:4}}>도미토리 가격 (원/박)</div>
                <input type="number" value={p2.dormPrice} onChange={e=>setP2(p=>({...p,dormPrice:parseInt(e.target.value)||0}))} style={{width:"100%",padding:"8px 12px",borderRadius:6,border:`1px solid ${C.border}`,fontSize:14,fontWeight:600,color:C.text,background:"#fff",outline:"none",boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:12,color:C.sub,marginBottom:4}}>프라이빗 객실 가격 (원/박)</div>
                <input type="number" value={p2.privatePrice} onChange={e=>setP2(p=>({...p,privatePrice:parseInt(e.target.value)||0}))} style={{width:"100%",padding:"8px 12px",borderRadius:6,border:`1px solid ${C.border}`,fontSize:14,fontWeight:600,color:C.text,background:"#fff",outline:"none",boxSizing:"border-box"}}/>
              </div>
            </div>
            <div style={{marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontSize:12,color:C.sub}}>예약률</span><span style={{fontSize:14,fontWeight:700,color:"#2563eb"}}>{p2.occupancy}%</span></div>
              <input type="range" min={50} max={90} step={5} value={p2.occupancy} onChange={e=>setP2(p=>({...p,occupancy:parseInt(e.target.value)}))} style={{width:"100%",accentColor:"#2563eb"}}/>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:C.sub}}><span>50%</span><span>70%</span><span>90%</span></div>
            </div>
            <div style={{padding:"14px 18px",background:"#f0fdf4",borderRadius:8,border:"1px solid #bbf7d0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:12,color:"#166534",marginBottom:2}}>월 예상 매출 ({sel?.name}, 예약률 {p2.occupancy}%)</div>
                <div style={{fontSize:11,color:"#166534"}}>도미토리 {sel?.dormBeds}침대 × {fmt(p2.dormPrice)}원 + 프라이빗 {sel?.privateRooms}실 × {fmt(p2.privatePrice)}원</div>
              </div>
              <div style={{fontSize:24,fontWeight:800,color:"#16a34a"}}>{fmt(monthlyRevenue)}원</div>
            </div>
          </Section>

          {/* 7. 수익성 분석 */}
          <Section title="7. 수익성 분석" status={step>=5&&area>0?(monthlyNet>0?"pass":"warning"):"pending"} show={step>=5&&area>0}>
            <div style={{marginBottom:14}}>
              <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:8}}>초기 투자비</div>
              <div style={{padding:"10px 14px",background:"#f8fafc",borderRadius:8,border:`1px solid ${C.border}`,marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:12,color:C.sub}}>스프링클러 (자동반영)</span><span style={{fontSize:13,fontWeight:600,color:sprCost>0?"#d97706":"#16a34a"}}>{sprCost>0?`${fmt(sprCost)}원`:"해당없음"}</span></div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div>
                  <div style={{fontSize:12,color:C.sub,marginBottom:4}}>인테리어 공사비 (원)</div>
                  <input type="number" value={p2.interior} onChange={e=>setP2(p=>({...p,interior:parseInt(e.target.value)||0}))} placeholder="예: 30000000" style={{width:"100%",padding:"8px 12px",borderRadius:6,border:`1px solid ${C.border}`,fontSize:13,color:C.text,background:"#fff",outline:"none",boxSizing:"border-box"}}/>
                </div>
                <div>
                  <div style={{fontSize:12,color:C.sub,marginBottom:4}}>가구/침구 구입비 (원)</div>
                  <input type="number" value={p2.furniture} onChange={e=>setP2(p=>({...p,furniture:parseInt(e.target.value)||0}))} placeholder="예: 10000000" style={{width:"100%",padding:"8px 12px",borderRadius:6,border:`1px solid ${C.border}`,fontSize:13,color:C.text,background:"#fff",outline:"none",boxSizing:"border-box"}}/>
                </div>
              </div>
              <div style={{marginTop:8,padding:"10px 14px",background:"#eff6ff",borderRadius:8,border:"1px solid #bfdbfe",display:"flex",justifyContent:"space-between"}}><span style={{fontSize:13,color:"#1e40af"}}>총 초기 투자비</span><span style={{fontSize:16,fontWeight:800,color:"#2563eb"}}>{fmt(totalInitial)}원</span></div>
            </div>
            <div style={{marginBottom:14}}>
              <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:8}}>월 운영비</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                {[["rent","임차료"],["labor","인건비"],["utilities","공과금"]].map(([k,l])=>(
                  <div key={k}>
                    <div style={{fontSize:12,color:C.sub,marginBottom:4}}>{l} (원/월)</div>
                    <input type="number" value={p2[k]} onChange={e=>setP2(p=>({...p,[k]:parseInt(e.target.value)||0}))} placeholder="0" style={{width:"100%",padding:"8px 12px",borderRadius:6,border:`1px solid ${C.border}`,fontSize:13,color:C.text,background:"#fff",outline:"none",boxSizing:"border-box"}}/>
                  </div>
                ))}
              </div>
              <div style={{marginTop:8,padding:"10px 14px",background:"#fef9c3",borderRadius:8,border:"1px solid #fde68a",display:"flex",justifyContent:"space-between"}}><span style={{fontSize:13,color:"#92400e"}}>총 월 운영비</span><span style={{fontSize:16,fontWeight:800,color:"#a16207"}}>{fmt(monthlyOps)}원</span></div>
            </div>
            <div style={{padding:"18px 20px",borderRadius:10,background:monthlyNet>0?"#f0fdf4":"#fef2f2",border:`2px solid ${monthlyNet>0?"#86efac":"#fecaca"}`}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                <span style={{fontSize:14,fontWeight:700,color:monthlyNet>0?"#166534":"#991b1b"}}>월 순수익</span>
                <span style={{fontSize:22,fontWeight:800,color:monthlyNet>0?"#16a34a":"#dc2626"}}>{monthlyNet>=0?"+":""}{fmt(monthlyNet)}원</span>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:C.sub,borderTop:`1px solid ${monthlyNet>0?"#bbf7d0":"#fecaca"}`,paddingTop:8}}>
                <span>투자회수기간</span>
                <span style={{fontWeight:700,color:C.text}}>{roiMonths ? `${roiMonths}개월 (${(roiMonths/12).toFixed(1)}년)` : totalInitial===0 ? "초기 투자 없음" : "수익 미발생 시 산출 불가"}</span>
              </div>
            </div>
          </Section>
        </div>}

        {step>=5&&geo&&<div style={{textAlign:"center",padding:"16px 0"}}><button onClick={()=>downloadPNG(printRef.current,`호스텔검토_${geo.dong||"결과"}_${new Date().toISOString().slice(0,10)}.png`)} style={{padding:"12px 32px",borderRadius:8,border:`1px solid ${C.border}`,background:"#fff",color:C.text,fontSize:14,fontWeight:600,cursor:"pointer"}}>결과 이미지 저장 (PNG)</button></div>}

        {step===0&&!error&&<div style={{textAlign:"center",padding:"80px 20px",color:C.sub}}><div style={{fontSize:16,fontWeight:600,marginBottom:8,color:C.text}}>주소를 입력하고 Enter를 누르세요</div><div style={{fontSize:13}}>용도지역, 학교정화구역, 건축물대장을 자동으로 검토합니다</div></div>}
        {step>=5&&<div style={{textAlign:"center",padding:"12px 0",color:C.sub,fontSize:12}}>* 이 결과는 1차 검토용이며, 최종 판단은 관할 구청 건축과 및 전문가 상담이 필요합니다.</div>}
      </div>
    </div>
  );
}
