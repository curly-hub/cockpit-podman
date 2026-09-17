/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Compose stack discovery from container labels, and stack operations via podman-compose.
 *
 * podman-compose (and docker-compose) label every container with the project name,
 * the working directory and the compose file(s). Nothing is stored on the pod itself,
 * so a pod's stack is derived from its member containers. */
import cockpit from 'cockpit';

import type { Uid } from './rest.js';

export interface StackInfo {
    project: string;
    service: string;
    workingDir: string;
    configFiles: string[];
}

interface Labeled {
    Config?: { Labels?: Record<string, string> | null };
}

export function containerStack(container: Labeled | undefined | null): StackInfo | null {
    const labels = container?.Config?.Labels;
    if (!labels)
        return null;
    const project = labels["com.docker.compose.project"] || labels["io.podman.compose.project"];
    if (!project)
        return null;
    const files = labels["com.docker.compose.project.config_files"] || "";
    return {
        project,
        service: labels["com.docker.compose.service"] || labels["io.podman.compose.service"] || "",
        workingDir: labels["com.docker.compose.project.working_dir"] || "",
        configFiles: files
            ? files.split(",").map(f => f.trim())
                    .filter(Boolean)
            : [],
    };
}

/* The stack shared by a pod's members; null when members belong to no or different projects. */
export function stackOfPod(members: (Labeled | undefined | null)[]): StackInfo | null {
    let stack: StackInfo | null = null;
    for (const member of members) {
        const s = containerStack(member);
        if (!s)
            continue;
        if (stack && stack.project !== s.project)
            return null;
        stack = stack ?? s;
    }
    return stack;
}

/* podman-compose can only be run for the session user and, with privileges, for root. */
export const canManageStack = (uid: Uid, stack: StackInfo | null): stack is StackInfo =>
    !!stack && !!stack.workingDir && (uid === null || uid === 0);

export function composeSpawn(uid: Uid, stack: StackInfo, args: string[]) {
    return cockpit.spawn(
        ["podman-compose", ...stack.configFiles.flatMap(f => ["-f", f]), ...args],
        {
            directory: stack.workingDir,
            err: "message",
            environ: ["LC_ALL=C.UTF-8"],
            ...(uid === 0 ? { superuser: "require" as const } : {}),
        });
}

/* `podman-compose up -d` recreates containers whose image or configuration changed. */
export async function recreateStack(uid: Uid, stack: StackInfo, pull: boolean): Promise<void> {
    if (pull)
        await composeSpawn(uid, stack, ["pull"]);
    await composeSpawn(uid, stack, ["up", "-d"]);
}

/* tag → image ID for every locally known image; used to spot containers still running an
 * older image after its tag was pulled again. */
export function tagToImageId(images: Record<string, { uid: Uid; Id: string; RepoTags?: string[] | null }> | null | undefined,
    makeKey: (uid: Uid, id: string) => string): Record<string, string> {
    const map: Record<string, string> = {};
    for (const image of Object.values(images ?? {})) {
        for (const tag of image.RepoTags ?? [])
            map[makeKey(image.uid, tag)] = image.Id;
    }
    return map;
}

export function isOutdated(container: { uid: Uid; Image?: string; ImageName?: string } | undefined | null,
    tagMap: Record<string, string>, makeKey: (uid: Uid, id: string) => string): boolean {
    if (!container?.ImageName || !container.Image)
        return false;
    const current = tagMap[makeKey(container.uid, container.ImageName)];
    return !!current && current !== container.Image;
}
