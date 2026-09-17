/* SPDX-License-Identifier: LGPL-2.1-or-later */
import React, { useEffect, useState } from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content";
import { Icon } from "@patternfly/react-core/dist/esm/components/Icon";
import { Label, LabelGroup } from "@patternfly/react-core/dist/esm/components/Label";
import { Skeleton } from "@patternfly/react-core/dist/esm/components/Skeleton";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { Gallery } from "@patternfly/react-core/dist/esm/layouts/Gallery";
import {
    CheckCircleIcon, CubeIcon, CubesIcon, ExclamationCircleIcon, ExclamationTriangleIcon,
    LayerGroupIcon, MemoryIcon, MicrochipIcon, ServerIcon,
} from '@patternfly/react-icons';

import cockpit from 'cockpit';
import * as machine_info from 'machine-info';

import { makeKey } from './util.js';
import './Overview.scss';

const _ = cockpit.gettext;

/* Minimal shapes of the podman inspect/list objects that the overview needs.
 * app.jsx attaches `uid` and `key` to every object it stores. */
interface Container {
    key: string;
    uid: number | null;
    Id: string;
    Name: string;
    Image?: string;
    ImageName?: string;
    IsInfra?: boolean;
    IsService?: boolean;
    RestartCount?: number;
    State?: {
        Status?: string;
        ExitCode?: number;
        Health?: { Status?: string };
        Healthcheck?: { Status?: string };
    };
    HostConfig?: { Memory?: number };
}

interface Pod {
    key: string;
    uid: number | null;
    Id: string;
    Name: string;
    Status: string;
}

interface Image {
    key: string;
    uid: number | null;
    Size: number;
}

interface Stats {
    CPU?: number;
    MemUsage?: number;
}

interface User {
    con: unknown;
    uid: number | null;
    name: string;
}

export interface OverviewProps {
    users: User[];
    version: string;
    cgroupVersion?: string;
    selinuxAvailable: boolean;
    containers: Record<string, Container> | null;
    containersStats: Record<string, Stats>;
    pods: Record<string, Pod> | null;
    images: Record<string, Image> | null;
    ownerFilter: string | number;
    imageUpdates?: Record<string, { status: string }>;
    onFilterChanged: (text: string) => void;
    onContainerFilterChanged: (value: string) => void;
}

type Severity = "danger" | "warning";

interface Issue {
    key: string;
    severity: Severity;
    name: string;
    detail: string;
}

const RESTART_LOOP_THRESHOLD = 3;

function matchesOwner(uid: number | null, ownerFilter: string | number): boolean {
    if (ownerFilter === "all")
        return true;
    if (ownerFilter === "user")
        return uid === null;
    return String(uid) === String(ownerFilter);
}

function ownerLabel(uid: number | null, name: string): string {
    if (uid === 0)
        return _("System (rootful)");
    if (uid === null)
        return cockpit.format(_("$0 (rootless)"), name);
    return cockpit.format(_("$0 (rootless, uid $1)"), name, uid);
}

function socketPath(uid: number | null): string {
    if (uid === 0)
        return "/run/podman/podman.sock";
    if (uid === null)
        return `${sessionStorage.getItem('XDG_RUNTIME_DIR') || "$XDG_RUNTIME_DIR"}/podman/podman.sock`;
    return `/run/user/${uid}/podman/podman.sock`;
}

interface TileProps {
    id: string;
    icon: React.ReactNode;
    title: string;
    value: React.ReactNode;
    detail?: React.ReactNode;
    status?: Severity | "success" | undefined;
}

const Tile = ({ id, icon, title, value, detail, status }: TileProps) => (
    <div className={"podman-overview-tile" + (status ? ` podman-overview-tile-${status}` : "")} id={`podman-overview-${id}`}>
        <div className="podman-overview-tile-header">
            <Icon size="md">{icon}</Icon>
            <span>{title}</span>
        </div>
        <div className="podman-overview-tile-value">{value}</div>
        {detail && <div className="podman-overview-tile-detail">{detail}</div>}
    </div>
);

