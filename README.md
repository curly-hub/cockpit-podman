# cockpit-podman (podorel-ui)

A [Cockpit](https://cockpit-project.org/) page for managing
[Podman](https://podman.io/) containers, pods, images, volumes, networks and
secrets on one host.

This is a fork of
[cockpit-project/cockpit-podman](https://github.com/cockpit-project/cockpit-podman).
The `podorel-ui` branch adds an overview, pod cards, compose stacks, image
update and vulnerability checks, diagnostics and a number of dialogs on top of
the upstream page, and is rebased on upstream `main` regularly. Everything
talks to Podman through its [REST API](https://docs.podman.io/en/latest/_static/api.html)
over the Cockpit bridge; there is no agent, no database and no separate login.

## What the page shows

**Overview.** Runtime mode, Podman version, socket state per owner, counts of
containers, pods, images and volumes, CPU, memory, network and disk I/O across
containers, storage use, and a list of what is wrong right now: unhealthy
containers, restart loops, failed exits, degraded pods, images with updates.
"View logs" opens a page-wide log view: pick any containers across pods and
owners, filter lines, pause, save as a file.

**Pods.** One card per pod with health, CPU and memory bars, member containers,
compose stack and file, I/O, and actions. "View logs" merges the logs of all
members live. Compose stacks discovered from container labels can be
recreated or pulled and recreated. "Deploy compose stack" takes pasted YAML or
an existing file, validates it, pulls and starts it. "Create from template"
offers a catalog of common services (nginx, whoami, PostgreSQL, MariaDB,
Redis, a Python file server, a Node.js app), asks only for what varies, and
saves your own templates in `~/.config/cockpit-podman/templates.json`.

**Images.** The upstream list plus "Check for updates" (digest comparison with
the registry through `skopeo`), inline pull and "recreate with new image" for
compose containers, "Build image from Containerfile" with a factual review of
the file before building, and "Scan for vulnerabilities" with
[Trivy](https://trivy.dev/): a label with the critical and high count, and a
tab listing every finding with a severity filter. Counts only, no score.

**Containers.** A flat table with a Pod column and state filters (all,
running, unhealthy, exited, newer image), plus per-container tabs for
resources with ten-minute history, security facts (privileged, host
namespaces, capabilities, mounts, SELinux label, seccomp) and the upstream
details, logs, terminal and health check log.

**Volumes, Networks, Secrets.** Which containers use each, sizes, unused
entries, delete and prune. Secrets can be created from a typed value or a file;
Podman never returns their content.

**Diagnostics.** When a Podman service is unavailable the page explains why
(not installed, socket missing, inactive or masked, permission denied, API
failing) and offers the matching recovery action instead of a generic error.

## Requirements

- Cockpit and Podman 4.0 or newer (5.x recommended) on Fedora or another
  systemd-based distribution.
- Optional, for the features that use them: `podman-compose` (stacks),
  `skopeo` (image update checks), `trivy` (vulnerability scans).

## Building

On Fedora:

    sudo dnf install nodejs make git

Then:

    git clone https://github.com/curly-hub/cockpit-podman
    cd cockpit-podman
    git checkout podorel-ui
    make

This builds the page into `dist/`.

## Installing

For your own user only, without touching the packaged cockpit-podman:

    make devel-install

That links `~/.local/share/cockpit/podman` to `dist/`; reload the Podman page in
Cockpit. `make watch` rebuilds on every source change, and `make devel-uninstall`
removes the link again.

System-wide, `sudo make install` puts the page in `/usr/local/share/cockpit/`
and needs `gettext` for the translations. `make rpm` builds an RPM.

## Checks

    npm run eslint
    npm run stylelint
    codespell src

The old `.jsx` files carry a large number of pre-existing strict-mode
TypeScript errors; only the `.ts` and `.tsx` files are expected to be clean
under `npx tsc --noEmit`.

## Upstream

Bug reports and features that make sense for every Cockpit user belong in
[cockpit-project/cockpit-podman](https://github.com/cockpit-project/cockpit-podman).
To stay current:

    git fetch upstream && git rebase upstream/main

See [HACKING.md](./HACKING.md) for the upstream development notes.

## License

LGPL-2.1-or-later, like upstream cockpit-podman.
