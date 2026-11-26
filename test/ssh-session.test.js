import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import {
  sshFingerprintFromKey,
  ssh_session_open,
  ssh_session_write,
  ssh_session_read,
  ssh_session_resize,
  ssh_session_close,
  activeSshSessionCount,
  closeAllSshSessions,
} from '../src/tools/ssh.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('SSH session: strict host fingerprint, password auth, interactive I/O, resize and close', async (t) => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const parsed = ssh2.utils.parseKey(privateKey);
  const trustedFingerprint = sshFingerprintFromKey(parsed.getPublicSSH());

  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => {}); // Rejected client-side host fingerprint ends this test connection.
    client.on('authentication', (ctx) => {
      if (ctx.username === 'test-user' && ctx.method === 'password' && ctx.password === 'unit-test-secret') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty());
        session.on('shell', (acceptShell) => {
          const channel = acceptShell();
          channel.write('test-shell-ready> ');
          channel.on('data', (data) => channel.write(Buffer.from(`REMOTE:${data.toString()}`)));
        });
      });
    });
  });
  server.on('error', () => {}); // A deliberately rejected host-key handshake may emit a server error.
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  let openedSessionId = null;
  t.after(async () => {
    closeAllSshSessions();
    if (openedSessionId) await ssh_session_close({ session_id: openedSessionId });
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;

  const wrongFingerprint = await ssh_session_open({
    host: '127.0.0.1', port, username: 'test-user', auth_method: 'password',
    password: 'unit-test-secret', host_fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  });
  assert.equal(wrongFingerprint.isError, true);
  assert.doesNotMatch(wrongFingerprint.text, /unit-test-secret/);
  assert.equal(activeSshSessionCount(), 0);

  const opened = await ssh_session_open({
    host: '127.0.0.1', port, username: 'test-user', auth_method: 'password',
    password: 'unit-test-secret', host_fingerprint: trustedFingerprint,
  });
  assert.equal(opened.isError, false, opened.text);
  assert.match(opened.text, /主机指纹验证：通过/);
  const id = opened.text.match(/会话 ID：([0-9a-f-]{36})/)?.[1];
  assert.ok(id);
  openedSessionId = id;

  let output = '';
  for (let i = 0; i < 10 && !output.includes('test-shell-ready'); i++) {
    output += (await ssh_session_read({ session_id: id, wait_ms: 200 })).text;
  }
  assert.match(output, /test-shell-ready/);

  const sent = await ssh_session_write({ session_id: id, data: 'printf test\n' });
  assert.equal(sent.isError, false);
  let echoed = '';
  for (let i = 0; i < 10 && !echoed.includes('REMOTE:'); i++) {
    echoed += (await ssh_session_read({ session_id: id, wait_ms: 200 })).text;
  }
  assert.match(echoed, /REMOTE:printf test/);

  const resized = await ssh_session_resize({ session_id: id, cols: 100, rows: 30 });
  assert.equal(resized.isError, false);
  assert.match(resized.text, /100 列 × 30 行/);
  assert.equal(activeSshSessionCount(), 1);

  const closed = await ssh_session_close({ session_id: id });
  assert.equal(closed.isError, false);
  assert.equal(activeSshSessionCount(), 0);
  assert.equal((await ssh_session_read({ session_id: id })).isError, true);
});
