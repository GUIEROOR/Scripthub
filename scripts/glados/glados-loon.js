/******************************
脚本功能：GLaDOS / Railgun 自动签到 + 积分兑换（Loon 专用）
Version  : v1.5.2-loon
更新时间：2026-11-18
仓库    ：GUIEROOR/Scripthub
Platform : Loon

设计目标：
1. 更稳定抓取 Cookie：监听 /console/account、/api/user/status、/api/user/points
2. 按邮箱识别账号，同账号重新登录自动替换旧 Cookie
3. 使用独立存储键，不读取 v1.3.0 的旧 Cookie
4. GLaDOS 主站域名同邮箱互通；railgun.info 作为独立会员体系单独保存和签到
5. 使用签到挑战，区分实际得分、连签和请求错误
6. 连续 3 次明确会话失效才移除账号
******************************/

var SCRIPT_NAME = "GLaDOS Loon";
var SCRIPT_VERSION = "v1.5.2-loon";
var STORE_KEY = "GLaDOS_Loon_Accounts_v140";
var EXCHANGE_PLAN = "plan500";
var EXCHANGE_MIN_POINTS = 500;
var MAX_FAIL_COUNT = 3;
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

var isRequestMode = typeof $request !== "undefined";

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch (_) { return null; }
}

function notify(title, subtitle, body) {
  try { $notification.post(title, subtitle || "", body || ""); } catch (_) {}
}

function readStore(key) {
  try { return $persistentStore.read(key); } catch (_) { return null; }
}

function writeStore(value, key) {
  try { return $persistentStore.write(value, key); } catch (_) { return false; }
}

function loadAccounts() {
  var raw = readStore(STORE_KEY);
  if (!raw) return [];
  var list = safeJsonParse(raw);
  return Array.isArray(list) ? list.filter(function (x) {
    return x && x.cookie && x.domain && x.email;
  }) : [];
}

