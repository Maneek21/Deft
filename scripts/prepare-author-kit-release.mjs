import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function authorKitReleaseMetadata({archive,filename,version,host_release,source_commit}) {
  if (!/^0\.1\.0-alpha\.[1-9][0-9]*$/u.test(version)
    || filename !== `deft-app-kit-${version}.tgz`
    || !/^0\.3\.0-preview\.[1-9][0-9]*$/u.test(host_release)
    || !/^[a-f0-9]{40}$/u.test(source_commit) || !Buffer.isBuffer(archive) || archive.length === 0) {
    throw Error('AUTHOR_KIT_RELEASE_IDENTITY_INVALID');
  }
  return {schema:'deft.author_kit_release.v1',version,filename,host_release,
    source_repository:'Maneek21/Deft',source_commit,
    sha256:createHash('sha256').update(archive).digest('hex'),
    integrity:'sha512-'+createHash('sha512').update(archive).digest('base64')};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root=fileURLToPath(new URL('..',import.meta.url));
  const kit=JSON.parse(readFileSync(resolve(root,'packages/app-kit/package.json'),'utf8'));
  const host=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  if (kit.name!=='@deft/app-kit' || process.env.RELEASE_COMMIT!==head
    || process.env.RELEASE_VERSION!==host.version) throw Error('AUTHOR_KIT_RELEASE_SOURCE_MISMATCH');
  execFileSync('git',['diff','--exit-code','HEAD','--','packages/app-kit'],{cwd:root,stdio:'pipe'});
  const {DEFT_APP_KIT_VERSION}=await import('../packages/app-kit/dist/core.js');
  if (DEFT_APP_KIT_VERSION!==kit.version) throw Error('AUTHOR_KIT_RELEASE_BUILD_MISMATCH');
  const filename=`deft-app-kit-${kit.version}.tgz`,archive=readFileSync(resolve(root,'dist',filename));
  const metadata=authorKitReleaseMetadata({archive,filename,version:kit.version,host_release:host.version,source_commit:head});
  writeFileSync(resolve(root,'dist/author-kit-release.json'),JSON.stringify(metadata,null,2)+'\n');
  console.log(`Author Kit ${kit.version}: ${basename(filename)} sha256:${metadata.sha256}`);
}
