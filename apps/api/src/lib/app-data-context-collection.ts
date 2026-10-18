import {isDeepStrictEqual} from 'node:util';

/** One context disclosure, never an authority cache. Collect optional metadata
 * between two fresh connection proofs, then disclose only stores validated from
 * the final proof. A changed scope/account/policy discards all collected data. */
export async function collectAppDataContext<Base, Store, Identity>(ports:{
 capture:()=>Promise<Base>;
 identity:(base:Base)=>unknown;
 stores:(base:Base)=>Promise<Store[]>;
 metadata:(base:Base)=>Promise<Identity[]>;
 finish:(base:Base)=>Promise<void>;
 denied:()=>Error;
}):Promise<{base:Base;stores:Store[];identities:Identity[]}> {
 const before=await ports.capture();
 const identities=await ports.metadata(before);
 const base=await ports.capture();
 if(!isDeepStrictEqual(ports.identity(before),ports.identity(base)))throw ports.denied();
 const stores=await ports.stores(base);
 await ports.finish(base);
 return {base,stores,identities};
}
