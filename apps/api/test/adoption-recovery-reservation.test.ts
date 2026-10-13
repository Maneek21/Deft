import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {assertAdoptionRecoveryReservation,AdoptionRecoveryConfigSchema,AdoptionRecoveryReservationSchema} from '../src/lib/adoption-recovery-reservation.js';

test('public recovery requires exact persistent read reservation; expiry never frees writer lock',async()=>{
 const root=await mkdtemp(join(tmpdir(),'adoption-public-read-'));try{
  const reservation=AdoptionRecoveryReservationSchema.parse({schema_version:'deft.adoption_recovery_reservation.v1',mode:'recovery_read_only',
   recovery_id:randomUUID(),nonce:'a'.repeat(64),expires_at:new Date(Date.now()+60000).toISOString(),adoption_id:randomUUID(),snapshot_digest:'b'.repeat(64),runtime_receipt_digest:'c'.repeat(64)});
  const bytes=Buffer.from(JSON.stringify(reservation)+'\n');
  const config=AdoptionRecoveryConfigSchema.parse({schema_version:'deft.adoption_recovery_read.v1',scope:{org_id:randomUUID(),owner_user_id:randomUUID(),account_id:'original_opaque'},
   writer_root:root,reservation,reservation_sha256:createHash('sha256').update(bytes).digest('hex')});
  await assert.rejects(assertAdoptionRecoveryReservation(config),'absence is not a fence');
  await mkdir(join(root,'.writer'));await writeFile(join(root,'.writer','owner.json'),JSON.stringify({mode:'forward_writer'}));
  await assert.rejects(assertAdoptionRecoveryReservation(config),'active writer is not recovery');
  await writeFile(join(root,'.writer','owner.json'),bytes);await assertAdoptionRecoveryReservation(config);
  await assert.rejects(assertAdoptionRecoveryReservation(config,new Date(Date.parse(reservation.expires_at))),'finite expiry denies');
  await assert.rejects(mkdir(join(root,'.writer')),'expired public reads never release persistent writer exclusion');
  await assert.rejects(assertAdoptionRecoveryReservation({...config,reservation:{...reservation,nonce:'d'.repeat(64)}}),'foreign reservation denied');
  await writeFile(join(root,'.writer','owner.json'),Buffer.concat([bytes,Buffer.from(' ')]));
  await assert.rejects(assertAdoptionRecoveryReservation(config),'byte change denied even with same parsed meaning');
 }finally{await rm(root,{recursive:true,force:true});}
});
