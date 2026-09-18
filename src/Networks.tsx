/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Podman networks and the containers attached to them. Pod members share the infra container's
 * network namespace, so they are shown on the networks of their pod's infra container. */
import React from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content";
import { DropdownItem } from '@patternfly/react-core/dist/esm/components/Dropdown/index.js';
import { Label, LabelGroup } from "@patternfly/react-core/dist/esm/components/Label";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { LayerGroupIcon, NetworkIcon } from '@patternfly/react-icons';
import { KebabDropdown } from "cockpit-components-dropdown.jsx";
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';
import { ListingTable } from "cockpit-components-table";

import { ConfirmModal } from './ConfirmModal.tsx';
import * as client from './client.js';
import type { Connection } from './rest.js';
import { RelativeTime, makeKey, matchesOwner, truncate_id } from './util.js';

const _ = cockpit.gettext;

export interface Network {
    key: string;
    uid: number | null;
    id: string;
    name: string;
    driver?: string;
    network_interface?: string;
    created?: string;
    subnets?: { subnet?: string; gateway?: string }[] | null;
    ipv6_enabled?: boolean;
    internal?: boolean;
    dns_enabled?: boolean;
    labels?: Record<string, string> | null;
}

interface Container {
    key: string;
    uid: number | null;
    Id: string;
    Name: string;
    IsInfra?: boolean;
    Pod?: string;
    State?: { Status?: string };
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> | null };
}

interface User {
    con: Connection | null;
    uid: number | null;
    name: string;
}

export interface NetworksProps {
    networks: Record<string, Network> | null;
    containers: Record<string, Container> | null;
    users: User[];
    ownerFilter: string | number;
    textFilter: string;
    onAddNotification: (n: { type: string; error: string; errorDetail?: string }) => void;
    onFilterChanged: (text: string) => void;
    onContainerFilterChanged: (value: string) => void;
}

interface Attached {
    container: Container;
    ip: string;
}

/* network key → containers on it. Pod members inherit the networks of their pod's infra container. */
function attachedContainers(networks: Network[], containers: Record<string, Container> | null): Record<string, Attached[]> {
    const byName: Record<string, Network> = {};
    for (const net of networks)
        byName[makeKey(net.uid, net.name)] = net;
    const infraByPod: Record<string, Container> = {};
    for (const c of Object.values(containers ?? {})) {
        if (c.IsInfra && c.Pod)
            infraByPod[makeKey(c.uid, c.Pod)] = c;
    }

    const result: Record<string, Attached[]> = {};
    for (const c of Object.values(containers ?? {})) {
        if (c.IsInfra)
            continue;
        let settings = c.NetworkSettings?.Networks;
        if ((!settings || Object.keys(settings).length === 0) && c.Pod)
            settings = infraByPod[makeKey(c.uid, c.Pod)]?.NetworkSettings?.Networks;
        for (const [name, endpoint] of Object.entries(settings ?? {})) {
            const net = byName[makeKey(c.uid, name)];
            if (!net)
                continue;
            (result[net.key] ??= []).push({ container: c, ip: endpoint?.IPAddress ?? "" });
        }
    }
    for (const list of Object.values(result))
        list.sort((a, b) => a.container.Name.localeCompare(b.container.Name));
    return result;
}

