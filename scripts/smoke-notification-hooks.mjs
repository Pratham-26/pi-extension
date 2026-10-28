import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildNotificationHookEnvironment,
  normalizeNotificationHookCommand,
  normalizeNotificationHookEvents,
  runNotificationHook,
} from '../dist/notification-hook.cjs';

const payload = {
  event: 'input_request',
  title: 'Pi Chat',
  message: 'An extension needs input',
  sessionPath: '/local/session.jsonl',
};

assert.equal(normalizeNotificationHookCommand('  /home/user/notify.sh  '), '/home/user/notify.sh');
assert.equal(normalizeNotificationHookCommand('echo ok\nrm -rf /'), '');
assert.deepEqual(normalizeNotificationHookEvents(['agent_finished', 'input_request', 'unknown', 'input_request']), [
  'agent_finished', 'input_request',
]);
assert.deepEqual(normalizeNotificationHookEvents(undefined), ['input_request']);

const env = buildNotificationHookEnvironment(payload, {
  PATH: '/usr/bin',
  HOME: '/home/user',
  API_TOKEN: 'should-not-pass',
  NODE_OPTIONS: '--require=unexpected.js',
  PI_CHAT_HOOK_PUSH_TOKEN: 'explicit-user-opt-in',
}, 'linux');
assert.equal(env.PATH, '/usr/bin');
assert.equal(env.HOME, '/home/user');
assert.equal(env.API_TOKEN, undefined);
assert.equal(env.NODE_OPTIONS, undefined);
assert.equal(env.PI_CHAT_HOOK_PUSH_TOKEN, 'explicit-user-opt-in');
assert.equal(env.PI_CHAT_EVENT, 'input_request');
assert.equal(env.PI_CHAT_TITLE, 'Pi Chat');
assert.equal(env.PI_CHAT_MESSAGE, payload.message);
assert.equal(env.PI_CHAT_SESSION_PATH, payload.sessionPath);

const emptyCommand = await runNotificationHook('', payload);
assert.equal(emptyCommand.success, false);
assert.equal(emptyCommand.reason, 'not-started');

const completed = await runNotificationHook('exit 0', payload);
assert.equal(completed.success, true);
assert.equal(completed.reason, 'completed');

const failed = await runNotificationHook('exit 7', payload);
assert.equal(failed.success, false);
assert.equal(failed.reason, 'exit-failed');
assert.equal(failed.exitCode, 7);

const fakeChild = new EventEmitter();
let hookInput = '';
let hookSpawn;
fakeChild.stdin = {
  once() { return this; },
  end(value) { hookInput = value; },
};
fakeChild.kill = () => true;
const payloadCheck = await runNotificationHook('path with spaces.sh', payload, {
  platform: 'linux',
  environment: { PATH: '/usr/bin', API_TOKEN: 'must-not-pass' },
  spawnProcess(shell, args, spawnOptions) {
    hookSpawn = { shell, args, spawnOptions };
    setImmediate(() => fakeChild.emit('close', 0));
    return fakeChild;
  },
});
assert.equal(payloadCheck.success, true);
assert.equal(hookSpawn.shell, '/bin/sh');
assert.deepEqual(hookSpawn.args, ['-c', 'path with spaces.sh']);
assert.deepEqual(JSON.parse(hookInput), payload);
assert.equal(hookSpawn.spawnOptions.env.API_TOKEN, undefined);
assert.equal(hookSpawn.spawnOptions.env.PI_CHAT_EVENT, payload.event);

console.log('Notification hook smoke checks passed.');
