/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Layered checks that explain why a Podman service could not be reached.
 *
 *   Podman installed → user runtime directory → podman.socket unit →
 *   socket file → REST API
 *
 * Every layer is checked even after an earlier one failed, so the result
 * shows the whole chain, but `problem` names the first broken layer. */
import cockpit from 'cockpit';

import * as client from './client.js';
import rest, { type Uid } from './rest.js';

const _ = cockpit.gettext;

export type StepStatus = "ok" | "fail" | "warn" | "skipped";

export interface DiagStep {
    id: string;
    title: string;
    status: StepStatus;
    detail: string;
}

export interface UnitState {
    LoadState: string;
    ActiveState: string;
    SubState: string;
    UnitFileState: string;
}

export type Problem =
    | "access-denied"
    | "not-installed"
    | "no-runtime-dir"
    | "unit-missing"
    | "masked"
    | "inactive"
    | "no-socket"
    | "api"
    | "unknown";

export interface Diagnosis {
    uid: Uid;
    username: string;
    system: boolean;
    scope: string;
    socketPath: string;
    steps: DiagStep[];
    unit: UnitState | null;
    problem: Problem;
    title: string;
    hint: string;
    finished: number;
}

interface SpawnError {
    message?: string;
    problem?: string;
    exit_status?: number;
}

const errText = (ex: unknown): string => {
    const e = ex as SpawnError;
    return e.message || e.problem || String(ex);
};

export function socketPathFor(uid: Uid): string {
    if (uid === 0)
        return "/run/podman/podman.sock";
    if (uid === null)
        return `${sessionStorage.getItem('XDG_RUNTIME_DIR') || "$XDG_RUNTIME_DIR"}/podman/podman.sock`;
    return `/run/user/${uid}/podman/podman.sock`;
}

/* systemctl invocation for the given service owner, mirroring app.jsx init() */
export function systemctl(uid: Uid, username: string, args: string[]) {
    const system = uid === 0;
    const other = uid !== null && uid !== 0;
    return cockpit.spawn(
        [
            ...(other ? ["runuser", "-u", username, "--"] : []),
            "systemctl",
            ...(system ? [] : ["--user"]),
            ...args,
        ],
        {
            err: "message",
            environ: other ? [`XDG_RUNTIME_DIR=/run/user/${uid}`] : [],
            ...(uid === null ? {} : { superuser: "require" as const }),
        });
}

export const journalUrl = (uid: Uid): string =>
    uid === 0
        ? "/system/logs/#/?priority=info&_SYSTEMD_UNIT=podman.socket"
        : "/system/logs/#/?priority=info&_SYSTEMD_USER_UNIT=podman.socket";

export const servicesUrl = (uid: Uid): string =>
    uid === 0 ? "/system/services#/podman.socket" : "/system/services#/podman.socket?owner=user";

export const enableLinger = (username: string) =>
    cockpit.spawn(["loginctl", "enable-linger", username], { superuser: "require", err: "message" });

function describe(problem: Problem, system: boolean): { title: string; hint: string } {
    switch (problem) {
    case "access-denied":
        return {
            title: _("Administrative access required"),
            hint: _("System (rootful) containers can only be managed with administrative access. Turn it on in the top bar."),
        };
    case "not-installed":
        return {
            title: _("Podman is not installed"),
            hint: _("The podman command was not found. Install the podman package and reload this page."),
        };
    case "no-runtime-dir":
        return {
            title: _("User session is not available"),
            hint: _("Rootless Podman needs the user's runtime directory. It exists only while the user has a session or lingering is enabled."),
        };
    case "unit-missing":
        return {
            title: _("Podman socket unit is missing"),
            hint: _("systemd does not know a podman.socket unit. Reinstalling podman restores it."),
        };
    case "masked":
        return {
            title: _("Podman socket is masked"),
            hint: _("podman.socket has been masked and cannot start until it is unmasked."),
        };
    case "inactive":
        return {
            title: system ? _("System Podman socket is not running") : _("Rootless Podman socket is not running"),
            hint: _("Cockpit talks to Podman through its socket. Start the socket, or enable it so it starts automatically."),
        };
    case "no-socket":
        return {
            title: _("Podman socket file is missing"),
            hint: _("podman.socket is active but the socket file does not exist. Restarting the socket usually recreates it."),
        };
    case "api":
        return {
            title: _("Podman API is not responding"),
            hint: _("The socket exists but the API request failed. The journal of podman.service has details."),
        };
    default:
        return {
            title: system ? _("System Podman service failed") : _("Rootless Podman service failed"),
            hint: _("All checks passed but the service could not be initialized. Retry, or check the journal."),
        };
    }
}

