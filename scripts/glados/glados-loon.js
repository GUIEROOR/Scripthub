/******************************
脚本功能：GLaDOS / Railgun 自动签到 + 积分兑换（Loon 专用）
Version  : v1.4.0-loon
更新时间：2026-09-26
仓库    ：GUIEROOR/Scripthub
Platform : Loon

设计目标：
1. 更稳定抓取 Cookie：监听 /console/account、/api/user/status、/api/user/points
2. 按邮箱识别账号，同账号重新登录自动替换旧 Cookie
3. 使用独立存储键，不读取 v1.3.0 的旧 Cookie
4. 同邮箱跨域只保留一份有效账号，避免重复签到
5. 连续 3 次验证失败自动移除失效账号
******************************/

var SCRIPT_NAME = "GLaDOS Loon";
var SCRIPT_VERSION = "v1.4.0-loon";
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
        resolve({ ok: false, statusCode: 0, data: null, raw: "", error: String(err) });
        return;
      }
      var statusCode = resp && (resp.statusCode || resp.status) || 0;
      var raw = body || "";
      resolve({
        ok: statusCode >= 200 && statusCode < 400,
        statusCode: statusCode,
        data: safeJsonParse(raw),
        raw: raw,
        error: ""
      });
    };

    if (method === "POST") $httpClient.post(opts, cb);
    else $httpClient.get(opts, cb);
  });
}

function apiRequest(domain, cookie, path, method, body) {
  var opts = {
    url: "https://" + domain + path,
    method: method || "GET",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
      "Origin": "https://" + domain,
      "Referer": "https://" + domain + "/console/account",
      "User-Agent": UA,
      "Cookie": cookie
    }
  };
  if (body !== undefined) opts.body = typeof body === "string" ? body : JSON.stringify(body);
  return httpRequest(opts);
}

