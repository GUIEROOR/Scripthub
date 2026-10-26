const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const key = site => 'GUIEROOR.ForumCheckin.v1.' + site;
const qmBase = 'https://www.1000qm.vip';
const sbBase = 'https://linux.sb';
const qmAuth = '<a href="member.php?mod=logging&amp;action=logout&amp;formhash=abc12345">退出</a>';
const qmForm = '<form id="qiandao" action="plugin.php?id=dsu_paulsign:sign&amp;operation=qiandao&amp;infloat=1"><input type="hidden" name="formhash" value="abc12345"><input name="todaysay" value=""></form>';
const qmBefore = qmAuth + qmForm + '<p>今天签到了吗？请选择心情</p>';
const qmAfter = qmAuth + '<p>您今天已经签到过了，请明天再来。</p>';
const sbAuth = '<main data-home-keyword-filter-user-id="42"><a href="/profile">个人资料</a><a href="/direct_messages">消息</a></main>';
const challenge = '<title>Just a moment...</title><script>window._cf_chl_opt = {};</script>';
const response = (body, status = 200, headers = {}) => ({ body, status, headers });

async function run(site, options = {}) {
  const base = site === 'qianmoju' ? qmBase : sbBase;
  const store = { [key(site)]: JSON.stringify({ base, cookie: 'auth=SECRET', ua: 'Safari-test' }), ...(options.store || {}) };
  const calls = [], notifications = [], logs = [];
  let doneCalls = 0;
  let resolveDone;
  const finished = new Promise(resolve => { resolveDone = resolve; });
  const queue = [...(options.responses || [])];
  function send(method) {
    return (request, cb) => {
      calls.push({ method, ...request });
      const item = queue.shift();
      if (!item) { cb('unexpected request'); return; }
      if (item.mutate) item.mutate(store);
      if (item.error) { cb(item.error); return; }
      cb(null, { status: item.status, headers: item.headers }, item.body);
    };
  }
  const context = {
    $argument: options.args || {},
    $script: { name: options.manual ? '手动执行' : '自动执行' },
    $httpClient: { get: send('GET'), post: send('POST') },
    $persistentStore: { read: k => store[k], write: (v, k) => { if (options.writeFails) return false; store[k] = v; return true; } },
    $notification: { post: (...args) => notifications.push(args) },
    $done: () => { doneCalls++; resolveDone(); },
    console: { log: value => logs.push(String(value)) },
    ...(options.capture ? { $request: options.capture.request, $response: options.capture.response } : {})
  };
  if (options.noRecord) delete store[key(site)];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, site + '.js'), 'utf8'), context, { timeout: 1000 });
  await finished;
  assert.equal(doneCalls, 1, '$done must be called once');
  assert.ok(![...logs, ...notifications.flat()].join('\n').includes('SECRET'), 'credentials must not be logged');
  return { calls, notifications, logs, store };
}
const success = r => r.logs.some(l => l.includes('] 成功：'));
const failure = r => r.logs.some(l => l.includes('] 未完成：'));

