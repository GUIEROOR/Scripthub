# 阡陌居每日签到 + LINUX SB 登录访问保活

版本：1.0.0。一个 Loon 插件入口、两个独立脚本和任务。无需 VPS、Docker、Node.js、BoxJS 或 CookieCloud。要求 Loon 3.5.1 (983) 或以上（插件使用新版 Script 语法）。

## 安装与首次使用

在 Loon → 插件 → 添加远程插件，粘贴：

```text
https://raw.githubusercontent.com/GUIEROOR/Scripthub/main/forum-checkin.lpx
```

1. 开启插件、MitM，并确认 Loon 的 CA 证书已安装且受信任。插件只添加两个站点的主机名，不修改现有分流规则。
2. 保持两个“抓取 Cookie”开关开启。在 Safari 登录自己的阡陌居账号，然后打开 `https://www.1000qm.vip/plugin.php?id=dsu_paulsign:sign`。如账号使用无 www 域名，请打开对应域名的同一路径；脚本使用实际抓取的域名，不跨域发送凭据。
3. 在 Safari 登录自己的 LINUX SB 账号，打开 `https://linux.sb/` 首页。必须等页面显示账号已登录；公开页、登录页和验证页不会保存凭据。
4. 每站点收到“登录凭据已保存”通知后，关闭对应抓取开关，减少日常页面处理。
5. 到 Loon 脚本列表，分别运行“阡陌居：手动签到”和“LINUX SB：手动保活”。确认真实账号上结果正确后，保留相应自动任务开关。

定时任务默认阡陌居每天 08:35、LINUX SB 每天 13:20。时间按手机本地时区；北京时间请确保设备时区为 Asia/Shanghai。开关只控制自动任务，手动按钮仍可独立运行。手机关机、Loon 未运行或网络不可用时不能保证触发；不会创建云端任务，也不会自动补跑错过的时间。

## 选项

| 参数 | 默认值 | 说明 |
|---|---|---|
| 两站点抓取开关 | 开 | 成功抓取后建议关闭；过期再开 |
| 两站点自动任务 | 开 | 独立启停和设定 Cron |
| 自动任务成功通知 | 关 | 失败始终通知；手动执行、凭据更新始终通知 |
| 两站点节点或策略组 | 空 | 遵循现有分流；可填 DIRECT 或实际节点/策略组名 |

选择脚本节点不会改变 Safari 的分流。若指定节点，请让 Safari 登录抓取时也使用相同出口；Cookie、User-Agent 相同仍不保证网站接受脚本请求。不要为解决验证问题频繁轮换出口或请求。

每个站点保存**一个账号**，重新抓取会替换该站点原凭据。两站点存储键独立：`GUIEROOR.ForumCheckin.v1.qianmoju` 与 `GUIEROOR.ForumCheckin.v1.linux-sb`。Cookie 与 User-Agent 只保存在 Loon 本地，脚本不上传到 GitHub、开发者服务器或第三方通知平台。不要公开凭据、抓包数据或本地存储备份。禁用/删除插件通常不等于清除已存凭据。

## 行为与结果

- 阡陌居：GET 当前签到页 → 确认登录 → 提取当前表单和 formhash → POST 签到 → GET 复查。已签到时跳过提交。只做每日签到，不领红包、不回帖、不额外做任务。不会在未确认结果时自动重试 POST。
- LINUX SB：只 GET 首页并确认退出入口，或用户标识与账号专属导航。HTTP 200、公开页面或出现“积分”等普通文字不构成登录证据。不领取奖励、不发帖、不回帖；“已登录访问完成”也不保证满足站点的账号保留/活跃度规则。
- 遇到登录失效、验证页、跨域跳转、HTTP 错误或未知页面会停止并提示。没有验证码识别、浏览器环境模拟或人机验证绕过功能。人工验证后可重新抓取。
- 响应 Cookie 在本次请求链中更新，只有任务成功才持久化；浏览器刚抓取的新凭据不会被旧任务覆盖。日志不输出 Cookie、表单值或原始响应。

## 验证与限制

离线回归：`node --test scripts/forum-checkin/forum-checkin.test.cjs`。覆盖成功/重复签到、失败确认、凭据捕获、验证页、重定向、Cookie 更新、跨站隔离和通知。

这些测试使用合成响应，不访问真实账号，不能证明当前站点页面或 iOS/Loon 的实际调度已经验收。真实账号首次手动运行是必要验收；如页面变更导致不识别，请提供脱敏日志，不要提交 Cookie。

## 来源

HTTP 签到流程、LINUX SB 登录证据设计参考并改编自 [HughRyu/SignMate](https://github.com/HughRyu/SignMate) 的 `src/utils/discuz-http.js` 与 `src/drivers/forum-visit.js`。保留 MIT 声明，详见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。Loon API/配置依据 [官方文档](https://nsloon.app/docs/Script/script_api/)。
