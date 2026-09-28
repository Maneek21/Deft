import test from 'node:test';
import assert from 'node:assert/strict';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';
test('security DB guard accepts exact CI disposable target and rejects active or widened targets',()=>{
 const original={CI:process.env.CI,DATABASE_URL:process.env.DATABASE_URL,DEFT_TEST_DATABASE_URL:process.env.DEFT_TEST_DATABASE_URL};
 try {
  process.env.CI='true';process.env.DATABASE_URL=process.env.DEFT_TEST_DATABASE_URL='postgres://postgres:postgres@localhost:5432/deft_test';assert.equal(securityTestDatabaseIsSafe(),true);
  process.env.DATABASE_URL='postgres://postgres:postgres@localhost:5432/deft';assert.equal(securityTestDatabaseIsSafe(),false);
  process.env.DEFT_TEST_DATABASE_URL=process.env.DATABASE_URL;assert.equal(securityTestDatabaseIsSafe(),false);
  process.env.CI='false';process.env.DATABASE_URL=process.env.DEFT_TEST_DATABASE_URL='postgres://postgres:postgres@localhost:5432/deft_test';assert.equal(securityTestDatabaseIsSafe(),false);
 } finally {for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
