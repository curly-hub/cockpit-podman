/* SPDX-License-Identifier: LGPL-2.1-or-later */
import React, { useEffect, useState } from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content";
import { DropdownItem } from '@patternfly/react-core/dist/esm/components/Dropdown/index.js';
import { EmptyState, EmptyStateBody, EmptyStateVariant } from "@patternfly/react-core/dist/esm/components/EmptyState";
import { Label, LabelGroup } from "@patternfly/react-core/dist/esm/components/Label";
import { Progress, ProgressMeasureLocation, ProgressSize, ProgressVariant } from "@patternfly/react-core/dist/esm/components/Progress";
import { Skeleton } from "@patternfly/react-core/dist/esm/components/Skeleton";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { Gallery } from "@patternfly/react-core/dist/esm/layouts/Gallery";
import {
    ArrowCircleUpIcon, CheckCircleIcon, CubesIcon, ExclamationCircleIcon, ExclamationTriangleIcon, InfoCircleIcon,
    LayerGroupIcon, PauseCircleIcon, RedoIcon, StopCircleIcon,
} from '@patternfly/react-icons';
import { useDialogs, DialogsContext } from "dialogs.jsx";

import cockpit from 'cockpit';
import * as machine_info from 'machine-info';

import { ComposeDeployModal } from './ComposeDeployModal.tsx';
import { ImageRunModal } from './ImageRunModal.jsx';
import { PodActions } from './PodActions.jsx';
import { PodLogsModal } from './PodLogs.tsx';
import { canManageStack, containerStack, isOutdated, recreateStack, stackOfPod, tagToImageId } from './compose.ts';
import { sumRates } from './stats.ts';
import type { StatsHistory } from './stats.ts';
import { RelativeTime, makeKey, image_name, PodmanInfoContext } from './util.js';
import './Pods.scss';

const _ = cockpit.gettext;

interface PodContainerRef {
    Id: string;
    Names: string;
    Status: string;
    RestartCount?: number;
}

interface Pod {
    key: string;
    uid: number | null;
    Id: string;
    Name: string;
    Status: string;
    Created?: string;
    InfraId?: string;
    Containers?: PodContainerRef[];
    Labels?: Record<string, string>;
}

interface Container {
    key: string;
    uid: number | null;
    Id: string;
    Name: string;
    Image?: string;
    ImageName?: string;
    IsInfra?: boolean;
    Config?: { Labels?: Record<string, string> | null };
    State?: {
        Status?: string;
        Health?: { Status?: string };
        Healthcheck?: { Status?: string };
    };
    HostConfig?: {
        Memory?: number;
        PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
    };
}

interface Stats {
    CPU?: number;
    MemUsage?: number;
}

interface Image {
    key: string;
    uid: number | null;
    Id: string;
    RepoTags?: string[] | null;
    [extra: string]: unknown;
}

interface QuadletContainer {
    key: string;
    uid: number | null;
    Id: string;
    Name: string;
    Pod?: string;
}

interface User {
    con: unknown;
    uid: number | null;
    name: string;
}

export interface PodsProps {
    pods: Record<string, Pod> | null;
    /* inactive Quadlet pods, mocked by app.jsx from the systemd generator output */
    quadletPods: Record<string, Pod> | null;
    quadletContainers: Record<string, QuadletContainer> | null;
    images: Record<string, Image> | null;
    containers: Record<string, Container> | null;
    containersStats: Record<string, Stats>;
    statsHistory?: StatsHistory;
    users: User[];
    ownerFilter: string | number;
    textFilter: string;
    /* "running" or "all", the same value the Containers table uses */
    filter: string;
    imageUpdates?: Record<string, { status: string; tag: string }>;
    onAddNotification: (n: { type: string; error: string; errorDetail?: string }) => void;
    onFilterChanged: (text: string) => void;
    onContainerFilterChanged: (value: string) => void;
}

const RESTART_LOOP_THRESHOLD = 3;

function matchesOwner(uid: number | null, ownerFilter: string | number): boolean {
    if (ownerFilter === "all")
        return true;
    if (ownerFilter === "user")
        return uid === null;
    return String(uid) === String(ownerFilter);
}

