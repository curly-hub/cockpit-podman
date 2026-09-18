/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Resource usage of one container over the last minutes: CPU, memory, network and block I/O. */
import React from 'react';

import { Gallery } from "@patternfly/react-core/dist/esm/layouts/Gallery";

import cockpit from 'cockpit';

import { Sparkline } from './Sparkline.tsx';
import { currentRates, rateSeries } from './stats.ts';
import type { Sample } from './stats.ts';

import './ContainerResources.scss';

const _ = cockpit.gettext;

interface Container {
    Name: string;
    State?: { Status?: string };
    HostConfig?: { Memory?: number; NanoCpus?: number; CpuQuota?: number; CpuPeriod?: number };
}

interface Stats {
    CPU?: number;
    MemUsage?: number;
    MemLimit?: number;
    PIDs?: number;
}

export interface ContainerResourcesProps {
    container: Container;
    stats?: Stats;
    history?: Sample[];
}

interface PanelProps {
    id: string;
    title: string;
    value: string;
    detail?: string;
    values: number[];
    max?: number;
    secondary?: { values: number[]; label: string; value: string };
}

const Panel = ({ id, title, value, detail, values, max, secondary }: PanelProps) => (
    <div className="podman-resource-panel" id={`container-resources-${id}`}>
        <div className="podman-resource-title">{title}</div>
        <div className="podman-resource-value">{value}</div>
        {detail && <div className="podman-resource-detail">{detail}</div>}
        <Sparkline values={values} {...(max !== undefined ? { max } : {})} width={220} height={44} ariaLabel={title} />
        {secondary &&
            <>
                <div className="podman-resource-detail">{secondary.label}: {secondary.value}</div>
                <Sparkline values={secondary.values} width={220} height={44} className="podman-sparkline-secondary" ariaLabel={secondary.label} />
            </>}
    </div>
);

export const ContainerResources = ({ container, stats, history }: ContainerResourcesProps) => {
    const running = container.State?.Status === "running";
    const samples = history ?? [];
    if (!running || (samples.length === 0 && !stats)) {
        return <p className="ct-grey-text">{running ? _("Waiting for the first stats sample...") : _("The container is not running.")}</p>;
    }

    const spanSec = samples.length > 1 ? Math.round((samples[samples.length - 1].t - samples[0].t) / 1000) : 0;
    const spanText = spanSec >= 90
        ? cockpit.format(_("last $0 min"), Math.round(spanSec / 60))
        : (spanSec > 0 ? cockpit.format(_("last $0 s"), spanSec) : _("collecting"));

    const cpuValues = samples.map(s => s.cpu ?? 0);
    const cpuNow = stats?.CPU ?? cpuValues[cpuValues.length - 1] ?? 0;
    const cpuPeak = Math.max(0, ...cpuValues);
    // a CPU quota caps the scale; otherwise the peak does
    const quota = container.HostConfig?.NanoCpus
        ? container.HostConfig.NanoCpus / 1e9 * 100
        : (container.HostConfig?.CpuQuota && container.HostConfig?.CpuPeriod ? container.HostConfig.CpuQuota / container.HostConfig.CpuPeriod * 100 : 0);

    const memValues = samples.map(s => s.mem ?? 0);
    const memNow = stats?.MemUsage ?? memValues[memValues.length - 1] ?? 0;
    const memLimit = container.HostConfig?.Memory || 0;
    const memPeak = Math.max(0, ...memValues);

    const rates = currentRates(samples);
    const rx = rateSeries(samples, r => r.rx);
    const tx = rateSeries(samples, r => r.tx);
    const bi = rateSeries(samples, r => r.bi);
    const bo = rateSeries(samples, r => r.bo);
    const last = samples[samples.length - 1];

    return (
        <Gallery hasGutter minWidths={{ default: "16rem" }} className="podman-resources">
            <Panel id="cpu" title={_("CPU")}
                   value={`${cpuNow.toFixed(1)}%`}
                   detail={(quota ? cockpit.format(_("limit $0% · "), Math.round(quota)) : "") + cockpit.format(_("peak $0% · $1"), cpuPeak.toFixed(1), spanText)}
                   values={cpuValues} {...(quota ? { max: quota } : {})} />
            <Panel id="memory" title={_("Memory")}
                   value={cockpit.format_bytes(memNow)}
                   detail={(memLimit ? cockpit.format(_("limit $0 · "), cockpit.format_bytes(memLimit)) : _("no limit · ")) + cockpit.format(_("peak $0"), cockpit.format_bytes(memPeak))}
                   values={memValues} {...(memLimit ? { max: memLimit } : {})} />
            <Panel id="network" title={_("Network")}
                   value={cockpit.format(_("↓ $0"), cockpit.format_bytes_per_sec(rates.rx))}
                   detail={cockpit.format(_("received in total $0"), cockpit.format_bytes(last?.rx ?? 0))}
                   values={rx}
                   secondary={{ values: tx, label: _("↑ sent"), value: cockpit.format(_("$0 · $1 in total"), cockpit.format_bytes_per_sec(rates.tx), cockpit.format_bytes(last?.tx ?? 0)) }} />
            <Panel id="disk" title={_("Disk I/O")}
                   value={cockpit.format(_("read $0"), cockpit.format_bytes_per_sec(rates.bi))}
                   detail={cockpit.format(_("$0 read in total"), cockpit.format_bytes(last?.bi ?? 0))}
                   values={bi}
                   secondary={{ values: bo, label: _("write"), value: cockpit.format(_("$0 · $1 in total"), cockpit.format_bytes_per_sec(rates.bo), cockpit.format_bytes(last?.bo ?? 0)) }} />
            <div className="podman-resource-panel" id="container-resources-pids">
                <div className="podman-resource-title">{_("Processes")}</div>
                <div className="podman-resource-value">{stats?.PIDs ?? last?.pids ?? "—"}</div>
                <div className="podman-resource-detail">{cockpit.format(_("$0 samples · every ~5 s"), samples.length)}</div>
            </div>
        </Gallery>
    );
};

export default ContainerResources;
