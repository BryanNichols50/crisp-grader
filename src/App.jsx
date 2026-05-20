import { useState, useRef, useCallback, Fragment } from "react";

const BENCHMARKS = {
  C:  { top20: 80,  avg: 62.69 },
  RI: { top20: 75,  avg: 55.87 },
  S:  { top20: 45,  avg: 31.25 },
  P:  { top20: 100, avg: 43.64 },
};

function benchmarkStatus(pct, key) {
  const b = BENCHMARKS[key];
  if (!b) return { color:"#6b7280", bg:"#f3f4f6", label:"" };
  if (pct >= b.top20) return { color:"#166534", bg:"#dcfce7", label:"Above top 20%" };
  if (pct >= b.avg)   return { color:"#713f12", bg:"#fef9c3", label:"Above avg" };
  return { color:"#991b1b", bg:"#fef2f2", label:"Below avg" };
}

// ── CRISP grading prompt ─────────────────────────────────────────────────────
const CRISP_PROMPT = `You are a BDC call quality coach for Hendrick Honda Charlotte. Grade each SALES call on the CRISP framework.

CALL DIRECTION RULES:
- INCOMING: Grade full CRISP (Connect, Request/Invite, Set, Objection Handling, Pursue)
- OUTGOING: Weight heavily on Pursue (Statement of Purpose, Anchor, Call to Action, outcome)

SCORING 100 pts total:
1. C CONNECT (0-20): professional greeting, gathered name+contact. N/A=10.
2. RI REQUEST+INVITE (0-30): requested appt (0/15) + invited test drive (0/10) + offered alternative (0/5). N/A=15.
3. S SET (0-25): specific date+time (0/12) + Whittle+Shepherd (0/5) + verbal contract (0/5) + painted picture (0/3). N/A=12.
4. OBJECTION HANDLING (0-15): Transition/Disrupt/Ask, Feel/Felt/Found, Onion. No objections=12.
5. P PURSUE (0-10): confirmed next step. Outbound: Statement of Purpose + Anchor + CTA.

GRADE: A=90-100, B=75-89, C=60-74, D=45-59, F<45

CHECKS (true/false): gatheredContact, requestedAppt, invitedTestDrive, setSpecificTime, offeredAlternative, usedWhittleShepherd, securedVerbalContract, handledObjection, paintedThePicture, apptSet

FOLLOW-UP FLAG — when in doubt, escalate:
TODAY: agent promised callback no appt / strong buying intent no commitment / agent dropped ball on engaged customer / customer ready to buy but agent failed to close
THIS_WEEK: vehicle unavailable still interested / soft appt no verbal contract / promised info no confirmed next step / financing or trade not resolved
MONITOR: some interest no urgency / inquiry with conversion potential / customer may return
NONE: appointment confirmed with verbal contract / no answer voicemail / not interested / service/parts only

followUpReason: one sentence why (or "None needed.")
crispGap: biggest missed CRISP step in one sentence
strengths: one sentence on what the agent did well
coaching: one specific actionable tip the agent can use on the next call`;

// ── S2S scoring prompt ────────────────────────────────────────────────────────
const S2S_PROMPT = `You are a service-to-sales conversion specialist for Hendrick Honda Charlotte. Score each SERVICE call for S2S conversion potential.

RED ALERT (score=100, redAlert=true) — ANY ONE triggers:
- Customer mentions wanting to trade in, buy different vehicle, or asks about new cars
- Customer compares repair cost to a payment ("is it even worth fixing?")
- High repair estimate AND customer expresses hesitation or frustration about fixing it
- Customer asks about inventory while in for service

S2S SCORING (0-100 pts, ORANGE threshold = 35+):
- highRepair: repair estimate ≥$1,500 mentioned → 35 pts
- highMileage: 100k+ miles mentioned → 20 pts; 80-99k → 12 pts
- repeatIssue: same problem recurring, "again", "third time" → 10 pts
- frustration: customer frustrated, fed up, "not worth it" → 7 pts
- olderVehicle: vehicle 2018 or older → 7 pts
- financingAsk: asks about payments, financing, monthly cost → 7 pts
- lifeEvent: new job, moving, growing family, kid driving → 7 pts
- frequentFlyer: 3rd+ visit this year, always coming in → 7 pts

s2sTier: "RED" if redAlert, "ORANGE" if score≥35, "NONE" otherwise
s2sOpener: Personalized BDC opener using details from the recap. Soft relationship tone. One or two sentences referencing the specific vehicle or service issue. Never cold pitch.`;

function cleanStr(s) { return (s||"").replace(/[\r\n\t]+/g," ").replace(/\s+/g," ").trim(); }

function getDept(row, cm) {
  const l4 = (row["Label4"]||row["label4"]||"").toLowerCase();
  const l1 = (row[cm.calltype]||row["Label1"]||"").toLowerCase();
  if (/service/i.test(l4)||/service/i.test(l1)) return "service";
  if (/parts/i.test(l4)||/parts/i.test(l1)) return "service";
  if (/bdc/i.test(l4)) return "bdc";
  if (/sales/i.test(l4)||/sales/i.test(l1)) return "sales";
  return "sales";
}

function detectDirection(row, cm) {
  const ct   = (row[cm.calltype]||"").toLowerCase();
  const l1   = (row["Label1"]||row["label1"]||"").toLowerCase();
  const disp = (row[cm.disposition]||"").toLowerCase();
  if (/outbound/i.test(ct)||/outbound/i.test(l1)) return "outgoing";
  if (/pursue|follow.?up|callback|out.?going/i.test(ct)) return "outgoing";
  if (/outbound/i.test(disp)) return "outgoing";
  return "incoming";
}

function detectCols(headers) {
  const l = headers.map(h => h.toLowerCase());
  const f = ps => { for (const p of ps) { const i = l.findIndex(h => h.includes(p)); if (i >= 0) return headers[i]; } return ""; };
  return {
    agent:       f(["phone code reference","agent","rep name","rep"]),
    date:        f(["date_time","date"]),
    duration:    f(["call duration","duration"]),
    recap:       f(["call recap","call_recap","recap","transcript","summary","notes"]),
    disposition: f(["disposition","outcome"]),
    calltype:    f(["label1","call_type","call type"]),
    customer:    f(["caller name","customer_name","customer name"]),
    phone:       f(["caller_phone","customer_number","customer number","phone"]),
    time:        f(["time"]),
  };
}

function sc(s) { if(s>=90)return"#16a34a"; if(s>=75)return"#65a30d"; if(s>=60)return"#d97706"; if(s>=45)return"#ea580c"; return"#dc2626"; }
function sg(s) { return s>=90?"A":s>=75?"B":s>=60?"C":s>=45?"D":"F"; }

const FLAG = {
  TODAY:     { label:"Today",     bg:"#fef2f2", color:"#991b1b", border:"#fca5a5", e:"🔴" },
  THIS_WEEK: { label:"This week", bg:"#fffbeb", color:"#78350f", border:"#fcd34d", e:"🟡" },
  MONITOR:   { label:"Monitor",   bg:"#f9fafb", color:"#4b5563", border:"#e5e7eb", e:"⚪" },
  NONE:      { label:"Done",      bg:"#f0fdf4", color:"#166534", border:"#bbf7d0", e:"✅" },
};

const NA_PATTERN = /no answer|voicemail|wrong number|not connected|caller hung up|missed|hung up|busy|disconnected|spam/i;

// ── API calls ─────────────────────────────────────────────────────────────────
async function callAPI(prompt, maxTokens=2000) {
  const res = await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:maxTokens,messages:[{role:"user",content:prompt}]})
  });
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const raw = data.content[0].text.replace(/```json|```/gi,"").trim();
  const s=raw.indexOf("["),e=raw.lastIndexOf("]");
  if(s<0||e<0) throw new Error("No JSON array");
  return JSON.parse(raw.slice(s,e+1));
}

