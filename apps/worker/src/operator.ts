/**
 * The operator's global stop: halts the guard for every account at once. Nothing is evaluated, signed or cancelled;
 * the guard's resting backstops stay on Hyperliquid. Each user is told once. Run inside the worker's environment so
 * the database URL is never on screen:
 *
 *   railway run --service worker -- npx tsx src/operator.ts status
 *   railway run --service worker -- npx tsx src/operator.ts stop "reason shown to users"
 *   railway run --service worker -- npx tsx src/operator.ts resume
 */
import postgres from 'postgres';
import { PgStore } from '@bulwarkxyz/store';

const [cmd, reason] = process.argv.slice(2);
const sql = postgres(process.env.DATABASE_URL as string, { onnotice: () => undefined, max: 1 });
const store = new PgStore(sql);
try {
  if (cmd === 'stop') {
    if (!reason) throw new Error('give a reason; users see it');
    await store.setOperatorState('global_stop', { on: true, reason }, Date.now());
    console.log(`Global stop ON (${reason}). The worker stops acting for every account within a few seconds; backstops stay.`);
  } else if (cmd === 'resume') {
    await store.setOperatorState('global_stop', { on: false, reason: null }, Date.now());
    console.log('Global stop OFF. The guard resumes on the next price update.');
  } else if (cmd === 'status') {
    const s = await store.operatorState<{ on: boolean; reason: string | null }>('global_stop');
    const hb = await store.operatorState<{ lastMarkAt: number; staleAccounts: number; tracked: number }>('worker_heartbeat');
    console.log(JSON.stringify({ globalStop: s ? { ...s.value, since: new Date(s.at).toISOString() } : { on: false }, workerHeartbeat: hb ? { ageS: Math.round((Date.now() - hb.at) / 1000), ...hb.value } : null }, null, 1));
  } else throw new Error('usage: operator.ts status | stop "reason" | resume');
} finally {
  await sql.end();
}
