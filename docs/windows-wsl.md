# Towercab on Windows, through WSL2

Towercab needs Linux with systemd and a sandbox tool. On a Windows laptop, Ubuntu under WSL2 provides
both. This guide takes you from a fresh Windows machine to a running Towercab.

It has not yet been run end to end on a Windows machine, so the README does not list Windows as
supported. If a step here is wrong for you, `towercab doctor` (step 7) says what is missing.

## 1. Install Ubuntu in WSL2

In PowerShell as administrator:

```powershell
wsl --install -d Ubuntu
```

Restart when asked, open **Ubuntu** from the Start menu and create your Linux user. Check that it runs
as version 2:

```powershell
wsl -l -v
```

## 2. Turn on systemd

Towercab runs as a systemd user service, and systemd is off by default in WSL. In Ubuntu:

```sh
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Then, in PowerShell, `wsl --shutdown`, and open Ubuntu again. `ps -p 1 -o comm=` prints `systemd`.

## 3. Keep everything in the Linux file system

Work in your Linux home (`~`), never under `/mnt/c` or any other `/mnt/` path. The Windows drives
cannot hold private file permissions, so the GitHub App key and token files would be readable by
others, and builds are far slower there. This is not supported: Towercab's config, its home, the
repo clones and the build cache under `/mnt/`. Check out Towercab itself in `~` too.

## 4. Install the tools and log in

Inside Ubuntu, install Node.js 22.18 or newer, `git`, `gh` 2.46 or newer and the Claude Code CLI as
the README's Requirements describe, then log in inside WSL (a login on Windows does not carry over):

```sh
sudo apt update && sudo apt install -y git bubblewrap
gh auth login
claude
```

Register the GitHub App as the README's Quickstart says and keep `app.pem` next to `config.toml` with
`chmod 600 app.pem`.

## 5. Allow the sandbox

`bwrap` needs unprivileged user namespaces. WSL2 kernels normally allow them; `towercab doctor` runs
a sandbox probe and says so if not. If Ubuntu restricts them, do not turn the restriction off.
Allow only the `bwrap` Towercab uses with the narrow AppArmor profile that `towercab doctor` prints.

## 6. Keep the WSL VM running

WSL stops its VM when nothing on the Windows side uses it, and the Towercab service stops with it.
In Windows, create or edit `%UserProfile%\.wslconfig`:

```ini
[wsl2]
vmIdleTimeout=-1
```

Run `wsl --shutdown` and open Ubuntu again. While missions run, Towercab also keeps Windows itself
awake through a `powershell.exe` child (`SetThreadExecutionState`, system required). Leave the laptop
plugged in and set Windows' own sleep timers to a long time: a closed lid still sleeps the machine
unless Windows' power settings say otherwise. `towercab doctor` warns when WSL is detected without
`vmIdleTimeout`.

## 7. Install, check and start

Follow the README's Quickstart to configure and `towercab up`, then run:

```sh
towercab doctor
```

It prints `wsl: <kernel release>` and fails, with the fix on the same line, when systemd is not PID 1,
the sandbox cannot start, a path is under `/mnt/`, or a key or secrets file is not mode 600.

## 8. Open the UI

From Windows, open <http://localhost:7311> in your browser. WSL2 forwards `localhost` to the Linux
side. Add your first intent there.
