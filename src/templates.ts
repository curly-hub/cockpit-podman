/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Pod templates: a built-in catalog of common single-container services and the user's own
 * saved templates, plus the steps that turn a template into a running pod.
 *
 * Custom templates live in ~/.config/cockpit-podman/templates.json of the session user, a plain
 * JSON file that can be edited or copied by hand. */
import cockpit from 'cockpit';
import type { JsonObject } from 'cockpit';

import * as client from './client.js';
import type { Connection } from './rest.js';

const _ = cockpit.gettext;

export interface TemplatePort {
    container: number;
    host?: number;
    protocol?: "tcp" | "udp";
}

export interface TemplateEnv {
    key: string;
    value: string;
    required?: boolean;
    secret?: boolean; // shown as a password field
    description?: string;
}

export interface TemplateVolume {
    container: string;
    /* a host directory to bind mount; when unset, a named volume "<pod>-<name>" is created */
    host?: string;
    name?: string;
    readOnly?: boolean;
    description?: string;
}

export interface TemplateHealthcheck {
    command: string[];
    interval?: number; // seconds
    retries?: number;
    startPeriod?: number; // seconds
    timeout?: number; // seconds
}

export interface PodTemplate {
    id: string;
    name: string;
    description: string;
    image: string;
    command?: string[];
    ports: TemplatePort[];
    env: TemplateEnv[];
    volumes: TemplateVolume[];
    memoryLimit?: number; // bytes
    restartPolicy?: "no" | "always" | "on-failure";
    healthcheck?: TemplateHealthcheck;
    notes?: string;
    builtin?: boolean;
}

const MB = 1000 * 1000;