test('Qianmoju submits current formhash and verifies the signed-in result', async () => {
  const r = await run('qianmoju', { responses: [response(qmBefore), response('<root><![CDATA[恭喜您签到成功]]></root>'), response(qmAfter)] });
  assert.ok(success(r));
  assert.deepEqual(r.calls.map(c => c.method), ['GET', 'POST', 'GET']);
  assert.match(r.calls[1].body, /formhash=abc12345/);
  assert.match(r.calls[1].body, /qdxq=kx/);
  assert.equal(r.calls[1]['auto-redirect'], false);
  assert.equal(r.notifications.length, 0);
});
test('already signed skips POST', async () => {
  const r = await run('qianmoju', { responses: [response(qmAfter)] });
  assert.ok(success(r)); assert.equal(r.calls.length, 1);
});
test('leaderboard generic signed text does not prove own attendance', async () => {
  const r = await run('qianmoju', { responses: [response(qmAuth + '<table>今日已签到 300 人</table>')] });
  assert.ok(failure(r)); assert.equal(r.calls.length, 1);
});
test('sign-in time has not started does not report already signed', async () => {
  const r = await run('qianmoju', { responses: [response(qmAuth + '您今天已经签到过了或者签到时间还未开始')] });
  assert.ok(failure(r));
});
test('a submitted failure with unchanged form never reports success', async () => {
  const r = await run('qianmoju', { responses: [response(qmBefore), response('签到失败'), response(qmBefore)] });
  assert.ok(failure(r)); assert.equal(r.calls.filter(c => c.method === 'POST').length, 1);
});
test('post acknowledgement alone with logged-out refresh is insufficient', async () => {
  const r = await run('qianmoju', { responses: [response(qmBefore), response('签到成功'), response('<form action="member.php?mod=logging&action=login">登录</form>')] });
  assert.ok(failure(r));
});
test('success acknowledgement contradicted by unchanged active form is rejected', async () => {
  const r = await run('qianmoju', { responses: [response(qmBefore), response('签到成功'), response(qmBefore)] });
  assert.ok(failure(r));
});
test('expired cookie with Expires comma is merged and used only on the same origin', async () => {
  const r = await run('qianmoju', { responses: [response(qmBefore, 200, { 'Set-Cookie': 'transient=; Expires=Thu, 01 Jan 1970 00:00:00 GMT, auth=NEW; Path=/' }), response('签到成功'), response(qmAfter)] });
  assert.ok(success(r));
  assert.equal(r.calls[1].headers.Cookie, 'auth=NEW');
  assert.equal(JSON.parse(r.store[key('qianmoju')]).cookie, 'auth=NEW');
});
test('missing formhash prevents submission', async () => {
  const r = await run('qianmoju', { responses: [response(qmBefore.replace(/abc12345/g, ''))] });
  assert.ok(failure(r)); assert.equal(r.calls.length, 1);
});
test('external form action cannot receive cookies', async () => {
  const bad = qmBefore.replace('action="plugin.php', 'action="https://evil.invalid/plugin.php');
  const r = await run('qianmoju', { responses: [response(bad)] });
  assert.ok(failure(r)); assert.equal(r.calls.length, 1);
});
test('cross-host redirect is rejected before a second request', async () => {
  const r = await run('linux-sb', { responses: [response('', 302, { Location: 'https://evil.invalid/' })] });
  assert.ok(failure(r)); assert.equal(r.calls.length, 1);
});
test('same-origin login redirect requests a refreshed cookie', async () => {
  const r = await run('linux-sb', { responses: [response('', 302, { Location: '/login' })] });
  assert.ok(failure(r)); assert.equal(r.calls.length, 1);
});
test('same-origin normal redirect can reach authenticated homepage', async () => {
  const r = await run('linux-sb', { responses: [response('', 302, { Location: '/?page=1' }), response(sbAuth)] });
  assert.ok(success(r)); assert.equal(r.calls.length, 2);
});
test('redirect loop is bounded', async () => {
  const r = await run('linux-sb', { responses: Array.from({ length: 4 }, () => response('', 302, { Location: '/' })) });
  assert.ok(failure(r)); assert.equal(r.calls.length, 4);
});
test('POST redirects are not retried or followed', async () => {
  const r = await run('qianmoju', { responses: [response(qmBefore), response('', 302, { Location: '/' })] });
  assert.ok(failure(r)); assert.equal(r.calls.length, 2);
});
test('LINUX SB positive account evidence succeeds with GET only', async () => {
  const r = await run('linux-sb', { responses: [response(sbAuth)], manual: true });
  assert.ok(success(r)); assert.equal(r.notifications.length, 1);
  assert.deepEqual(r.calls.map(c => c.method), ['GET']);
});
test('LINUX SB logout link also proves login', async () => {
  assert.ok(success(await run('linux-sb', { responses: [response('<a href="/logout">退出</a>')] })));
});
for (const [name, html] of [
  ['public 200', '<title>LINUX SB</title>积分 100 已签到'],
  ['login page', '<a href="/login">登录</a>'],
  ['partial navigation', '<a href="/profile">个人资料</a>'],
  ['identity without account navigation', '<div data-home-keyword-filter-user-id="42">'],
  ['script-only account markup', '<script>' + JSON.stringify(sbAuth) + '</script>'],
  ['external logout', '<a href="https://evil.invalid/logout">退出</a>'],
  ['zero user ID', sbAuth.replace('="42"', '="0"')],
  ['login and logout together', sbAuth + '<a href="/login">登录</a>'],
  ['human challenge', challenge + sbAuth]
]) test('LINUX SB rejects ' + name, async () => {
  const r = await run('linux-sb', { responses: [response(html)] });
  assert.ok(failure(r)); assert.equal(r.notifications.length, 1);
});
test('capture stores only authenticated response and does not issue requests', async () => {
  const r = await run('linux-sb', { noRecord: true, capture: { request: { url: sbBase + '/', method: 'GET', headers: { cookie: 'auth=SECRET', 'user-agent': 'Safari' } }, response: response(sbAuth) } });
  assert.equal(JSON.parse(r.store[key('linux-sb')]).ua, 'Safari');
  assert.equal(r.calls.length, 0); assert.equal(r.notifications.length, 1);
});
test('challenge capture preserves known credentials without notification spam', async () => {
  const r = await run('linux-sb', { capture: { request: { url: sbBase + '/', headers: { Cookie: 'bad=NEW' } }, response: response(challenge) } });
  assert.equal(JSON.parse(r.store[key('linux-sb')]).cookie, 'auth=SECRET');
  assert.equal(r.notifications.length, 0);
});
test('Qianmoju capture accepts authenticated account and current host', async () => {
  const r = await run('qianmoju', { noRecord: true, capture: { request: { url: 'https://1000qm.vip/plugin.php?id=dsu_paulsign:sign', headers: { Cookie: 'auth=SECRET' } }, response: response(qmAuth) } });
  assert.equal(JSON.parse(r.store[key('qianmoju')]).base, 'https://1000qm.vip');
});
test('missing credentials yields actionable error without network activity', async () => {
  const r = await run('qianmoju', { noRecord: true });
  assert.ok(failure(r)); assert.equal(r.calls.length, 0);
});
test('bad stored host cannot receive credentials', async () => {
  const r = await run('linux-sb', { store: { [key('linux-sb')]: JSON.stringify({ base: 'https://evil.invalid', cookie: 'auth=SECRET' }) } });
  assert.ok(failure(r)); assert.equal(r.calls.length, 0);
});
test('CRLF credentials rejected before HTTP', async () => {
  const r = await run('linux-sb', { store: { [key('linux-sb')]: JSON.stringify({ base: sbBase, cookie: 'auth=SECRET\r\nx: y' }) } });
  assert.ok(failure(r)); assert.equal(r.calls.length, 0);
});
test('successful cookie refresh is persisted, other site is untouched', async () => {
  const other = JSON.stringify({ base: qmBase, cookie: 'other=private' });
  const r = await run('linux-sb', { store: { [key('qianmoju')]: other }, responses: [response(sbAuth, 200, { 'Set-Cookie': 'auth=NEW; Path=/; Secure' })] });
  assert.equal(JSON.parse(r.store[key('linux-sb')]).cookie, 'auth=NEW');
  assert.equal(r.store[key('qianmoju')], other);
});
test('failed response does not persist invalidated cookie', async () => {
  const r = await run('linux-sb', { responses: [response('<a href="/login">登录</a>', 200, { 'Set-Cookie': 'auth=; Max-Age=0' })] });
  assert.ok(failure(r)); assert.equal(JSON.parse(r.store[key('linux-sb')]).cookie, 'auth=SECRET');
});
test('old task cannot overwrite a freshly captured record', async () => {
  const fresh = JSON.stringify({ base: sbBase, cookie: 'auth=FRESH', ua: 'fresh' });
  const r = await run('linux-sb', { responses: [{ ...response(sbAuth), mutate: store => { store[key('linux-sb')] = fresh; } }] });
  assert.equal(r.store[key('linux-sb')], fresh);
});
test('node and notification options are applied', async () => {
  const r = await run('linux-sb', { args: { sbNode: '我的策略', notifySuccess: true }, responses: [response(sbAuth)] });
  assert.equal(r.calls[0].node, '我的策略'); assert.equal(r.notifications.length, 1);
});
test('network errors are sanitized rather than echoing credential-rich errors', async () => {
  const r = await run('linux-sb', { responses: [{ error: 'auth=SECRET' }] });
  assert.ok(failure(r));
});
test('HTTP failure is never success', async () => {
  assert.ok(failure(await run('linux-sb', { responses: [response(sbAuth, 503)] })));
});
test('storage failure is reported as failure', async () => {
  assert.ok(failure(await run('linux-sb', { responses: [response(sbAuth)], writeFails: true })));
});
test('plugin references declared arguments and the two shipped scripts', () => {
  const plugin = fs.readFileSync(path.join(__dirname, '../../forum-checkin.lpx'), 'utf8');
  const argumentsSection = plugin.split('[Argument]')[1].split('[Script]')[0];
  const declared = new Set([...argumentsSection.matchAll(/^(\w+)\s*=/gm)].map(m => m[1]));
  for (const [, ref] of plugin.matchAll(/\$\{(\w+)\}/g)) assert.ok(ref === 'url' || declared.has(ref), 'undeclared ' + ref);
  assert.equal((plugin.match(/^cron /gm) || []).length, 2);
  assert.equal((plugin.match(/^generic /gm) || []).length, 2);
  for (const [, script] of plugin.matchAll(/forum-checkin\/(\w[\w-]*\.js)/g)) assert.ok(fs.existsSync(path.join(__dirname, script)));
});
