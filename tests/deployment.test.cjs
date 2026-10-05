const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

test('deployment accepts master and Actions detached HEAD, but rejects developer', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webbanhang-deploy-test-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(path.join(__dirname, '../scripts/deploy-production.ps1'), path.join(root, 'scripts/deploy-production.ps1'));
    git('init', '-b', 'master');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'Fixture');
    const sha = git('rev-parse', 'HEAD');
    const validate = ref => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/deploy-production.ps1'), '-ValidateOnly'], {
      encoding: 'utf8', env: { ...process.env, GITHUB_REF: ref }, windowsHide: true,
    });
    assert.equal(validate('').status, 0);
    git('checkout', '--detach');
    const detached = validate('refs/heads/master');
    assert.equal(detached.status, 0, detached.stderr);
    assert.equal(detached.stdout.trim(), sha);
    assert.notEqual(validate('refs/heads/developer').status, 0);
    git('switch', '-c', 'developer');
    assert.notEqual(validate('').status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
