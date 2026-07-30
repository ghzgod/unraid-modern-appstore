# Unraid Modern App Store

A modern front-end for the Unraid **Apps** page. It replaces Community Applications' grid with a responsive card layout and adds the sorting CA cannot do on its own: **GitHub stars**, **trending** (stars gained today / this week / this month), **Unraid downloads**, **newest to the App Store**, or name.

It never modifies Community Applications. Everything is layered on top and scoped to this plugin's own markup, so switching the view off, or uninstalling, returns the Apps page to stock.

## Requirements

- Unraid 6.12 or newer with the **Community Applications** plugin installed.
- A GitHub **personal access token** (free) for star counts. A classic token with **no scopes** is enough; it only reads public star counts. Without one the grid still works, minus the star badges.

## Install

Plugins → Install Plugin, paste:

```
https://raw.githubusercontent.com/ghzgod/unraid-modern-appstore/main/modern.appstore.plg
```

Then set your token at **Settings → Utilities → Unraid Modern App Store**.

## What you get

- **A card grid** with the app icon, author, category, a Docker or Plugin tag, the description, and when the app was added to the store.
- **Badges** for GitHub stars and Docker pulls. Pull counts are dropped for apps built on an official base image (nginx, redis, postgres), where the figure belongs to the base image rather than the app.
- **Sorting that works across the whole catalog**, with real pagination, search and category filtering.
- **Pinned Apps** and **Installed Apps** rendered by the plugin.
- **A restyled Info drawer**, with the description, details and maintainer as one column of cards, and a built-in screenshot lightbox.
- **A Modern view toggle** in the toolbar to hand the page back to Community Applications at any time.

## How star data is gathered

Stars come from the public GitHub API, keyed to each app's project repository. They are fetched for **the apps currently on screen**, so browsing fills the catalog in gradually; an app is only re-checked if it has never been tried or its last attempt is over a week old. The refresh icon offers a rescan of the current page, or a full catalog scan (limited to once every three days).

Community Applications publishes most project links as `ca.unraid.net/cdn/...` redirectors, so the plugin resolves each one to its real destination and caches the result. Apps whose project link is a plain homepage rather than a repository have no star count, because there is no repository to count.

## What it writes

Only its own two directories:

- `/usr/local/emhttp/plugins/modern.appstore/`
- `/boot/config/plugins/modern.appstore/` (settings, the star database and its history)

Both are removed on uninstall. It never writes to any Community Applications path.

## Licence

MIT
