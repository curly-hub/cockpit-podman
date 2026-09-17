/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Detect whether a registry has a newer version of a local image.
 *
 * skopeo fetches the raw manifest (or manifest index) for the tag; its digest,
 * plus the digest of the manifest matching the host architecture, is compared
 * against the digests Podman recorded for the local image. */
import cockpit from 'cockpit';

export type UpdateStatus = "update" | "current" | "error";

export interface UpdateResult {
    status: UpdateStatus;
    tag: string;
    remoteDigest?: string;
    message?: string;
    checked: number; // ms since epoch
}

export interface CheckableImage {
    key: string;
    uid: number | null;
    RepoTags?: string[] | null;
    RepoDigests?: string[] | null;
    Digest?: string;
}

interface ManifestIndex {
    mediaType?: string;
    manifests?: { digest: string; platform?: { architecture?: string; os?: string } }[];
}

const STORAGE_KEY = "podman-image-updates";

/* First tag that can be looked up in a registry, or null for local/intermediate images. */
export function checkableTag(image: CheckableImage): string | null {
    for (const tag of image.RepoTags ?? []) {
        if (tag.startsWith("localhost/") || tag.includes("<none>"))
            continue;
        return tag;
    }
    return null;
}

async function sha256(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return "sha256:" + Array.from(new Uint8Array(hash))
            .map(b => b.toString(16).padStart(2, "0"))
            .join("");
}

export async function checkImage(image: CheckableImage, tag: string, arch: string): Promise<UpdateResult> {
    const checked = Date.now();
    try {
        const raw = await cockpit.spawn(["skopeo", "inspect", "--raw", `docker://${tag}`], {
            err: "message",
            binary: true,
            ...(image.uid === 0 ? { superuser: "try" as const } : {}),
        });

        const indexDigest = await sha256(raw);
        const remote = new Set<string>([indexDigest]);
        try {
            const parsed = JSON.parse(new TextDecoder().decode(raw)) as ManifestIndex;
            for (const m of parsed.manifests ?? []) {
                if (m.platform?.architecture === arch && (m.platform?.os ?? "linux") === "linux")
                    remote.add(m.digest);
            }
        } catch {
            // single-platform manifest: indexDigest already is the manifest digest
        }

        const local = new Set<string>();
        if (image.Digest)
            local.add(image.Digest);
        for (const repoDigest of image.RepoDigests ?? []) {
            const at = repoDigest.indexOf("@");
            if (at >= 0)
                local.add(repoDigest.slice(at + 1));
        }

        const current = [...remote].some(d => local.has(d));
        return { status: current ? "current" : "update", tag, remoteDigest: indexDigest, checked };
    } catch (ex) {
        const err = ex as { message?: string; problem?: string };
        return { status: "error", tag, message: err.message || err.problem || String(ex), checked };
    }
}

/* Check all registry-backed images with limited concurrency; report each result as it arrives. */
export async function checkImages(
    images: CheckableImage[],
    arch: string,
    onResult: (key: string, result: UpdateResult) => void,
    concurrency = 4,
): Promise<void> {
    const queue: { image: CheckableImage; tag: string }[] = [];
    for (const image of images) {
        const tag = checkableTag(image);
        if (tag)
            queue.push({ image, tag });
    }

    const worker = async () => {
        for (;;) {
            const item = queue.shift();
            if (!item)
                return;
            onResult(item.image.key, await checkImage(item.image, item.tag, arch));
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

/* Results survive a page reload within the browser session. */
export function loadResults(): Record<string, UpdateResult> {
    try {
        return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}") as Record<string, UpdateResult>;
    } catch {
        return {};
    }
}

export function storeResults(results: Record<string, UpdateResult>): void {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(results));
    } catch {
        // storage unavailable, results simply are not persisted
    }
}
