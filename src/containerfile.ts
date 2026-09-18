/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* A factual review of a Containerfile before it is built: what it builds on, and things that
 * commonly end up in images by accident. Nothing here blocks a build. */
import cockpit from 'cockpit';

const _ = cockpit.gettext;

export interface ContainerfileNote {
    line: number;
    text: string;
}

export interface ContainerfileReview {
    error: string | null;
    baseImages: string[];
    warnings: ContainerfileNote[];
}

const SECRET_KEY_RE = /(PASS(WORD|WD)?|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIALS?)/i;
const SECRET_FILE_RE = /(^|\/)(\.env(\.|$)|id_(rsa|ed25519|ecdsa|dsa)(\.|$)|\.netrc$|\.npmrc$|\.pypirc$|\.git-credentials$|credentials(\.json)?$|.*\.(pem|key|p12|pfx)$)/i;

/* Join Containerfile continuation lines and return [firstLineNumber, instruction, arguments]. */
function instructions(text: string): [number, string, string][] {
    const result: [number, string, string][] = [];
    const lines = text.split("\n");
    let i = 0;
    while (i < lines.length) {
        const start = i + 1;
        let line = lines[i].trim();
        i++;
        if (!line || line.startsWith("#"))
            continue;
        while (line.endsWith("\\") && i < lines.length) {
            line = line.slice(0, -1) + " " + lines[i].trim();
            i++;
        }
        const space = line.search(/\s/);
        const keyword = (space < 0 ? line : line.slice(0, space)).toUpperCase();
        const args = space < 0 ? "" : line.slice(space + 1).trim();
        result.push([start, keyword, args]);
    }
    return result;
}

export function reviewContainerfile(text: string): ContainerfileReview {
    const review: ContainerfileReview = { error: null, baseImages: [], warnings: [] };
    const parsed = instructions(text);
    if (parsed.length === 0) {
        review.error = _("The Containerfile is empty.");
        return review;
    }
    let sawFrom = false;
    let sawUser = false;
    for (const [line, keyword, args] of parsed) {
        if (keyword === "ARG" && !sawFrom)
            continue; // ARG before FROM is allowed
        if (keyword === "FROM") {
            sawFrom = true;
            const image = args.replace(/^--platform=\S+\s+/, "").split(/\s+/)[0];
            if (image && !review.baseImages.includes(image))
                review.baseImages.push(image);
            continue;
        }
        if (!sawFrom) {
            review.error = cockpit.format(_("Line $0: the first instruction must be FROM."), line);
            return review;
        }
        if (keyword === "USER")
            sawUser = true;
        if (keyword === "ENV" || keyword === "ARG") {
            // ENV KEY=value KEY2=value2, ENV KEY value, ARG KEY=value
            const pairs = args.includes("=") ? args.match(/[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)/g) ?? [] : [args.replace(/\s+/, "=")];
            for (const pair of pairs) {
                const eq = pair.indexOf("=");
                const key = pair.slice(0, eq);
                const value = pair.slice(eq + 1).replace(/^["']|["']$/g, "");
                if (SECRET_KEY_RE.test(key) && value && !value.startsWith("$"))
                    review.warnings.push({ line, text: cockpit.format(_("$0 $1 puts a value that looks like a credential into the image. Anyone who can pull the image can read it; use a Podman secret or a build secret instead."), keyword, key) });
            }
        }
        if (keyword === "COPY" || keyword === "ADD") {
            const words = args.replace(/^(--\S+\s+)*/, "").split(/\s+/);
            for (const src of words.slice(0, -1)) {
                if (SECRET_FILE_RE.test(src))
                    review.warnings.push({ line, text: cockpit.format(_("$0 $1 copies a file that usually contains credentials into the image."), keyword, src) });
            }
        }
        if (keyword === "RUN" && /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(args))
            review.warnings.push({ line, text: _("RUN pipes a download straight into a shell. The build runs whatever the server sends at that moment.") });
    }
    if (!sawFrom)
        review.error = _("The Containerfile has no FROM instruction.");
    else if (!sawUser)
        review.warnings.push({ line: 0, text: _("No USER instruction: processes in the container run as root unless the base image sets a user.") });
    return review;
}
