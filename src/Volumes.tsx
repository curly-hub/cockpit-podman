/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Podman volumes: who uses them, how big they are, and which ones nothing references any more. */
import React from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content";
import { DropdownItem } from '@patternfly/react-core/dist/esm/components/Dropdown/index.js';
import { Label, LabelGroup } from "@patternfly/react-core/dist/esm/components/Label";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { ExclamationTriangleIcon, LayerGroupIcon } from '@patternfly/react-icons';
import { KebabDropdown } from "cockpit-components-dropdown.jsx";
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';
import { ListingTable } from "cockpit-components-table";

import { ConfirmModal } from './ConfirmModal.tsx';
import * as client from './client.js';
import type { Connection } from './rest.js';
import { RelativeTime, makeKey, matchesOwner } from './util.js';

const _ = cockpit.gettext;

export interface Volume {
    key: string;
    uid: number | null;
    Name: string;
    Driver?: string;
    Mountpoint?: string;
    CreatedAt?: string;
    Labels?: Record<string, string> | null;
    Options?: Record<string, string> | null;
    Anonymous?: boolean;
    df?: { Size?: number; ReclaimableSize?: number; Links?: number } | null;
}

interface Container {
    key: string;
    uid: number | null;
    Id: string;
    Name: string;
    IsInfra?: boolean;
    State?: { Status?: string };
    Mounts?: { Type?: string; Name?: string; Destination?: string; RW?: boolean }[] | null;
}

interface User {
    con: Connection | null;
    uid: number | null;
    name: string;
}

export interface VolumesProps {
    volumes: Record<string, Volume> | null;
    containers: Record<string, Container> | null;
    users: User[];
    ownerFilter: string | number;
    textFilter: string;
    onAddNotification: (n: { type: string; error: string; errorDetail?: string }) => void;
    onFilterChanged: (text: string) => void;
    onContainerFilterChanged: (value: string) => void;
    onRefresh: () => void;
}

interface Usage {
    container: Container;
    destination: string;
    rw: boolean;
}

/* volume key → containers that mount it */
function volumeUsers(containers: Record<string, Container> | null): Record<string, Usage[]> {
    const result: Record<string, Usage[]> = {};
    for (const c of Object.values(containers ?? {})) {
        for (const mount of c.Mounts ?? []) {
            if (mount.Type !== "volume" || !mount.Name)
                continue;
            (result[makeKey(c.uid, mount.Name)] ??= []).push({ container: c, destination: mount.Destination ?? "", rw: mount.RW !== false });
        }
    }
    for (const list of Object.values(result))
        list.sort((a, b) => a.container.Name.localeCompare(b.container.Name));
    return result;
}

const isAnonymous = (vol: Volume) => vol.Anonymous || /^[0-9a-f]{64}$/.test(vol.Name);

