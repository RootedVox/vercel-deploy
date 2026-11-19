import assert from 'node:assert/strict';
import test from 'node:test';
import { runPageScript } from './page-script.js';

test('moderation reasons belong to one decision and survive a failed submission', async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', style: {}, children: [], focus() {}, after() {}, querySelector() { return null; },
      addEventListener(type, fn) { this[type] = fn; }
    });
    return elements.get(id);
  }
  const requests = [];
  const alerts = [];
  runPageScript('checker-ui.js', {
    document: {
      body: { dataset: { status: 'pending' } }, getElementById: element,
      querySelector: element, createElement: element
    },
    RootedVoxAuth: { getSession: () => new Promise(() => {}) },
    request: (_, options) => {
      const { promise, resolve } = Promise.withResolvers();
      requests.push({ body: JSON.parse(options.body), resolve });
      return promise;
    },
    alert: message => alerts.push(message)
  });
  function open(id, action) {
    const button = { dataset: { id, action } };
    return element('list').click({ target: { closest: selector => selector === 'button[data-action]' ? button : null } });
  }
  const reason = element('reasonInput'), cancel = element('cancelReason'), confirm = element('confirmReason');
  await open('A', 'reject');
  reason.value = 'reason for A';
  cancel.click();
  await open('B', 'delete');
  assert.equal(reason.value, '');
  await confirm.click({ target: confirm });
  assert.equal(requests.length, 0);
  assert.deepEqual(alerts, ['请填写原因']);

  reason.value = 'reason for B';
  const submission = confirm.click({ target: confirm });
  assert.equal(cancel.disabled, true);
  assert.deepEqual(requests[0].body, { id: 'B', action: 'delete', reason: 'reason for B' });
  requests[0].resolve(Response.json({ error: 'moderation_conflict' }, { status: 409 }));
  await submission;
  assert.equal(reason.value, 'reason for B');
  assert.equal(element('reasonModal').style.display, 'flex');
  assert.equal(cancel.disabled, false);
  assert.equal(confirm.disabled, false);
  const retry = confirm.click({ target: confirm });
  assert.deepEqual(requests[1].body, requests[0].body);
  requests[1].resolve(Response.json({ ok: true }));
  await retry;
  assert.equal(element('reasonModal').style.display, 'none');
  assert.equal(reason.value, '');
});