function saveAccounts(accounts) {
  return writeStore(JSON.stringify(accounts), STORE_KEY);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// 会员体系：railgun.info 与 GLaDOS 主站会员数据不互通。
// glados.network / glados.vip / glados.one / glados.space 视为同一 GLaDOS 体系。
function getAccountRealm(domain) {
  return String(domain || "").toLowerCase() === "railgun.info" ? "railgun" : "glados";
}

function getAccountKey(email, domain) {
  return normalizeEmail(email) + "::" + getAccountRealm(domain);
}

function getHeader(headers, name) {
  if (!headers) return "";
  var lower = name.toLowerCase();
  for (var k in headers) {
    if (String(k).toLowerCase() === lower) return headers[k] || "";
  }
  return "";
}

function getDomainFromUrl(url) {
  var m = String(url || "").match(/^https?:\/\/([^/:?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function httpRequest(opts) {
  return new Promise(function (resolve) {
    var method = String(opts.method || "GET").toUpperCase();
    var cb = function (err, resp, body) {
      if (err) {
        resolve({ ok: false, statusCode: 0, data: null, raw: "", error: typeof err === "string" ? err : JSON.stringify(err) });
        return;
      }
      var statusCode = resp && (resp.statusCode || resp.status) || 0;
      var raw = body || "";
      resolve({
        ok: statusCode >= 200 && statusCode < 400,
        statusCode: statusCode,
        data: safeJsonParse(raw),
        raw: raw,
        headers: resp && resp.headers || {},
        error: ""
      });
    };

    if (method === "POST") $httpClient.post(opts, cb);
    else $httpClient.get(opts, cb);
  });
}

function apiRequest(domain, cookie, path, method, body, userAgent) {
  var opts = {
    url: "https://" + domain + path,
    method: method || "GET",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://" + domain,
      "Referer": "https://" + domain + (path.indexOf("/api/user/checkin") === 0 ? "/console/checkin" : "/console/account"),
      "User-Agent": userAgent || UA,
      "Cookie": typeof cookie === "object" ? cookie.value : cookie
    }
  };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json;charset=UTF-8";
    opts.body = JSON.stringify(body);
  }
  return httpRequest(opts).then(function (resp) {
    if (cookie && typeof cookie === "object") {
      var setCookie = getHeader(resp.headers, "set-cookie");
      if (setCookie) cookie.value = mergeResponseCookies(cookie.value, setCookie);
    }
    return resp;
  });
}

// Keep challenge-issued session cookies inside this account's request sequence.
function mergeResponseCookies(original, setCookie) {
  var pairs = String(original || "").split(/;\s*/).filter(Boolean);
  var updates = Array.isArray(setCookie) ? setCookie :
    String(setCookie).split(/,(?=\s*[^;,=\s]+=[^;,]*)/);
  updates.forEach(function (line) {
    var pair = String(line).split(";")[0].trim();
    var equals = pair.indexOf("=");
    if (equals < 1) return;
    var name = pair.slice(0, equals);
    pairs = pairs.filter(function (existing) { return existing.slice(0, existing.indexOf("=")) !== name; });
    var expired = /;\s*max-age\s*=\s*0(?:;|$)/i.test(line);
    var expires = String(line).match(/;\s*expires=([^;]+)/i);
    if (expires && Date.parse(expires[1]) <= Date.now()) expired = true;
    if (!expired) pairs.push(pair);
  });
  return pairs.join("; ");
}

function responseMessage(resp, stage, secrets) {
  var data = resp.data || {};
  var details = data.data || {};
  var code = numericValue(data.code);
  var parts = [stage, "HTTP " + resp.statusCode, "code=" + code];
  var message = data.message || data.error;
  var reason = data.reason || details.reason;
  if (typeof message === "string") parts.push(message);
  if (typeof reason === "string") parts.push("reason=" + reason);
  if (resp.error) parts.push("网络错误 " + resp.error);
  if (code === 4) parts.push("请在对应域名刷新登录状态后重新抓取");
  var text = parts.join(" | ");
  (secrets || []).filter(Boolean).forEach(function (secret) {
    text = text.split(String(secret)).join("[已隐藏]");
  });
  return text.replace(/[\r\n\t]+/g, " ").slice(0, 600);
}

function parseStatusResponse(resp) {
  if (!resp || resp.statusCode === 401 || (resp.ok && resp.data && Number(resp.data.code) === -2)) {
    return { valid: false, explicitInvalid: true, email: "", leftDays: "N/A" };
  }
  if (!resp.ok || !resp.data) {
    return { valid: false, explicitInvalid: false, email: "", leftDays: "N/A" };
  }

  var data = resp.data.data || resp.data;
  var email = data && data.email ? String(data.email).trim() : "";
  var leftDays = data && data.leftDays;
  var days = (leftDays !== undefined && leftDays !== null && leftDays !== "")
    ? parseInt(parseFloat(leftDays), 10) + " 天"
    : "N/A";

  return {
    valid: !!email,
    explicitInvalid: false,
    email: email,
    leftDays: days
  };
}

function getStatus(domain, cookie, userAgent) {
  return apiRequest(domain, cookie, "/api/user/status", "GET", undefined, userAgent).then(function (resp) {
    var parsed = parseStatusResponse(resp);
    parsed.statusCode = resp.statusCode;
    parsed.message = responseMessage(resp, "查询登录状态", [typeof cookie === "object" ? cookie.value : cookie]);
    return parsed;
  });
}

function getPoints(domain, cookie, userAgent) {
  return apiRequest(domain, cookie, "/api/user/points", "GET", undefined, userAgent).then(function (resp) {
    if (!resp.ok || !resp.data) return { points: "N/A", pointsNum: 0 };
    var val = resp.data.points;
    if (val === undefined && resp.data.data) val = resp.data.data.points;
    var data = resp.data.data || resp.data;
    if (val == null && Array.isArray(data.list) && data.list[0]) val = data.list[0].balance;
    var n = numericValue(val);
    return { points: n === null ? "N/A" : String(n), pointsNum: n, streak: numericValue(data.streak) };
  });
}

function numericValue(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  var n = Number(value);
  return isFinite(n) ? n : null;
}

// SHA-256 over the ASCII nonce and protocol suffix. Loon scripts need no Web Crypto API.
function checkinProof(nonce) {
  var input = nonce + ".glados-observe-v1";
  var constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  var hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var words = new Int32Array(Math.ceil((input.length + 9) / 64) * 16);
  for (var i = 0; i < input.length; i++) words[i >>> 2] |= input.charCodeAt(i) << (24 - (i % 4) * 8);
  words[i >>> 2] |= 0x80 << (24 - (i % 4) * 8);
  words[words.length - 1] = input.length * 8;
  var schedule = new Int32Array(64);
  function rotate(value, bits) { return (value >>> bits) | (value << (32 - bits)); }
  for (var offset = 0; offset < words.length; offset += 16) {
    schedule.set(words.subarray(offset, offset + 16));
    for (i = 16; i < 64; i++) {
      var x = schedule[i - 15], y = schedule[i - 2];
      var low = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      var high = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      schedule[i] = schedule[i - 16] + low + schedule[i - 7] + high;
    }
    var a = hash[0], b = hash[1], c = hash[2], d = hash[3];
    var e = hash[4], f = hash[5], g = hash[6], h = hash[7];
    for (i = 0; i < 64; i++) {
      var sumE = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      var choose = (e & f) ^ (~e & g);
      var t1 = (h + sumE + choose + constants[i] + schedule[i]) | 0;
      var sumA = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      var majority = (a & b) ^ (a & c) ^ (b & c);
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + sumA + majority) | 0;
    }
    var block = [a, b, c, d, e, f, g, h];
    for (i = 0; i < hash.length; i++) hash[i] = (hash[i] + block[i]) | 0;
  }
  return hash.map(function (word) {
    return ("00000000" + (word >>> 0).toString(16)).slice(-8);
  }).join("");
}

function checkin(domain, cookie, userAgent) {
  cookie = { value: typeof cookie === "object" ? cookie.value : cookie };
  var challengePath = "/api/user/checkin/challenge";
  var waitMs = 2800;

  function submit(payload) {
    return apiRequest(domain, cookie, "/api/user/checkin", "POST", payload, userAgent).then(function (resp) {
      var data = resp.data || {};
      var code = resp.ok ? numericValue(data.code) : null;
      var details = data.data || data;
      var points = numericValue(details.points);
      var message = responseMessage(resp, "提交签到", [cookie.value, payload.nonce, payload.proof]);
      return {
        code: code === null ? -2 : code,
        status: code === 0 ? "签到成功" : code === 1 ? "重复签到" : "签到失败",
        message: code === 0 || code === 1 ? "" : message,
        points: code === 0 ? points : null,
        streak: numericValue(details.streak),
        mode: payload.proof ? "challenge" : "legacy"
      };
    });
  }

  return apiRequest(domain, cookie, challengePath, "GET", undefined, userAgent).then(function (resp) {
    if (domain === "railgun.info" && (resp.statusCode === 404 || resp.statusCode === 405)) {
      return submit({ token: domain });
    }
    var data = resp.data || {};
    var challenge = data.data || data;
    var nonce = challenge.nonce;
    var ttl = numericValue(challenge.ttl);
    if (!resp.ok || numericValue(data.code) !== 0 ||
        typeof nonce !== "string" || !/^[!-~]{1,1024}$/.test(nonce) || (ttl !== null && ttl <= waitMs)) {
      return {
        code: -3,
        status: "获取签到挑战失败",
        message: responseMessage(resp, "获取签到挑战", [cookie.value, nonce]),
        points: null,
        streak: null,
        mode: "challenge"
      };
    }
    console.log("[GLaDOS] " + domain + " | 挑战已获取 | 等待 " + waitMs + " ms");
    return new Promise(function (resolve) { setTimeout(resolve, waitMs); }).then(function () {
      return submit({ token: domain, nonce: nonce, proof: checkinProof(nonce) });
    });
  });
}

function exchange(domain, cookie, userAgent) {
  return apiRequest(domain, cookie, "/api/user/exchange", "POST", { planType: EXCHANGE_PLAN }, userAgent).then(function (resp) {
    if (!resp.data) return "兑换失败";
    var code = resp.data.code !== undefined ? resp.data.code : -2;
    if (code === 0) return "兑换成功(" + EXCHANGE_PLAN + ")";
    return "兑换失败: " + (resp.data.message || ("code=" + code));
  });
}

function upsertAccount(domain, cookie, email, userAgent) {
  var accounts = loadAccounts();
  var accountKey = getAccountKey(email, domain);
  var realm = getAccountRealm(domain);
  var now = new Date().toISOString();
  var found = -1;

  for (var i = 0; i < accounts.length; i++) {
    if (getAccountKey(accounts[i].email, accounts[i].domain) === accountKey) {
      found = i;
      break;
    }
  }

  var record = {
    email: email,
    domain: domain,
    realm: realm,
    cookie: cookie,
    userAgent: userAgent,
    updatedAt: now,
    failCount: 0
  };

  if (found >= 0) {
    var oldDomain = accounts[found].domain;
    accounts[found] = record;
    if (!saveAccounts(accounts)) throw new Error("无法写入账号存储");
    return { type: "updated", index: found + 1, oldDomain: oldDomain, total: accounts.length };
  }

  accounts.push(record);
  if (!saveAccounts(accounts)) throw new Error("无法写入账号存储");
  return { type: "new", index: accounts.length, oldDomain: "", total: accounts.length };
}

function captureCookie() {
  var headers = $request.headers || {};
  var cookie = getHeader(headers, "cookie");
  var userAgent = getHeader(headers, "user-agent");
  var domain = getDomainFromUrl($request.url || "");

  if (!cookie || !domain) {
    console.log("[GLaDOS] 抓包失败：Cookie 或 Domain 为空");
    notify("GLaDOS 抓包失败", "", "没有读取到 Cookie，请确认 Loon MITM 已启用后刷新页面");
    $done({});
    return;
  }

  console.log("[GLaDOS] 捕获请求: " + ($request.url || ""));
  console.log("[GLaDOS] 正在验证 Cookie: " + domain);

  getStatus(domain, cookie, userAgent).then(function (status) {
    if (!status.valid) {
      console.log("[GLaDOS] Cookie 验证失败，未写入存储。HTTP=" + status.statusCode);
      notify("GLaDOS 抓包", "Cookie 未保存", status.message);
      $done({});
      return;
    }

    var result = upsertAccount(domain, cookie, status.email, userAgent);
    var action = result.type === "new" ? "新账号已保存" : "Cookie 已更新";
    console.log("[GLaDOS] " + action + ": " + status.email + " | " + domain);
    if (result.oldDomain && result.oldDomain !== domain) {
      console.log("[GLaDOS] 同会员体系跨域更新: " + result.oldDomain + " -> " + domain);
    }

    notify("GLaDOS 抓包", action, status.email + " | " + domain + " | " + getAccountRealm(domain) + " | 共 " + result.total + " 个账户");
    $done({});
  }).catch(function (e) {
    console.log("[GLaDOS] 抓包异常: " + e);
    notify("GLaDOS 抓包失败", "", String(e));
    $done({});
  });
}

function runOne(account) {
  var domain = account.domain;
  var cookie = account.cookie;
  var userAgent = account.userAgent;

  return getStatus(domain, cookie, userAgent).then(function (before) {
    if (!before.valid) {
      return {
        email: account.email,
        domain: domain,
        invalid: true,
        explicitInvalid: before.explicitInvalid,
        code: -9,
        status: before.explicitInvalid ? "登录状态已失效" : "登录状态查询失败",
        message: before.message,
        earnedPoints: null,
        totalPoints: "N/A",
        daysAfter: "N/A",
        exchange: "跳过"
      };
    }

    account.failCount = 0;

    return checkin(domain, cookie, userAgent).then(function (ci) {
      return getPoints(domain, cookie, userAgent).then(function (pts) {
        var exchangeText = ci.code !== 0 && ci.code !== 1 ? "跳过(签到失败)" :
          pts.pointsNum === null ? "跳过(余额未知)" : "跳过(积分不足)";
        var exchangePromise = Promise.resolve(exchangeText);

        if ((ci.code === 0 || ci.code === 1) && pts.pointsNum >= EXCHANGE_MIN_POINTS) {
          exchangePromise = exchange(domain, cookie, userAgent);
        }

        return exchangePromise.then(function (ex) {
          exchangeText = ex;
          var balance = ex.indexOf("兑换成功") === 0 ? getPoints(domain, cookie, userAgent) : Promise.resolve(pts);
          return Promise.all([getStatus(domain, cookie, userAgent), balance]).then(function (updated) {
            return {
              email: before.email,
              domain: domain,
              invalid: false,
              code: ci.code,
              status: ci.status,
              message: ci.message,
              earnedPoints: ci.points,
              totalPoints: updated[1].points,
              streak: ci.streak === null ? pts.streak : ci.streak,
              mode: ci.mode,
              daysAfter: updated[0].leftDays,
              exchange: exchangeText
            };
          });
        });
      });
    });
  });
}

function runCron() {
  var accounts = loadAccounts();

  if (!accounts.length) {
    console.log("[GLaDOS] 没有 v1.4.0 账号数据");
    notify("GLaDOS", "没有账号", "请打开 GLaDOS 控制台并刷新一次以抓取 Cookie");
    $done();
    return;
  }

  console.log("🚀 " + SCRIPT_NAME + " " + SCRIPT_VERSION);
  console.log("账号数: " + accounts.length);
  console.log("------------------------------------");

  var results = [];
  var i = 0;

  function next() {
    if (i >= accounts.length) {
      // Preserve Cookie updates captured while the scheduled run was waiting on requests.
      var removed = [];
      var cleaned = loadAccounts().filter(function (saved) {
        var processed = accounts.find(function (account) {
          return account.domain === saved.domain && account.cookie === saved.cookie &&
            account.updatedAt === saved.updatedAt &&
            getAccountKey(account.email, account.domain) === getAccountKey(saved.email, saved.domain);
        });
        if (!processed) return true;
        if ((processed.failCount || 0) >= MAX_FAIL_COUNT) {
          removed.push(saved.email);
          return false;
        }
        saved.failCount = processed.failCount;
        return true;
      });
      if (!saveAccounts(cleaned)) {
        console.log("[GLaDOS] 无法更新账号存储");
        removed = [];
      }

      var ok = results.filter(function (r) { return r.code === 0; }).length;
      var dup = results.filter(function (r) { return r.code === 1; }).length;
      var fail = results.length - ok - dup;

      console.log("------------------------------------");
      console.log("📊 Summary");
      console.log("Total     : " + results.length);
      console.log("Success   : " + ok);
      console.log("Duplicate : " + dup);
      console.log("Failed    : " + fail);
      console.log("Removed   : " + removed.length);

      var body = "账号 " + results.length + " | ✅" + ok + " 🔁" + dup + " ❌" + fail;
      if (removed.length) body += " | 清理 " + removed.length;
      notify("GLaDOS", "签到完成", body);

      for (var r = 0; r < results.length; r++) {
        var item = results[r];
        var icon = item.code === 0 ? "✅" : item.code === 1 ? "🔁" : "❌";
        var pts = item.code === 0 ? " | 本次 " + (item.earnedPoints == null ? "未知" : "+" + item.earnedPoints) : "";
        var streak = item.streak == null ? "" : " | 连签 " + item.streak + " 天";
        var detail = item.message ? item.message + " | " : "";
        notify(icon + " " + item.email, item.domain + " | " + item.status + pts,
          detail + "剩余 " + item.daysAfter + " | 积分 " + item.totalPoints + streak + " | " + item.exchange);
      }

      $done();
      return;
    }

    var account = accounts[i];
    i++;

    runOne(account).then(function (result) {
      if (result.explicitInvalid) account.failCount = (account.failCount || 0) + 1;
      else if (!result.invalid) account.failCount = 0;

      var icon = result.code === 0 ? "✅ " : result.code === 1 ? "🔁 " : "❌ ";
      var earned = result.earnedPoints == null ? "未知" : "+" + result.earnedPoints;
      console.log(icon + result.email + " | " + result.domain + " | " + result.status +
        (result.mode ? " | " + result.mode : "") +
        (result.code === 0 ? " | 本次 " + earned : "") +
        (result.streak == null ? "" : " | 连签 " + result.streak + " 天") +
        " | 余额 " + result.totalPoints + (result.message ? " | " + result.message : ""));

      results.push(result);
      next();
    }).catch(function (e) {
      results.push({
        email: account.email,
        domain: account.domain,
        invalid: true,
        code: -10,
        status: "执行异常",
        message: String(e),
        earnedPoints: null,
        totalPoints: "N/A",
        daysAfter: "N/A",
        exchange: "跳过"
      });
      next();
    });
  }

  next();
}

if (isRequestMode) {
  captureCookie();
} else {
  var delay = Math.floor(Math.random() * 11);
  setTimeout(runCron, delay * 1000);
}
