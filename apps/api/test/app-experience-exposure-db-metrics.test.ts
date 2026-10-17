import assert from 'node:assert/strict';import test from 'node:test';import pg from 'pg';import {sql} from 'drizzle-orm';
import {createExperienceExposureDatabase} from '../src/lib/app-experience-exposure-db.js';
test('transaction timing observes only durations and preserves query settlement release ordering',async()=>{
 const original=pg.Pool.prototype.connect,events:string[]=[],samples:any[]=[];
 const client={query:async(query:any)=>{events.push(typeof query==='string'?query:query.text);return {rows:[{ok:1}],rowCount:1};},end:async()=>{events.push('discard');},release:(broken:boolean)=>{events.push('release:'+broken);}};
 pg.Pool.prototype.connect=async()=>client as any;const db=createExperienceExposureDatabase('postgres://synthetic:synthetic@127.0.0.1/synthetic');
 try{const result=await db.transaction(tx=>tx.execute(sql`SELECT ${'synthetic-secret-canary'}`),undefined,undefined,s=>samples.push(s));assert.equal(result.rows.length,1);assert.equal(samples.filter(x=>x.kind==='query').length,3);assert.equal(samples.filter(x=>x.kind==='acquisition').length,1);assert.ok(samples.every(x=>Object.keys(x).sort().join(',')==='elapsed_ms,kind'&&Number.isFinite(x.elapsed_ms)&&x.elapsed_ms>=0));assert.equal(JSON.stringify(samples).includes('canary'),false);assert.deepEqual(events,['begin','SELECT $1','commit','release:false']);}
 finally{pg.Pool.prototype.connect=original;await db.close();}
});
test('throwing timing observer cannot alter transaction result or release',async()=>{
 const original=pg.Pool.prototype.connect,events:string[]=[];const client={query:async()=>({rows:[{ok:1}],rowCount:1}),end:async()=>{},release:(b:boolean)=>events.push(String(b))};pg.Pool.prototype.connect=async()=>client as any;const db=createExperienceExposureDatabase('postgres://synthetic:synthetic@127.0.0.1/synthetic');
 try{const r=await db.transaction(tx=>tx.execute(sql`SELECT 1`),undefined,undefined,()=>{throw Error('synthetic-observer-failure');});assert.equal(r.rows.length,1);assert.deepEqual(events,['false']);}
 finally{pg.Pool.prototype.connect=original;await db.close();}
});
test('abort rolls back before healthy release when timing observer is active',async()=>{
 const original=pg.Pool.prototype.connect,controller=new AbortController(),events:string[]=[],samples:any[]=[];const client={query:async(query:any)=>{const text=typeof query==='string'?query:query.text;events.push(text);if(text.startsWith('SELECT'))controller.abort();return {rows:[],rowCount:0};},end:async()=>{events.push('discard');},release:(b:boolean)=>events.push('release:'+b)};pg.Pool.prototype.connect=async()=>client as any;const db=createExperienceExposureDatabase('postgres://synthetic:synthetic@127.0.0.1/synthetic');
 try{await assert.rejects(db.transaction(tx=>tx.execute(sql`SELECT 1`),controller.signal,undefined,s=>samples.push(s)));assert.deepEqual(events,['begin','SELECT 1','rollback','release:false']);assert.ok(samples.some(x=>x.kind==='query'));}
 finally{pg.Pool.prototype.connect=original;await db.close();}
});

for (const boundary of ['begin', 'before_commit', 'commit'] as const) {
  test(`cancellation at ${boundary} preserves transaction settlement`, async () => {
    const original = pg.Pool.prototype.connect;
    const controller = new AbortController(), events: string[] = [];
    const client = {
      query: async (query: string | pg.QueryConfig) => {
        const text = typeof query === 'string' ? query : query.text;
        events.push(text);
        if (text === boundary) controller.abort(new Error('synthetic boundary cancellation'));
        return { rows: [], rowCount: 0 };
      },
      end: async () => { events.push('discard'); },
      release: (broken: boolean) => { events.push(`release:${broken}`); },
    };
    pg.Pool.prototype.connect = async () => client as any;
    const database = createExperienceExposureDatabase('postgres://synthetic:synthetic@127.0.0.1/synthetic');
    try {
      const running = database.transaction(async () => {
        if (boundary === 'before_commit') controller.abort(new Error('synthetic boundary cancellation'));
        return 42;
      }, controller.signal);
      if (boundary === 'commit') {
        assert.equal(await running, 42, 'an acknowledged COMMIT is not undone by later cancellation');
        assert.deepEqual(events, ['begin', 'commit', 'release:false']);
      } else {
        await assert.rejects(running, /synthetic boundary cancellation/);
        assert.deepEqual(events.map(event => event.toLowerCase()), ['begin', 'rollback', 'release:false']);
      }
    } finally { pg.Pool.prototype.connect = original; await database.close(); }
  });
}

test('failed pool acquisition emits duration without changing original error',async()=>{
 const original=pg.Pool.prototype.connect,samples:any[]=[];pg.Pool.prototype.connect=async()=>{throw Error('synthetic-acquisition-failure');};const db=createExperienceExposureDatabase('postgres://synthetic:synthetic@127.0.0.1/synthetic');
 try{await assert.rejects(db.transaction(async()=>1,undefined,undefined,s=>samples.push(s)),/synthetic-acquisition-failure/);assert.equal(samples.length,1);assert.equal(samples[0].kind,'acquisition');assert.ok(Number.isFinite(samples[0].elapsed_ms));}
 finally{pg.Pool.prototype.connect=original;await db.close();}
});