export const BUILTIN_TEMPLATES: PodTemplate[] = [
    {
        id: "nginx-static",
        name: "Nginx static site",
        description: _("Serves the files of a host directory over HTTP."),
        image: "docker.io/library/nginx:alpine",
        ports: [{ container: 80, host: 8080 }],
        env: [],
        volumes: [{ container: "/usr/share/nginx/html", host: "", readOnly: true, description: _("Directory with the site files") }],
        memoryLimit: 256 * MB,
        restartPolicy: "always",
        healthcheck: { command: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1/ || exit 1"], interval: 30, retries: 3, startPeriod: 5 },
        builtin: true,
    },
    {
        id: "whoami",
        name: "HTTP echo (whoami)",
        description: _("A tiny web server that prints the request it receives. Handy for testing ports and proxies."),
        image: "docker.io/traefik/whoami:latest",
        ports: [{ container: 80, host: 8081 }],
        env: [],
        volumes: [],
        memoryLimit: 64 * MB,
        restartPolicy: "always",
        builtin: true,
    },
    {
        id: "postgres",
        name: "PostgreSQL",
        description: _("PostgreSQL 17 with its data in a named volume."),
        image: "docker.io/library/postgres:17",
        ports: [{ container: 5432, host: 5432 }],
        env: [
            { key: "POSTGRES_PASSWORD", value: "", required: true, secret: true, description: _("Password of the superuser") },
            { key: "POSTGRES_USER", value: "postgres" },
            { key: "POSTGRES_DB", value: "app" },
        ],
        volumes: [{ container: "/var/lib/postgresql/data", name: "data" }],
        memoryLimit: 1024 * MB,
        restartPolicy: "always",
        healthcheck: { command: ["CMD-SHELL", "pg_isready -U \"$POSTGRES_USER\" || exit 1"], interval: 30, retries: 3, startPeriod: 10 },
        builtin: true,
    },
    {
        id: "mariadb",
        name: "MariaDB",
        description: _("MariaDB 11 with its data in a named volume."),
        image: "docker.io/library/mariadb:11",
        ports: [{ container: 3306, host: 3306 }],
        env: [
            { key: "MARIADB_ROOT_PASSWORD", value: "", required: true, secret: true, description: _("Password of the root user") },
            { key: "MARIADB_DATABASE", value: "app" },
        ],
        volumes: [{ container: "/var/lib/mysql", name: "data" }],
        memoryLimit: 1024 * MB,
        restartPolicy: "always",
        healthcheck: { command: ["CMD-SHELL", "healthcheck.sh --connect --innodb_initialized || exit 1"], interval: 30, retries: 3, startPeriod: 20 },
        builtin: true,
    },
    {
        id: "redis",
        name: "Redis",
        description: _("Redis 7 key-value store, persisted to a named volume."),
        image: "docker.io/library/redis:7-alpine",
        command: ["redis-server", "--save", "60", "1", "--appendonly", "yes"],
        ports: [{ container: 6379, host: 6379 }],
        env: [],
        volumes: [{ container: "/data", name: "data" }],
        memoryLimit: 256 * MB,
        restartPolicy: "always",
        healthcheck: { command: ["CMD-SHELL", "redis-cli ping | grep -q PONG || exit 1"], interval: 30, retries: 3, startPeriod: 5 },
        builtin: true,
    },
    {
        id: "python-http",
        name: "Python file server",
        description: _("Python's built-in HTTP server, sharing a host directory read-only."),
        image: "docker.io/library/python:3-alpine",
        command: ["python3", "-m", "http.server", "8000", "--directory", "/srv"],
        ports: [{ container: 8000, host: 8000 }],
        env: [],
        volumes: [{ container: "/srv", host: "", readOnly: true, description: _("Directory to share") }],
        memoryLimit: 128 * MB,
        restartPolicy: "on-failure",
        builtin: true,
    },
    {
        id: "node-app",
        name: "Node.js application",
        description: _("Runs a Node.js project from a host directory with `node server.js`. Install its dependencies on the host first."),
        image: "docker.io/library/node:22-alpine",
        command: ["node", "server.js"],
        ports: [{ container: 3000, host: 3000 }],
        env: [{ key: "NODE_ENV", value: "production" }],
        volumes: [{ container: "/app", host: "", description: _("Project directory containing server.js") }],
        memoryLimit: 512 * MB,
        restartPolicy: "on-failure",
        notes: _("The container's working directory is /app."),
        builtin: true,
    },
];

const TEMPLATES_FILE = ".config/cockpit-podman/templates.json";

export const templatesPath = (home: string) => `${home}/${TEMPLATES_FILE}`;

// pod names, like container names
export const POD_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
// template ids double as file-friendly keys
export const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function sanitize(raw: unknown): PodTemplate | null {
    if (!raw || typeof raw !== "object")
        return null;
    const t = raw as Partial<PodTemplate>;
    if (typeof t.id !== "string" || !TEMPLATE_ID_RE.test(t.id) || typeof t.image !== "string" || !t.image)
        return null;
    return {
        id: t.id,
        name: typeof t.name === "string" && t.name ? t.name : t.id,
        description: typeof t.description === "string" ? t.description : "",
        image: t.image,
        ...(Array.isArray(t.command) ? { command: t.command.map(String) } : {}),
        ports: Array.isArray(t.ports) ? t.ports.filter(p => p && Number.isInteger(p.container)) : [],
        env: Array.isArray(t.env) ? t.env.filter(e => e && typeof e.key === "string").map(e => ({ ...e, value: String(e.value ?? "") })) : [],
        volumes: Array.isArray(t.volumes) ? t.volumes.filter(v => v && typeof v.container === "string") : [],
        ...(typeof t.memoryLimit === "number" ? { memoryLimit: t.memoryLimit } : {}),
        ...(t.restartPolicy ? { restartPolicy: t.restartPolicy } : {}),
        ...(t.healthcheck && Array.isArray(t.healthcheck.command) ? { healthcheck: t.healthcheck } : {}),
        ...(typeof t.notes === "string" ? { notes: t.notes } : {}),
    };
}

/* The user's saved templates; a missing file means none. */
export async function loadCustomTemplates(home: string): Promise<PodTemplate[]> {
    const content = await cockpit.file(templatesPath(home)).read();
    if (!content)
        return [];
    const parsed = JSON.parse(content) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { templates?: unknown[] })?.templates ?? [];
    return list.map(sanitize).filter((t): t is PodTemplate => t !== null);
}

export async function saveCustomTemplates(home: string, templates: PodTemplate[]): Promise<void> {
    const dir = templatesPath(home).replace(/\/[^/]*$/, "");
    await cockpit.spawn(["mkdir", "-p", dir], { err: "message" });
    const stripped = templates.map(t => {
        const copy = { ...t };
        delete copy.builtin;
        return copy;
    });
    await cockpit.file(templatesPath(home)).replace(JSON.stringify({ templates: stripped }, null, 2) + "\n");
}

/* Everything the user filled in for one pod. */
export interface TemplateValues {
    podName: string;
    hostPorts: Record<number, number | null>; // container port → host port, null publishes nothing
    env: Record<string, string>;
    hostPaths: Record<string, string>; // container path → host directory, for bind-mount volumes
    memoryLimit: number | null; // bytes
    restartPolicy: "no" | "always" | "on-failure";
}

export const defaultValues = (t: PodTemplate): TemplateValues => ({
    podName: t.id,
    hostPorts: Object.fromEntries(t.ports.map(p => [p.container, p.host ?? null])),
    env: Object.fromEntries(t.env.map(e => [e.key, e.value])),
    hostPaths: Object.fromEntries(t.volumes.filter(v => v.host !== undefined).map(v => [v.container, v.host ?? ""])),
    memoryLimit: t.memoryLimit ?? null,
    restartPolicy: t.restartPolicy ?? "no",
});

