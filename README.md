# App Store GitHub Addon

An Unraid plugin that adds **GitHub star counts** to every Community Applications (CA) app tile, plus a sortable **GitHub** view of the whole CA catalog — by **stars**, **trending** (today / week / month / year), or **newest to the App Store**. It uses Community Applications' *own* app page and **never modifies the CA plugin**.

## Requirements

- Unraid 6.12+ with the **Community Applications** plugin installed.
- A GitHub **personal access token** (free). A *classic* token with **no scopes** is enough — it only reads public star counts.

## Install

1. Unraid → **Plugins** → **Install Plugin**.
2. Paste this URL and install:
   ```
   https://raw.githubusercontent.com/ghzgod/appstore-github-addon/main/appstore.github.addon.plg
   ```
3. Open **Settings → Utilities → App Store GitHub Addon** and paste your GitHub token.
   Get one at <https://github.com/settings/tokens/new> — give it any name, leave **all scopes unchecked**, generate, and copy the value.

## What you get

- ★ **star badge** on every GitHub-backed app tile, on every Apps view.
- A **GitHub ★** item in the Apps left menu that opens the real All-Apps page, with a dropdown to sort the whole catalog by **Stars**, **Trending**, or **Newest to the App Store** — using CA's native tiles and pagination.
- Trending is computed from real GitHub **stargazer timestamps**.
- Star data is cached in appdata (`/mnt/user/appdata/appstore_github_addon`) and refreshed daily; a manual refresh is available (rate-limited to once every 3 days).

## How it works (without modifying CA)

The plugin reads CA's catalog cache read-only, fetches star counts from the GitHub API (cached in SQLite), and decorates CA's own page. Sorting works by injecting numeric metrics into CA's transient `displayed.json` and then calling CA's *own* sort — so CA re-renders **its real tiles** in the new order. Nothing in the Community Applications plugin is changed, and the bundled `.plg` ships with **no token or other secrets** — each user sets their own.

## License

[MIT](LICENSE)