export async function diagnose(uid: Uid, username: string, initError?: unknown): Promise<Diagnosis> {
    const system = uid === 0;
    const other = uid !== null && uid !== 0;
    const su = uid === null ? {} : { superuser: "require" as const };
    const socketPath = socketPathFor(uid);
    const scope = system ? _("System (rootful) Podman") : (other ? cockpit.format(_("Rootless Podman of $0"), username) : _("Rootless Podman"));
    const steps: DiagStep[] = [];
    let unit: UnitState | null = null;
    let problem: Problem = "unknown";
    const setProblem = (p: Problem) => { if (problem === "unknown") problem = p; };

    const initErr = initError as SpawnError | undefined;
    if (system && initErr?.problem === "access-denied") {
        steps.push({ id: "access", title: _("Administrative access"), status: "fail", detail: _("Not available in this session") });
        return { uid, username, system, scope, socketPath, steps, unit, problem: "access-denied", ...describe("access-denied", system), finished: Date.now() };
    }

    // 1. podman binary
    try {
        const out = await cockpit.spawn(["podman", "--version"], { err: "message" });
        steps.push({ id: "installed", title: _("Podman installed"), status: "ok", detail: out.trim() });
    } catch (ex) {
        const notFound = (ex as SpawnError).problem === "not-found";
        steps.push({ id: "installed", title: _("Podman installed"), status: "fail", detail: notFound ? _("podman command not found") : errText(ex) });
        setProblem("not-installed");
    }

    // 2. user runtime directory
    if (!system) {
        const xrd = uid === null ? sessionStorage.getItem('XDG_RUNTIME_DIR') : `/run/user/${uid}`;
        if (!xrd) {
            steps.push({ id: "runtime", title: _("User runtime directory"), status: "fail", detail: _("$XDG_RUNTIME_DIR is not set in this session") });
            setProblem("no-runtime-dir");
        } else {
            try {
                await cockpit.spawn(["test", "-d", xrd], { err: "message", ...su });
                steps.push({ id: "runtime", title: _("User runtime directory"), status: "ok", detail: xrd });
            } catch {
                steps.push({ id: "runtime", title: _("User runtime directory"), status: "fail", detail: cockpit.format(_("$0 does not exist"), xrd) });
                setProblem("no-runtime-dir");
            }
        }
    }

    // 3. systemd unit
    try {
        const out = await systemctl(uid, username, ["show", "-p", "LoadState,ActiveState,SubState,UnitFileState", "podman.socket"]);
        const parsed: Record<string, string> = {};
        for (const line of out.split("\n")) {
            const eq = line.indexOf("=");
            if (eq > 0)
                parsed[line.slice(0, eq)] = line.slice(eq + 1).trim();
        }
        unit = {
            LoadState: parsed.LoadState || "",
            ActiveState: parsed.ActiveState || "",
            SubState: parsed.SubState || "",
            UnitFileState: parsed.UnitFileState || "",
        };
        if (unit.LoadState === "not-found") {
            steps.push({ id: "unit", title: _("podman.socket unit"), status: "fail", detail: _("unit not found") });
            setProblem("unit-missing");
        } else if (unit.LoadState === "masked" || unit.UnitFileState === "masked") {
            steps.push({ id: "unit", title: _("podman.socket unit"), status: "fail", detail: _("masked") });
            setProblem("masked");
        } else if (unit.ActiveState === "active") {
            steps.push({ id: "unit", title: _("podman.socket unit"), status: "ok", detail: cockpit.format("$0 ($1), $2", unit.ActiveState, unit.SubState, unit.UnitFileState) });
        } else {
            steps.push({ id: "unit", title: _("podman.socket unit"), status: "fail", detail: cockpit.format("$0 ($1), $2", unit.ActiveState, unit.SubState, unit.UnitFileState || _("not enabled")) });
            setProblem("inactive");
        }
    } catch (ex) {
        steps.push({ id: "unit", title: _("podman.socket unit"), status: "fail", detail: errText(ex) });
        setProblem(system ? "inactive" : "no-runtime-dir");
    }

    // 4. socket file
    try {
        await cockpit.spawn(["test", "-S", socketPath], { err: "message", ...su });
        steps.push({ id: "socket", title: _("Socket file"), status: "ok", detail: socketPath });
    } catch {
        steps.push({ id: "socket", title: _("Socket file"), status: "fail", detail: cockpit.format(_("$0 does not exist"), socketPath) });
        setProblem("no-socket");
    }

    // 5. REST API
    let con: { close?: () => void } | null = null;
    try {
        const c = rest.connect(uid);
        con = c as unknown as { close?: () => void };
        const info = await client.getInfo(c);
        const version = (info.version as { Version?: string } | undefined)?.Version;
        steps.push({ id: "api", title: _("Podman API"), status: "ok", detail: version ? cockpit.format(_("Podman $0 responding"), version) : _("responding") });
    } catch (ex) {
        steps.push({ id: "api", title: _("Podman API"), status: "fail", detail: errText(ex) });
        setProblem("api");
    } finally {
        con?.close?.();
    }

    return { uid, username, system, scope, socketPath, steps, unit, problem, ...describe(problem, system), finished: Date.now() };
}
