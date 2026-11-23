# 告警外部通道

价格告警触发时，网关除了通过 WebSocket 推给界面，还会把同一条消息异步投递给 `gateway/config.json` 里 `alert_channels` 配置的通道。发送在独立线程排队完成，不阻塞行情与交易循环。

## 通用字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `type` | 是 | 通道类型，见下文 |
| `name` | 否 | 「设置 → 告警通道」里显示的名称，缺省用类型名 |

所有 `url` / `token` / `password` / `secret` 只在网关侧使用。`Config.public()` 只下发 `alert_channel_names`，界面拿不到任何地址或密钥。

告警文案统一为：

```text
[Tally] XAUUSD 上穿 2000，现价 2001.5（突破）
```

## 通道

### webhook

POST `{"text": "...", "alert": {...}}`，可自定义请求头。Slack 的 Incoming Webhook 也可以直接用它。

```json
{
  "type": "webhook",
  "name": "团队群",
  "url": "https://hooks.example.com/services/xxx",
  "headers": { "X-Token": "..." }
}
```

### discord

POST `{"content": "..."}`。

```json
{ "type": "discord", "url": "https://discord.com/api/webhooks/xxx" }
```

### telegram

```json
{ "type": "telegram", "token": "123:abc", "chatId": "456" }
```

### wecom（企业微信群机器人）

```json
{ "type": "wecom", "url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx" }
```

### feishu（飞书 / Lark 自定义机器人）

```json
{ "type": "feishu", "url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" }
```

机器人开启「签名校验」时加 `secret`，网关会按官方算法附上 `timestamp` 与 `sign`。

### dingtalk（钉钉群机器人）

```json
{
  "type": "dingtalk",
  "url": "https://oapi.dingtalk.com/robot/send?access_token=xxx",
  "secret": "SEC..."
}
```

`secret` 可选；配置后自动按加签规则把 `timestamp` 与 `sign` 拼到地址后面。

### bark（iOS）

`url` 填设备地址；可选 `group`、`sound`、`level`。

```json
{
  "type": "bark",
  "url": "https://api.day.app/<device-key>",
  "group": "交易",
  "sound": "alarm"
}
```

### ntfy

`url` 直接写到主题，正文是纯文本；`Title` 头默认 `Tally`，`headers` 可放 `Authorization`，`priority` 可选 1–5。

```json
{
  "type": "ntfy",
  "url": "https://ntfy.sh/mytrade",
  "headers": { "Authorization": "Bearer xxx" },
  "priority": 4
}
```

### email（SMTP）

默认 `465 + SSL`；587 端口用 `"ssl": false, "starttls": true`。QQ / 163 等邮箱填授权码，不是登录密码。

```json
{
  "type": "email",
  "host": "smtp.example.com",
  "port": 465,
  "user": "bot@example.com",
  "password": "授权码",
  "from": "bot@example.com",
  "to": ["me@example.com"]
}
```

`to` 可以是字符串或数组，缺省发给 `from`。

## 运行行为

- 配置有问题（缺少 `url`、`host` 等）时，该通道在启动阶段被跳过并写审计 `alert.channel.invalid`；未知 `type` 记 `alert.channel.unknown`。
- 单个通道发送失败只记 `alert.channel.error`，不影响其他通道；成功记 `alert.channel.sent`。
- 待发队列容量 100 条，满了会丢弃并记 `alert.channel.drop`。
- 机器人或群设置里若使用「自定义关键词」校验，关键词需要包含 `Tally`；也可以改用加签（`secret`）。
- 修改 `config.json` 后需要重启网关（或重启 App）才生效。
