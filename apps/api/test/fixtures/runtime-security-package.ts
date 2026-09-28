import { readFileSync } from 'node:fs';
import { buildDeftAppPackage, prepareDeftExperienceArtifact } from '@deft/app-kit';
/** Declarative synthetic package; no provider, account, network access, or external author tree. */
export async function runtimeSecurityPackage() {
  const manifest = JSON.parse(readFileSync(new URL('./runtime-security-manifest.json', import.meta.url), 'utf8'));
  const artifact = await prepareDeftExperienceArtifact('experiences/main.json', {
    schema_version: 'deft.experience_bundle.v3', worker_source: 'self.onmessage=()=>{};', entry_view: 'main',
    resource_keys: ['inbox'], action_keys: ['archive_message','reply_message','send_message'], state_keys: ['drafts','requests'],
  });
  manifest.experiences = [{ key:'main',label:'Synthetic workspace',artifact_path:artifact.path,artifact_digest:artifact.digest,
    bridge_version:'deft.experience_bridge.v1',renderer_version:'deft.trusted_renderer.v1' }];
  return buildDeftAppPackage({manifest,artifacts:[artifact]});
}
