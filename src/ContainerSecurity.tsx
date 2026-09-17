/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Factual runtime security information about a container, with warnings for
 * settings that widen its access to the host. No scores, just facts. */
import React from 'react';

import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection";
import { Icon } from "@patternfly/react-core/dist/esm/components/Icon";
import { Label, LabelGroup } from "@patternfly/react-core/dist/esm/components/Label";
import { List, ListItem } from "@patternfly/react-core/dist/esm/components/List";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack";
import { CheckCircleIcon, ExclamationCircleIcon, ExclamationTriangleIcon } from '@patternfly/react-icons';

import cockpit from 'cockpit';

const _ = cockpit.gettext;

export interface SecurityContainer {
    uid: number | null;
    Config?: {
        User?: string;
        Labels?: Record<string, string> | null;
    };
    HostConfig?: {
        Privileged?: boolean;
        ReadonlyRootfs?: boolean;
        CapAdd?: string[] | null;
        CapDrop?: string[] | null;
        NetworkMode?: string;
        PidMode?: string;
        IpcMode?: string;
        UsernsMode?: string;
        SecurityOpt?: string[] | null;
        Devices?: { PathOnHost?: string; PathInContainer?: string }[] | null;
        PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
        RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
    };
    EffectiveCaps?: string[] | null;
    ProcessLabel?: string;
    MountLabel?: string;
    Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean }[] | null;
}

export type Severity = "danger" | "warning";

export interface SecurityWarning {
    id: string;
    severity: Severity;
    text: string;
}

const DANGEROUS_CAPS = ["CAP_SYS_ADMIN", "CAP_SYS_PTRACE", "CAP_SYS_MODULE", "CAP_NET_ADMIN", "CAP_DAC_READ_SEARCH", "CAP_SYS_RAWIO", "CAP_ALL", "ALL"];
const SENSITIVE_PATHS = ["/", "/etc", "/usr", "/boot", "/root", "/var/run", "/run", "/proc", "/sys", "/dev", "/var/lib/containers", "/home"];

const isSensitiveSource = (source: string): boolean => {
    if (source.endsWith(".sock"))
        return true;
    return SENSITIVE_PATHS.some(p => source === p || (p !== "/" && source.startsWith(p + "/") && source.split("/").length <= 3));
};

const secOpt = (container: SecurityContainer, key: string): string | null => {
    for (const opt of container.HostConfig?.SecurityOpt ?? []) {
        const [k, ...rest] = opt.split(/[=:]/);
        if (k === key)
            return rest.join("=") || "";
    }
    return null;
};

export function securityWarnings(container: SecurityContainer): SecurityWarning[] {
    const w: SecurityWarning[] = [];
    const hc = container.HostConfig ?? {};
    const rootless = container.uid !== 0;

    if (hc.Privileged)
        w.push({ id: "privileged", severity: rootless ? "warning" : "danger", text: _("Privileged container") });
    if (hc.NetworkMode === "host")
        w.push({ id: "hostnet", severity: "warning", text: _("Host network namespace") });
    if (hc.PidMode === "host")
        w.push({ id: "hostpid", severity: "warning", text: _("Host PID namespace") });
    if (hc.IpcMode === "host")
        w.push({ id: "hostipc", severity: "warning", text: _("Host IPC namespace") });

    const added = (hc.CapAdd ?? []).map(c => c.toUpperCase().startsWith("CAP_") ? c.toUpperCase() : `CAP_${c.toUpperCase()}`);
    const dangerous = added.filter(c => DANGEROUS_CAPS.includes(c) || c === "CAP_ALL");
    if (dangerous.length)
        w.push({ id: "caps", severity: rootless ? "warning" : "danger", text: cockpit.format(_("Added capabilities: $0"), dangerous.join(", ")) });

    if (secOpt(container, "label") === "disable")
        w.push({ id: "selinux", severity: "warning", text: _("SELinux label disabled") });
    if (secOpt(container, "seccomp") === "unconfined")
        w.push({ id: "seccomp", severity: "warning", text: _("seccomp unconfined") });

    for (const m of container.Mounts ?? []) {
        if (m.Type === "bind" && m.RW && m.Source && isSensitiveSource(m.Source))
            w.push({ id: `mount-${m.Source}`, severity: "warning", text: cockpit.format(_("Writable bind mount of $0"), m.Source) });
    }

    if ((hc.Devices ?? []).length)
        w.push({ id: "devices", severity: "warning", text: cockpit.format(cockpit.ngettext("$0 host device passed through", "$0 host devices passed through", hc.Devices!.length), hc.Devices!.length) });

    if (!rootless && !container.Config?.User)
        w.push({ id: "root", severity: "warning", text: _("Runs as root inside a rootful container") });

    const allInterfaces = Object.values(hc.PortBindings ?? {})
            .some(bindings => (bindings ?? []).some(b => !b.HostIp || b.HostIp === "0.0.0.0" || b.HostIp === "::"));
    if (allInterfaces)
        w.push({ id: "ports", severity: "warning", text: _("Ports published on all interfaces") });

    return w;
}

const yesNo = (v: boolean | undefined) => (v ? _("yes") : _("no"));

