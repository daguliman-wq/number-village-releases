import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeListing,scan,identity,ROOT} from './sync-drive.mjs';
test('public metadata parser never executes scripts',()=>{
 const row=[];row[0]='PublicDriveId';row[2]='A song.mp4';row[3]='video/mp4';row[9]=1000;row[13]=123;
 const json=JSON.stringify([[row]]).replace(/"/g,'\\x22');
 const result=decodeListing("_DRIVE_ivd'] = '"+json+"'");assert.equal(result[0].bytes,123);assert.equal(result[0].name,'A song.mp4');
 assert.throws(()=>decodeListing("_DRIVE_ivd'] = 'process.exit()'"));assert.throws(()=>decodeListing('<html>Sign in</html>'));
});
test('nested discovery and limits retain full file identity',async()=>{
 const file={driveId:'VideoId001',name:'One.mp4',mime:'video/mp4',bytes:123,modifiedTime:1000};
 const rows=await scan(async id=>id===ROOT?[{driveId:'NestedFolder',name:'Folder',mime:'application/vnd.google-apps.folder'}]:[file]);assert.equal(rows.length,1);assert.equal(rows[0].folder,'Folder');
 await assert.rejects(scan(async()=>[{driveId:ROOT,name:'Cycle',mime:'application/vnd.google-apps.folder'}]));
 await assert.rejects(scan(async()=>[{...file,bytes:0}]));
});
test('renames and moves never change known IDs or reuse retired IDs',()=>{
 const used=new Set(['rhyme-p50-001']);assert.equal(identity({id:'rhyme-01'},used),'rhyme-01');assert.equal(identity(null,used),'rhyme-p50-002');assert.equal(identity(null,used),'rhyme-p50-003');
});

test('unchanged source skips media downloads; a failed scan preserves last good manifest',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');const {sync}=await import('./sync-drive.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-test-'));const row=[];row[0]='VideoId001';row[2]='One.mp4';row[3]='video/mp4';row[9]=1000;row[13]=123;
 const html="<title>Folder</title>_DRIVE_ivd'] = '"+JSON.stringify([[row]]).replace(/"/g,'\\x22')+"'";
 const prior={schema:1,rootId:ROOT,generatedAt:'2026-11-15T00:00:00.000Z',videos:[{id:'rhyme-01',driveId:'VideoId001',sourceName:'One.mp4',title:'One',playlist:'동요',bytes:123,sha256:'a'.repeat(64),modifiedTime:1000}],retired:[]};
 const saved=globalThis.fetch;let calls=0;
 try{await fs.writeFile(path.join(dir,'catalog.json'),JSON.stringify(prior));globalThis.fetch=async url=>{calls++;return new Response(String(url).includes('embeddedfolderview')?'<title>Folder</title><a href="https://drive.google.com/file/d/VideoId001/view">One</a>':html);};
  await sync(dir);assert.equal(calls,2);const good=await fs.readFile(path.join(dir,'catalog.json'),'utf8');assert.deepEqual(JSON.parse(good).videos,prior.videos);assert.equal(JSON.parse(good).generatedAt,prior.generatedAt);
  globalThis.fetch=async()=>new Response('Forbidden',{status:403});await assert.rejects(sync(dir));assert.equal(await fs.readFile(path.join(dir,'catalog.json'),'utf8'),good);
 }finally{globalThis.fetch=saved;await fs.rm(dir,{recursive:true,force:true});}
});
