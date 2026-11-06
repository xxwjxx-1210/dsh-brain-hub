# dsh-brain-hub

A second brain for DeepSeek Harness where **Markdown is the database and git is the sync**. No server, no database — your memory is a folder of `.md` files you can read, grep and back up.

[中文](README.md) | English

## What it does

It closes the gap between chatting in the DeepSeek web app and actually getting work done in DSH:

| Layer | What it does |
| --- | --- |
| **Memory store** | `MEMORY.md` (core memory) is injected into every system prompt; one file per note in `notes/`; `index.json` as the index; every write auto-commits and pushes |
| **Card review** | Cards extracted in the web chat land in `inbox/` first — **you approve each one**, choosing "cloud" or "local only" |
| **Web-chat notes** | Progress from the sidebar web chat is saved to `progress.md`; older drafts rotate into `history/` (last 20 kept) and the tail is fed back into the system prompt |

A brain icon in the session header opens a four-step flow:

1. **Open the web chat** — opens `chat.deepseek.com` in the sidebar.
2. **Have it write cards** — sends the extraction rules to the web chat and waits for cards in the agreed format.
3. **Review and save** — each card offers "read in full / save this one / discard".
4. **Back up to the cloud** — commit + push; unpushed commits are pushed as well.

Every step reports where it is (step N of 4; what is happening now), and step 3 shows a generation line (what time, how many cards, how many skipped).

**No de-duplication**: save the same topic as often as you like. File-name collisions get a `-2` / `-3` suffix instead of being overwritten or silently skipped.

## Install

```sh
# from npm
dsh plugin --profile <profile> add dsh-brain-hub

# from GitHub
dsh plugin --profile <profile> add "github:xxwjxx-1210/dsh-brain-hub#main"

# or from a local tgz
dsh plugin --profile <profile> add file:/absolute/path/dsh-brain-hub-0.2.6.tgz
```

Then **quit DSH completely from the tray and start it again** — the client bundle is only loaded at boot, hot reload does not replace it. Same for upgrades.

## Configuration

In `<profile>/cordis.patch.yml`, under `- id: dsh-brain-hub`; everything is optional:

```yaml
backend: git                     # git | folder | local
memoryDir: 'D:\notes\memory'    # git repo holding the memory; default $DSH_HOME/memory
notesDir: 'D:\notes\webds'      # web-chat notes; default $DSH_HOME/dsh_memory
remote: 'https://github.com/<you>/<private-repo>.git'
branch: main
coreLimit: 3000                 # chars of core memory injected
autoPull: true                  # pull --rebase on boot
autoPush: true                  # push after every write
readOnly: false                 # true rejects every write tool
injectProgress: true            # inject the tail of progress.md
```

An empty `remote` is fine — a purely local memory store works too.

> Keep the configuration in the profile layer, not in `node_modules/<package>/cordis.patch.yml`: that copy is replaced on the next install.

## First run

After installing and restarting DSH, the first click on the brain icon in the session header opens a one-time guide: the three-step workflow plus the three cloud options, each with a ready-to-paste YAML snippet. The "got it" flag is stored in `<memoryDir>/hub.json`.

## Three cloud backends

`backend` decides where the memory store goes:

| backend | Where it lives | git needed | Good for |
| --- | --- | --- | --- |
| `git` (default) | memory dir, pushed to your own private repo | yes | multi-device sync with history |
| `folder` | memory dir inside OneDrive / Dropbox / any synced folder | no | no git, let the sync client upload |
| `local` | this machine only | no | sensitive content, no backup |

```yaml
# git
config:
  backend: git
  remote: 'https://github.com/<you>/<private-repo>.git'

# OneDrive / synced folder
config:
  backend: folder
  memoryDir: 'C:\Users\<you>\OneDrive\brain-hub'

# local only
config:
  backend: local
```

In `folder` mode step 4 skips `git commit` and simply reports that files are in the synced folder.

## Cloud vs local notes

Every card in the review window has two buttons:

- **Save to cloud** → `notes/`, tracked by git and pushed.
- **Local only** → `private/`, permanently excluded in `.gitignore`, **never pushed under any circumstances**.

Rule of thumb: *would you be uncomfortable if a colleague or a client saw this note?* If yes, keep it local (real client names, quotes, phone numbers, unannounced projects). Methods, decision rules and anonymised cases go to the cloud.

## Manual fallbacks

If the web chat misbehaves (not signed in, the "unusual environment" warning, sidebar still loading), the menu keeps two routes that do not depend on automatic injection:

- **Copy the rules** — puts the extraction prompt on the clipboard so you can paste it into the web chat yourself;
- **Pull in the last answer** — reads the current conversation, splits out cards and jumps to step 3.

So the flow still completes even when step 2 cannot.

## Data format

```markdown
---
id: 20261105-120000-some-title
title: "Some title"
tags: tag-a, tag-b
created: 2026-11-05T12:00:00.000Z
updated: 2026-11-05T12:00:00.000Z
uploaded: true
---
# Some title

Body
```

The `notes/` format is compatible with `dsh-memory-github`, so an existing store can be reused as-is; `private/` uses the same format, it simply never enters git.

## Tools exposed to the model

`memory_write` · `memory_search` · `memory_read` · `memory_list` · `memory_stats` · `memory_core` · `memory_update` · `memory_forget` · `memory_sync`

With `readOnly: true` the write tools answer with a refusal instead of committing anything.

## RPC

`POST /api/plugin-rpc/brain-hub` with the envelope `{ type:"client-request", rpcId, method, payload:{ endpoint, payload } }`.

Endpoints: `status` `hub.settings` `hub.rename` `cards.list` `cards.save` `cards.read` `cards.update` `cards.discard` `cards.upload` `progress.save` `progress.read` `progress.history` `memory.sync` `prompt.get` `prompt.save`.

## Known limitations

- **The web-chat half drives the sidebar browser**: you have to be logged in to `chat.deepseek.com` inside the sidebar, and DSH asks for that login again after every restart. DeepSeek sometimes shows an "unusual environment" warning for embedded browsers; when that happens step two fails, and the plugin reports the failing stage, page URL and input state so you can see why.
- Card quality depends on the prompt. The rules live in `<memoryDir>/prompts/distill.md` and can be edited in the panel — changes apply immediately, no restart.
- Single repository, single branch. Multi-writer conflicts are left to git.
- No vector search: ranking is a weighted score over title, tags and body.

## Development

```powershell
cd dsh-brain-hub
node test\harness.mjs        # host: fake ctx + temp git repo + bare remote, 45 checks
node test\client-apply.mjs   # client: fake ModuleLoader, 8 checks
npm pack                      # then pnpm-install the tgz into a profile
```

No build step, no runtime dependencies — `dist/` is the source.

MIT License.