function parseStatusResponse(resp) {
  if (!resp || resp.statusCode === 401 || resp.statusCode === 403) {
    return { valid: false, explicitInvalid: true, email: "", leftDays: "N/A" };
  }
  if (!resp.data) {
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

function getStatus(domain, cookie) {
  return apiRequest(domain, cookie, "/api/user/status", "GET").then(function (resp) {
    var parsed = parseStatusResponse(resp);
    parsed.statusCode = resp.statusCode;
    return parsed;
  });
}

function getPoints(domain, cookie) {
  return apiRequest(domain, cookie, "/api/user/points", "GET").then(function (resp) {
    if (!resp.data) return { points: "N/A", pointsNum: 0 };
    var val = resp.data.points;
    if (val === undefined && resp.data.data) val = resp.data.data.points;
    if (val === undefined || val === null || val === "") return { points: "N/A", pointsNum: 0 };
    var n = parseInt(parseFloat(val), 10);
    return { points: String(n), pointsNum: isNaN(n) ? 0 : n };
  });
}

function checkin(domain, cookie) {
  return apiRequest(domain, cookie, "/api/user/checkin", "POST", { token: domain }).then(function (resp) {
    if (!resp.data) {
      return { code: -2, status: "签到失败", message: resp.error || resp.raw || ("HTTP " + resp.statusCode), points: "0" };
    }
    var code = resp.data.code !== undefined ? resp.data.code : -2;
    var message = resp.data.message || "";
    var points = String(resp.data.points !== undefined ? resp.data.points : 0);
    if (code === 0) return { code: 0, status: "签到成功", message: message, points: points };
    if (code === 1) return { code: 1, status: "重复签到", message: message, points: "0" };
    return { code: code, status: "签到失败", message: message || ("code=" + code), points: "0" };
  });
}

function exchange(domain, cookie) {
  return apiRequest(domain, cookie, "/api/user/exchange", "POST", { planType: EXCHANGE_PLAN }).then(function (resp) {
    if (!resp.data) return "兑换失败";
    var code = resp.data.code !== undefined ? resp.data.code : -2;
    if (code === 0) return "兑换成功(" + EXCHANGE_PLAN + ")";
    return "兑换失败: " + (resp.data.message || ("code=" + code));
  });
}

function upsertAccount(domain, cookie, email) {
  var accounts = loadAccounts();
  var normalized = normalizeEmail(email);
  var now = new Date().toISOString();
  var found = -1;

  for (var i = 0; i < accounts.length; i++) {
    if (normalizeEmail(accounts[i].email) === normalized) {
      found = i;
      break;
    }
  }

  var record = {
    email: email,
    domain: domain,
    cookie: cookie,
    updatedAt: now,
    failCount: 0
  };

  if (found >= 0) {
    var oldDomain = accounts[found].domain;
    accounts[found] = record;
    saveAccounts(accounts);
    return { type: "updated", index: found + 1, oldDomain: oldDomain, total: accounts.length };
  }

  accounts.push(record);
  saveAccounts(accounts);
  return { type: "new", index: accounts.length, oldDomain: "", total: accounts.length };
}

function captureCookie() {
  var headers = $request.headers || {};
  var cookie = getHeader(headers, "cookie");
  var domain = getDomainFromUrl($request.url || "");

  if (!cookie || !domain) {
    console.log("[GLaDOS] 抓包失败：Cookie 或 Domain 为空");
    notify("GLaDOS 抓包失败", "", "没有读取到 Cookie，请确认 Loon MITM 已启用后刷新页面");
    $done({});
    return;
  }

  console.log("[GLaDOS] 捕获请求: " + ($request.url || ""));
  console.log("[GLaDOS] 正在验证 Cookie: " + domain);

  getStatus(domain, cookie).then(function (status) {
    if (!status.valid) {
      console.log("[GLaDOS] Cookie 验证失败，未写入存储。HTTP=" + status.statusCode);
      notify("GLaDOS 抓包", "Cookie 未保存", "未能识别登录账号，请保持登录状态后刷新控制台页面");
      $done({});
      return;
    }

    var result = upsertAccount(domain, cookie, status.email);
    var action = result.type === "new" ? "新账号已保存" : "Cookie 已更新";
    console.log("[GLaDOS] " + action + ": " + status.email + " | " + domain);
    if (result.oldDomain && result.oldDomain !== domain) {
      console.log("[GLaDOS] 同邮箱跨域更新: " + result.oldDomain + " -> " + domain);
    }

    notify("GLaDOS 抓包", action, status.email + " | " + domain + " | 共 " + result.total + " 个账号");
    $done({});
  }).catch(function (e) {
    console.log("[GLaDOS] 抓包异常: " + e);
    notify("GLaDOS 抓包失败", "", String(e));
    $done({});
  });
}

function runOne(account, index) {
  var domain = account.domain;
  var cookie = account.cookie;

  return getStatus(domain, cookie).then(function (before) {
    if (!before.valid) {
      return {
        email: account.email,
        domain: domain,
        invalid: true,
        explicitInvalid: before.explicitInvalid,
        code: -9,
        status: "Cookie 验证失败",
        message: "HTTP " + before.statusCode,
        earnedPoints: "0",
        totalPoints: "N/A",
        daysAfter: "N/A",
        exchange: "跳过"
      };
    }

    account.email = before.email;
    account.failCount = 0;

    return checkin(domain, cookie).then(function (ci) {
      return getPoints(domain, cookie).then(function (pts) {
        var exchangeText = "跳过(积分不足)";
        var exchangePromise = Promise.resolve(exchangeText);

        if (pts.pointsNum >= EXCHANGE_MIN_POINTS) {
          exchangePromise = exchange(domain, cookie);
        }

        return exchangePromise.then(function (ex) {
          exchangeText = ex;
          return getStatus(domain, cookie).then(function (after) {
            return {
              email: before.email,
              domain: domain,
              invalid: false,
              code: ci.code,
              status: ci.status,
              message: ci.message,
              earnedPoints: ci.points,
              totalPoints: pts.points,
              daysAfter: after.leftDays,
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
      var cleaned = [];
      var removed = [];

      for (var j = 0; j < accounts.length; j++) {
        var acc = accounts[j];
        if ((acc.failCount || 0) >= MAX_FAIL_COUNT) removed.push(acc.email);
        else cleaned.push(acc);
      }

      saveAccounts(cleaned);

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
        var pts = item.earnedPoints !== "0" ? " | +" + item.earnedPoints + "积分" : "";
        notify(icon + " " + item.email, item.status + pts, "剩余 " + item.daysAfter + " | 积分 " + item.totalPoints + " | " + item.exchange);
      }

      $done();
      return;
    }

    var currentIndex = i;
    var account = accounts[currentIndex];
    i++;

    runOne(account, currentIndex + 1).then(function (result) {
      if (result.invalid) {
        accounts[currentIndex].failCount = (accounts[currentIndex].failCount || 0) + 1;
        console.log("❌ " + account.email + " | " + account.domain + " | 验证失败 " + accounts[currentIndex].failCount + "/" + MAX_FAIL_COUNT);
      } else {
        accounts[currentIndex].failCount = 0;
        accounts[currentIndex].email = result.email;
        console.log((result.code === 0 ? "✅ " : result.code === 1 ? "🔁 " : "❌ ") + result.email + " | " + result.status + " | " + result.domain);
      }

      results.push(result);
      next();
    }).catch(function (e) {
      accounts[currentIndex].failCount = (accounts[currentIndex].failCount || 0) + 1;
      results.push({
        email: account.email,
        domain: account.domain,
        invalid: true,
        code: -10,
        status: "执行异常",
        message: String(e),
        earnedPoints: "0",
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
