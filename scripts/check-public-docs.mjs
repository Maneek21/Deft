import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const root = process.cwd();
const files = ['README.md','FEATURES.md','docs/README.md','docs/documentation-maintenance.md','docs/examples/README.md','docs/modules-and-apps.md','docs/product-status.md','docs/current-limitations.md','docs/getting-started.md','docs/connected-app-author-guide.md','docs/self-hosted-v1-contract.md', ...(await readdir('docs/tutorials')).filter(f=>f.endsWith('.md')).map(f=>`docs/tutorials/${f}`)];
const errors = [];
for (const file of files) {
  const text = await readFile(file,'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = match[1];
    if (/^(https?:|mailto:|#)/.test(link)) continue;
    if (link.startsWith('/')) { errors.push(`${file}: web-root link does not work on GitHub: ${link}`); continue; }
    const [path,fragment] = link.split('#');
    const target = resolve(dirname(resolve(root,file)),path);
    try {
      await stat(target);
      if(fragment && target.endsWith('.md')) {
        const other = await readFile(target,'utf8');
        const anchors = [...other.matchAll(/^#{1,6} (.+)$/gm)].map(m=>m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').replace(/ /g,'-'));
        if(!anchors.includes(fragment)) errors.push(`${file}: missing heading ${link}`);
      }
    } catch { errors.push(`${file}: missing target ${link}`); }
  }
  for(const match of text.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
    try { JSON.parse(match[1]); } catch { errors.push(`${file}: invalid JSON example`); }
  }
}
if(errors.length){ console.error(errors.join('\n')); process.exitCode=1; }
else console.log(`Public docs checks passed: ${files.length} entry points and tutorials.`);
