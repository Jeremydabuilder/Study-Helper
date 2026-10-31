// Run after build:hosted. These commands must work without the removed tsx CLI.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const env = { PATH: process.env.PATH, HOME: process.env.HOME, APP_ENV: 'production', DATA_LABEL: 'production' };
const run = (file, args = [], patch = {}) => spawnSync(process.execPath, [file, ...args], { env: { ...env, ...patch }, encoding: 'utf8', timeout: 10000 });
const help = run('dist-server/operator.mjs', ['help']);
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Study Helper operator commands/);
const prodSeed = run('dist-server/seed-staging.mjs');
assert.equal(prodSeed.status, 2, prodSeed.stderr);
assert.match(prodSeed.stderr, /APP_ENV is not/);
const wrongLabel = run('dist-server/seed-staging.mjs', [], { APP_ENV: 'staging', DATA_LABEL: 'production' });
assert.equal(wrongLabel.status, 2, wrongLabel.stderr);
assert.match(wrongLabel.stderr, /DATA_LABEL/);
console.log('Release tools: operator help and staging environment guards passed.');
