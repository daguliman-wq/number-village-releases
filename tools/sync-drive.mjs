import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const ROOT='1tKdTIVHnGWSOs4JHrvJw3gl479BZRH9J';
export function decodeListing(html){
 const raw=html.match(/_DRIVE_ivd'\]\s*=\s*'((?:\\.|[^'\\])*)'/)?.[1];
 if(!raw)throw Error('Public folder listing unavailable (sharing or Drive page changed)');
 const text=JSON.parse('"'+raw.replace(/"/g,'\\"').replace(/\\x([0-9a-f]{2})/gi,'\\u00$1').replace(/\\'/g,"'")+'"');
 const data=JSON.parse(text);if(!Array.isArray(data[0]))throw Error('Unknown folder listing');
 // Completeness is checked against the public embedded folder listing.
 return data[0].map(r=>({driveId:r[0],name:r[2],mime:r[3],bytes:Number(r[13]),modifiedTime:Number(r[9])}));
}
async function response(url){const r=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('Drive HTTP '+r.status);return r;}
async function listing(id){
 if(!process.env.DRIVE_API_KEY){
  const rows=decodeListing(await (await response('https://drive.google.com/drive/folders/'+id)).text());
  const embedded=await(await response('https://drive.google.com/embeddedfolderview?id='+id)).text();
  if(!embedded.includes('<title>'))throw Error('Embedded folder unavailable');
  const all=new Set([...embedded.matchAll(/https:\/\/drive\.google\.com\/(?:file\/d\/|drive\/folders\/)([A-Za-z0-9_-]{5,150})/g)].map(m=>m[1]));
  const found=new Set(rows.map(r=>r.driveId));if(all.size!==found.size||[...all].some(key=>!found.has(key)))throw Error('Folder metadata incomplete; configure DRIVE_API_KEY for paginated listing');
  return rows;
 }
 const rows=[];let token='';do{
  const u=new URL('https://www.googleapis.com/drive/v3/files');u.search=new URLSearchParams({key:process.env.DRIVE_API_KEY,q:"'"+id+"' in parents and trashed = false",pageSize:'1000',fields:'nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime)',...(token?{pageToken:token}:{})});
  const d=await (await response(u)).json();if(d.incompleteSearch||!Array.isArray(d.files))throw Error('Incomplete Drive API result');
  rows.push(...d.files.map(r=>({driveId:r.id,name:r.name,mime:r.mimeType,bytes:Number(r.size),modifiedTime:Date.parse(r.modifiedTime)})));token=d.nextPageToken||'';
 }while(token);return rows;
}
export async function scan(load=listing){
 const pending=[{id:ROOT,folder:''}],seen=new Set(),files=[];
 while(pending.length){const {id,folder}=pending.shift();if(seen.has(id)||seen.size>=200)throw Error('Folder cycle or limit');seen.add(id);
  const rows=await load(id);for(const r of rows){if(!/^[A-Za-z0-9_-]{5,150}$/.test(r.driveId)||typeof r.name!=='string')throw Error('Invalid Drive metadata');
   if(r.mime==='application/vnd.google-apps.folder')pending.push({id:r.driveId,folder:[folder,r.name].filter(Boolean).join('/')});
   else if(r.mime==='video/mp4'){if(!Number.isSafeInteger(r.bytes)||r.bytes<=0||r.bytes>4*1024**3||!Number.isFinite(r.modifiedTime)||r.modifiedTime<=0)throw Error('Invalid video metadata');files.push({...r,folder:folder||'동요'});}
  }if(files.length>5000)throw Error('Video limit');
 }return files.sort((a,b)=>(a.folder+'/'+a.name).localeCompare(b.folder+'/'+b.name,'en',{numeric:true}));
}
export function identity(previous,used){if(previous)return previous.id;for(let n=0;n<49950;n++){const id='rhyme-p'+(50+Math.floor(n/999)).toString().padStart(2,'0')+'-'+(n%999+1).toString().padStart(3,'0');if(!used.has(id)){used.add(id);return id;}}throw Error('ID space exhausted');}
async function media(file,target){
 const r=await response('https://drive.google.com/uc?export=download&id='+file.driveId);if(!/^(video\/|application\/octet-stream)/i.test(r.headers.get('content-type')||''))throw Error('Non-video Drive response');
 const hash=crypto.createHash('sha256');let total=0;const out=await fs.open(target,'w');try{for await(const chunk of r.body){total+=chunk.length;if(total>file.bytes)throw Error('Oversize video');hash.update(chunk);await out.write(chunk);}}finally{await out.close();}
 if(total!==file.bytes)throw Error('Truncated video');return hash.digest('hex');
}
export async function sync(dir='videos'){
 const prior=JSON.parse(await fs.readFile(path.join(dir,'catalog.json'),'utf8'));const old=new Map(prior.videos.map(e=>[e.driveId,e]));const retired=prior.retired||[];
 const used=new Set([...prior.videos,...retired].map(e=>e.id));for(const e of retired)if(!old.has(e.driveId))old.set(e.driveId,e);
 const files=await scan();if(files.length===0&&prior.videos.length)throw Error('Refusing empty Drive snapshot; last good catalog retained');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'number-village-'));const videos=[];
 try{for(const file of files){const before=old.get(file.driveId);const id=identity(before,used);let sha256=before?.sha256;
   if(!before||before.bytes!==file.bytes||before.modifiedTime!==file.modifiedTime){const target=path.join(temp,'video.mp4');sha256=await media(file,target);
    const thumbnail=path.join(dir,'thumbs',id+'-'+sha256+'.jpg');await fs.mkdir(path.dirname(thumbnail),{recursive:true});
    const ff=spawnSync(process.env.FFMPEG||'ffmpeg',['-y','-v','error','-i',target,'-ss','1','-frames:v','1','-vf','scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2','-threads','1',thumbnail],{encoding:'utf8'});if(ff.status!==0)throw Error('Thumbnail failed: '+file.name);
    console.log('Verified changed/new video '+id);
   }
   videos.push({id,driveId:file.driveId,sourceName:file.name,title:before&&(!before.sourceName||before.sourceName===file.name)?before.title:file.name.replace(/\.mp4$/i,'').replace(/^\d+\s*[-_.]\s*/,'').split(/\s[|｜]\s/)[0].replace(/\s*\[[^\]]+\]$/,''),playlist:file.folder,bytes:file.bytes,sha256,modifiedTime:file.modifiedTime});
  }
  const live=new Set(videos.map(e=>e.driveId));const removed=[...old.values()].filter(e=>!live.has(e.driveId));
  const changed=JSON.stringify(prior.videos)!==JSON.stringify(videos)||JSON.stringify(prior.retired||[])!==JSON.stringify(removed);
  const now=new Date().toISOString();const next={schema:1,rootId:ROOT,generatedAt:changed?now:prior.generatedAt,checkedDate:now.slice(0,10),videos,retired:removed};
  const text=JSON.stringify(next,null,2)+'\n';if(text!==JSON.stringify(prior,null,2)+'\n'){await fs.writeFile(path.join(dir,'catalog.next.json'),text);await fs.rename(path.join(dir,'catalog.next.json'),path.join(dir,'catalog.json'));}
  console.log('Catalog ready: '+videos.length+' active / '+removed.length+' retired');
 }finally{await fs.rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))sync(process.argv[2]||'videos').catch(error=>{console.error(error.message.replaceAll(process.env.DRIVE_API_KEY||'__none__','[redacted]'));process.exitCode=1;});
