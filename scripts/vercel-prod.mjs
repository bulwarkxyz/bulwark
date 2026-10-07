// Prints the production deployment Vercel is serving for the linked project, as JSON {id, url}: after an instant
// rollback, Vercel keeps serving the rolled-back-to deployment and new production deploys are not assigned to the
// domains until one is promoted, so "the newest deployment" is not necessarily the live one.
// Reads the project from .vercel/project.json and the token from the Vercel CLI's own login (never printed).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { projectId, orgId } = JSON.parse(readFileSync(new URL('../.vercel/project.json', import.meta.url), 'utf8'));
const { token } = JSON.parse(readFileSync(`${homedir()}/Library/Application Support/com.vercel.cli/auth.json`, 'utf8'));
const r = await fetch(`https://api.vercel.com/v9/projects/${projectId}?teamId=${orgId}`, { headers: { authorization: `Bearer ${token}` } });
const p = (await r.json()).targets?.production;
if (!p?.id) process.exit(1);
console.log(JSON.stringify({ id: p.id, url: p.url ? `https://${p.url}` : null }));