export const Overview = ({
    users, version, cgroupVersion, selinuxAvailable,
    containers, containersStats, pods, images, ownerFilter, imageUpdates,
    onFilterChanged, onContainerFilterChanged,
}: OverviewProps) => {
    const [memTotal, setMemTotal] = useState<number>(0);

    useEffect(() => {
        machine_info.cpu_ram_info()
                .then((info: { memory?: number }) => setMemTotal(info.memory ?? 0))
                .catch((ex: Error) => console.warn("Overview: cannot read host memory:", ex.toString()));
    }, []);

    const connected = users.filter(u => u.con && matchesOwner(u.uid, ownerFilter));
    const loading = containers === null || pods === null || images === null;

    // --- containers ---
    // same visibility rules as the Containers table: hide pod infra and service containers
    const containerList = Object.values(containers ?? {})
            .filter(c => matchesOwner(c.uid, ownerFilter) && !c.IsInfra && !c.IsService);
    const counts = { running: 0, exited: 0, paused: 0, other: 0 };
    let cpuSum = 0;
    let cpuSampled = 0;
    let memSum = 0;
    let memUncapped = 0;
    const issues: Issue[] = [];
    const usedImageKeys = new Set<string>();

    for (const c of containerList) {
        const status = c.State?.Status ?? "";
        if (c.Image)
            usedImageKeys.add(makeKey(c.uid, c.Image));

        if (status === "running" || status === "restarting")
            counts.running++;
        else if (status === "exited" || status === "stopped")
            counts.exited++;
        else if (status === "paused")
            counts.paused++;
        else
            counts.other++;

        const stats = containersStats[c.key];
        if (status === "running" && stats) {
            if (stats.CPU !== undefined) {
                cpuSum += stats.CPU;
                cpuSampled++;
            }
            if (Number.isInteger(stats.MemUsage))
                memSum += stats.MemUsage as number;
        }
        if (status === "running" && !c.HostConfig?.Memory)
            memUncapped++;

        // HACK: Podman renamed `Healthcheck` to `Health`
        const health = c.State?.Health?.Status ?? c.State?.Healthcheck?.Status;
        if (health === "unhealthy") {
            issues.push({ key: c.key + "-health", severity: "danger", name: c.Name, detail: _("Health check is failing") });
        }
        if (status === "restarting" || (status === "running" && (c.RestartCount ?? 0) >= RESTART_LOOP_THRESHOLD)) {
            issues.push({
                key: c.key + "-restart",
                severity: "warning",
                name: c.Name,
                detail: cockpit.format(_("Restarted $0 times, possible restart loop"), c.RestartCount ?? 0),
            });
        }
        if (status === "exited" && (c.State?.ExitCode ?? 0) !== 0) {
            issues.push({
                key: c.key + "-exit",
                severity: "warning",
                name: c.Name,
                detail: cockpit.format(_("Exited with code $0"), c.State?.ExitCode),
            });
        }
    }

    // --- pods ---
    const podList = Object.values(pods ?? {}).filter(p => matchesOwner(p.uid, ownerFilter));
    const podsRunning = podList.filter(p => p.Status === "Running").length;
    const podsDegraded = podList.filter(p => p.Status === "Degraded");
    for (const p of podsDegraded)
        issues.push({ key: p.key + "-degraded", severity: "warning", name: p.Name, detail: _("Pod is degraded, some containers are not running") });

    // --- images ---
    const imageList = Object.values(images ?? {}).filter(i => matchesOwner(i.uid, ownerFilter));
    const imagesSize = imageList.reduce((sum, i) => sum + (i.Size || 0), 0);
    const imagesUnused = imageList.filter(i => !usedImageKeys.has(i.key)).length;
    const imagesOutdated = imageList.filter(i => imageUpdates?.[i.key]?.status === "update").length;

    // --- runtime ---
    const hasRootless = connected.some(u => u.uid !== 0);
    const hasRootful = connected.some(u => u.uid === 0);
    let mode = _("Not connected");
    if (hasRootless && hasRootful)
        mode = _("Rootless + rootful");
    else if (hasRootless)
        mode = _("Rootless");
    else if (hasRootful)
        mode = _("Rootful");

    const dangerCount = issues.filter(i => i.severity === "danger").length;
    const attentionStatus: Severity | "success" = dangerCount > 0 ? "danger" : (issues.length > 0 ? "warning" : "success");

    const skel = <Skeleton width="3em" screenreaderText={_("Loading")} />;

    const showContainers = (filter: string) => {
        onContainerFilterChanged(filter);
        document.getElementById("containers-containers")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    return (
        <Card id="containers-overview" className="containers-overview" isPlain={false}>
            <CardHeader actions={{
                actions: (
                    <LabelGroup className="podman-overview-runtime-labels" numLabels={6}>
                        <Label isCompact>{cockpit.format(_("Podman $0"), version)}</Label>
                        {cgroupVersion && <Label isCompact>{cockpit.format(_("cgroups $0"), cgroupVersion)}</Label>}
                        {selinuxAvailable && <Label isCompact color="blue">{_("SELinux")}</Label>}
                        {connected.map(u => (
                            <Tooltip key={String(u.uid)} content={socketPath(u.uid)}>
                                <Label isCompact color="green" icon={<CheckCircleIcon />}>{ownerLabel(u.uid, u.name)}</Label>
                            </Tooltip>
                        ))}
                    </LabelGroup>
                ),
            }}>
                <CardTitle>
                    <Content component={ContentVariants.h1} className="containers-overview-title">{_("Overview")}</Content>
                </CardTitle>
            </CardHeader>
            <CardBody>
                <Gallery hasGutter minWidths={{ default: "13rem" }} className="podman-overview-tiles">
                    <Tile id="runtime"
                          icon={<ServerIcon />}
                          title={_("Runtime")}
                          value={mode}
                          detail={connected.length
                              ? cockpit.format(cockpit.ngettext("$0 Podman service connected", "$0 Podman services connected", connected.length), connected.length)
                              : _("No Podman service reachable")} />
                    <Tile id="containers"
                          icon={<CubeIcon />}
                          title={_("Containers")}
                          value={loading ? skel : counts.running}
                          detail={loading
                              ? null
                              : (
                                  <>
                                      <Button variant="link" isInline onClick={() => showContainers("running")}>{_("running")}</Button>
                                      {" · "}
                                      <Button variant="link" isInline onClick={() => showContainers("all")}>
                                          {cockpit.format(_("$0 total"), containerList.length)}
                                      </Button>
                                      {counts.exited > 0 && ` · ${cockpit.format(_("$0 exited"), counts.exited)}`}
                                      {counts.paused > 0 && ` · ${cockpit.format(_("$0 paused"), counts.paused)}`}
                                  </>
                              )} />
                    <Tile id="pods"
                          icon={<CubesIcon />}
                          title={_("Pods")}
                          value={loading ? skel : podsRunning}
                          detail={loading
                              ? null
                              : cockpit.format(_("running · $0 total"), podList.length) +
                                (podsDegraded.length ? ` · ${cockpit.format(_("$0 degraded"), podsDegraded.length)}` : "")} />
                    <Tile id="images"
                          icon={<LayerGroupIcon />}
                          title={_("Images")}
                          value={loading ? skel : imageList.length}
                          status={!loading && imagesOutdated > 0 ? "warning" : undefined}
                          detail={loading
                              ? null
                              : (
                                  <>
                                      {cockpit.format_bytes(imagesSize)}
                                      {imagesUnused > 0 && ` · ${cockpit.format(_("$0 unused"), imagesUnused)}`}
                                      {imagesOutdated > 0 &&
                                          <>
                                              {" · "}
                                              <span className="podman-overview-uncapped">
                                                  {cockpit.format(cockpit.ngettext("$0 update available", "$0 updates available", imagesOutdated), imagesOutdated)}
                                              </span>
                                          </>}
                                  </>
                              )} />
                    <Tile id="cpu"
                          icon={<MicrochipIcon />}
                          title={_("CPU")}
                          value={loading ? skel : (cpuSampled ? `${cpuSum.toFixed(1)}%` : "—")}
                          detail={loading
                              ? null
                              : (cpuSampled
                                  ? cockpit.format(cockpit.ngettext("of host, $0 container sampled", "of host, $0 containers sampled", cpuSampled), cpuSampled)
                                  : _("No running containers"))} />
                    <Tile id="memory"
                          icon={<MemoryIcon />}
                          title={_("Memory")}
                          value={loading ? skel : (counts.running ? cockpit.format_bytes(memSum) : "—")}
                          status={!loading && memUncapped > 0 ? "warning" : undefined}
                          detail={loading
                              ? null
                              : (
                                  <>
                                      {memTotal && counts.running ? cockpit.format(_("$0% of host"), Math.round(memSum / memTotal * 100)) : null}
                                      {memUncapped > 0 && (
                                          <>
                                              {memTotal && counts.running ? " · " : ""}
                                              <Tooltip content={_("Running containers without a memory limit can consume all host memory.")}>
                                                  <span className="podman-overview-uncapped">
                                                      {cockpit.format(cockpit.ngettext("$0 without memory limit", "$0 without memory limit", memUncapped), memUncapped)}
                                                  </span>
                                              </Tooltip>
                                          </>
                                      )}
                                  </>
                              )} />
                </Gallery>

                <div className={`podman-overview-attention podman-overview-attention-${attentionStatus}`} id="podman-overview-attention">
                    <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }} className="podman-overview-attention-header">
                        <Icon status={attentionStatus}>
                            {attentionStatus === "success" && <CheckCircleIcon />}
                            {attentionStatus === "warning" && <ExclamationTriangleIcon />}
                            {attentionStatus === "danger" && <ExclamationCircleIcon />}
                        </Icon>
                        <FlexItem>
                            <strong>
                                {loading
                                    ? _("Checking containers…")
                                    : (issues.length === 0
                                        ? (containerList.length ? _("All containers are healthy") : _("No containers"))
                                        : cockpit.format(cockpit.ngettext("$0 item needs attention", "$0 items need attention", issues.length), issues.length))}
                            </strong>
                        </FlexItem>
                    </Flex>
                    {issues.length > 0 && (
                        <ul className="podman-overview-issues">
                            {issues.map(issue => (
                                <li key={issue.key}>
                                    <Label isCompact status={issue.severity}>
                                        {issue.severity === "danger" ? _("Unhealthy") : _("Warning")}
                                    </Label>
                                    <Button variant="link" isInline className="podman-overview-issue-name"
                                            onClick={() => { onFilterChanged(issue.name); showContainers("all") }}>
                                        {issue.name}
                                    </Button>
                                    <span className="podman-overview-issue-detail">{issue.detail}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </CardBody>
        </Card>
    );
};
