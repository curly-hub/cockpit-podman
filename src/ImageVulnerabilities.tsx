/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Vulnerability scan results for an image: a compact label in the Images table and a tab with
 * the findings. Counts by severity, no score. */
import React, { useState } from 'react';

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { EmptyState, EmptyStateBody, EmptyStateFooter, EmptyStateVariant } from "@patternfly/react-core/dist/esm/components/EmptyState";
import { Label } from "@patternfly/react-core/dist/esm/components/Label";
import { ToggleGroup, ToggleGroupItem } from "@patternfly/react-core/dist/esm/components/ToggleGroup";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { CheckCircleIcon, ExclamationCircleIcon, ExclamationTriangleIcon, ShieldAltIcon } from '@patternfly/react-icons';

import cockpit from 'cockpit';
import { ListingTable } from "cockpit-components-table";

import { SEVERITIES } from './security-scan.ts';
import type { ScanResult, Severity } from './security-scan.ts';
import { RelativeTime } from './util.js';

const _ = cockpit.gettext;

const severityName = (s: Severity) => {
    switch (s) {
    case "CRITICAL": return _("Critical");
    case "HIGH": return _("High");
    case "MEDIUM": return _("Medium");
    case "LOW": return _("Low");
    default: return _("Unknown");
    }
};

const severityStatus = (s: Severity): "danger" | "warning" | "info" | "custom" => {
    switch (s) {
    case "CRITICAL":
    case "HIGH":
        return "danger";
    case "MEDIUM":
        return "warning";
    case "LOW":
        return "info";
    default:
        return "custom";
    }
};

const SeverityLabel = ({ severity }: { severity: Severity }) => (
    <Label isCompact status={severityStatus(severity)}>{severityName(severity)}</Label>
);

/* "3 critical, 12 high" for the severities that have findings */
export function countsSummary(result: ScanResult): string {
    return SEVERITIES.filter(s => result.counts[s] > 0)
            .map(s => `${result.counts[s]} ${severityName(s).toLowerCase()}`)
            .join(", ");
}

export const total = (result: ScanResult) => SEVERITIES.reduce((sum, s) => sum + result.counts[s], 0);

/* not-found is what cockpit.spawn reports when trivy is not installed */
export const scannerMissing = (result: ScanResult | undefined) => result?.status === "error" && result.message === "not-found";

/* Compact label for the Images table. Nothing is shown before the first scan. */
export const VulnerabilityLabel = ({ result, scanning }: { result?: ScanResult; scanning?: boolean }) => {
    if (scanning)
        return <Label isCompact variant="outline" color="grey" icon={<ShieldAltIcon />} className="image-scan-label">{_("Scanning…")}</Label>;
    if (!result)
        return null;
    const when = <RelativeTime time={new Date(result.scanned)} />;
    if (result.status === "error") {
        return (
            <Tooltip content={scannerMissing(result) ? _("Trivy is not installed.") : result.message}>
                <Label isCompact variant="outline" color="grey" icon={<ExclamationTriangleIcon />} className="image-scan-label">{_("Scan failed")}</Label>
            </Tooltip>
        );
    }
    const n = total(result);
    if (n === 0) {
        return (
            <Tooltip content={<>{_("No known vulnerabilities, scanned")} {when}</>}>
                <Label isCompact variant="outline" color="green" icon={<CheckCircleIcon />} className="image-scan-label">{_("No known CVEs")}</Label>
            </Tooltip>
        );
    }
    const severe = result.counts.CRITICAL + result.counts.HIGH;
    return (
        <Tooltip content={<>{countsSummary(result)}{", "}{_("scanned")} {when}</>}>
            <Label isCompact status={severe ? "danger" : "warning"} icon={severe ? <ExclamationCircleIcon /> : <ExclamationTriangleIcon />} className="image-scan-label">
                {severe
                    ? cockpit.format(cockpit.ngettext("$0 critical/high CVE", "$0 critical/high CVEs", severe), severe)
                    : cockpit.format(cockpit.ngettext("$0 CVE", "$0 CVEs", n), n)}
            </Label>
        </Tooltip>
    );
};

export interface ImageVulnerabilitiesProps {
    result?: ScanResult;
    scanning: boolean;
    onScan: () => void;
}

