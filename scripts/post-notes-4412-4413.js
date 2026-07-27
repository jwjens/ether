const https=require("https"); const {execSync}=require("child_process");
const REPO="jwjens/ether";
const RELEASES=[
 {tag:"v4.4.12", name:"v4.4.12 — Cloud restore stays signed in (sign-in loop fixed)",
  body:"**The sign-in loop after pulling a station from the cloud is gone.** A machine that restores its station now keeps its session across the restore instead of bouncing back to the sign-in screen.\n\n_Local-first as always: the studio machine runs the audio; the cloud is the sync hub._"},
 {tag:"v4.4.13", name:"v4.4.13 — Publish your station + smarter onboarding",
  body:"**Save & Publish now works.** Publishing your public listener page authenticates as the station's owner, so it no longer fails with \"this station isn't linked to your account.\"\n\n**Less nagging:** the \"Sync your stations\" screen is skipped when every station on your account is already on the computer.\n\n_Local-first as always: the studio machine runs the audio; the cloud is the sync hub._"},
];
function token(){const o=execSync("git credential fill",{input:"protocol=https\nhost=github.com\n\n"}).toString();const m=o.match(/password=(.+)/);if(!m)throw new Error("no token");return m[1].trim();}
function api(method,path,tok,payload){return new Promise((res,rej)=>{const d=payload?JSON.stringify(payload):null;const r=https.request({hostname:"api.github.com",path,method,headers:{"User-Agent":"ether-release",Authorization:`Bearer ${tok}`,Accept:"application/vnd.github+json",...(d?{"Content-Type":"application/json","Content-Length":Buffer.byteLength(d)}:{})}},x=>{let b="";x.on("data",c=>b+=c);x.on("end",()=>res({status:x.statusCode,body:b}))});r.on("error",rej);if(d)r.write(d);r.end();});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const tok=token();for(const rel of RELEASES){let id=null;for(let i=0;i<60;i++){const r=await api("GET",`/repos/${REPO}/releases/tags/${rel.tag}`,tok);if(r.status===200){id=JSON.parse(r.body).id;break;}console.log(`[${rel.tag}] waiting…`);await sleep(30000);}if(!id){console.error(`[${rel.tag}] never appeared`);continue;}const p=await api("PATCH",`/repos/${REPO}/releases/${id}`,tok,{name:rel.name,body:rel.body});console.log(`[${rel.tag}] PATCH ${p.status}`);}console.log("done.");})().catch(e=>{console.error("err",e.message);process.exitCode=1;});
