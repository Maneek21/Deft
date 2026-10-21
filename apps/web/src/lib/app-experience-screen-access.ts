import type {ExperienceNode} from './app-experience-bridge';

/** Only controls on the current screen demand record-write access. Read-only
 * documents and optional controls on other screens do not require a grant. */
export function experienceScreenStoreKeys(root:ExperienceNode):string[]{
 const keys=new Set<string>();
 const visit=(node:ExperienceNode)=>{
  if(node.kind==='record_form'||node.kind==='record_mirror_control'||node.kind==='local_job_schedule'||node.kind==='local_job_list')keys.add(node.store_key);
  if(node.kind==='stack')node.children.forEach(visit);
 };
 visit(root);return [...keys].sort();
}
