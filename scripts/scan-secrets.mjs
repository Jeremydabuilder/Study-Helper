// A small secret scanner for CI and pre-release checks: looks for credential-shaped strings in tracked files. It is a safety net, not a replacement for a dedicated scanner.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter((f) => f && !/\.(png|jpe?g|pdf|lock)$|package-lock\.json$/.test(f));
const rules = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/], ['OpenAI-style key', /sk-[A-Za-z0-9]{32,}/], ['Groq key', /gsk_[A-Za-z0-9]{30,}/], ['Google client secret', /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/], ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/], ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Database URL with password', /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]{6,}@(?!localhost|127\.0\.0\.1)[^\s/]+/],
];
const hits = [];
for (const f of files) { let t; try { t = readFileSync(f, 'utf8'); } catch { continue; } for (const [name, re] of rules) if (re.test(t)) hits.push(`${f}: ${name}`); }
if (hits.length) { console.error('Possible secrets found:\n' + hits.join('\n')); process.exit(1); }
console.log(`secret scan: ${files.length} tracked files, no credential-shaped strings found`);