function statusLabel(status: string) {
    // https://github.com/containers/podman/blob/main/libpod/define/podstate.go
    switch (status) {
    case "Running":
        return <Label status="success" icon={<CheckCircleIcon />}>{_("Running")}</Label>;
    case "Degraded":
        return <Label status="warning" icon={<ExclamationTriangleIcon />}>{_("Degraded")}</Label>;
    case "Paused":
        return <Label status="info" icon={<PauseCircleIcon />}>{_("Paused")}</Label>;
    case "Error":
        return <Label status="danger" icon={<ExclamationCircleIcon />}>{_("Error")}</Label>;
    case "Created":
        return <Label color="grey" icon={<InfoCircleIcon />}>{_("Created")}</Label>;
    default:
        return <Label color="grey" icon={<StopCircleIcon />}>{_("Stopped")}</Label>;
    }
}

function containerLabelColor(status: string, unhealthy: boolean): "green" | "red" | "grey" | "orange" {
    if (unhealthy)
        return "red";
    if (status === "running")
        return "green";
    if (status === "restarting")
        return "orange";
    return "grey";
}

/* Icon carrying the same meaning as the colour, for colour-blind users and screen readers */
function containerLabelIcon(status: string, unhealthy: boolean, looping: boolean) {
    if (unhealthy)
        return <ExclamationCircleIcon />;
    if (looping || status === "restarting")
        return <RedoIcon />;
    if (status === "running")
        return <CheckCircleIcon />;
    if (status === "paused")
        return <PauseCircleIcon />;
    return <StopCircleIcon />;
}

