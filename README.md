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
- **Timeout escalation.** Off by default. Set `/telegram escalate <seconds>` and an
  `ask` opens in the terminal as usual, moving to Telegram only once it has gone
  unanswered for that long. The terminal dialog is cancelled when it does, so only
  one channel can answer. If Telegram is unreachable the dialog reopens, so a
  question is never lost. `escalate off` disables it.
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
   then **shows whose `/start` it saw — username, name, and user id — and waits for you
   to confirm it is you** before that id becomes the allowlist. It writes
   `~/.omp/agent/telegram/config.json` with mode `0600`, sends a test message, and
   offers to disable the older `hooks/post/telegram-notify.ts` hook.
5. **Restart omp.**

Non-interactive (for a second machine you have already set up once). `--user` is
required here: `--yes` deliberately refuses to auto-accept a discovered identity.

```bash
bun scripts/setup.ts --token 123:ABC --chat -1001234567890 --user 4242 --machine intel --yes
```

## Usage

| Where | Action | Effect |
|---|---|---|
| Telegram | Reply to a notification | Continues that session |
| Telegram | Message with no reply (private chat only) | Goes to the newest live session |
| Telegram | `/away [on\|off]` | Toggles away mode for the whole machine |
| Telegram | `/status` | Machine, away state, poller, allowed users — each resolved to a linked `@username` |
| Telegram | Reply `/exit` to a notification | Ends that session. A bare `/exit` is refused, so the wrong session can't be ended. |
| omp | `/telegram away [on\|off]` | Same toggle, from the terminal |
| omp | `/telegram escalate <seconds\|off>` | Relays an `ask` left unanswered for that long. `off` disables it. |
| omp | `/telegram test` | Sends a test message |
| omp | `/telegram status` | Shows config and whether this session is the poller |

In a group, a message that is not a reply is ignored on purpose: every machine's bot
would see it and inject it everywhere.

The `/` menu in Telegram is published with `setMyCommands` — at setup, and again
whenever a session takes the poller role and the list has changed. Telegram clients
cache it, so a freshly-registered menu can take a few seconds to appear, or a chat
reopen. With one bot per machine, each bot shows its own menu.

## Config

`~/.omp/agent/telegram/config.json`, mode `0600`:

| Field | Meaning |
|---|---|
| `botToken` | This machine's bot token |
| `chatId` | Group or private chat to post in |
| `allowedUserIds` | Telegram user ids allowed to drive the agent. **Empty disables replies entirely.** |
| `machineName` | Label in notifications (default: short hostname) |
| `notifyNonInteractive` | Notify for `-p` / json runs too (default `true`) |

State lives beside it in `state/`: the leader lock, the update offset, the published
command-menu fingerprint, per-session inboxes, message→session routing, pending asks,
away flag, and `err.log`.

## Security

- **Identity is the allowlist.** Every message and every button tap is checked against
  `allowedUserIds` before anything is injected; an empty list denies everyone. Telegram
  text becomes a prompt for an agent that can run shell commands, so treat that list
  as a credential.
- Setup never adopts an id silently: it prints who sent the `/start` and asks you to
  confirm, because in a shared group anyone could send one first.
- Check the current list any time with `/telegram status`, which resolves each id to a
  username, or read `allowedUserIds` in `~/.omp/agent/telegram/config.json`. An id that
  cannot be resolved is shown as the bare number.
- Unauthorized senders get **no reply at all** — the drop is written to `err.log`, so
  the bot never confirms to a stranger that it is listening.
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
| No `/` command menu | Registered at setup and on poller start. Reopen the chat; `err.log` shows `setMyCommands` failures. |
| Notifications work but commands are ignored | Nothing is polling. Run `/telegram status`: it re-reads the config and starts the poller. `poller: none` after that means the session predates the installed build — restart it. |

A session that started before setup ran activates on its next tick, or immediately
when you run `/telegram status`. A session running code older than the installed
build keeps that old code in memory and must be restarted once.

## Development

```bash
bun test          # end-to-end against a mock Bot API
bunx tsc -p .     # type check
omp plugin link . # load this checkout in local sessions
```
