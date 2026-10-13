import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {z} from 'zod';

const Hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const AdoptionRecoveryReservationSchema=z.strictObject({
 schema_version:z.literal('deft.adoption_recovery_reservation.v1'),mode:z.literal('recovery_read_only'),
 recovery_id:z.string().uuid(),nonce:Hash,expires_at:z.iso.datetime(),adoption_id:z.string().uuid(),
 snapshot_digest:Hash,runtime_receipt_digest:Hash});
export const AdoptionRecoveryConfigSchema=z.strictObject({schema_version:z.literal('deft.adoption_recovery_read.v1'),
 scope:z.strictObject({org_id:z.string().uuid(),owner_user_id:z.string().uuid(),account_id:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u)}),
 writer_root:z.string().min(1).refine(isAbsolute),reservation:AdoptionRecoveryReservationSchema,reservation_sha256:Hash});
export type AdoptionRecoveryConfig=z.infer<typeof AdoptionRecoveryConfigSchema>;
export const recoveryDenied=()=>new Error('ADOPTION_RECOVERY_ACCESS_DENIED');
/** Private operator configuration, never a caller-selected path or authority.
 * The SAME persistent lock used by retained/forward writers is reserved by
 * the recovery operator. Expiry denies reads; it never releases that lock. */
export async function assertAdoptionRecoveryReservation(config:AdoptionRecoveryConfig,now=new Date()){
 if(!Number.isFinite(now.getTime())||Date.parse(config.reservation.expires_at)<=now.getTime())throw recoveryDenied();
 const root=await lstat(config.writer_root),lock=await lstat(join(config.writer_root,'.writer'));
 if(!root.isDirectory()||root.isSymbolicLink()||!lock.isDirectory()||lock.isSymbolicLink())throw recoveryDenied();
 const path=join(config.writer_root,'.writer','owner.json'),before=await lstat(path);
 if(!before.isFile()||before.isSymbolicLink()||before.size>8192)throw recoveryDenied();
 const bytes=await readFile(path),after=await lstat(path);
 if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.size!==after.size
  ||createHash('sha256').update(bytes).digest('hex')!==config.reservation_sha256
  ||JSON.stringify(AdoptionRecoveryReservationSchema.parse(JSON.parse(bytes.toString('utf8'))))!==JSON.stringify(config.reservation))throw recoveryDenied();
 if(Date.parse(config.reservation.expires_at)<=Date.now())throw recoveryDenied();
}
export async function loadAdoptionRecoveryConfig(){
 const path=process.env.DEFT_ADOPTION_RECOVERY_READ_CONFIG;if(!path||!isAbsolute(path))throw recoveryDenied();
 const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.size>16384)throw recoveryDenied();
 const bytes=await readFile(path);return {config:AdoptionRecoveryConfigSchema.parse(JSON.parse(bytes.toString('utf8'))),
  digest:createHash('sha256').update(bytes).digest('hex')};
}