/* The "Vulnerabilities" tab of an image row. */
export const ImageVulnerabilities = ({ result, scanning, onScan }: ImageVulnerabilitiesProps) => {
    const [severity, setSeverity] = useState<Severity | "all">("all");

    const scanButton = (
        <Button variant={result ? "secondary" : "primary"} size="sm" onClick={onScan} isLoading={scanning} isDisabled={scanning}>
            {scanning ? _("Scanning…") : (result ? _("Scan again") : _("Scan for vulnerabilities"))}
        </Button>
    );

    if (!result || (result.status === "error" && !scanning)) {
        const missing = scannerMissing(result);
        return (
            <EmptyState variant={EmptyStateVariant.xs} icon={ShieldAltIcon}
                        titleText={missing ? _("Trivy is not installed") : (result ? _("The scan failed") : _("Not scanned yet"))}
                        headingLevel="h4" {...(result ? { status: "warning" as const } : {})}>
                <EmptyStateBody>
                    {missing
                        ? _("Scans use Trivy, which reads the image from Podman and matches its packages against a vulnerability database. Install the trivy package and try again.")
                        : (result
                            ? <pre className="image-scan-error">{result.message}</pre>
                            : _("Trivy checks the packages in the image against known vulnerabilities. The first scan downloads its database, which takes a moment."))}
                </EmptyStateBody>
                <EmptyStateFooter>{scanButton}</EmptyStateFooter>
            </EmptyState>
        );
    }

    const n = total(result);
    const rows = result.findings
            .filter(f => severity === "all" || f.severity === severity)
            .map((f, i) => ({
                columns: [
                    { title: <SeverityLabel severity={f.severity} />, sortKey: String(SEVERITIES.indexOf(f.severity)) },
                    {
                        title: f.url
                            ? <a href={f.url} target="_blank" rel="noopener noreferrer">{f.id}</a>
                            : f.id,
                        sortKey: f.id,
                        props: { modifier: "nowrap" as const },
                    },
                    { title: f.pkg, sortKey: f.pkg, props: { modifier: "breakWord" as const } },
                    { title: f.installed, props: { modifier: "breakWord" as const } },
                    {
                        title: f.fixed || <span className="ct-grey-text">{_("no fix yet")}</span>,
                        sortKey: f.fixed,
                        props: { modifier: "breakWord" as const },
                    },
                    { title: <span className="image-scan-title">{f.title}</span>, props: { modifier: "truncate" as const } },
                ],
                props: { key: `${f.target}-${f.pkg}-${f.id}-${i}` },
            }));

    return (
        <Flex direction={{ default: "column" }} spaceItems={{ default: "spaceItemsSm" }} className="image-scan">
            <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                <FlexItem>
                    {n === 0
                        ? <Label color="green" icon={<CheckCircleIcon />}>{_("No known vulnerabilities")}</Label>
                        : <span>{cockpit.format(cockpit.ngettext("$0 vulnerability: $1", "$0 vulnerabilities: $1", n), n, countsSummary(result))}</span>}
                </FlexItem>
                {n > 0 &&
                    <FlexItem className="ct-grey-text">
                        {cockpit.format(cockpit.ngettext("$0 has a fixed version", "$0 have a fixed version", result.fixable), result.fixable)}
                    </FlexItem>}
                <FlexItem className="ct-grey-text">
                    {result.os && <>{result.os}{" · "}</>}
                    {result.scanner}{" · "}{_("scanned")} <RelativeTime time={new Date(result.scanned)} />
                </FlexItem>
                <FlexItem align={{ default: "alignRight" }}>{scanButton}</FlexItem>
            </Flex>

            {result.eosl &&
                <Alert variant="warning" isInline isPlain title={_("The operating system in this image has reached its end of life and receives no more security updates. Rebuild it on a newer base image.")} />}

            {n > 0 &&
                <ToggleGroup aria-label={_("Filter by severity")} isCompact>
                    <ToggleGroupItem text={`${_("All")} (${n})`} buttonId="scan-severity-all"
                                     isSelected={severity === "all"} onChange={() => setSeverity("all")} />
                    {SEVERITIES.filter(s => result.counts[s] > 0).map(s => (
                        <ToggleGroupItem key={s} text={`${severityName(s)} (${result.counts[s]})`} buttonId={`scan-severity-${s.toLowerCase()}`}
                                         isSelected={severity === s} onChange={() => setSeverity(s)} />
                    ))}
                </ToggleGroup>}

            {n > 0 &&
                <ListingTable aria-label={_("Vulnerabilities")}
                              variant="compact"
                              emptyCaption={_("No vulnerabilities of this severity")}
                              columns={[
                                  { title: _("Severity"), sortable: true },
                                  { title: _("Vulnerability"), sortable: true },
                                  { title: _("Package"), sortable: true },
                                  { title: _("Installed") },
                                  { title: _("Fixed in"), sortable: true },
                                  { title: _("Summary") },
                              ]}
                              rows={rows} />}

            {result.truncated
                ? <span className="ct-grey-text">{cockpit.format(_("$0 more findings of lower severity are not listed."), result.truncated)}</span>
                : null}
        </Flex>
    );
};
