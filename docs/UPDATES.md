# Updating ENJOY Signage

New versions are published to a GitHub repository, by default **`greube/enjoy-signage`** on the `main` branch. Each server can then update itself with one command:

| Server | Update with |
|---|---|
| Windows | Start → ENJOY Signage → **Update ENJOY Signage**. Or, in the ENJOY Signage folder: `node app\platform\windows\enjoy.js update` |
| Mac | In `~/Library/Application Support/ENJOY Signage`: `node app/platform/mac/enjoy.js update` |
| Ubuntu | `sudo church-signage update` |

**What it does:**

1. Asks GitHub which version is newest.
2. If that's newer than what's installed, downloads it.
3. Keeps a copy of the current program.
4. Runs the new version's own installer, which stops the server, replaces the program, keeps all your content and settings, and starts the server again.
5. Checks the new version actually starts. If it doesn't, it puts the previous version back the same way and tells you.

TVs reconnect by themselves within a few seconds. Your content is never touched by an update.

Add `--check` to only see whether an update is available, without installing anything.

---

## Setting up the repository (once)

1. Sign in at https://github.com as **greube**, click **+** (top right) → **New repository**.
2. **Repository name:** `enjoy-signage`.
3. Choose **Public** or **Private** (see below). Leave everything else empty: no README, licence or .gitignore, because the code is pushed in afterwards.
4. Click **Create repository**.

**Public or private?**
- **Public:** updates work with no setup on each server. Anyone could read the code, but it contains no passwords or church data. Those live only in each server's own content folder, which is never uploaded.
- **Private:** only you can see it, but each server needs a read-only access token. You type it in once, on the first update.

### Making a read-only token (private repositories only)

1. On GitHub, go to your picture (top right) → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Name:** `ENJOY Signage updates`. **Expiration:** pick up to a year, and put a reminder in your calendar to renew it.
3. **Repository access:** *Only select repositories* → `enjoy-signage`.
4. **Permissions → Repository permissions → Contents:** **Read-only**. Leave everything else as *No access*.
5. Click **Generate token** and copy it. It starts with `github_pat_`.

On each server, run the update once with the token:

```
node app\platform\windows\enjoy.js update --token github_pat_…       (Windows)
node app/platform/mac/enjoy.js update --token github_pat_…           (Mac)
sudo church-signage update --token github_pat_…                      (Ubuntu)
```

It's saved on that server for next time, readable only by that account (on Ubuntu, only by root). If you run an update without one, it also offers to take the token there and then. When the token expires, make a new one and run the update with `--token` again.

---

## Options

| Option | What it does |
|---|---|
| `--check` | Only say whether a newer version is available |
| `--force` | Reinstall even if it's already up to date (or to go back to an older version on the branch) |
| `--token TOKEN` | Use (and save) an access token for a private repository |
| `--repo owner/name` | Update from another repository (saved for next time) |
| `--branch name` | Update from another branch (saved for next time). For example, a `testing` branch on one server before releasing to `main`. |

## Updating without GitHub

Download the new version as a zip or .tar.gz, extract it, and run its installer, as in each platform's install guide. It does the same thing as `update`.

## Troubleshooting

| Message | What to do |
|---|---|
| *Couldn't find the repository…* | The repository is private (run with `--token`), or the name is wrong (check with `--repo`). |
| *GitHub didn't accept the access token* | The token has expired or been deleted. Make a new one and run with `--token`. |
| *GitHub is limiting requests* | Try again later. A token also raises the limit, even for a public repository. |
| *Version X didn't start properly, so putting Y back…* | The new version has a problem. You're back on the previous version and nothing was lost. Send the messages shown to whoever made the change. |
| *Couldn't reach GitHub* | The server has no internet access right now. |