/* One titled row of a pod card; every card shows the same rows in the same order. */
const PodRow = ({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) => (
    <div className={"podman-pod-row" + (className ? " " + className : "")}>
        <span className="podman-pod-row-title">{title}</span>
        <div className="podman-pod-row-value">{children}</div>
    </div>
);

const statusOrder: Record<string, number> = { Running: 0, Degraded: 1, Paused: 2, Error: 3 };

export const Pods = ({
    pods, quadletPods, quadletContainers, images, containers, containersStats, statsHistory, users, ownerFilter, textFilter, filter,
    imageUpdates, onAddNotification, onFilterChanged, onContainerFilterChanged,
}: PodsProps) => {
    const [memTotal, setMemTotal] = useState<number>(0);
    // pod key → label of the stack operation in progress
    const [stackBusy, setStackBusy] = useState<Record<string, string>>({});
    const Dialogs = useDialogs();
    const tagMap = tagToImageId(images, makeKey);

    const runStack = async (podKey: string, project: string, label: string, action: () => Promise<void>) => {
        setStackBusy(prev => ({ ...prev, [podKey]: label }));
        try {
            await action();
            onAddNotification({ type: "success", error: cockpit.format(_("Stack $0: $1 finished"), project, label) });
        } catch (ex) {
            onAddNotification({
                type: "danger",
                error: cockpit.format(_("Stack $0: $1 failed"), project, label),
                errorDetail: (ex as { message?: string }).message || String(ex),
            });
        } finally {
            setStackBusy(prev => {
                const next = { ...prev };
                delete next[podKey];
                return next;
            });
        }
    };

    const createContainer = (pod: Pod) => {
        // same shape Containers.jsx hands to ImageRunModal
        const localImages = Object.values(images ?? {}).map(img => {
            const tags = img.RepoTags ?? [];
            img.Index = tags[0] ? tags[0].split('/')[0] : "";
            img.Name = image_name(img as { RepoTags?: string[] });
            img.toString = function () { return this.Name as string };
            return img;
        })
                .filter(img => img.Index !== "");
        Dialogs.show(
            <PodmanInfoContext.Consumer>
                {podmanInfo => (
                    <DialogsContext.Consumer>
                        {dialogs => (
                            <ImageRunModal users={users}
                                           localImages={localImages}
                                           pod={pod}
                                           onAddNotification={onAddNotification}
                                           podmanInfo={podmanInfo}
                                           dialogs={dialogs} />
                        )}
                    </DialogsContext.Consumer>
                )}
            </PodmanInfoContext.Consumer>
        );
    };

    useEffect(() => {
        machine_info.cpu_ram_info()
                .then((info: { memory?: number }) => setMemTotal(info.memory ?? 0))
                .catch((ex: Error) => console.warn("Pods: cannot read host memory:", ex.toString()));
    }, []);

    const focusTable = (text: string, showAll = false) => {
        onFilterChanged(text);
        if (showAll)
            onContainerFilterChanged("all");
        document.getElementById("containers-containers")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    const loading = pods === null || containers === null;
    const lcf = textFilter.toLowerCase();
    const onlyRunning = filter === "running";

    // Quadlet pods that currently have no podman pod object show up as inactive pods
    const serviceKeys = new Set(Object.values(pods ?? {})
            .map(pod => pod.Labels?.PODMAN_SYSTEMD_UNIT ? makeKey(pod.uid, pod.Labels.PODMAN_SYSTEMD_UNIT) : null)
            .filter(Boolean));
    const inactiveQuadletPods = Object.values(quadletPods ?? {}).filter(pod => !serviceKeys.has(pod.key));

    const visiblePods = [...Object.values(pods ?? {}), ...inactiveQuadletPods]
            .filter(pod => matchesOwner(pod.uid, ownerFilter))
            .filter(pod => !lcf ||
                pod.Name.toLowerCase().includes(lcf) ||
                (pod.Containers ?? []).some(c => (c.Names || "").toLowerCase().includes(lcf)));
    // mirror the Containers table: "Only running" hides every pod that is not in Running state
    const podList = visiblePods
            .filter(pod => !onlyRunning || pod.Status === "Running")
            .sort((a, b) => (statusOrder[a.Status] ?? 9) - (statusOrder[b.Status] ?? 9) || a.Name.localeCompare(b.Name));
    const hiddenPods = visiblePods.length - podList.length;

    const renderPod = (pod: Pod) => {
        const user = users.find(u => u.uid === pod.uid);
        const isPodService = !!pod.Labels?.PODMAN_SYSTEMD_UNIT && !pod.Labels.PODMAN_SYSTEMD_UNIT.startsWith("podman-compose@");
        let members: PodContainerRef[] = (pod.Containers ?? []).filter(c => c.Id !== pod.InfraId);
        if (members.length === 0 && isPodService) {
            // inactive quadlet pod: its containers are quadlets referencing the pod unit
            members = Object.values(quadletContainers ?? {})
                    .filter(c => c.Pod && makeKey(c.uid, c.Pod) === pod.key)
                    .map(c => ({ Id: c.Id, Names: c.Name, Status: "exited" }));
        }

        const memberContainers = members.map(ref => containers?.[makeKey(pod.uid, ref.Id)]).filter(Boolean) as Container[];
        const stack = stackOfPod(memberContainers);
        const outdated = memberContainers.filter(c => isOutdated(c, tagMap, makeKey)).length;
        const updatesAvailable = memberContainers.filter(c => {
            const update = c.Image ? imageUpdates?.[makeKey(pod.uid, c.Image)] : undefined;
            return update?.status === "update" && update.tag === c.ImageName;
        }).length;
        const busy = stackBusy[pod.key];

        let running = 0;
        let unhealthy = 0;
        let looping = 0;
        let cpu = 0;
        let mem = 0;
        let memCap = 0;
        let uncapped = 0;
        let sampled = false;

        const memberDetails = members.map(ref => {
            const container = containers?.[makeKey(pod.uid, ref.Id)];
            const status = container?.State?.Status ?? ref.Status ?? "";
            // HACK: Podman renamed `Healthcheck` to `Health`
            const health = container?.State?.Health?.Status ?? container?.State?.Healthcheck?.Status;
            const isUnhealthy = health === "unhealthy";
            const isLooping = status === "restarting" || (status === "running" && (ref.RestartCount ?? 0) >= RESTART_LOOP_THRESHOLD);

            if (status === "running" || status === "restarting")
                running++;
            if (isUnhealthy)
                unhealthy++;
            if (isLooping)
                looping++;

            if (status === "running") {
                const stats = containersStats[makeKey(pod.uid, ref.Id)];
                if (stats?.CPU !== undefined) {
                    cpu += stats.CPU;
                    sampled = true;
                }
                if (Number.isInteger(stats?.MemUsage))
                    mem += stats?.MemUsage as number;
                if (container?.HostConfig?.Memory)
                    memCap += container.HostConfig.Memory;
                else
                    uncapped++;
            }

            return { ref, name: container?.Name ?? ref.Names ?? ref.Id.slice(0, 12), status, isUnhealthy, isLooping };
        });

        const isRunning = pod.Status === "Running" || pod.Status === "Degraded";
        const io = sumRates(members.map(ref => statsHistory?.[makeKey(pod.uid, ref.Id)]));
        const memBase = uncapped === 0 && memCap > 0 ? memCap : memTotal;
        const memPct = memBase ? Math.min(100, Math.round(mem / memBase * 100)) : 0;
        const memVariant = memPct >= 90 ? ProgressVariant.danger : (memPct >= 75 ? ProgressVariant.warning : undefined);
        let memLabel = cockpit.format_bytes(mem);
        if (uncapped === 0 && memCap > 0)
            memLabel += ` / ${cockpit.format_bytes(memCap)}`;
        else if (memTotal)
            memLabel += cockpit.format(_(" · $0% of host"), memPct);

        const stackItems: React.ReactNode[] = [];
        // only real Podman containers have logs; inactive quadlet members are unit files
        const logSources = (pod.Containers ?? [])
                .filter(ref => ref.Id !== pod.InfraId)
                .map(ref => {
                    const container = containers?.[makeKey(pod.uid, ref.Id)];
                    const service = stack ? containerStack(container)?.service : "";
                    return { id: ref.Id, name: service || container?.Name || ref.Names || ref.Id.slice(0, 12) };
                });
        if (logSources.length > 0) {
            stackItems.push(
                <DropdownItem key="pod-logs" className="pod-action-logs" component="button"
                              description={_("Combined output of every container")}
                              onClick={() => Dialogs.show(<PodLogsModal uid={pod.uid} podName={pod.Name} sources={logSources} />)}>
                    {_("View logs")}
                </DropdownItem>,
            );
        }
        if (canManageStack(pod.uid, stack)) {
            stackItems.push(
                <DropdownItem key="stack-pull-recreate" className="pod-action-stack-pull" component="button"
                              isDisabled={!!busy}
                              description={_("podman-compose pull && up -d")}
                              onClick={() => runStack(pod.key, stack.project, _("Pull and recreate"), () => recreateStack(pod.uid, stack, true))}>
                    {_("Pull and recreate stack")}
                </DropdownItem>,
                <DropdownItem key="stack-recreate" className="pod-action-stack-up" component="button"
                              isDisabled={!!busy}
                              description={_("podman-compose up -d")}
                              onClick={() => runStack(pod.key, stack.project, _("Recreate"), () => recreateStack(pod.uid, stack, false))}>
                    {_("Recreate stack")}
                </DropdownItem>,
            );
        }

        return (
            <Card isCompact key={pod.key} className="podman-pod-card" id={`podman-pod-${pod.Id.slice(0, 12)}`}>
                {/* ct-card-expandable-header opts out of Cockpit's wrapping card-header override */}
                <CardHeader className="ct-card-expandable-header podman-pod-header" actions={{
                    actions: user?.con
                        ? <PodActions con={user.con} pod={pod} onAddNotification={onAddNotification} isPodService={isPodService}
                                      onCreateContainer={images ? () => createContainer(pod) : null}
                                      extraItems={stackItems} />
                        : null,
                    hasNoOffset: true,
                }}>
                    <CardTitle>
                        <Button variant="link" isInline className="podman-pod-name" onClick={() => focusTable(pod.Name, pod.Status !== "Running")}>
                            {pod.Name}
                        </Button>
                    </CardTitle>
                </CardHeader>
                <CardBody className="podman-pod-body">
                    <PodRow title={_("Status")} className="podman-pod-row-labels">
                        <LabelGroup numLabels={4}>
                            {statusLabel(pod.Status)}
                            {unhealthy > 0 &&
                                <Label status="danger" icon={<ExclamationCircleIcon />}>{cockpit.format(cockpit.ngettext("$0 unhealthy", "$0 unhealthy", unhealthy), unhealthy)}</Label>}
                            {looping > 0 &&
                                <Label status="warning" icon={<RedoIcon />}>{cockpit.format(cockpit.ngettext("$0 restart loop", "$0 restart loops", looping), looping)}</Label>}
                            {unhealthy === 0 && looping === 0 && isRunning && members.length > 0 &&
                                <Label color="green" variant="outline" icon={<CheckCircleIcon />}>{_("Healthy")}</Label>}
                            {uncapped > 0 &&
                                <Tooltip content={_("Running containers without a memory limit can consume all host memory.")}>
                                    <Label status="warning" icon={<ExclamationTriangleIcon />}>
                                        {cockpit.format(cockpit.ngettext("$0 without memory limit", "$0 without memory limit", uncapped), uncapped)}
                                    </Label>
                                </Tooltip>}
                            {busy && <Label color="blue" icon={<Spinner size="sm" />}>{busy}</Label>}
                        </LabelGroup>
                    </PodRow>

                    <PodRow title={_("Managed by")} className="podman-pod-row-labels">
                        <LabelGroup numLabels={4}>
                            {stack &&
                                <Tooltip content={stack.workingDir ? `${stack.workingDir}/${stack.configFiles.join(", ") || "compose.yaml"}` : stack.project}>
                                    <Label color="blue" icon={<LayerGroupIcon />}>{cockpit.format(_("Compose: $0"), stack.project)}</Label>
                                </Tooltip>}
                            {isPodService && <Label color="purple">{_("systemd")}</Label>}
                            {!stack && !isPodService && <Label variant="outline">{_("Podman")}</Label>}
                            {outdated > 0 &&
                                <Tooltip content={_("A newer image was pulled; recreate the stack to use it.")}>
                                    <Label status="warning" icon={<ArrowCircleUpIcon />}>{cockpit.format(cockpit.ngettext("$0 newer image pulled", "$0 newer images pulled", outdated), outdated)}</Label>
                                </Tooltip>}
                            {updatesAvailable > 0 && outdated === 0 &&
                                <Tooltip content={_("The registry has a newer image; use Pull and recreate stack.")}>
                                    <Label status="warning" icon={<ArrowCircleUpIcon />}>{cockpit.format(cockpit.ngettext("$0 image update available", "$0 image updates available", updatesAvailable), updatesAvailable)}</Label>
                                </Tooltip>}
                            {users.filter(u => u.con).length > 1 && user &&
                                <Label color="grey">{pod.uid === 0 ? _("system") : user.name}</Label>}
                        </LabelGroup>
                    </PodRow>

                    <PodRow title={_("Containers")}>
                        <span className="podman-pod-facts">
                            {cockpit.format(cockpit.ngettext("$0 of $1 running", "$0 of $1 running", members.length), running, members.length)}
                            {pod.Created && <> · {_("created")} <RelativeTime time={pod.Created} /></>}
                        </span>
                    </PodRow>

                    <PodRow title={_("CPU")}>
                        {isRunning
                            ? <Progress value={Math.min(100, cpu)}
                                        label={sampled ? `${cpu.toFixed(1)}%` : _("n/a")}
                                        size={ProgressSize.sm}
                                        measureLocation={ProgressMeasureLocation.outside}
                                        aria-label={cockpit.format(_("CPU usage of pod $0"), pod.Name)} />
                            : <span className="podman-pod-facts">{_("not running")}</span>}
                    </PodRow>

                    <PodRow title={_("Memory")}>
                        {isRunning
                            ? <Progress value={memPct}
                                        label={memLabel}
                                        size={ProgressSize.sm}
                                        measureLocation={ProgressMeasureLocation.outside}
                                        {...(memVariant ? { variant: memVariant } : {})}
                                        aria-label={cockpit.format(_("Memory usage of pod $0"), pod.Name)} />
                            : <span className="podman-pod-facts">{_("not running")}</span>}
                    </PodRow>

                    <PodRow title={_("I/O")}>
                        {isRunning && io.span
                            ? (
                                <span className="podman-pod-facts podman-pod-io">
                                    {cockpit.format(_("net ↓ $0 ↑ $1"), cockpit.format_bytes_per_sec(io.rx), cockpit.format_bytes_per_sec(io.tx))}
                                    {" · "}
                                    {cockpit.format(_("disk R $0 W $1"), cockpit.format_bytes_per_sec(io.bi), cockpit.format_bytes_per_sec(io.bo))}
                                </span>
                            )
                            : <span className="podman-pod-facts">{isRunning ? _("measuring…") : _("not running")}</span>}
                    </PodRow>

                    <PodRow title={_("Members")} className="podman-pod-row-members">
                        {memberDetails.length > 0
                            ? (
                                <LabelGroup numLabels={8} className="podman-pod-containers">
                                    {memberDetails.map(m => (
                                        <Tooltip key={m.ref.Id} content={m.isUnhealthy ? _("Health check is failing") : (m.isLooping ? _("Possible restart loop") : m.status)}>
                                            <Label variant="outline" color={containerLabelColor(m.status, m.isUnhealthy)}
                                                   icon={containerLabelIcon(m.status, m.isUnhealthy, m.isLooping)}
                                                   onClick={() => focusTable(m.name, m.status !== "running")}>
                                                {m.name}
                                            </Label>
                                        </Tooltip>
                                    ))}
                                </LabelGroup>
                            )
                            : <span className="podman-pod-facts">{_("No containers")}</span>}
                    </PodRow>
                </CardBody>
            </Card>
        );
    };

    let body;
    if (loading) {
        body = (
            <Gallery hasGutter minWidths={{ default: "26rem" }}>
                {[0, 1, 2].map(i => (
                    <Card isCompact key={i} className="podman-pod-card">
                        <CardBody className="podman-pod-body">
                            <Skeleton width="60%" screenreaderText={_("Loading pods")} />
                            <Skeleton width="40%" />
                            <Skeleton />
                        </CardBody>
                    </Card>
                ))}
            </Gallery>
        );
    } else if (podList.length === 0) {
        body = (
            <EmptyState variant={EmptyStateVariant.xs} icon={CubesIcon}
                        titleText={hiddenPods ? _("No running pods") : (textFilter ? _("No matching pods") : _("No pods"))} headingLevel="h3">
                <EmptyStateBody>
                    {hiddenPods
                        ? (
                            <>
                                {cockpit.format(cockpit.ngettext("$0 stopped pod is hidden by the \"Only running\" filter.", "$0 stopped pods are hidden by the \"Only running\" filter.", hiddenPods), hiddenPods)}
                                {" "}
                                <Button variant="link" isInline onClick={() => onContainerFilterChanged("all")}>{_("Show all")}</Button>
                            </>
                        )
                        : (textFilter ? _("No pod or pod member matches the current filter.") : _("Pods group containers that share a network namespace. Create one from the Containers card."))}
                </EmptyStateBody>
            </EmptyState>
        );
    } else {
        body = (
            <Gallery hasGutter minWidths={{ default: "26rem" }} className="podman-pod-gallery">
                {podList.map(renderPod)}
            </Gallery>
        );
    }

    const runningPods = podList.filter(p => p.Status === "Running").length;

    return (
        <Card id="containers-pods" className="containers-pods">
            <CardHeader actions={{
                actions: (
                    <Button variant="secondary" id="pods-deploy-stack"
                            onClick={() => Dialogs.show(<ComposeDeployModal users={users} containers={containers} onAddNotification={onAddNotification} />)}>
                        {_("Deploy compose stack")}
                    </Button>
                ),
            }}>
                <Flex alignItems={{ default: "alignItemsBaseline" }}>
                    <CardTitle>
                        <Content component={ContentVariants.h1} className="containers-pods-title">{_("Pods")}</Content>
                    </CardTitle>
                    {!loading && podList.length > 0 &&
                        <Content component={ContentVariants.p} className="ignore-pixels">
                            {cockpit.format(cockpit.ngettext("$0 pod, $1 running", "$0 pods, $1 running", podList.length), podList.length, runningPods)}
                            {hiddenPods > 0 &&
                                <>
                                    {" · "}
                                    {cockpit.format(cockpit.ngettext("$0 stopped pod hidden", "$0 stopped pods hidden", hiddenPods), hiddenPods)}
                                    {" "}
                                    <Button variant="link" isInline onClick={() => onContainerFilterChanged("all")}>{_("Show all")}</Button>
                                </>}
                        </Content>}
                </Flex>
            </CardHeader>
            <CardBody>
                {body}
            </CardBody>
        </Card>
    );
};
