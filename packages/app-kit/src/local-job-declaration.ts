import {z} from 'zod';
const key=z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).refine(x=>!['constructor','prototype','__proto__'].includes(x));
/** A reviewed local state transition, not a provider/effect grant. */
export const AppLocalJobOperationsSchema=z.array(z.strictObject({key,local_only:z.literal(true)})).min(1).max(8).refine(rows=>rows.every((row,index)=>!index||rows[index-1]!.key<row.key));