const ContainerSecurity = ({ container }: { container: SecurityContainer }) => {
    const hc = container.HostConfig ?? {};
    const rootless = container.uid !== 0;
    const warnings = securityWarnings(container);
    const caps = container.EffectiveCaps ?? [];
    const bindMounts = (container.Mounts ?? []).filter(m => m.Type === "bind");
    const selinuxDisabled = secOpt(container, "label") === "disable";
    const seccomp = secOpt(container, "seccomp");
    const noNewPrivs = (hc.SecurityOpt ?? []).some(o => o.startsWith("no-new-privileges"));
    const ports = Object.entries(hc.PortBindings ?? {}).flatMap(([port, bindings]) =>
        (bindings ?? []).map(b => `${b.HostIp || "0.0.0.0"}:${b.HostPort} → ${port}`));

    const user = container.Config?.User
        ? container.Config.User
        : (rootless ? _("root inside the container, mapped to your unprivileged user on the host") : _("root"));

    return (
        <Stack hasGutter className="container-security">
            <LabelGroup numLabels={10} aria-label={_("Security warnings")}>
                {warnings.length === 0
                    ? <Label color="green" icon={<CheckCircleIcon />}>{_("No warnings")}</Label>
                    : warnings.map(w => (
                        <Label key={w.id} status={w.severity} icon={w.severity === "danger" ? <ExclamationCircleIcon /> : <ExclamationTriangleIcon />}>
                            {w.text}
                        </Label>
                    ))}
            </LabelGroup>

            <DescriptionList isCompact isHorizontal className="container-security-facts">
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Mode")}</DescriptionListTerm>
                    <DescriptionListDescription>{rootless ? _("Rootless") : _("Rootful")}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Privileged")}</DescriptionListTerm>
                    <DescriptionListDescription>{yesNo(hc.Privileged)}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("User")}</DescriptionListTerm>
                    <DescriptionListDescription>{user}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Read-only root filesystem")}</DescriptionListTerm>
                    <DescriptionListDescription>{yesNo(hc.ReadonlyRootfs)}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Network namespace")}</DescriptionListTerm>
                    <DescriptionListDescription>{hc.NetworkMode || _("default")}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("PID namespace")}</DescriptionListTerm>
                    <DescriptionListDescription>{hc.PidMode || _("private")}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("IPC namespace")}</DescriptionListTerm>
                    <DescriptionListDescription>{hc.IpcMode || _("private")}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("User namespace")}</DescriptionListTerm>
                    <DescriptionListDescription>{hc.UsernsMode || (rootless ? _("rootless user namespace") : _("host"))}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("SELinux")}</DescriptionListTerm>
                    <DescriptionListDescription>
                        {selinuxDisabled
                            ? <><Icon status="warning" isInline><ExclamationTriangleIcon /></Icon> {_("label disabled")}</>
                            : (container.ProcessLabel || _("not available"))}
                    </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("seccomp")}</DescriptionListTerm>
                    <DescriptionListDescription>{seccomp === null ? _("default profile") : (seccomp || _("custom"))}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("No new privileges")}</DescriptionListTerm>
                    <DescriptionListDescription>{yesNo(noNewPrivs)}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Restart policy")}</DescriptionListTerm>
                    <DescriptionListDescription>
                        {hc.RestartPolicy?.Name
                            ? (hc.RestartPolicy.MaximumRetryCount ? `${hc.RestartPolicy.Name} (${hc.RestartPolicy.MaximumRetryCount})` : hc.RestartPolicy.Name)
                            : _("no")}
                    </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Published ports")}</DescriptionListTerm>
                    <DescriptionListDescription>
                        {ports.length ? <List isPlain>{ports.map(p => <ListItem key={p}>{p}</ListItem>)}</List> : _("none")}
                    </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Host devices")}</DescriptionListTerm>
                    <DescriptionListDescription>
                        {(hc.Devices ?? []).length
                            ? <List isPlain>{hc.Devices!.map(d => <ListItem key={d.PathOnHost}>{d.PathOnHost} → {d.PathInContainer}</ListItem>)}</List>
                            : _("none")}
                    </DescriptionListDescription>
                </DescriptionListGroup>
            </DescriptionList>

            {bindMounts.length > 0 &&
                <ExpandableSection toggleText={cockpit.format(cockpit.ngettext("$0 bind mount", "$0 bind mounts", bindMounts.length), bindMounts.length)}>
                    <List isPlain>
                        {bindMounts.map(m => (
                            <ListItem key={`${m.Source}-${m.Destination}`}>
                                <code>{m.Source}</code> → <code>{m.Destination}</code> {m.RW ? _("(read-write)") : _("(read-only)")}
                            </ListItem>
                        ))}
                    </List>
                </ExpandableSection>}

            <ExpandableSection toggleText={cockpit.format(cockpit.ngettext("$0 effective capability", "$0 effective capabilities", caps.length), caps.length)}>
                <LabelGroup numLabels={40}>
                    {caps.map(c => <Label key={c} isCompact variant="outline" color={DANGEROUS_CAPS.includes(c) ? "red" : "grey"}>{c}</Label>)}
                </LabelGroup>
                {(hc.CapDrop ?? []).length > 0 &&
                    <p className="pf-v6-u-mt-sm">{cockpit.format(_("Dropped: $0"), hc.CapDrop!.join(", "))}</p>}
            </ExpandableSection>
        </Stack>
    );
};

export default ContainerSecurity;
