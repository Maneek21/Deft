import assert from 'node:assert/strict';import test from 'node:test';import {readNativeFileIntake} from './email-native-file-intake';
const transfer=(files:File[],text='',html='',directory=false)=>({files,items:files.map(file=>({kind:'file',getAsFile:()=>file,webkitGetAsEntry:()=>({isDirectory:directory})})),types:files.length?['Files']:['text/plain','text/html'],getData:(kind:string)=>kind==='text/plain'?text:kind==='text/html'?html:''}) as unknown as DataTransfer;
test('local file-only paste and drop preserve exact File objects; HTML does not become remote intake',()=>{
 const file=new File(['bytes'],'screenshot.png',{type:'image/png'});for(const kind of ['paste','drop'] as const){const result=readNativeFileIntake(transfer([file],'','<img src="https://remote.invalid/image">'),kind);assert.equal(result.kind,'files');assert.equal(result.files[0],file);}
 for(const text of ['', 'ordinary text','https://remote.invalid/file'])assert.deepEqual(readNativeFileIntake(transfer([],text,'<img src="https://remote.invalid/image">'),'paste'),{kind:'none',files:[]});
});
test('mixed text/files preserves ordinary paste and nominates no silently attached files',()=>{
 const file=new File(['x'],'x.txt');assert.deepEqual(readNativeFileIntake(transfer([file],'keep text'),'paste'),{kind:'mixed',files:[]});assert.deepEqual(readNativeFileIntake(transfer([file],' '),'paste'),{kind:'mixed',files:[]});
 assert.equal(readNativeFileIntake(transfer([file],'keep folder description','',true),'paste').kind,'mixed');assert.equal(readNativeFileIntake(transfer(Array.from({length:33},()=>file),'keep description'),'paste').kind,'mixed');
});
test('directory, unavailable clipboard and more-than32 file input are explicitly unsupported',()=>{
 const file=new File(['x'],'x.txt');assert.equal(readNativeFileIntake(transfer([file],'','',true),'drop').kind,'unsupported');assert.equal(readNativeFileIntake({...transfer([]),types:['Files']} as unknown as DataTransfer,'paste').kind,'unsupported');assert.equal(readNativeFileIntake(transfer(Array.from({length:33},()=>file)),'drop').kind,'unsupported');assert.equal(readNativeFileIntake(transfer(Array.from({length:32},()=>file)),'drop').files.length,32);assert.deepEqual(readNativeFileIntake(null,'paste'),{kind:'none',files:[]});
});
