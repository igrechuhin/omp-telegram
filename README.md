# omp-telegram

Telegram bridge for [omp](https://omp.sh) sessions. One message per stop with what
actually happened, replies that continue the session, and `ask` questions as inline
buttons when you are away from the terminal.

```text
🟢 Done · TradeWing · feature/MC-31011
📝 Fix proposal reservation leak
🖥 m1max · ⏱ 4m12s
┃ Released the reservation on .expired and .rejected; swift build green.

Reply to this message to continue the session.
```

## How it works

- **Stop report.** On `session_stop` the plugin sends repo, branch, session title,
  machine, elapsed time, outcome, and the last response. Long text is truncated in
  the message and attached in full as a `.md` file.
- **Reply to continue.** Reply to a notification in Telegram and the text is
  injected into *that* session as your next user message.
- **Questions as buttons.** With away mode on, an `ask` call is sent to Telegram with
  one button per option instead of opening the terminal dialog. The agent ends its
  turn and resumes when you answer.
- **One reader per machine.** Sessions elect a leader through a lock file; only the
  leader polls Telegram. Leadership moves automatically when that session exits.

## Why one bot per machine

Telegram allows a single `getUpdates` reader per bot token. Two machines polling the
same bot get `409 Conflict` and steal each other's replies. So each machine gets its
own bot, and all of them live in one group with you.

Telegram's **privacy mode** (on by default) then does the routing: a bot in a group
only receives replies to *its own* messages and taps on *its own* buttons. No relay
server, no webhook.

## Install, per machine

1. **Create a bot.** In [@BotFather](https://t.me/BotFather): `/newbot`. Name it after
   the machine (`omp m1max`). Keep **Group Privacy** on (the default).
2. **Add it to your group** (or just open a private chat with it).
3. **Install the plugin:**
   ```bash
   omp plugin install git+https://github.com/igrechuhin/omp-telegram
   ```
4. **Run setup:**
   ```bash
   bun ~/.omp/plugins/node_modules/omp-telegram/scripts/setup.ts
   ```
   It verifies the token, asks you to send `/start` (in the group: `/start@yourbot`),
   learns your user id and chat id, writes `~/.omp/agent/telegram/config.json` with
   mode `0600`, sends a test message, and offers to disable the older
   `hooks/post/telegram-notify.ts` hook.
5. **Restart omp.**

Non-interactive (for a second machine you have already set up once):

```bash
bun scripts/setup.ts --token 123:ABC --chat -1001234567890 --user 4242 --machine intel --yes
```

## Usage

| Where | Action | Effect |
|---|---|---|
| Telegram | Reply to a notification | Continues that session |
| Telegram | Message with no reply (private chat only) | Goes to the newest live session |
| Telegram | `/away [on\|off]` | Toggles away mode for the whole machine |
| Telegram | `/status` | Machine, away state, poller, allowed users |
| omp | `/telegram away [on\|off]` | Same toggle, from the terminal |
| omp | `/telegram test` | Sends a test message |
| omp | `/telegram status` | Shows config and whether this session is the poller |

In a group, a message that is not a reply is ignored on purpose: every machine's bot
would see it and inject it everywhere.

## Config

`~/.omp/agent/telegram/config.json`, mode `0600`:

| Field | Meaning |
|---|---|
| `botToken` | This machine's bot token |
| `chatId` | Group or private chat to post in |
| `allowedUserIds` | Telegram user ids allowed to drive the agent. **Empty disables replies entirely.** |
| `machineName` | Label in notifications (default: short hostname) |
| `notifyNonInteractive` | Notify for `-p` / json runs too (default `true`) |

State lives beside it in `state/`: the leader lock, the update offset, per-session
inboxes, message→session routing, pending asks, away flag, and `err.log`.

## Security

- Only `allowedUserIds` can inject text. Everything else is logged and dropped.
  Telegram text becomes a prompt for an agent that can run shell commands, so treat
  that list as a credential.
- The token is never written to `err.log`.
- Replies reach a session only while its process is alive; otherwise Telegram gets
  "that session has ended".

## Troubleshooting

| Symptom | Cause |
|---|---|
| No notifications | No config (`/telegram status`), or `err.log` shows send failures |
| `getUpdates conflict` in `err.log` | Another process polls this bot. Use one bot per machine. |
| Replies ignored | Your user id is not in `allowedUserIds`, or you sent non-reply text in a group |
| Two notifications per stop | The legacy `hooks/post/telegram-notify.ts` is still active; setup can disable it |

## Development

```bash
bun test          # end-to-end against a mock Bot API
bunx tsc -p .     # type check
omp plugin link . # load this checkout in local sessions
```
