# Syncing Moss notes between a Mac and a Linux replica

Two replicas keep one scoped set of Moss notes in sync through a moss-multi deployment:

- **M, the Mac** holds the notes in Moss's folders (`<Title>/<Title>.md`). Its scope allows the notes it may upload and
  denies private folders.
- **L, the Linux replica** starts empty. Its scope follows the same entry note, so it pulls from the server only the
  notes that note links to. Agents read and edit them there, and may create new ones.

Each replica runs `moss-multi watch` as a service. When the Mac is offline, L keeps working. When the Mac returns, its
daemon pulls every change. That includes a note an agent made and linked from a followed note, which arrives download
only. If Moss saves an open note over a pulled edit, sync keeps the pulled edit and pushes only the new typing; anything
it cannot place goes to `<note>.md.rej`, never to the server.

The scope rules are in `moss-multi help` (`init --scope`, `scope confirm`): only `allow` uploads, `follow` pulls, and
`deny` always wins.

## 1. Install the CLI (both replicas)

The CLI is one bundled file with no install step. It needs Node 24.18.1 or later (`node --version`).

1. Download the `moss-multi-cli` artifact from a green CI run of the commit you want. With the GitHub CLI:

   ```sh
   gh run download <run-id> --repo brsbl/moss-multi --name moss-multi-cli --dir moss-multi-cli
   cd moss-multi-cli
   ```

   You can also download the artifact zip from the run's page and unzip it.

2. Verify the checksums. On macOS, run `shasum -a 256 -c SHA256SUMS`. On Linux, run `sha256sum -c SHA256SUMS`. Every
   line must say `OK`. The bundle's SHA-256 must also match the `sha256` printed in that run's **Pack the CLI** step.

3. Put the CLI on your PATH:

   ```sh
   install -d ~/.local/lib/moss-multi ~/.local/bin
   install -m 755 moss-multi.mjs moss-multi-watch.sh ~/.local/lib/moss-multi/
   ln -sf ~/.local/lib/moss-multi/moss-multi.mjs ~/.local/bin/moss-multi
   ```

   Add `~/.local/bin` to your PATH if it is not there, for example in `~/.zshrc` or `~/.profile`:
   `export PATH="$HOME/.local/bin:$PATH"`.

4. Check the install: `moss-multi --version` prints `moss-multi <version> (commit <sha>)`. The commit must equal the
   `commit` in `release.json`.

## 2. Operator checklist

Mint one agent key per replica in the web app under **Settings → Agents** (for example "Mac" and "Linux agent").

On each replica:

1. **Sign in with the agent key.** Write `~/.config/moss-multi/watch.env` with the server and key, then make it
   private. The service refuses the file unless its mode is 600.

   ```sh
   mkdir -p ~/.config/moss-multi
   printf 'MOSS_MULTI_SERVER=%s\nMOSS_MULTI_API_KEY=%s\n' 'https://notes.example.com' 'mm_sk_...' > ~/.config/moss-multi/watch.env
   chmod 600 ~/.config/moss-multi/watch.env
   MOSS_MULTI_NO_OPEN=1 moss-multi login --server https://notes.example.com --key mm_sk_...
   moss-multi whoami
   ```

2. **Scope the workspace.**

   On the Mac, in the Moss notes folder:

   ```sh
   cd ~/Moss/Notes
   moss-multi init --scope --follow 'Moss Home' --deny 'Personal/**' --deny 'Admin/Finance/**'
   moss-multi scope confirm     # read the list; answer y to allow exactly those notes
   moss-multi sync              # the first upload
   ```

   On Linux, in an empty folder:

   ```sh
   mkdir -p ~/Notes && cd ~/Notes
   moss-multi init --scope --allow '**' --follow 'Moss Home' --deny 'Personal/**' --deny 'Admin/Finance/**'
   moss-multi sync              # pulls Moss Home and the notes it links to
   ```

   `--allow '**'` lets L upload what its agents edit or create. L only ever holds notes it pulled through `follow`, plus
   the agents' own notes. Use the same `--deny` list as the Mac, so a file an agent writes under a denied folder never
   leaves L. A new note reaches the Mac only if a followed note links to it within the scope's `depth` (default 1, so
   link it from Moss Home). On the Mac it is download only until `moss-multi scope confirm` adds it.

3. **Install the service.** Make the log folder first, then follow the steps for that system.

   **macOS (launchd agent):**

   ```sh
   mkdir -p ~/Library/Logs/moss-multi ~/Library/LaunchAgents
   sed "s#/Users/YOU#$HOME#g" moss-multi-cli/app.moss-multi.watch.plist > ~/Library/LaunchAgents/app.moss-multi.watch.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.moss-multi.watch.plist
   ```

   Edit the last `ProgramArguments` entry first if the notes are not in `~/Moss/Notes`, and the `PATH` entry if `node`
   is elsewhere. The agent starts at login, restarts after a failure and logs to `~/Library/Logs/moss-multi/watch.log`.
   To stop it, run `launchctl bootout gui/$(id -u)/app.moss-multi.watch`.

   **Linux (systemd user unit):**

   ```sh
   mkdir -p ~/.local/state/moss-multi ~/.config/systemd/user
   cp moss-multi-cli/moss-multi-watch.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now moss-multi-watch
   loginctl enable-linger "$USER"
   ```

   Edit the `ExecStart` line's last argument first if the workspace is not `~/Notes`. The unit restarts on failure and
   logs to `~/.local/state/moss-multi/watch.log`. With lingering it starts at boot without a login session. To stop it,
   run `systemctl --user disable --now moss-multi-watch`.

Both services run `moss-multi-watch.sh`, which reads the env file and sets `MOSS_MULTI_NO_OPEN=1`. It then runs
`moss-multi watch <workspace>`. Exit 78 in the log means the env file is missing or readable by others. systemd stops
retrying; launchd retries every 10 seconds until you fix it.

## 3. Checking on it

- `tail -f` the log. Each pulled, pushed or created note is one line, and failures go to the same file.
- A `<note>.md.rej` file beside a note holds typing that sync could not place. The note holds the server's text. Copy
  back what you want and delete the `.rej` file.
- Every server change is a version in the note's History, so nothing sync wrote is lost.