export const Volumes = ({
    volumes, containers, users, ownerFilter, textFilter, onAddNotification, onFilterChanged, onContainerFilterChanged, onRefresh,
}: VolumesProps) => {
    const Dialogs = useDialogs();
    const loading = volumes === null || containers === null;
    const lcf = textFilter.toLowerCase();
    const multiUser = users.filter(u => u.con).length > 1;

    const usage = volumeUsers(containers);
    const all = Object.values(volumes ?? {}).filter(vol => matchesOwner(vol.uid, ownerFilter));
    const list = all
            .filter(vol => !lcf || vol.Name.toLowerCase().includes(lcf) ||
                (usage[vol.key] ?? []).some(u => u.container.Name.toLowerCase().includes(lcf)))
            .sort((a, b) => a.Name.localeCompare(b.Name));

    const unusedList = all.filter(vol => !(usage[vol.key] ?? []).length);
    const totalSize = all.reduce((sum, vol) => sum + (vol.df?.Size ?? 0), 0);
    const unusedSize = unusedList.reduce((sum, vol) => sum + (vol.df?.Size ?? 0), 0);

    const showContainer = (name: string, running: boolean) => {
        onFilterChanged(name);
        if (!running)
            onContainerFilterChanged("all");
        document.getElementById("containers-containers")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    const deleteVolume = (vol: Volume, con: Connection) => {
        Dialogs.show(
            <ConfirmModal title={cockpit.format(_("Delete volume $0?"), vol.Name)}
                          body={<p>{_("The volume and all data stored in it will be permanently removed.")}</p>}
                          actionLabel={_("Delete")}
                          onConfirm={() => client.delVolume(con, vol.Name, false)
                                  .catch(ex => {
                                      onAddNotification({ type: "danger", error: cockpit.format(_("Failed to delete volume $0"), vol.Name), errorDetail: ex.message });
                                      throw ex;
                                  })} />
        );
    };

    const pruneVolumes = () => {
        const connected = users.filter(u => u.con && matchesOwner(u.uid, ownerFilter));
        Dialogs.show(
            <ConfirmModal title={_("Delete all unused volumes?")}
                          body={
                              <>
                                  <p>{cockpit.format(cockpit.ngettext("$0 volume that no container mounts will be permanently removed, freeing about $1.",
                                                                      "$0 volumes that no container mounts will be permanently removed, freeing about $1.", unusedList.length),
                                                     unusedList.length, cockpit.format_bytes(unusedSize))}</p>
                                  <ul>
                                      {unusedList.map(vol => <li key={vol.key}>{vol.Name}</li>)}
                                  </ul>
                              </>
                          }
                          actionLabel={_("Delete unused volumes")}
                          onConfirm={() => Promise.all(connected.map(u => client.pruneVolumes(u.con as Connection)))} />
        );
    };

    const columns = [
        { title: _("Name"), header: true },
        { title: _("Size") },
        { title: _("Used by") },
        { title: _("Mount point") },
        ...(multiUser ? [{ title: _("Owner") }] : []),
        { title: _("Created") },
        { title: "", props: { "aria-label": _("Actions") } },
    ];

    const rows = list.map(vol => {
        const user = users.find(u => u.uid === vol.uid);
        const mounts = usage[vol.key] ?? [];
        const project = vol.Labels?.["com.docker.compose.project"] || vol.Labels?.["io.podman.compose.project"];
        const anonymous = isAnonymous(vol);

        const dropdownItems: React.ReactNode[] = [];
        if (user?.con) {
            dropdownItems.push(
                <DropdownItem key="delete" className="pf-m-danger" component="button"
                              isDisabled={mounts.length > 0}
                              description={mounts.length > 0 ? _("Still mounted by containers") : undefined}
                              onClick={() => deleteVolume(vol, user.con as Connection)}>
                    {_("Delete")}
                </DropdownItem>
            );
        }

        return {
            columns: [
                {
                    title: (
                        <>
                            <span className={anonymous ? "ct-grey-text" : ""}>{anonymous ? vol.Name.slice(0, 12) : vol.Name}</span>
                            {anonymous && <> <Label isCompact>{_("anonymous")}</Label></>}
                            {project && <> <Label isCompact color="blue" icon={<LayerGroupIcon />}>{cockpit.format(_("Compose: $0"), project)}</Label></>}
                            {mounts.length === 0 && <> <Label isCompact status="warning" icon={<ExclamationTriangleIcon />}>{_("Unused")}</Label></>}
                        </>
                    ),
                    sortKey: vol.Name,
                    props: { modifier: "breakWord" as const },
                },
                {
                    title: vol.df ? cockpit.format_bytes(vol.df.Size ?? 0) : <span className="ct-grey-text">—</span>,
                    sortKey: String(vol.df?.Size ?? -1).padStart(15, "0"),
                    props: { modifier: "nowrap" as const },
                },
                {
                    title: mounts.length
                        ? (
                            <LabelGroup numLabels={6}>
                                {mounts.map(m => {
                                    const running = m.container.State?.Status === "running";
                                    return (
                                        <Tooltip key={m.container.key + m.destination} content={`${m.destination}${m.rw ? "" : " " + _("(read-only)")}`}>
                                            <Label variant="outline" color={running ? "green" : "grey"}
                                                   onClick={() => showContainer(m.container.Name, running)}>
                                                {m.container.Name}
                                            </Label>
                                        </Tooltip>
                                    );
                                })}
                            </LabelGroup>
                        )
                        : <span className="ct-grey-text">{_("No container")}</span>,
                    sortKey: String(mounts.length),
                },
                {
                    title: vol.Mountpoint
                        ? <Tooltip content={vol.Mountpoint}><span className="ct-grey-text podman-volume-path">{vol.Mountpoint}</span></Tooltip>
                        : <span className="ct-grey-text">—</span>,
                    props: { modifier: "truncate" as const },
                },
                ...(multiUser
                    ? [{ title: vol.uid === 0 ? _("system") : <><span className="ct-grey-text">{_("user:")} </span>{user?.name}</>, props: { modifier: "nowrap" as const } }]
                    : []),
                { title: vol.CreatedAt ? <RelativeTime time={vol.CreatedAt} /> : <span className="ct-grey-text">—</span>, sortKey: vol.CreatedAt ?? "" },
                {
                    title: dropdownItems.length
                        ? <KebabDropdown toggleButtonId={`volume-${vol.key}-actions`} position="right" dropdownItems={dropdownItems} />
                        : null,
                    props: { className: "pf-v6-c-table__action content-action" },
                },
            ],
            props: { key: vol.key, "data-row-id": vol.key },
        };
    });

    const actions = (
        <Flex spaceItems={{ default: "spaceItemsSm" }}>
            <Button variant="secondary" isDisabled={loading} onClick={onRefresh}>{_("Refresh sizes")}</Button>
            <Button variant="secondary" isDanger isDisabled={loading || unusedList.length === 0} onClick={pruneVolumes}>
                {_("Delete unused")}
            </Button>
        </Flex>
    );

    return (
        <Card id="containers-volumes" className="containers-volumes">
            <CardHeader actions={{ actions }}>
                <Flex alignItems={{ default: "alignItemsBaseline" }}>
                    <CardTitle>
                        <Content component={ContentVariants.h1}>{_("Volumes")}</Content>
                    </CardTitle>
                    {!loading && all.length > 0 &&
                        <Content component={ContentVariants.p} className="ignore-pixels">
                            {cockpit.format(cockpit.ngettext("$0 volume", "$0 volumes", all.length), all.length)}
                            {totalSize > 0 && ` · ${cockpit.format_bytes(totalSize)}`}
                            {unusedList.length > 0 && ` · ${cockpit.format(_("$0 unused"), unusedList.length)}${unusedSize > 0 ? ` (${cockpit.format_bytes(unusedSize)})` : ""}`}
                        </Content>}
                </Flex>
            </CardHeader>
            <CardBody>
                <ListingTable aria-label={_("Volumes")}
                              variant="compact"
                              loading={loading ? _("Loading volumes...") : ""}
                              emptyCaption={textFilter ? _("No volumes match the current filter") : _("No volumes")}
                              emptyCaptionDetail={textFilter ? <Button variant="link" isInline onClick={() => onFilterChanged("")}>{_("Clear filter")}</Button> : _("Named volumes appear here once a container or compose project creates one.")}
                              columns={columns}
                              rows={rows} />
            </CardBody>
        </Card>
    );
};