async function gradeOneBatch(rows, cm) {
  const calls = rows.map((r,i) =>
    `CALL ${i+1} [${detectDirection(r,cm).toUpperCase()}]\nAgent: ${cleanStr(r[cm.agent])||"Unknown"}\nDuration: ${r[cm.duration]||"?"}\nCall Type: ${r[cm.calltype]||""}\nDisposition: ${r[cm.disposition]||""}\nRecap: ${(r[cm.recap]||"No recap").slice(0,600)}`
  ).join("\n\n—\n\n");
  const prompt = `${CRISP_PROMPT}\n\n${calls}\n\nReturn ONLY a JSON array of exactly ${rows.length} objects:\n[{"cScore":0,"riScore":0,"sScore":0,"ohScore":0,"pScore":0,"total":0,"grade":"B","gatheredContact":false,"requestedAppt":false,"invitedTestDrive":false,"setSpecificTime":false,"offeredAlternative":false,"usedWhittleShepherd":false,"securedVerbalContract":false,"handledObjection":false,"paintedThePicture":false,"apptSet":false,"strengths":"...","coaching":"...","crispGap":"...","followUpFlag":"NONE","followUpReason":"None needed."}]`;
  const parsed = await callAPI(prompt, 2000);
  if(!Array.isArray(parsed)||parsed.length!==rows.length) throw new Error("Length mismatch");
  return parsed;
}

async function gradeS2SBatch(rows, cm) {
  const calls = rows.map((r,i) =>
    `CALL ${i+1}\nAgent: ${cleanStr(r[cm.agent])||"Unknown"}\nCustomer: ${cleanStr(r[cm.customer])||"Unknown"}\nDuration: ${r[cm.duration]||"?"}\nDisposition: ${r[cm.disposition]||""}\nRecap: ${(r[cm.recap]||"No recap").slice(0,600)}`
  ).join("\n\n—\n\n");
  const prompt = `${S2S_PROMPT}\n\n${calls}\n\nReturn ONLY a JSON array of exactly ${rows.length} objects:\n[{"s2sScore":0,"s2sTier":"NONE","redAlert":false,"redReason":"","highRepair":false,"highMileage":false,"repeatIssue":false,"frustration":false,"olderVehicle":false,"financingAsk":false,"lifeEvent":false,"frequentFlyer":false,"s2sReason":"...","s2sOpener":"..."}]`;
  const parsed = await callAPI(prompt, 2000);
  if(!Array.isArray(parsed)||parsed.length!==rows.length) throw new Error("Length mismatch");
  return parsed;
}

function fallback(n){return Array.from({length:n},()=>({cScore:0,riScore:0,sScore:0,ohScore:0,pScore:0,total:0,grade:"F",gatheredContact:false,requestedAppt:false,invitedTestDrive:false,setSpecificTime:false,offeredAlternative:false,usedWhittleShepherd:false,securedVerbalContract:false,handledObjection:false,paintedThePicture:false,apptSet:false,strengths:"Error.",coaching:"Review manually.",crispGap:"Unknown.",followUpFlag:"NONE",followUpReason:"Grading error."}));}
function s2sFallback(n){return Array.from({length:n},()=>({s2sScore:0,s2sTier:"NONE",redAlert:false,redReason:"",highRepair:false,highMileage:false,repeatIssue:false,frustration:false,olderVehicle:false,financingAsk:false,lifeEvent:false,frequentFlyer:false,s2sReason:"Scoring error.",s2sOpener:""}));}

// ── UI components ─────────────────────────────────────────────────────────────
function GradeBadge({grade}){
  const map={A:["#dcfce7","#166534"],B:["#d9f99d","#365314"],C:["#fef9c3","#713f12"],D:["#ffedd5","#7c2d12"],F:["#fee2e2","#7f1d1d"]};
  const[bg,col]=map[grade]||map.F;
  return <span style={{background:bg,color:col,borderRadius:"50%",width:24,height:24,display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700}}>{grade}</span>;
}
function FlagBadge({flag}){
  if(!flag||flag==="NONE") return <span style={{color:"#d1d5db",fontSize:11}}>—</span>;
  const c=FLAG[flag]||FLAG.NONE;
  return <span style={{background:c.bg,color:c.color,border:`0.5px solid ${c.border}`,borderRadius:20,padding:"1px 7px",fontSize:10,fontWeight:600,whiteSpace:"nowrap"}}>{c.e} {c.label}</span>;
}
function MiniBar({value,max=100,color,height=3}){
  return <div style={{height,background:"#e5e7eb",borderRadius:2,overflow:"hidden",marginTop:2}}><div style={{height:"100%",width:`${Math.min((value/max)*100,100)}%`,background:color||sc(value),borderRadius:2}}/></div>;
}
function DirBadge({dir}){
  const cfg=dir==="incoming"?{bg:"#dbeafe",color:"#1e40af"}:{bg:"#fce7f3",color:"#9d174d"};
  return <span style={{...cfg,borderRadius:10,padding:"1px 7px",fontSize:10,fontWeight:500}}>{dir}</span>;
}
function DeptBadge({dept}){
  const map={sales:{bg:"#dcfce7",color:"#166534"},bdc:{bg:"#dbeafe",color:"#1e40af"},service:{bg:"#fef9c3",color:"#713f12"}};
  const c=map[dept]||map.sales;
  return <span style={{...c,borderRadius:10,padding:"1px 7px",fontSize:10,fontWeight:500}}>{dept}</span>;
}