export const Networks = ({
    networks, containers, users, ownerFilter, textFilter, onAddNotification, onFilterChanged, onContainerFilterChanged,
}: NetworksProps) => {
    const Dialogs = useDialogs();
    const loading = networks === null || containers === null;
    const lcf = textFilter.toLowerCase();
    const multiUser = users.filter(u => u.con).length > 1;

    const all = Object.values(networks ?? {}).filter(net => matchesOwner(net.uid, ownerFilter));
    const attached = attachedContainers(all, containers);
    const list = all
            .filter(net => !lcf || net.name.toLowerCase().includes(lcf) ||
                (attached[net.key] ?? []).some(a => a.container.Name.toLowerCase().includes(lcf)))
            .sort((a, b) => a.name.localeCompare(b.name));

    const showContainer = (name: string, running: boolean) => {
        onFilterChanged(name);
        if (!running)
            onContainerFilterChanged("all");
        document.getElementById("containers-containers")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    const deleteNetwork = (net: Network, con: Connection) => {
        Dialogs.show(
            <ConfirmModal title={cockpit.format(_("Delete network $0?"), net.name)}
                          body={<p>{_("The network will be removed. Containers can no longer be attached to it.")}</p>}
                          actionLabel={_("Delete")}
                          onConfirm={() => client.delNetwork(con, net.name)
                                  .catch(ex => {
                                      onAddNotification({ type: "danger", error: cockpit.format(_("Failed to delete network $0"), net.name), errorDetail: ex.message });
                                      throw ex;
                                  })} />
        );
    };

    const columns = [
        { title: _("Name"), header: true },
        { title: _("Driver") },
        { title: _("Subnet") },
        { title: _("Options") },
        { title: _("Containers") },
        ...(multiUser ? [{ title: _("Owner") }] : []),
        { title: _("Created") },
        { title: "", props: { "aria-label": _("Actions") } },
    ];

    const rows = list.map(net => {
        const user = users.find(u => u.uid === net.uid);
        const members = attached[net.key] ?? [];
        const project = net.labels?.["com.docker.compose.project"] || net.labels?.["io.podman.compose.project"];
        const isDefault = net.name === "podman";

        const options: React.ReactNode[] = [];
        if (net.internal)
            options.push(<Label key="internal" isCompact color="orange">{_("internal")}</Label>);
        if (net.dns_enabled)
            options.push(<Label key="dns" isCompact>{_("DNS")}</Label>);
        if (net.ipv6_enabled)
            options.push(<Label key="ipv6" isCompact>{_("IPv6")}</Label>);

        const dropdownItems: React.ReactNode[] = [];
        if (user?.con && !isDefault) {
            dropdownItems.push(
                <DropdownItem key="delete" className="pf-m-danger" component="button"
                              isDisabled={members.length > 0}
                              description={members.length > 0 ? _("Still in use by containers") : undefined}
                              onClick={() => deleteNetwork(net, user.con as Connection)}>
                    {_("Delete")}
                </DropdownItem>
            );
        }

        return {
            columns: [
                {
                    title: (
                        <>
                            <span className="podman-network-name">{net.name}</span>
                            {project &&
                                <>
                                    {" "}
                                    <Label isCompact color="blue" icon={<LayerGroupIcon />}>{cockpit.format(_("Compose: $0"), project)}</Label>
                                </>}
                        </>
                    ),
                    sortKey: net.name,
                    props: { modifier: "breakWord" as const },
                },
                { title: <span className="ct-grey-text">{net.driver ?? "—"}{net.network_interface ? ` · ${net.network_interface}` : ""}</span> },
                {
                    title: (net.subnets ?? []).length
                        ? (net.subnets ?? []).map(sn => (
                            <div key={sn.subnet}>
                                {sn.subnet}
                                {sn.gateway && <span className="ct-grey-text"> {cockpit.format(_("via $0"), sn.gateway)}</span>}
                            </div>
                        ))
                        : <span className="ct-grey-text">—</span>,
                    props: { modifier: "nowrap" as const },
                },
                { title: options.length ? <LabelGroup>{options}</LabelGroup> : <span className="ct-grey-text">—</span> },
                {
                    title: members.length
                        ? (
                            <LabelGroup numLabels={6}>
                                {members.map(a => {
                                    const running = a.container.State?.Status === "running";
                                    return (
                                        <Tooltip key={a.container.key} content={a.ip ? cockpit.format(_("IP address $0"), a.ip) : a.container.State?.Status ?? ""}>
                                            <Label variant="outline" color={running ? "green" : "grey"}
                                                   onClick={() => showContainer(a.container.Name, running)}>
                                                {a.container.Name}
                                            </Label>
                                        </Tooltip>
                                    );
                                })}
                            </LabelGroup>
                        )
                        : <span className="ct-grey-text">{isDefault ? _("Default network") : _("Unused")}</span>,
                    sortKey: String(members.length),
                },
                ...(multiUser
                    ? [{ title: net.uid === 0 ? _("system") : <><span className="ct-grey-text">{_("user:")} </span>{user?.name}</>, props: { modifier: "nowrap" as const } }]
                    : []),
                { title: net.created ? <RelativeTime time={net.created} /> : truncate_id(net.id), sortKey: net.created ?? "" },
                {
                    title: dropdownItems.length
                        ? <KebabDropdown toggleButtonId={`network-${net.key}-actions`} position="right" dropdownItems={dropdownItems} />
                        : null,
                    props: { className: "pf-v6-c-table__action content-action" },
                },
            ],
            props: { key: net.key, "data-row-id": net.key },
        };
    });

    const unused = list.filter(net => net.name !== "podman" && !(attached[net.key] ?? []).length).length;

    return (
        <Card id="containers-networks" className="containers-networks">
            <CardHeader>
                <Flex alignItems={{ default: "alignItemsBaseline" }}>
                    <CardTitle>
                        <Content component={ContentVariants.h1}>{_("Networks")}</Content>
                    </CardTitle>
                    {!loading && list.length > 0 &&
                        <Content component={ContentVariants.p} className="ignore-pixels">
                            {cockpit.format(cockpit.ngettext("$0 network", "$0 networks", list.length), list.length)}
                            {unused > 0 && ` · ${cockpit.format(_("$0 unused"), unused)}`}
                        </Content>}
                </Flex>
            </CardHeader>
            <CardBody>
                <ListingTable aria-label={_("Networks")}
                              variant="compact"
                              loading={loading ? _("Loading networks...") : ""}
                              emptyCaption={textFilter ? _("No networks match the current filter") : _("No networks")}
                              emptyCaptionDetail={textFilter ? <Button variant="link" isInline onClick={() => onFilterChanged("")}>{_("Clear filter")}</Button> : <><NetworkIcon /> {_("Podman creates networks for compose projects and on demand.")}</>}
                              columns={columns}
                              rows={rows} />
            </CardBody>
        </Card>
    );
};
