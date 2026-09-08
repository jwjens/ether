'use strict';
// COMMITTED ON PURPOSE — a receipt tool, excluded from the installer.
// scripts/verify-autopost-migration.js — receipt for v57. Copies the live profile, migrates the COPY,
// proves the opt-in is NULL everywhere so no seam can have moved.
const fs=require('fs'), os=require('os'), path=require('path');
const Database=require(path.join(__dirname,'..','node_modules','better-sqlite3'));
const SRC=process.argv[2]||path.join(process.env.LOCALAPPDATA,'Ether','profiles','ETH-STN-BAA8-E056-6FC8','openair.db');
const TMP=path.join(os.tmpdir(),`ether-v57-${Date.now()}.db`);
const ro=new Database(SRC,{readonly:true,fileMustExist:true}); ro.close();
fs.copyFileSync(SRC,TMP); for(const e of ['-wal','-shm']) if(fs.existsSync(SRC+e)) fs.copyFileSync(SRC+e,TMP+e);
console.log('source (READ-ONLY, never written):',SRC);
console.log('working copy:',TMP);
const db=new Database(TMP);
const cols=(t)=>{try{return db.prepare(`PRAGMA table_info(${t})`).all().map(c=>c.name);}catch{return[];}};
const NEW={categories:['overlay_chain_type'],generated_schedule:['chain_type','chain_type_effective','post_ms','cut_end_ms'],songs:['end_post_ms','end_post_source','end_post_confirmed_at'],library_asset:['end_post_ms','end_post_source','end_post_confirmed_at']};
console.log('\n--- BEFORE ---');
for(const t of Object.keys(NEW)) console.log(`  ${t}: ${NEW[t].filter(c=>cols(t).includes(c)).length}/${NEW[t].length} of the new columns present`);
const before={rows:db.prepare('SELECT COUNT(*) n FROM generated_schedule').get().n, cats:db.prepare('SELECT COUNT(*) n FROM categories').get().n};
console.log('--- applying migration v57 to the COPY ---');
require(path.join(__dirname,'migrate-chain-type-autopost-phase-sync-57.js')).applyMigration(db);
console.log('\n--- AFTER ---');
let fail=0;
for(const t of Object.keys(NEW)){const have=NEW[t].filter(c=>cols(t).includes(c)).length; if(have!==NEW[t].length) fail++;
  console.log(`  ${t}: ${have}/${NEW[t].length} ${have===NEW[t].length?'':'<-- MISSING'}`);}
const after={rows:db.prepare('SELECT COUNT(*) n FROM generated_schedule').get().n, cats:db.prepare('SELECT COUNT(*) n FROM categories').get().n};
if(before.rows!==after.rows||before.cats!==after.cats){console.log('  DATA CHANGED');fail++;}
console.log(`  generated_schedule rows ${after.rows} (was ${before.rows}), categories ${after.cats} (was ${before.cats}) — unchanged`);
const optIn=db.prepare("SELECT COUNT(*) n FROM categories WHERE overlay_chain_type IS NOT NULL").get().n;
const placed=db.prepare("SELECT COUNT(*) n FROM generated_schedule WHERE chain_type IS NOT NULL").get().n;
if(optIn!==0||placed!==0) fail++;
console.log(`\n--- nothing has opted in, so no seam can have moved ---`);
console.log(`  categories with a chain type: ${optIn}`);
console.log(`  placements with a chain type: ${placed}`);
console.log('\n--- re-running (idempotence) ---');
require(path.join(__dirname,'migrate-chain-type-autopost-phase-sync-57.js')).applyMigration(db);
db.close(); for(const e of ['','-wal','-shm']){try{fs.unlinkSync(TMP+e);}catch{}}
console.log(`\n${fail===0?'PASS — columns added, no data touched, nothing opted in.':'FAIL — '+fail+' problem(s).'}`);
process.exit(fail===0?0:1);