function CallRow({c,colSpan=9,expanded,onToggle}){
  const g=c._g;
  const isOpen=expanded===c._id;
  const fc=FLAG[g.followUpFlag]||FLAG.NONE;
  const rowBg=g.followUpFlag==="TODAY"?"#fff9f9":g.followUpFlag==="THIS_WEEK"?"#fffdf5":"transparent";
  return (
    <Fragment>
      <tr onClick={()=>onToggle(c._id)} style={{borderBottom:"0.5px solid #f3f4f6",cursor:"pointer",background:rowBg}}>
        <td style={{padding:"6px 8px",fontSize:10,color:"#6b7280",whiteSpace:"nowrap"}}>{(c._date||"").slice(0,10)}</td>
        {colSpan===13&&<td style={{padding:"6px 8px",fontWeight:500,maxWidth:90,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c._agent}</td>}
        <td style={{padding:"6px 8px",maxWidth:110,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c._customer&&c._customer!=="Unknown"?c._customer:<span style={{color:"#9ca3af",fontFamily:"monospace",fontSize:11}}>{c._phone||"—"}</span>}</td>
        <td style={{padding:"6px 8px"}}><DirBadge dir={c._dir}/></td>
        <td style={{padding:"6px 8px",minWidth:70}}><strong style={{color:sc(g.total)}}>{g.total}</strong><MiniBar value={g.total} color={sc(g.total)}/></td>
        {colSpan===13&&<>
          <td style={{padding:"6px 8px",color:sc((g.cScore/20)*100)}}>{g.cScore}</td>
          <td style={{padding:"6px 8px",color:sc((g.riScore/30)*100)}}>{g.riScore}</td>
          <td style={{padding:"6px 8px",color:sc((g.sScore/25)*100)}}>{g.sScore}</td>
          <td style={{padding:"6px 8px",color:sc((g.ohScore/15)*100)}}>{g.ohScore}</td>
          <td style={{padding:"6px 8px",color:sc((g.pScore/10)*100)}}>{g.pScore}</td>
        </>}
        <td style={{padding:"6px 8px",textAlign:"center"}}>{g.apptSet?<span style={{color:"#16a34a"}}>✓</span>:<span style={{color:"#d1d5db"}}>—</span>}</td>
        <td style={{padding:"6px 8px"}}><FlagBadge flag={g.followUpFlag}/></td>
        <td style={{padding:"6px 8px"}}><GradeBadge grade={g.grade}/></td>
        <td style={{padding:"6px 8px",color:"#9ca3af",fontSize:10}}>{isOpen?"▲":"▼"}</td>
      </tr>
      {isOpen&&(
        <tr style={{background:"#f9fafb"}}>
          <td colSpan={colSpan} style={{padding:"10px 12px"}}>
            {g.followUpFlag!=="NONE"&&<div style={{background:fc.bg,border:`0.5px solid ${fc.border}`,borderRadius:5,padding:"5px 10px",marginBottom:6,fontSize:11,color:fc.color}}><strong>{fc.e} {fc.label}:</strong> {g.followUpReason}</div>}
            {g.crispGap&&<div style={{background:"#fffbeb",border:"0.5px solid #fcd34d",borderRadius:5,padding:"5px 10px",marginBottom:6,fontSize:11,color:"#78350f"}}><strong>Gap:</strong> {g.crispGap}</div>}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,fontSize:11}}>
              <div><strong style={{color:"#16a34a"}}>Strength: </strong>{g.strengths}</div>
              <div><strong style={{color:"#d97706"}}>Coach: </strong>{g.coaching}</div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App(){
  const[screen,setScreen]=useState("upload");
  const[csvData,setCsvData]=useState([]);
  const[headers,setHeaders]=useState([]);
  const[cm,setCm]=useState({});
  const[limit,setLimit]=useState(9999);
  const[graded,setGraded]=useState([]);
  const[noAnswers,setNoAnswers]=useState([]);
  const[progress,setProgress]=useState({done:0,total:0,errors:0,status:""});
  const[dashTab,setDashTab]=useState("gm");
  const[selectedAgent,setSelectedAgent]=useState(null);
  const[deptFilter,setDeptFilter]=useState("sales");
  const[dirFilter,setDirFilter]=useState("all");
  const[gradeFilter,setGradeFilter]=useState("");
  const[flagFilter,setFlagFilter]=useState("");
  const[expanded,setExpanded]=useState(null);
  const[dragging,setDragging]=useState(false);
  const fileRef=useRef();

  const parseCSV=useCallback((file)=>{
    const reader=new FileReader();
    reader.onload=(e)=>{
      const text=e.target.result;
      const lines=text.split(/\r?\n/).filter(Boolean);
      if(!lines.length) return;
      const parseRow=(line)=>{const cols=[];let cur="";let inQ=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ;}else if(ch===","&&!inQ){cols.push(cur);cur="";}else cur+=ch;}cols.push(cur);return cols;};
      const hs=parseRow(lines[0]);
      const rows=lines.slice(1).map(l=>{const vals=parseRow(l);return Object.fromEntries(hs.map((h,i)=>[h,vals[i]||""]));}).filter(r=>Object.values(r).some(v=>v));
      setHeaders(hs);setCsvData(rows);setCm(detectCols(hs));setScreen("mapping");
    };
    reader.readAsText(file);
  },[]);

  const handleDrop=useCallback((e)=>{e.preventDefault();setDragging(false);if(e.dataTransfer.files[0])parseCSV(e.dataTransfer.files[0]);},[parseCSV]);

  const startGrading=useCallback(async()=>{
    const raw=csvData.slice(0,limit);
    const naList=[],gradable=[];

    raw.forEach(row=>{
      const disp=row[cm.disposition]||"";
      const recap=row[cm.recap]||"";
      const dept=getDept(row,cm);
      const isNA=NA_PATTERN.test(disp)||(recap.length<30&&NA_PATTERN.test(disp))||(!recap.trim()&&!/(connected|answered)/i.test(disp));
      const agent=cleanStr(row[cm.agent])||"";
      if(!agent) return;
      if(isNA){
        naList.push({
          _id:naList.length+gradable.length,_agent:agent,
          _phone:row[cm.phone]||"",_customer:cleanStr(row[cm.customer])||"",
          _dir:detectDirection(row,cm),_dept:dept,_duration:row[cm.duration]||"",
          _date:row[cm.date]||"",_time:row[cm.time]||row[cm.date]||"",
          _disposition:disp,...row,
        });
      } else {
        gradable.push(row);
      }
    });

    const salesGradable=gradable.filter(r=>{const d=getDept(r,cm);return d==="sales"||d==="bdc";});
    const serviceGradable=gradable.filter(r=>getDept(r,cm)==="service");
    const totalGradable=salesGradable.length+serviceGradable.length;

    setNoAnswers(naList);
    setScreen("grading");
    setProgress({done:0,total:totalGradable,errors:0,status:`Skipped ${naList.length} no-answers. Grading ${salesGradable.length} sales + ${serviceGradable.length} service calls...`});

    const results=[];
    let errors=0;
    const BATCH=5;
    const CONCURRENCY=2;

    // ── CRISP grade sales calls ───────────────────────────────────────────────
    for(let i=0;i<salesGradable.length;i+=BATCH*CONCURRENCY){
      const chunks=[];
      for(let j=0;j<CONCURRENCY;j++){
        const start=i+j*BATCH;
        if(start<salesGradable.length) chunks.push(salesGradable.slice(start,Math.min(start+BATCH,salesGradable.length)));
      }
      setProgress({done:Math.min(i,salesGradable.length),total:totalGradable,errors,status:`CRISP grading sales ${i+1}–${Math.min(i+BATCH*CONCURRENCY,salesGradable.length)} of ${salesGradable.length}...`});
      const gradeResults=await Promise.all(chunks.map(async(chunk)=>{
        for(let attempt=0;attempt<3;attempt++){
          try{ return await gradeOneBatch(chunk,cm); }
          catch(e){ if(attempt===2){errors++;return fallback(chunk.length);} await new Promise(r=>setTimeout(r,1200*(attempt+1))); }
        }
        return fallback(chunk.length);
      }));
      chunks.forEach((chunk,ci)=>{
        const grades=gradeResults[ci];
        chunk.forEach((row,j)=>{
          const phone=row[cm.phone]||"";
          results.push({...row,_g:grades[j],_s2s:null,_id:results.length,_agent:cleanStr(row[cm.agent])||"Unknown",_dir:detectDirection(row,cm),_dept:getDept(row,cm),_customer:cleanStr(row[cm.customer])||phone||"Unknown",_duration:row[cm.duration]||"",_phone:phone,_date:row[cm.date]||"",_time:row[cm.time]||row[cm.date]||""});
        });
      });
    }

    // ── S2S score service calls ───────────────────────────────────────────────
    for(let i=0;i<serviceGradable.length;i+=BATCH*CONCURRENCY){
      const chunks=[];
      for(let j=0;j<CONCURRENCY;j++){
        const start=i+j*BATCH;
        if(start<serviceGradable.length) chunks.push(serviceGradable.slice(start,Math.min(start+BATCH,serviceGradable.length)));
      }
      setProgress({done:salesGradable.length+Math.min(i,serviceGradable.length),total:totalGradable,errors,status:`S2S scoring service ${i+1}–${Math.min(i+BATCH*CONCURRENCY,serviceGradable.length)} of ${serviceGradable.length}...`});
      const s2sResults=await Promise.all(chunks.map(async(chunk)=>{
        for(let attempt=0;attempt<3;attempt++){
          try{ return await gradeS2SBatch(chunk,cm); }
          catch(e){ if(attempt===2){errors++;return s2sFallback(chunk.length);} await new Promise(r=>setTimeout(r,1200*(attempt+1))); }
        }
        return s2sFallback(chunk.length);
      }));
      chunks.forEach((chunk,ci)=>{
        const s2s=s2sResults[ci];
        chunk.forEach((row,j)=>{
          const phone=row[cm.phone]||"";
          const nullG={cScore:0,riScore:0,sScore:0,ohScore:0,pScore:0,total:0,grade:"—",gatheredContact:false,requestedAppt:false,invitedTestDrive:false,setSpecificTime:false,offeredAlternative:false,usedWhittleShepherd:false,securedVerbalContract:false,handledObjection:false,paintedThePicture:false,apptSet:false,strengths:"",coaching:"",crispGap:"",followUpFlag:"NONE",followUpReason:""};
          results.push({...row,_g:nullG,_s2s:s2s[j],_id:results.length,_agent:cleanStr(row[cm.agent])||"Unknown",_dir:detectDirection(row,cm),_dept:"service",_customer:cleanStr(row[cm.customer])||phone||"Unknown",_duration:row[cm.duration]||"",_phone:phone,_date:row[cm.date]||"",_time:row[cm.time]||row[cm.date]||""});
        });
      });
    }

    setGraded(results);
    setProgress({done:totalGradable,total:totalGradable,errors,status:`Done! ${salesGradable.length} CRISP + ${serviceGradable.length} S2S + ${naList.length} no-answers.`});
    setScreen("dashboard");
    setDashTab("gm");
  },[csvData,limit,cm]);

  // ── Derived data ──────────────────────────────────────────────────────────
  const salesCalls=graded.filter(c=>c._dept==="sales"||c._dept==="bdc");
  const serviceCalls=graded.filter(c=>c._dept==="service");
  const viewCalls=deptFilter==="service"?serviceCalls:salesCalls;

  const redAlerts=serviceCalls.filter(c=>c._s2s?.redAlert);
  const orangeLeads=serviceCalls.filter(c=>!c._s2s?.redAlert&&c._s2s?.s2sTier==="ORANGE").sort((a,b)=>(b._s2s?.s2sScore||0)-(a._s2s?.s2sScore||0));

  const agentMap={};
  viewCalls.forEach(c=>{
    const a=c._agent;
    if(!agentMap[a])agentMap[a]={calls:0,tot:0,apts:0,today:0,week:0,inc:0,out:0,cTot:0,riTot:0,sTot:0,ohTot:0,pTot:0};
    agentMap[a].calls++;agentMap[a].tot+=c._g.total||0;
    if(c._g.apptSet)agentMap[a].apts++;
    if(c._g.followUpFlag==="TODAY")agentMap[a].today++;
    if(c._g.followUpFlag==="THIS_WEEK")agentMap[a].week++;
    if(c._dir==="incoming")agentMap[a].inc++;else agentMap[a].out++;
    agentMap[a].cTot+=c._g.cScore||0;agentMap[a].riTot+=c._g.riScore||0;
    agentMap[a].sTot+=c._g.sScore||0;agentMap[a].ohTot+=c._g.ohScore||0;agentMap[a].pTot+=c._g.pScore||0;
  });

  const leaderboard=Object.entries(agentMap).map(([n,d])=>({
    n,calls:d.calls,avg:d.calls?Math.round(d.tot/d.calls):0,aptPct:d.calls?Math.round((d.apts/d.calls)*100):0,
    today:d.today,week:d.week,inc:d.inc,out:d.out,
    avgC:d.calls?Math.round(d.cTot/d.calls):0,avgRI:d.calls?Math.round(d.riTot/d.calls):0,
    avgS:d.calls?Math.round(d.sTot/d.calls):0,avgOH:d.calls?Math.round(d.ohTot/d.calls):0,avgP:d.calls?Math.round(d.pTot/d.calls):0,
  })).sort((a,b)=>b.avg-a.avg);

  const agents=[...new Set(viewCalls.map(c=>c._agent))].filter(Boolean).sort();
  const n=viewCalls.length;
  const teamAvg=n?Math.round(viewCalls.reduce((s,c)=>s+c._g.total,0)/n):0;
  const teamApt=n?Math.round((viewCalls.filter(c=>c._g.apptSet).length/n)*100):0;
  const todayCount=viewCalls.filter(c=>c._g.followUpFlag==="TODAY").length;
  const weekCount=viewCalls.filter(c=>c._g.followUpFlag==="THIS_WEEK").length;
  const topAgent=leaderboard[0];
  const dateStr=graded[0]?._date?.slice(0,15)||new Date().toLocaleDateString();

  const filteredCalls=viewCalls.filter(c=>{
    if(dirFilter!=="all"&&c._dir!==dirFilter)return false;
    if(gradeFilter&&c._g.grade!==gradeFilter)return false;
    if(flagFilter&&c._g.followUpFlag!==flagFilter)return false;
    return true;
  });

  const toggleExpand=useCallback((id)=>setExpanded(prev=>prev===id?null:id),[]);
  const exportCSV=(calls,name)=>{
    const hs=["Date","Time","Agent","Dept","Dir","Customer","Phone","Duration","Grade","Score","C","RI","S","OH","P","Appt","Flag","Reason","Gap","Coaching"];
    const esc=v=>`"${String(v??"").replace(/"/g,'""')}"`;
    const csv=[hs.join(","),...calls.map(c=>[c._date,c._time,c._agent,c._dept,c._dir,c._customer,c._phone,c._duration,c._g.grade,c._g.total,c._g.cScore,c._g.riScore,c._g.sScore,c._g.ohScore,c._g.pScore,c._g.apptSet?"Yes":"No",c._g.followUpFlag,c._g.followUpReason,c._g.crispGap,c._g.coaching].map(esc).join(","))].join("\n");
    const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download=`CRISP_${name}.csv`;a.click();
  };

  // ── Styles ────────────────────────────────────────────────────────────────
  const S={fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,color:"#111",minHeight:"100vh",background:"#f8f9fa"};
  const card={background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:10,padding:"12px 16px"};
  const btn={background:"#fff",border:"0.5px solid #d1d5db",borderRadius:7,padding:"6px 12px",fontSize:12,cursor:"pointer",fontWeight:500,color:"#111",display:"inline-flex",alignItems:"center",gap:4};
  const btnP={...btn,background:"#111",color:"#fff",border:"none"};
  const btnSm={...btn,padding:"4px 10px",fontSize:11};
  const sel={background:"#fff",border:"0.5px solid #d1d5db",borderRadius:7,padding:"4px 8px",fontSize:12,color:"#111",cursor:"pointer"};
  const tabS=(active)=>({padding:"8px 14px",fontSize:12,fontWeight:active?600:400,cursor:"pointer",border:"none",background:"none",borderBottom:active?"2px solid #111":"2px solid transparent",color:active?"#111":"#6b7280",whiteSpace:"nowrap"});
  const th={padding:"7px 8px",textAlign:"left",fontWeight:600,fontSize:10,color:"#6b7280",borderBottom:"0.5px solid #e5e7eb",whiteSpace:"nowrap"};

  // ── UPLOAD ────────────────────────────────────────────────────────────────
  if(screen==="upload") return (
    <div style={{...S,display:"flex",alignItems:"center",justifyContent:"center",padding:"2rem"}}>
      <div style={{maxWidth:480,width:"100%",textAlign:"center"}}>
        <div style={{fontSize:11,fontWeight:600,letterSpacing:"2px",color:"#6b7280",textTransform:"uppercase",marginBottom:6}}>Hendrick Honda Charlotte</div>
        <div style={{fontSize:22,fontWeight:700,marginBottom:4}}>CRISP Daily Coaching System</div>
        <div style={{fontSize:13,color:"#6b7280",marginBottom:20}}>Upload your CarWars CSV to grade every call, flag every missed opportunity, and surface every S2S lead.</div>
        <div style={{display:"flex",justifyContent:"center",gap:5,flexWrap:"wrap",marginBottom:24}}>
          {[["C","Connect","#1d4ed8"],["R+I","Request/Invite","#16a34a"],["S","Set","#0891b2"],["OH","Objections","#7c3aed"],["P","Pursue","#d97706"],["S2S","Service-to-Sales","#dc2626"]].map(([k,l,c])=>(
            <div key={k} style={{background:c,color:"#fff",borderRadius:6,padding:"3px 9px",fontSize:11,fontWeight:700}}>{k} <span style={{fontWeight:400,opacity:.9}}>{l}</span></div>
          ))}
        </div>
        <div onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={handleDrop} onClick={()=>fileRef.current.click()}
          style={{border:`1.5px dashed ${dragging?"#111":"#d1d5db"}`,borderRadius:12,padding:"40px 24px",cursor:"pointer",background:dragging?"#f0f0f0":"#fafafa",transition:"all .15s"}}>
          <div style={{fontSize:28,marginBottom:8}}>📂</div>
          <div style={{fontWeight:600,marginBottom:4}}>Drop CarWars CSV here</div>
          <div style={{fontSize:12,color:"#9ca3af"}}>or click to browse</div>
          <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>{if(e.target.files[0])parseCSV(e.target.files[0]);}}/>
        </div>
        <div style={{marginTop:12,fontSize:11,color:"#9ca3af"}}>Sales/BDC → CRISP graded · Service → S2S scored · No-answers auto-filtered</div>
      </div>
    </div>
  );

  // ── MAPPING ───────────────────────────────────────────────────────────────
  if(screen==="mapping") return (
    <div style={{...S,padding:"2rem",maxWidth:560,margin:"0 auto"}}>
      <div style={{fontSize:16,fontWeight:700,marginBottom:4}}>Confirm column mapping</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>{csvData.length} calls detected</div>
      <div style={card}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <tbody>
            {[{k:"agent",l:"Agent"},{k:"date",l:"Date"},{k:"duration",l:"Duration"},{k:"recap",l:"Call recap (required)"},{k:"disposition",l:"Disposition"},{k:"calltype",l:"Call type / dept"},{k:"customer",l:"Customer name"},{k:"phone",l:"Phone"},{k:"time",l:"Time of call"}].map(f=>(
              <tr key={f.k}>
                <td style={{padding:"5px 0",width:"42%",color:"#374151"}}>{f.l}</td>
                <td style={{padding:"5px 0"}}>
                  <select style={sel} value={cm[f.k]||""} onChange={e=>setCm(p=>({...p,[f.k]:e.target.value}))}>
                    <option value="">not mapped</option>
                    {headers.map(h=><option key={h} value={h}>{h}</option>)}
                  </select>
                </td>
                <td style={{padding:"5px 6px",fontSize:10,color:"#16a34a"}}>{cm[f.k]?"✓ auto":""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap",alignItems:"center"}}>
        <select style={sel} value={limit} onChange={e=>setLimit(parseInt(e.target.value))}>
          <option value={50}>Grade first 50</option><option value={100}>Grade first 100</option>
          <option value={200}>Grade first 200</option><option value={9999}>Grade ALL</option>
        </select>
        <button style={btnP} onClick={startGrading}>🤖 Grade calls</button>
        <button style={btn} onClick={()=>setScreen("upload")}>Back</button>
      </div>
    </div>
  );

  // ── GRADING ───────────────────────────────────────────────────────────────
  if(screen==="grading") return (
    <div style={{...S,display:"flex",alignItems:"center",justifyContent:"center",padding:"2rem"}}>
      <div style={{maxWidth:420,width:"100%",textAlign:"center"}}>
        <div style={{fontSize:32,marginBottom:12}}>🤖</div>
        <div style={{fontSize:16,fontWeight:700,marginBottom:4}}>Grading calls…</div>
        <div style={{fontSize:12,color:"#6b7280",marginBottom:8}}>{progress.status}</div>
        <div style={{height:6,background:"#e5e7eb",borderRadius:3,overflow:"hidden",margin:"12px 0"}}>
          <div style={{height:"100%",width:`${progress.total?(progress.done/progress.total)*100:0}%`,background:"#111",borderRadius:3,transition:"width .3s"}}/>
        </div>
        <div style={{fontSize:12,color:"#9ca3af"}}>{progress.done} / {progress.total}</div>
        {progress.errors>0&&<div style={{fontSize:11,color:"#dc2626",marginTop:6}}>{progress.errors} batch(es) retried</div>}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:12}}>
          <div style={{background:"#f0fdf4",border:"0.5px solid #bbf7d0",borderRadius:8,padding:"10px 12px",fontSize:11,color:"#166534"}}>Sales/BDC → CRISP graded</div>
          <div style={{background:"#fff7ed",border:"0.5px solid #fed7aa",borderRadius:8,padding:"10px 12px",fontSize:11,color:"#9a3412"}}>Service → S2S scored</div>
        </div>
        <div style={{fontSize:11,color:"#9ca3af",marginTop:10}}>Running parallel batches · leave this tab open</div>
      </div>
    </div>
  );

  // ── DASHBOARD ─────────────────────────────────────────────────────────────
  return (
    <div style={{...S,padding:"16px 20px"}}>

      {/* Top bar */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontSize:15,fontWeight:700}}>CRISP Daily Report — Hendrick Honda Charlotte</div>
          <div style={{fontSize:11,color:"#6b7280"}}>{dateStr} · {graded.length} total · {noAnswers.length} no-answers · {salesCalls.length} sales · {serviceCalls.length} service</div>
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <button style={btnSm} onClick={()=>exportCSV(viewCalls,"CRISP")}>⬇ Export CSV</button>
          <button style={btnSm} onClick={()=>setScreen("upload")}>⬆ New file</button>
        </div>
      </div>

      {/* Dept + Tab bar */}
      <div style={{display:"flex",alignItems:"center",borderBottom:"0.5px solid #e5e7eb",marginBottom:14,gap:0,overflowX:"auto"}}>
        <div style={{display:"flex",gap:4,marginRight:12,flexShrink:0,padding:"4px 0"}}>
          {[["sales","Sales / BDC"],["service","Service"]].map(([id,label])=>(
            <button key={id} onClick={()=>{setDeptFilter(id);setSelectedAgent(null);setDashTab("gm");}} style={{padding:"4px 10px",fontSize:11,fontWeight:deptFilter===id?700:400,cursor:"pointer",border:"0.5px solid "+(deptFilter===id?"#111":"#e5e7eb"),borderRadius:6,background:deptFilter===id?"#111":"#fff",color:deptFilter===id?"#fff":"#6b7280"}}>{label}{id==="service"&&redAlerts.length>0&&<span style={{background:"#dc2626",color:"#fff",borderRadius:20,padding:"0 5px",fontSize:10,marginLeft:4}}>{redAlerts.length}</span>}</button>
          ))}
        </div>
        <button style={tabS(dashTab==="gm")} onClick={()=>{setDashTab("gm");setSelectedAgent(null);}}>GM Summary</button>
        <button style={tabS(dashTab==="followup")} onClick={()=>setDashTab("followup")}>
          Follow-Up ({todayCount+weekCount}){todayCount>0&&<span style={{background:"#dc2626",color:"#fff",borderRadius:20,padding:"0 5px",fontSize:10,marginLeft:4}}>{todayCount}</span>}
        </button>
        {deptFilter==="service"&&(
          <button style={{...tabS(dashTab==="s2s"),color:redAlerts.length>0&&dashTab!=="s2s"?"#991b1b":dashTab==="s2s"?"#111":"#6b7280"}} onClick={()=>setDashTab("s2s")}>
            S2S Leads ({redAlerts.length+orangeLeads.length}){redAlerts.length>0&&<span style={{background:"#dc2626",color:"#fff",borderRadius:20,padding:"0 5px",fontSize:10,marginLeft:4}}>{redAlerts.length}</span>}
          </button>
        )}
        <button style={tabS(dashTab==="noanswer")} onClick={()=>setDashTab("noanswer")}>No Answer ({noAnswers.length})</button>
        <button style={tabS(dashTab==="all")} onClick={()=>setDashTab("all")}>All Calls ({n})</button>
        {agents.map(a=>{
          const ad=agentMap[a];
          return <button key={a} style={tabS(dashTab==="agent"&&selectedAgent===a)} onClick={()=>{setDashTab("agent");setSelectedAgent(a);}}>
            {a.split(" ")[0]}{ad?.today>0&&<span style={{background:"#dc2626",color:"#fff",borderRadius:20,padding:"0 5px",fontSize:10,marginLeft:4}}>{ad.today}</span>}
          </button>;
        })}
      </div>

      {/* ── GM SUMMARY ── */}
      {dashTab==="gm"&&(
        <div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,minmax(0,1fr))",gap:10,marginBottom:14}}>
            {[{l:"Calls graded",v:n},{l:"Team avg",v:teamAvg+"/100"},{l:"Appt rate",v:teamApt+"%"},{l:"Need action today",v:todayCount,hi:todayCount>0},{l:"Follow up this week",v:weekCount}].map(m=>(
              <div key={m.l} style={{...card,textAlign:"center",background:m.hi?"#fef2f2":"#fff",border:m.hi?"0.5px solid #fca5a5":"0.5px solid #e5e7eb"}}>
                <div style={{fontSize:11,color:m.hi?"#991b1b":"#6b7280",marginBottom:4}}>{m.hi?"🔴 ":""}{m.l}</div>
                <div style={{fontSize:22,fontWeight:700,color:m.hi?"#991b1b":"#111"}}>{m.v}</div>
              </div>
            ))}
          </div>

          {deptFilter==="service"&&(redAlerts.length>0||orangeLeads.length>0)&&(
            <div style={{...card,marginBottom:14,background:"#fef2f2",border:"0.5px solid #fecaca"}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <span style={{background:"#dc2626",color:"#fff",borderRadius:6,padding:"3px 10px",fontSize:12,fontWeight:500}}>S2S ALERTS</span>
                <span style={{fontSize:13,fontWeight:500,color:"#991b1b"}}>{redAlerts.length} RED · {orangeLeads.length} ORANGE leads today</span>
              </div>
              <div style={{fontSize:12,color:"#991b1b"}}>Switch to "S2S Leads" tab to see BDC openers and full lead details.</div>
            </div>
          )}

          {(()=>{
            const cP=leaderboard.length?Math.round(leaderboard.reduce((s,a)=>s+a.avgC,0)/leaderboard.length/20*100):0;
            const riP=leaderboard.length?Math.round(leaderboard.reduce((s,a)=>s+a.avgRI,0)/leaderboard.length/30*100):0;
            const sP=leaderboard.length?Math.round(leaderboard.reduce((s,a)=>s+a.avgS,0)/leaderboard.length/25*100):0;
            const pP=leaderboard.length?Math.round(leaderboard.reduce((s,a)=>s+a.avgP,0)/leaderboard.length/10*100):0;
            const gaps=[riP<75&&{step:"R+I",actual:riP,target:75},sP<45&&{step:"S Set",actual:sP,target:45},pP<100&&{step:"P Pursue",actual:pP,target:100},cP<80&&{step:"C Connect",actual:cP,target:80}].filter(Boolean);
            if(!gaps.length) return <div style={{...card,marginBottom:14,background:"#f0fdf4",border:"0.5px solid #bbf7d0"}}><div style={{fontSize:12,color:"#166534",fontWeight:600}}>✅ All CRISP steps at or above CarWars top 20% benchmark!</div></div>;
            return <div style={{...card,marginBottom:14,background:"#fef2f2",border:"0.5px solid #fecaca"}}>
              <div style={{fontSize:12,fontWeight:600,color:"#991b1b",marginBottom:8}}>⚠ Below CarWars top 20% on {gaps.length} step{gaps.length>1?"s":""}</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {gaps.map(g=><div key={g.step} style={{background:"#fff",border:"0.5px solid #fecaca",borderRadius:6,padding:"6px 10px",fontSize:11}}>
                  <div style={{fontWeight:600,color:"#991b1b"}}>{g.step}</div>
                  <div>{g.actual}% vs {g.target}% target</div>
                </div>)}
              </div>
            </div>;
          })()}

          <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,2fr)",gap:14,marginBottom:14}}>
            {topAgent&&<div style={card}>
              <div style={{fontSize:11,fontWeight:600,letterSpacing:"1px",textTransform:"uppercase",color:"#6b7280",marginBottom:10}}>⭐ Top performer</div>
              <div style={{fontSize:19,fontWeight:700,marginBottom:2}}>{topAgent.n}</div>
              <div style={{fontSize:12,color:"#6b7280",marginBottom:8}}>{topAgent.calls} calls · {topAgent.aptPct}% appt rate</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{fontSize:26,fontWeight:700,color:sc(topAgent.avg)}}>{topAgent.avg}</div>
                <div style={{flex:1}}><MiniBar value={topAgent.avg} color={sc(topAgent.avg)} height={6}/></div>
                <GradeBadge grade={sg(topAgent.avg)}/>
              </div>
            </div>}
            <div style={card}>
              <div style={{fontSize:11,fontWeight:600,letterSpacing:"1px",textTransform:"uppercase",color:"#6b7280",marginBottom:10}}>Team CRISP vs CarWars benchmarks</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                {[{k:"avgC",bk:"C",l:"Connect",max:20,c:"#1d4ed8"},{k:"avgRI",bk:"RI",l:"Request/Invite",max:30,c:"#16a34a"},{k:"avgS",bk:"S",l:"Set",max:25,c:"#0891b2"},{k:"avgP",bk:"P",l:"Pursue",max:10,c:"#d97706"}].map(item=>{
                  const a2=leaderboard.length?Math.round(leaderboard.reduce((s,a)=>s+a[item.k],0)/leaderboard.length):0;
                  const pct=Math.round((a2/item.max)*100);
                  const bm=BENCHMARKS[item.bk];
                  const st=benchmarkStatus(pct,item.bk);
                  return <div key={item.k} style={{background:st.bg,borderRadius:8,padding:"10px 12px",border:`0.5px solid ${st.color}33`}}>
                    <div style={{fontSize:10,fontWeight:600,color:"#374151",marginBottom:4}}>{item.l}</div>
                    <div style={{fontSize:19,fontWeight:800,color:st.color}}>{pct}%</div>
                    <div style={{height:4,background:"#e5e7eb",borderRadius:2,margin:"5px 0",overflow:"hidden"}}><div style={{height:"100%",width:`${Math.min(pct,100)}%`,background:item.c,borderRadius:2}}/></div>
                    <div style={{fontSize:10,color:st.color,fontWeight:600}}>{st.label}</div>
                    <div style={{fontSize:10,color:"#9ca3af"}}>Top 20%: {bm.top20}%</div>
                    {pct<bm.top20&&<div style={{fontSize:10,color:"#991b1b"}}>Gap: {bm.top20-pct}pts</div>}
                  </div>;
                })}
              </div>
            </div>
          </div>

          <div style={card}>
            <div style={{fontSize:11,fontWeight:600,letterSpacing:"1px",textTransform:"uppercase",color:"#6b7280",marginBottom:10}}>Agent leaderboard — click to drill down</div>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr style={{background:"#f9fafb"}}>
                  {["#","Agent","Calls","In/Out","Avg Score","C/20","R+I/30","S/25","OH/15","P/10","Appt%","Today","Week","Grade",""].map(h=><th key={h} style={th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {leaderboard.map((a,i)=>(
                    <tr key={a.n} style={{borderBottom:"0.5px solid #f3f4f6",cursor:"pointer",background:a.today>0?"#fff9f9":"transparent"}} onClick={()=>{setDashTab("agent");setSelectedAgent(a.n);}}>
                      <td style={{padding:"6px 8px",color:"#9ca3af",fontSize:10}}>{i+1}</td>
                      <td style={{padding:"6px 8px",fontWeight:600}}>{a.n}</td>
                      <td style={{padding:"6px 8px"}}>{a.calls}</td>
                      <td style={{padding:"6px 8px",fontSize:10}}><DirBadge dir="incoming"/> {a.inc} <DirBadge dir="outgoing"/> {a.out}</td>
                      <td style={{padding:"6px 8px",minWidth:80}}><strong style={{color:sc(a.avg)}}>{a.avg}</strong><MiniBar value={a.avg} color={sc(a.avg)}/></td>
                      <td style={{padding:"6px 8px",color:sc((a.avgC/20)*100)}}>{a.avgC}</td>
                      <td style={{padding:"6px 8px",color:sc((a.avgRI/30)*100)}}>{a.avgRI}</td>
                      <td style={{padding:"6px 8px",color:sc((a.avgS/25)*100)}}>{a.avgS}</td>
                      <td style={{padding:"6px 8px",color:sc((a.avgOH/15)*100)}}>{a.avgOH}</td>
                      <td style={{padding:"6px 8px",color:sc((a.avgP/10)*100)}}>{a.avgP}</td>
                      <td style={{padding:"6px 8px"}}>{a.aptPct}%</td>
                      <td style={{padding:"6px 8px"}}>{a.today>0?<span style={{background:"#fef2f2",border:"0.5px solid #fca5a5",borderRadius:4,padding:"1px 6px",color:"#991b1b",fontWeight:700}}>{a.today}</span>:"—"}</td>
                      <td style={{padding:"6px 8px"}}>{a.week>0?<span style={{background:"#fffbeb",border:"0.5px solid #fcd34d",borderRadius:4,padding:"1px 6px",color:"#78350f"}}>{a.week}</span>:"—"}</td>
                      <td style={{padding:"6px 8px"}}><GradeBadge grade={sg(a.avg)}/></td>
                      <td style={{padding:"6px 8px",color:"#9ca3af",fontSize:10}}>→</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── S2S LEADS ── */}
      {dashTab==="s2s"&&(
        <div>
          {/* RED ALERTS */}
          <div style={{...card,marginBottom:14,background:"#fef2f2",border:"1px solid #f09595"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:redAlerts.length>0?12:0}}>
              <div style={{background:"#dc2626",color:"#fff",borderRadius:6,padding:"4px 10px",fontSize:12,fontWeight:500}}>RED ALERT</div>
              <div style={{fontSize:13,fontWeight:500,color:"#991b1b"}}>{redAlerts.length} customer{redAlerts.length!==1?"s":""} — BDC calls today, advisor flags at checkout</div>
            </div>
            {redAlerts.length===0&&<div style={{fontSize:12,color:"#6b7280"}}>No red alerts today.</div>}
            {redAlerts.map(c=>(
              <div key={c._id} style={{background:"#fff",border:"0.5px solid #fecaca",borderRadius:8,padding:"10px 12px",marginBottom:8}}>
                <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:6,flexWrap:"wrap"}}>
                  <span style={{background:"#dc2626",color:"#fff",borderRadius:4,padding:"2px 8px",fontSize:11,fontWeight:500}}>100</span>
                  <strong style={{fontSize:13}}>{c._customer&&c._customer!=="Unknown"?c._customer:<span style={{fontFamily:"monospace"}}>{c._phone||"—"}</span>}</strong>
                  {c._phone&&c._customer!=="Unknown"&&<span style={{fontSize:11,color:"#6b7280",fontFamily:"monospace"}}>{c._phone}</span>}
                  <DirBadge dir={c._dir}/>
                  <span style={{fontSize:11,color:"#6b7280"}}>{c._agent} · {c._duration}</span>
                  <span style={{fontSize:11,color:"#9ca3af"}}>{c._time||c._date}</span>
                </div>
                <div style={{fontSize:12,color:"#991b1b",marginBottom:6}}><strong>Why flagged:</strong> {c._s2s?.redReason||c._s2s?.s2sReason}</div>
                {c._s2s?.s2sOpener&&<div style={{background:"#fff9f9",border:"0.5px solid #fecaca",borderRadius:6,padding:"8px 10px",fontSize:12,color:"#374151"}}>
                  <div style={{fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.8px",color:"#991b1b",marginBottom:4}}>BDC opener</div>
                  {c._s2s.s2sOpener}
                </div>}
              </div>
            ))}
          </div>

          {/* ORANGE LEADS */}
          <div style={{...card,marginBottom:14,border:"1px solid #fdba74"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:orangeLeads.length>0?12:0}}>
              <div style={{background:"#ea580c",color:"#fff",borderRadius:6,padding:"4px 10px",fontSize:12,fontWeight:500}}>ORANGE</div>
              <div style={{fontSize:13,fontWeight:500,color:"#9a3412"}}>{orangeLeads.length} lead{orangeLeads.length!==1?"s":""} — BDC follows up this week</div>
            </div>
            {orangeLeads.length===0&&<div style={{fontSize:12,color:"#6b7280"}}>No orange leads today.</div>}
            {orangeLeads.map(c=>(
              <div key={c._id} style={{background:"#fff",border:"0.5px solid #fed7aa",borderRadius:8,padding:"10px 12px",marginBottom:8}}>
                <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:6,flexWrap:"wrap"}}>
                  <span style={{background:"#ea580c",color:"#fff",borderRadius:4,padding:"2px 8px",fontSize:11,fontWeight:500}}>{c._s2s?.s2sScore}</span>
                  <strong style={{fontSize:13}}>{c._customer&&c._customer!=="Unknown"?c._customer:<span style={{fontFamily:"monospace"}}>{c._phone||"—"}</span>}</strong>
                  {c._phone&&c._customer!=="Unknown"&&<span style={{fontSize:11,color:"#6b7280",fontFamily:"monospace"}}>{c._phone}</span>}
                  <DirBadge dir={c._dir}/>
                  <span style={{fontSize:11,color:"#6b7280"}}>{c._agent} · {c._duration}</span>
                  <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                    {c._s2s?.highRepair&&<span style={{background:"#fff7ed",color:"#9a3412",border:"0.5px solid #fed7aa",borderRadius:10,padding:"1px 6px",fontSize:10}}>high repair</span>}
                    {c._s2s?.highMileage&&<span style={{background:"#eff6ff",color:"#1e40af",border:"0.5px solid #bfdbfe",borderRadius:10,padding:"1px 6px",fontSize:10}}>high mileage</span>}
                    {c._s2s?.repeatIssue&&<span style={{background:"#f0fdf4",color:"#166534",border:"0.5px solid #bbf7d0",borderRadius:10,padding:"1px 6px",fontSize:10}}>repeat issue</span>}
                    {c._s2s?.frustration&&<span style={{background:"#fef2f2",color:"#991b1b",border:"0.5px solid #fecaca",borderRadius:10,padding:"1px 6px",fontSize:10}}>frustrated</span>}
                    {c._s2s?.olderVehicle&&<span style={{background:"#faf5ff",color:"#6b21a8",border:"0.5px solid #e9d5ff",borderRadius:10,padding:"1px 6px",fontSize:10}}>older vehicle</span>}
                    {c._s2s?.financingAsk&&<span style={{background:"#ecfdf5",color:"#065f46",border:"0.5px solid #a7f3d0",borderRadius:10,padding:"1px 6px",fontSize:10}}>financing ask</span>}
                    {c._s2s?.lifeEvent&&<span style={{background:"#fffbeb",color:"#78350f",border:"0.5px solid #fde68a",borderRadius:10,padding:"1px 6px",fontSize:10}}>life event</span>}
                    {c._s2s?.frequentFlyer&&<span style={{background:"#f0f9ff",color:"#0c4a6e",border:"0.5px solid #bae6fd",borderRadius:10,padding:"1px 6px",fontSize:10}}>freq. flyer</span>}
                  </div>
                </div>
                <div style={{fontSize:12,color:"#9a3412",marginBottom:6}}>{c._s2s?.s2sReason}</div>
                {c._s2s?.s2sOpener&&<div style={{background:"#fff7ed",border:"0.5px solid #fed7aa",borderRadius:6,padding:"8px 10px",fontSize:12,color:"#374151"}}>
                  <div style={{fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.8px",color:"#9a3412",marginBottom:4}}>BDC opener</div>
                  {c._s2s.s2sOpener}
                </div>}
              </div>
            ))}
          </div>

          {/* All service calls */}
          <div style={card}>
            <div style={{fontSize:11,fontWeight:500,textTransform:"uppercase",letterSpacing:"1px",color:"#6b7280",marginBottom:10}}>All service calls — S2S scores</div>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr style={{background:"#f9fafb"}}>
                  {["Time","Agent","Customer","Phone","Score","Tier","Signals"].map(h=><th key={h} style={th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {serviceCalls.sort((a,b)=>(b._s2s?.s2sScore||0)-(a._s2s?.s2sScore||0)).map(c=>{
                    const s=c._s2s;
                    const tc=s?.redAlert?"#dc2626":s?.s2sTier==="ORANGE"?"#ea580c":"#9ca3af";
                    const tb=s?.redAlert?"#fef2f2":s?.s2sTier==="ORANGE"?"#fff7ed":"#f9fafb";
                    const sigs=[s?.highRepair&&"repair",s?.highMileage&&"mileage",s?.repeatIssue&&"repeat",s?.frustration&&"frustrated",s?.olderVehicle&&"old car",s?.financingAsk&&"financing",s?.lifeEvent&&"life event",s?.frequentFlyer&&"freq. flyer"].filter(Boolean);
                    return <tr key={c._id} style={{borderBottom:"0.5px solid #f3f4f6",background:s?.redAlert?"#fff9f9":"transparent"}}>
                      <td style={{padding:"6px 8px",fontSize:10,color:"#6b7280",whiteSpace:"nowrap"}}>{c._time||c._date}</td>
                      <td style={{padding:"6px 8px",fontWeight:500,maxWidth:100,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c._agent}</td>
                      <td style={{padding:"6px 8px",maxWidth:110,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c._customer&&c._customer!=="Unknown"?c._customer:"—"}</td>
                      <td style={{padding:"6px 8px",fontFamily:"monospace",fontSize:11,color:"#6b7280"}}>{c._phone||"—"}</td>
                      <td style={{padding:"6px 8px"}}><strong style={{color:tc}}>{s?.s2sScore||0}</strong></td>
                      <td style={{padding:"6px 8px"}}><span style={{background:tb,color:tc,border:`0.5px solid ${tc}44`,borderRadius:10,padding:"1px 7px",fontSize:10,fontWeight:500}}>{s?.redAlert?"RED":s?.s2sTier||"NONE"}</span></td>
                      <td style={{padding:"6px 8px",fontSize:11,color:"#6b7280"}}>{sigs.join(", ")||"—"}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── FOLLOW-UP ── */}
      {dashTab==="followup"&&(
        <div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
            {[{f:"TODAY",cnt:todayCount,desc:"Call back today"},{f:"THIS_WEEK",cnt:weekCount,desc:"Follow up this week"},{f:"MONITOR",cnt:viewCalls.filter(c=>c._g.followUpFlag==="MONITOR").length,desc:"Watch and revisit"}].map(t=>{
              const fc=FLAG[t.f];
              return <div key={t.f} style={{...card,background:fc.bg,border:`0.5px solid ${fc.border}`,textAlign:"center"}}>
                <div style={{fontSize:11,color:fc.color,fontWeight:600,marginBottom:4}}>{fc.e} {fc.label}</div>
                <div style={{fontSize:28,fontWeight:700,color:fc.color}}>{t.cnt}</div>
                <div style={{fontSize:11,color:fc.color,opacity:.8}}>{t.desc}</div>
              </div>;
            })}
          </div>
          {["TODAY","THIS_WEEK","MONITOR"].map(f=>{
            const calls=viewCalls.filter(c=>c._g.followUpFlag===f).sort((a,b)=>a._agent.localeCompare(b._agent));
            if(!calls.length) return null;
            const fc=FLAG[f];
            return <div key={f} style={{marginBottom:12}}>
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"1px",color:fc.color,marginBottom:6}}>{fc.e} {fc.label}</div>
              {calls.map(c=>(
                <div key={c._id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:fc.bg,border:`0.5px solid ${fc.border}`,borderRadius:7,fontSize:12,marginBottom:4,flexWrap:"wrap"}}>
                  <DirBadge dir={c._dir}/>
                  <strong style={{minWidth:90}}>{c._agent.split(" ")[0]}</strong>
                  <span style={{fontWeight:500,minWidth:110,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c._customer&&c._customer!=="Unknown"?c._customer:<span style={{fontFamily:"monospace",fontSize:11}}>{c._phone||"—"}</span>}</span>
                  <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"#374151",fontSize:11}}>{c._g.followUpReason}</span>
                  <span style={{color:"#9ca3af",fontSize:10,whiteSpace:"nowrap"}}>{c._duration}</span>
                </div>
              ))}
            </div>;
          })}
        </div>
      )}

      {/* ── NO ANSWER ── */}
      {dashTab==="noanswer"&&(
        <div>
          <div style={{...card,marginBottom:14,background:"#f9fafb"}}>
            <div style={{fontSize:12,color:"#6b7280"}}><strong style={{color:"#111"}}>{noAnswers.length} calls</strong> with no live conversation — no-answers, voicemails, hangups. Not CRISP-graded.</div>
          </div>
          <div style={{border:"0.5px solid #e5e7eb",borderRadius:8,overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr style={{background:"#f9fafb"}}>
                {["Time","Agent","Dir","Dept","Phone","Duration","Disposition"].map(h=><th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {noAnswers.map(c=>(
                  <tr key={c._id} style={{borderBottom:"0.5px solid #f3f4f6"}}>
                    <td style={{padding:"6px 8px",fontSize:11,color:"#6b7280",whiteSpace:"nowrap"}}>{c._time||c._date||"—"}</td>
                    <td style={{padding:"6px 8px",fontWeight:500}}>{c._agent}</td>
                    <td style={{padding:"6px 8px"}}><DirBadge dir={c._dir}/></td>
                    <td style={{padding:"6px 8px"}}><DeptBadge dept={c._dept}/></td>
                    <td style={{padding:"6px 8px",fontFamily:"monospace",fontSize:11}}>{c._phone||"—"}</td>
                    <td style={{padding:"6px 8px",color:"#6b7280"}}>{c._duration||"—"}</td>
                    <td style={{padding:"6px 8px",color:"#6b7280",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c._disposition||"—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── AGENT DRILL-DOWN ── */}
      {dashTab==="agent"&&selectedAgent&&(()=>{
        const aCalls=viewCalls.filter(c=>c._agent===selectedAgent);
        const aData=agentMap[selectedAgent];
        const aAvg=aData&&aData.calls?Math.round(aData.tot/aData.calls):0;
        return (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
              <div>
                <div style={{fontSize:16,fontWeight:700}}>{selectedAgent}</div>
                <div style={{fontSize:11,color:"#6b7280"}}>{aCalls.length} calls · {aCalls.filter(c=>c._dir==="incoming").length} in · {aCalls.filter(c=>c._dir==="outgoing").length} out</div>
              </div>
              <button style={btnSm} onClick={()=>exportCSV(aCalls,selectedAgent.replace(/\s/g,"_"))}>⬇ Export CSV</button>
            </div>

            {aData?.today>0&&<div style={{...card,marginBottom:12,background:"#fef2f2",border:"0.5px solid #fca5a5"}}>
              <div style={{fontSize:12,fontWeight:700,color:"#991b1b",marginBottom:8}}>🔴 {aData.today} call{aData.today>1?"s":""} need follow-up TODAY</div>
              {aCalls.filter(c=>c._g.followUpFlag==="TODAY").map(c=>(
                <div key={c._id} style={{background:"#fff",border:"0.5px solid #fecaca",borderRadius:6,padding:"8px 10px",marginBottom:6,fontSize:12}}>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:3}}><DirBadge dir={c._dir}/><strong>{c._customer&&c._customer!=="Unknown"?c._customer:c._phone||"—"}</strong><span style={{color:"#9ca3af",fontSize:11}}>{c._duration}</span></div>
                  <div style={{color:"#991b1b",fontSize:11}}>{c._g.followUpReason}</div>
                  <div style={{color:"#d97706",fontSize:11,marginTop:2}}><strong>Coach:</strong> {c._g.coaching}</div>
                </div>
              ))}
            </div>}

            {aData?.week>0&&<div style={{...card,marginBottom:12,background:"#fffbeb",border:"0.5px solid #fcd34d"}}>
              <div style={{fontSize:12,fontWeight:700,color:"#78350f",marginBottom:8}}>🟡 {aData.week} call{aData.week>1?"s":""} to follow up this week</div>
              {aCalls.filter(c=>c._g.followUpFlag==="THIS_WEEK").map(c=>(
                <div key={c._id} style={{background:"#fff",border:"0.5px solid #fcd34d",borderRadius:6,padding:"8px 10px",marginBottom:6,fontSize:12}}>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:3}}><DirBadge dir={c._dir}/><strong>{c._customer&&c._customer!=="Unknown"?c._customer:c._phone||"—"}</strong></div>
                  <div style={{color:"#78350f",fontSize:11}}>{c._g.followUpReason}</div>
                </div>
              ))}
            </div>}

            <div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:10,marginBottom:12}}>
              {[{l:"Calls",v:aCalls.length},{l:"Avg score",v:aAvg+"/100"},{l:"Appt rate",v:(aData&&aData.calls?Math.round((aData.apts/aData.calls)*100):0)+"%"},{l:"Urgent flags",v:(aData?.today||0)+(aData?.week||0)}].map(m=>(
                <div key={m.l} style={{...card,textAlign:"center"}}><div style={{fontSize:10,color:"#6b7280",marginBottom:3}}>{m.l}</div><div style={{fontSize:20,fontWeight:700}}>{m.v}</div></div>
              ))}
            </div>

            <div style={{...card,marginBottom:12}}>
              <div style={{fontSize:11,fontWeight:600,letterSpacing:"1px",textTransform:"uppercase",color:"#6b7280",marginBottom:10}}>CRISP scores</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
                {[{k:"cScore",l:"Connect",max:20,c:"#1d4ed8"},{k:"riScore",l:"Req/Invite",max:30,c:"#16a34a"},{k:"sScore",l:"Set",max:25,c:"#0891b2"},{k:"ohScore",l:"Objections",max:15,c:"#7c3aed"},{k:"pScore",l:"Pursue",max:10,c:"#d97706"}].map(item=>{
                  const av=aCalls.length?Math.round(aCalls.reduce((s,c)=>s+(c._g[item.k]||0),0)/aCalls.length):0;
                  return <div key={item.k} style={{textAlign:"center"}}>
                    <div style={{fontSize:10,color:"#6b7280",marginBottom:3}}>{item.l}</div>
                    <div style={{fontSize:17,fontWeight:700,color:item.c}}>{av}<span style={{fontSize:10,color:"#9ca3af",fontWeight:400}}>/{item.max}</span></div>
                    <MiniBar value={av} max={item.max} color={item.c} height={4}/>
                  </div>;
                })}
              </div>
            </div>

            <div style={{border:"0.5px solid #e5e7eb",borderRadius:8,overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr style={{background:"#f9fafb"}}>
                  {["Date","Customer","Dir","Score","C","R/I","S","OH","P","Appt","Flag","Grade",""].map(h=><th key={h} style={th}>{h}</th>)}
                </tr></thead>
                <tbody>{aCalls.map(c=><CallRow key={c._id} c={c} colSpan={13} expanded={expanded} onToggle={toggleExpand}/>)}</tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* ── ALL CALLS ── */}
      {dashTab==="all"&&(
        <div>
          <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap",alignItems:"center"}}>
            <select style={sel} value={dirFilter} onChange={e=>setDirFilter(e.target.value)}>
              <option value="all">All directions</option>
              <option value="incoming">Incoming</option>
              <option value="outgoing">Outgoing</option>
            </select>
            <select style={sel} value={gradeFilter} onChange={e=>setGradeFilter(e.target.value)}>
              <option value="">All grades</option>
              {["A","B","C","D","F"].map(g=><option key={g}>{g}</option>)}
            </select>
            <select style={sel} value={flagFilter} onChange={e=>setFlagFilter(e.target.value)}>
              <option value="">All follow-up</option>
              <option value="TODAY">🔴 Today</option>
              <option value="THIS_WEEK">🟡 This week</option>
              <option value="MONITOR">⚪ Monitor</option>
              <option value="NONE">✅ Done</option>
            </select>
            <span style={{fontSize:11,color:"#9ca3af"}}>{filteredCalls.length} calls</span>
          </div>
          <div style={{border:"0.5px solid #e5e7eb",borderRadius:8,overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr style={{background:"#f9fafb"}}>
                {["Date","Agent","Customer","Dir","Score","Appt","Flag","Grade",""].map(h=><th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>{filteredCalls.map(c=><CallRow key={c._id} c={c} colSpan={9} expanded={expanded} onToggle={toggleExpand}/>)}</tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}
