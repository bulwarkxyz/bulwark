#!/usr/bin/env node
// Before this repo is pushed in public: nothing that must stay private is in a tracked file or anywhere in
// the git history (pushing publishes every commit, not just the last one).
// Usage: node scripts/public-repo-check.mjs   (exit 1 on any finding; prints the file or commit and the rule)
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const RULES = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'hex private key next to a key word', re: /(private|secret|signer|agent)[_ -]?key["'\s:=]+0x[0-9a-fA-F]{64}\b/i },
  { name: 'mnemonic', re: /\b(mnemonic|seed phrase)\b["'\s:=]+["']?([a-z]+ ){11,23}[a-z]+/i },
  { name: 'AWS access key id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'AWS secret access key', re: /aws_secret_access_key\s*[=:]\s*\S{20,}/i },
  { name: 'GitHub token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'Telegram bot token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
  { name: 'Vercel token or bypass secret', re: /x-vercel-protection-bypass|_vercel_share=[A-Za-z0-9]{8,}|VERCEL_TOKEN\s*=\s*\S+/ },
  { name: 'private review alias', re: /bulwark-review-[0-9a-f]{10}/ },
  { name: 'local machine path', re: /\/Users\/[a-z][a-z0-9_-]+\/|\/private\/tmp\/claude-/ },
  { name: 'Hydromancer or RPC key in a URL', re: /[?&](api[_-]?key|apikey|token)=[A-Za-z0-9_-]{16,}/i },
];
const FILE_RULES = [
  { name: 'env file', re: /(^|\/)\.env(\.[a-z]+)?$/, allow: /\.env\.example$/ },
  { name: 'Vercel project link', re: /(^|\/)\.vercel\// },
  { name: 'key or credential file', re: /\.(pem|p12|pfx|key)$/ },
];
const MAX_BYTES = 2 * 1024 * 1024;

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 30 });
const findings = [];

// 1. Tracked files: names, sizes, contents.
for (const f of git('ls-files').split('\n').filter(Boolean)) {
  for (const r of FILE_RULES) if (r.re.test(f) && !(r.allow && r.allow.test(f))) findings.push(`${f}: ${r.name}`);
  let size = 0;
  try {
    size = statSync(f).size;
  } catch {
    continue; // deleted in the working tree
  }
  if (size > MAX_BYTES) findings.push(`${f}: ${(size / 1048576).toFixed(1)} MB, over the 2 MB limit for a tracked file`);
  if (size > MAX_BYTES || /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|pdf)$/i.test(f)) continue;
  const text = git('show', `HEAD:${f}`).toString();
  for (const r of RULES) if (r.re.test(text)) findings.push(`${f}: ${r.name}`);
}

// 2. Every commit reachable from HEAD: added lines only (a secret added and later removed is still public).
const log = git('log', '-p', '--no-color', '--unified=0', '--format=@@commit %H', 'HEAD');
let commit = '';
let file = '';
const seen = new Set();
for (const line of log.split('\n')) {
  if (line.startsWith('@@commit ')) commit = line.slice(9, 17);
  else if (line.startsWith('+++ b/')) file = line.slice(6);
  else if (line.startsWith('+') && !line.startsWith('+++'))
    for (const r of RULES)
      if (r.re.test(line)) {
        const k = `${commit} ${file} ${r.name}`;
        if (!seen.has(k)) findings.push(`history ${commit} ${file}: ${r.name}`), seen.add(k);
      }
}

if (findings.length) {
  console.log(`FAIL: ${findings.length} finding(s)`);
  for (const f of findings) console.log(`  ${f}`);
  process.exit(1);
}
console.log('ok: no secrets, private links, local paths, env or key files, or oversized files in tracked files or history');