/* A template with the values folded back in, for "save as template". */
export function templateFromValues(base: PodTemplate, values: TemplateValues, id: string, name: string, description: string): PodTemplate {
    const t: PodTemplate = {
        id,
        name,
        description,
        image: base.image,
        ports: base.ports.map(p => ({ container: p.container, ...(p.protocol ? { protocol: p.protocol } : {}), ...(values.hostPorts[p.container] ? { host: values.hostPorts[p.container] as number } : {}) })),
        env: base.env.map(e => ({ ...e, value: e.secret ? "" : (values.env[e.key] ?? e.value) })),
        volumes: base.volumes.map(v => v.host !== undefined ? { ...v, host: values.hostPaths[v.container] ?? "" } : v),
        restartPolicy: values.restartPolicy,
    };
    if (base.command)
        t.command = base.command;
    if (values.memoryLimit)
        t.memoryLimit = values.memoryLimit;
    if (base.healthcheck)
        t.healthcheck = base.healthcheck;
    if (base.notes)
        t.notes = base.notes;
    return t;
}

export function validateValues(t: PodTemplate, values: TemplateValues): string | null {
    if (!POD_NAME_RE.test(values.podName))
        return _("The pod name may contain letters, digits, underscores, dots and hyphens and must start with a letter or digit.");
    for (const e of t.env) {
        if (e.required && !values.env[e.key])
            return cockpit.format(_("$0 needs a value."), e.key);
    }
    for (const v of t.volumes) {
        if (v.host !== undefined && !values.hostPaths[v.container])
            return cockpit.format(_("A host directory for $0 is needed."), v.container);
    }
    for (const p of t.ports) {
        const host = values.hostPorts[p.container];
        if (host !== null && (!Number.isInteger(host) || host < 1 || host > 65535))
            return cockpit.format(_("Host port for $0 must be between 1 and 65535."), p.container);
    }
    return null;
}

export type StepCallback = (step: "pod" | "pull" | "container" | "start", state: "running" | "done") => void;

/* Create the pod, make sure the image is there, create the container and start the pod. */
export async function createFromTemplate(con: Connection, t: PodTemplate, values: TemplateValues, onStep: StepCallback): Promise<void> {
    onStep("pod", "running");
    const portmappings = t.ports
            .filter(p => values.hostPorts[p.container])
            .map(p => ({ container_port: p.container, host_port: values.hostPorts[p.container] as number, protocol: p.protocol ?? "tcp" }));
    const podReply = JSON.parse(await client.createPod(con, { name: values.podName, ...(portmappings.length ? { portmappings } : {}) })) as { Id: string };
    onStep("pod", "done");

    onStep("pull", "running");
    try {
        await client.imageExists(con, t.image);
    } catch {
        await client.pullImage(con, t.image);
    }
    onStep("pull", "done");

    onStep("container", "running");
    const config: JsonObject = {
        pod: podReply.Id,
        image: t.image,
        name: `${values.podName}-${t.id}`,
        env: Object.fromEntries(t.env.map(e => [e.key, values.env[e.key] ?? e.value]).filter(([, v]) => v !== "")),
        labels: { "io.cockpit.podman.template": t.id },
    };
    if (t.command)
        config.command = t.command;
    const mounts = t.volumes.filter(v => v.host !== undefined).map(v => ({
        type: "bind",
        source: values.hostPaths[v.container],
        destination: v.container,
        options: [...(v.readOnly ? ["ro"] : []), "Z"],
    }));
    if (mounts.length)
        config.mounts = mounts;
    const named = t.volumes.filter(v => v.host === undefined).map(v => ({
        Name: `${values.podName}-${v.name ?? v.container.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-/, "")}`,
        Dest: v.container,
        Options: v.readOnly ? ["ro"] : [],
    }));
    if (named.length)
        config.volumes = named;
    if (values.memoryLimit)
        config.resource_limits = { memory: { limit: values.memoryLimit } };
    if (values.restartPolicy !== "no")
        config.restart_policy = values.restartPolicy;
    if (t.healthcheck) {
        config.healthconfig = {
            Test: t.healthcheck.command,
            Interval: (t.healthcheck.interval ?? 30) * 1e9,
            Retries: t.healthcheck.retries ?? 3,
            StartPeriod: (t.healthcheck.startPeriod ?? 0) * 1e9,
            Timeout: (t.healthcheck.timeout ?? 30) * 1e9,
        };
    }
    await client.createContainer(con, config);
    onStep("container", "done");

    onStep("start", "running");
    await client.postPod(con, "start", podReply.Id, {});
    onStep("start", "done");
}
