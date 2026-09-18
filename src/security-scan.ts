/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Vulnerability scans of local images with Trivy.
 *
 * Trivy reads the image from Podman's storage through the user's or root's socket, matches the
 * installed packages against its vulnerability database, and prints a JSON report. Only the
 * findings are kept here; there is no score, just counts by severity and the list. */
import cockpit from 'cockpit';

import type { Uid } from './rest.js';

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type Severity = typeof SEVERITIES[number];

export interface Finding {
    id: string;
    severity: Severity;
    pkg: string;
    installed: string;
    fixed: string; // "" when no fixed version is known
    title: string;
    url: string;
    target: string; // OS package list or an application manifest inside the image
}

export interface ScanResult {
    status: "done" | "error";
    scanned: number; // ms since epoch
    reference: string; // what was scanned: the tag or the image ID
    scanner?: string; // "Trivy 0.69.3"
    os?: string; // "alpine 3.19.9"
    eosl?: boolean; // the OS release no longer receives security updates
    counts: Record<Severity, number>;
    fixable: number;
    findings: Finding[];
    truncated?: number; // findings dropped to keep the stored result small
    message?: string;
}

export interface ScannableImage {
    key: string;
    uid: Uid;
    Id: string;
    RepoTags?: string[] | null;
}

interface TrivyVulnerability {
    VulnerabilityID?: string;
    PkgName?: string;
    InstalledVersion?: string;
    FixedVersion?: string;
    Title?: string;
    PrimaryURL?: string;
    Severity?: string;
}

interface TrivyReport {
    Trivy?: { Version?: string };
    Metadata?: { OS?: { Family?: string; Name?: string; EOSL?: boolean } };
    Results?: { Target?: string; Vulnerabilities?: TrivyVulnerability[] | null }[] | null;
}

const STORAGE_KEY = "podman-image-scans";
// findings kept per image in the stored result; the counts always cover everything
const MAX_FINDINGS = 400;

export const emptyCounts = (): Record<Severity, number> => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });

const severityRank = (s: Severity) => SEVERITIES.indexOf(s);

/* The reference to hand to the scanner: the first real tag, or the image ID. */
export function scanReference(image: ScannableImage): string {
    for (const tag of image.RepoTags ?? []) {
        if (!tag.includes("<none>"))
            return tag;
    }
    return image.Id;
}

/* "Trivy 0.69.3" when the scanner is installed, null when it is not. */
export async function scannerVersion(): Promise<string | null> {
    try {
        const out = await cockpit.spawn(["trivy", "--version"], { err: "message" });
        const version = /Version:\s*(\S+)/.exec(out)?.[1];
        return version ? `Trivy ${version}` : "Trivy";
    } catch (ex) {
        if ((ex as { problem?: string }).problem === "not-found")
            return null;
        throw ex;
    }
}

export function parseReport(text: string, reference: string, scanned: number): ScanResult {
    const report = JSON.parse(text) as TrivyReport;
    const counts = emptyCounts();
    let fixable = 0;
    const findings: Finding[] = [];
    for (const result of report.Results ?? []) {
        for (const v of result.Vulnerabilities ?? []) {
            const severity = (SEVERITIES as readonly string[]).includes(v.Severity ?? "") ? v.Severity as Severity : "UNKNOWN";
            counts[severity]++;
            if (v.FixedVersion)
                fixable++;
            findings.push({
                id: v.VulnerabilityID ?? "",
                severity,
                pkg: v.PkgName ?? "",
                installed: v.InstalledVersion ?? "",
                fixed: v.FixedVersion ?? "",
                title: v.Title ?? "",
                url: v.PrimaryURL ?? "",
                target: result.Target ?? "",
            });
        }
    }
    findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.pkg.localeCompare(b.pkg) || a.id.localeCompare(b.id));
    const truncated = Math.max(0, findings.length - MAX_FINDINGS);
    const os = report.Metadata?.OS;
    const result: ScanResult = { status: "done", scanned, reference, counts, fixable, findings: findings.slice(0, MAX_FINDINGS) };
    if (report.Trivy?.Version)
        result.scanner = `Trivy ${report.Trivy.Version}`;
    if (os?.Family)
        result.os = `${os.Family} ${os.Name ?? ""}`.trim();
    if (os?.EOSL !== undefined)
        result.eosl = os.EOSL;
    if (truncated)
        result.truncated = truncated;
    return result;
}

export async function scanImage(image: ScannableImage): Promise<ScanResult> {
    const scanned = Date.now();
    const reference = scanReference(image);
    try {
        const out = await cockpit.spawn(
            ["trivy", "image", "--scanners", "vuln", "--format", "json", "--quiet", "--image-src", "podman", reference],
            {
                err: "message",
                environ: ["LC_ALL=C.UTF-8"],
                ...(image.uid === 0 ? { superuser: "require" as const } : {}),
            });
        return parseReport(out, reference, scanned);
    } catch (ex) {
        const err = ex as { message?: string; problem?: string };
        return {
            status: "error",
            scanned,
            reference,
            counts: emptyCounts(),
            fixable: 0,
            findings: [],
            message: err.problem === "not-found" ? "not-found" : (err.message || String(ex)),
        };
    }
}

/* Scan images one after the other (a scan is CPU and memory heavy); report each result as it arrives. */
export async function scanImages(images: ScannableImage[], onResult: (key: string, result: ScanResult) => void): Promise<void> {
    for (const image of images)
        onResult(image.key, await scanImage(image));
}

/* Results survive a page reload within the browser session. */
export function loadResults(): Record<string, ScanResult> {
    try {
        return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}") as Record<string, ScanResult>;
    } catch {
        return {};
    }
}

export function storeResults(results: Record<string, ScanResult>): void {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(results));
    } catch {
        // storage unavailable or full, results simply are not persisted
    }
}
