/*
 * Forum Check-in v1.0.0 — standalone Loon runtime; no Node/browser dependencies.
 * HTTP flow and login-evidence design adapted from HughRyu/SignMate (MIT).
 * See THIRD_PARTY_LICENSES.md. Credentials stay in Loon local storage.
 */
(function () {
  "use strict";
  var SITE = "linux-sb";
  var NAME = SITE === "qianmoju" ? "阡陌居签到" : "LINUX SB 保活";
  var KEY = "GUIEROOR.ForumCheckin.v1." + SITE;
  var args = typeof $argument === "object" && $argument ? $argument : {};
  var manual = typeof $script !== "undefined" && /手动/.test($script.name || "");
  var node = String(args[SITE === "qianmoju" ? "qmNode" : "sbNode"] || "").trim();
  var ended = false;
  var requests = 0;

  function finish(ok, message, alwaysNotify) {
    if (ended) return;
    ended = true;
    console.log("[" + NAME + "] " + (ok ? "成功：" : "未完成：") + message);
    if (!ok || manual || alwaysNotify || args.notifySuccess === true || args.notifySuccess === "true") {
      $notification.post(NAME, ok ? "完成" : "需要处理", message);
    }
    $done(typeof $request !== "undefined" ? {} : undefined);
  }
  function fail(message) { throw new Error(message); }
  function header(headers, name) {
    var key = Object.keys(headers || {}).find(function (k) { return k.toLowerCase() === name.toLowerCase(); });
    return key ? headers[key] : "";
  }
  function decode(s) {
    return String(s || "").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
      .replace(/&#(?:39|x27);|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); });
  }
  function markup(html) {
    return String(html || "").replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  }
  function text(html) { return decode(markup(html).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim(); }
  function attr(tag, name) {
    var hit = tag.match(new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
    return hit ? decode(hit[1] !== undefined ? hit[1] : hit[2] !== undefined ? hit[2] : hit[3]) : "";
  }
  // Only HTTPS, exact allowlisted hosts, no userinfo/ports/backslashes/control chars.
  function parseUrl(url) {
    if (/[\\\s\x00-\x1f\x7f]/.test(url)) fail("地址格式异常，已停止发送凭据");
    var m = String(url).match(/^https:\/\/([^/?#]+)([^#]*)/i);
    if (!m) fail("只允许 HTTPS 站点");
    var host = m[1].toLowerCase();
    var allowed = SITE === "qianmoju" ? ["www.1000qm.vip", "1000qm.vip"] : ["linux.sb"];
    if (allowed.indexOf(host) < 0) fail("地址不属于当前站点，已停止发送凭据");
    return { origin: "https://" + host, path: m[2] || "/", host: host };
  }
  function resolveSameOrigin(base, href) {
    var p = parseUrl(base);
    href = decode(href).trim();
    var url;
    if (/^https:\/\//i.test(href)) url = href;
    else if (/^\/\//.test(href)) url = "https:" + href;
    else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) fail("跳转协议异常，已停止");
    else if (href.charAt(0) === "/") url = p.origin + href;
    else if (href.charAt(0) === "?") url = p.origin + p.path.split("?")[0] + href;
    else url = p.origin + p.path.split("?")[0].replace(/[^/]*$/, "") + href;
    if (parseUrl(url).origin !== p.origin) fail("遇到跨域跳转，请在浏览器重新登录并抓取 Cookie");
    return url;
  }
  function challenge(html) {
    var title = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return /just a moment|attention required|安全验证|人机验证|captcha|异常请求验证/i.test(title ? text(title[1]) : "")
      || /window\._cf_chl_opt\b|id=["'](?:challenge-form|cf-challenge)["']|\/cdn-cgi\/challenge-platform\//i.test(html);
  }
  function links(html, base) {
    var out = [];
    var re = /<(?:a|form)\b[^>]*>/gi;
    var m;
    while ((m = re.exec(markup(html)))) {
      var href = attr(m[0], "href") || attr(m[0], "action");
      if (!href) continue;
      try { out.push(parseUrl(resolveSameOrigin(base, href)).path); } catch (_) { /* Not account evidence. */ }
    }
    return out;
  }
  function authenticated(html, base) {
    if (challenge(html)) return false;
    var paths = links(html, base);
    if (SITE === "qianmoju") {
      return paths.some(function (p) { return /(?:^|\/)member\.php\?/.test(p) && /[?&]mod=logging(?:&|$)/.test(p) && /[?&]action=logout(?:&|$)/.test(p); });
    }
    var login = paths.some(function (p) { return /^\/(?:login|signin)\/?(?:\?|$)/i.test(p); });
    var logout = paths.some(function (p) { return /^\/(?:logout|signout|user_logout)\/?(?:\?|$)/i.test(p); });
    var identity = /\bdata-home-keyword-filter-user-id\s*=\s*["']([1-9]\d*)["']/i.test(markup(html));
    var profile = paths.some(function (p) { return /^\/profile\/?(?:\?|$)/.test(p); });
    var messages = paths.some(function (p) { return /^\/direct_messages\/?(?:\?|$)/.test(p); });
    return !login && (logout || (identity && profile && messages));
  }
  function validCookie(cookie) { return typeof cookie === "string" && cookie.indexOf("=") > 0 && !/[\r\n]|[^\x20-\xff]/.test(cookie); }
  function readRecord() {
    try { return JSON.parse($persistentStore.read(KEY) || "null"); } catch (_) { return null; }
  }
  function saveRecord(record, expectedCookie) {
    // Do not overwrite credentials freshly captured by a concurrent browser request.
    var latest = readRecord();
    if (expectedCookie !== undefined && latest && latest.cookie !== expectedCookie) return;
    if (!$persistentStore.write(JSON.stringify(record), KEY)) fail("本地保存失败，请检查 Loon 存储");
  }
  function mergeCookies(cookie, headers) {
    var raw = header(headers, "set-cookie");
    if (!raw) return cookie;
    var jar = Object.create(null);
    cookie.split(";").forEach(function (part) {
      var eq = part.indexOf("=");
      if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    });
    (Array.isArray(raw) ? raw : String(raw).split(/,(?=\s*[^;,=\s]+=)/)).forEach(function (line) {
      var first = String(line).split(";")[0], eq = first.indexOf("=");
      if (eq <= 0) return;
      var name = first.slice(0, eq).trim(), value = first.slice(eq + 1).trim();
      var expires = String(line).match(/;\s*expires=([^;]+)/i);
      if (/;\s*max-age=\s*0(?:;|$)/i.test(line) || (expires && Date.parse(expires[1]) <= Date.now())) delete jar[name];
      else jar[name] = value;
    });
    return Object.keys(jar).map(function (k) { return k + "=" + jar[k]; }).join("; ");
  }
  async function request(record, url, method, body, referer) {
    var origin = parseUrl(record.base).origin;
    for (var hop = 0; hop < 4; hop++) {
      if (parseUrl(url).origin !== origin) fail("请求跨域，已停止发送凭据");
      if (++requests > 7) fail("请求次数达到上限，请手动检查页面");
      var options = { url: url, timeout: 12000, "auto-redirect": false, "auto-cookie": false, insecure: false,
        headers: { Cookie: record.cookie, "User-Agent": record.ua || "Mozilla/5.0", Accept: "text/html,application/xhtml+xml", Referer: referer || record.base } };
      if (node) options.node = node;
      if (method === "POST") {
        options.headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
        options.headers.Origin = origin;
        options.body = body;
      }
      var response = await new Promise(function (resolve, reject) {
        $httpClient[method === "POST" ? "post" : "get"](options, function (error, res, data) {
          if (error || !res) { reject(new Error("网络请求失败，请检查连接或插件策略；凭据未删除")); return; }
          resolve({ status: Number(res.statusCode || res.status), headers: res.headers || {}, body: typeof data === "string" ? data : "" });
        });
      });
      record.cookie = mergeCookies(record.cookie, response.headers);
      if ([301, 302, 303, 307, 308].indexOf(response.status) >= 0) {
        var location = header(response.headers, "location");
        if (!location) fail("页面跳转异常，请重新登录");
        if (method === "POST") fail("签到提交发生跳转，结果未确认；请查看网站后重试");
        url = resolveSameOrigin(url, location);
        if (/\/(?:login|signin)\/?(?:\?|$)|[?&]action=login(?:&|$)/i.test(url)) fail("需要重新登录并更新 Cookie");
        continue;
      }
      if (challenge(response.body)) fail("遇到人机验证，请用相同网络出口在 Safari 手动完成验证后重新抓取；凭据未删除");
      if (response.status < 200 || response.status >= 300) fail("访问失败：HTTP " + response.status + "；请检查网络或登录状态");
      return response;
    }
    fail("页面跳转次数过多，请手动检查");
  }
  function capture() {
    if (typeof $response === "undefined" || String($request.method || "GET").toUpperCase() !== "GET") return finish(true, "跳过非页面响应", false);
    var p = parseUrl($request.url), html = $response.body || "";
    var cookie = header($request.headers, "cookie");
    var status = Number($response.statusCode || $response.status);
    if (status !== 200 || !authenticated(html, p.origin) || !validCookie(cookie)) {
      // Public pages, login forms and challenges must never replace a working record.
      console.log("[" + NAME + "] 未抓取：请打开已登录的" + (SITE === "qianmoju" ? "签到页" : "首页") + "；原凭据保留");
      ended = true; $done({}); return;
    }
    cookie = mergeCookies(cookie, $response.headers || {});
    var previous = readRecord();
    var record = { base: p.origin, cookie: cookie, ua: header($request.headers, "user-agent") || "", capturedAt: Date.now() };
    if (previous && previous.cookie === cookie && previous.ua === record.ua && previous.base === record.base) {
      ended = true; $done({}); return;
    }
    saveRecord(record);
    finish(true, "登录凭据已保存（当前站点单账号）；可关闭此站点抓取开关，再手动测试", true);
  }
    async function execute(record) {
    var page = await request(record, record.base + "/", "GET");
    if (!authenticated(page.body, record.base)) fail("无法确认 LINUX SB 登录态，未报告保活成功；请重新登录并抓取 Cookie");
    return "已登录访问首页完成（仅验证本次访问，不代表领取签到奖励或保证账号保留）";
  }

  async function run() {
    if (typeof $request !== "undefined") { capture(); return; }
    var record = readRecord();
    if (!record || !validCookie(record.cookie)) fail("尚未保存 Cookie，请开启抓取开关并在 Safari 登录对应站点");
    parseUrl(record.base);
    var expectedCookie = record.cookie;
    var message = await execute(record);
    record.lastSuccessAt = Date.now();
    saveRecord(record, expectedCookie);
    finish(true, message, false);
  }
  run().catch(function (error) { finish(false, error.message || "执行异常，请查看日志", false); });
})();
