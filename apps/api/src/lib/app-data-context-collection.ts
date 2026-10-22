import {isDeepStrictEqual} from 'node:util';

/** One context disclosure, never an authority cache. Actual metadata I/O stays
 * between two fresh proofs. Without metadata there is no intervening work, so
 * only the final capture precedes current stores and the terminal saved fence. */
export async function collectAppDataContext<Base, Store, Identity>(ports:{
 capture:()=>Promise<Base>;
 identity:(base:Base)=>unknown;
 stores:(base:Base)=>Promise<Store[]>;
 metadata?:(base:Base)=>Promise<Identity[]>;
 finish:(base:Base)=>Promise<void>;
 denied:()=>Error;
}):Promise<{base:Base;stores:Store[];identities:Identity[]}> {
 let base:Base,identities:Identity[]=[];
 if(ports.metadata){
  const before=await ports.capture();
  identities=await ports.metadata(before);
  base=await ports.capture();
  if(!isDeepStrictEqual(ports.identity(before),ports.identity(base)))throw ports.denied();
 }else base=await ports.capture();
 const stores=await ports.stores(base);
 await ports.finish(base);
 return {base,stores,identities};
}
