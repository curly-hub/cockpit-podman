/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Page-wide log view: pick any set of containers, across pods and owners, and follow their
 * merged output live. Lines can be filtered by text, the view paused, and the result saved. */
import React, { useMemo, useState } from 'react';

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal';
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput";
import { Toolbar, ToolbarContent, ToolbarGroup, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar";
import { DownloadIcon, PauseIcon, PlayIcon } from '@patternfly/react-icons';
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';
import { MultiTypeaheadSelect } from "cockpit-components-multi-typeahead-select.tsx";

import { LogView } from './PodLogs.tsx';
import type { LogSource, LogViewHandle } from './PodLogs.tsx';
import { containerStack } from './compose.ts';
import type { Uid } from './rest.js';

const _ = cockpit.gettext;

interface Container {
    key: string;
    uid: Uid;
    Id: string;
    Name: string;
    IsInfra?: boolean;
    IsService?: boolean;
    Pod?: string;
    State?: { Status?: string };
    Config?: { Labels?: Record<string, string> | null };
}

interface Pod {
    key: string;
    uid: Uid;
    Id: string;
    Name: string;
}

interface User {
    con: unknown;
    uid: Uid;
    name: string;
}

export interface ContainerLogsModalProps {
    users: User[];
    containers: Record<string, Container> | null;
    pods: Record<string, Pod> | null;
    /* container keys to start with; defaults to every running container */
    initial?: string[];
}

// streams opened at once when the dialog starts with "all running containers"
const INITIAL_LIMIT = 25;

export const ContainerLogsModal = ({ users, containers, pods, initial }: ContainerLogsModalProps) => {
    const Dialogs = useDialogs();
    const multiUser = users.filter(u => u.con).length > 1;
    const all = useMemo(() => Object.values(containers ?? {})
            .filter(c => !c.IsInfra && !c.IsService)
            .sort((a, b) => a.Name.localeCompare(b.Name)), [containers]);

    const [selected, setSelected] = useState<string[]>(() => {
        if (initial)
            return initial;
        return all.filter(c => c.State?.Status === "running").slice(0, INITIAL_LIMIT)
                .map(c => c.key);
    });
    const [filter, setFilter] = useState("");
    const [paused, setPaused] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);
    const view = React.useRef<LogViewHandle>(null);

    const podName = (c: Container) => {
        if (!c.Pod)
            return null;
        const pod = Object.values(pods ?? {}).find(p => p.uid === c.uid && p.Id === c.Pod);
        return pod?.Name ?? null;
    };
    const ownerName = (c: Container) => users.find(u => u.uid === c.uid)?.name ?? "";

    const options = all.map(c => {
        const pod = podName(c);
        const stack = containerStack(c)?.project;
        const where = stack ? cockpit.format(_("stack $0"), stack) : (pod ? cockpit.format(_("pod $0"), pod) : "");
        const owner = multiUser ? ` · ${c.uid === 0 ? _("system") : ownerName(c)}` : "";
        return {
            value: c.key,
            content: `${c.Name}${where ? ` (${where})` : ""}${owner}`,
            color: (c.State?.Status === "running" ? "green" : "grey") as "green" | "grey",
        };
    });

    // the terminal restarts its streams whenever this array changes identity, so build it only
    // from the selection
    const sources = useMemo<LogSource[]>(() => {
        const result: LogSource[] = [];
        for (const key of selected) {
            const c = containers?.[key];
            if (!c)
                continue;
            const stack = containerStack(c);
            const name = stack?.service && stack.project ? `${stack.project}/${stack.service}` : c.Name;
            result.push({ uid: c.uid, id: c.Id, name: multiUser && c.uid !== null ? `${c.uid === 0 ? "system" : ownerName(c)}:${name}` : name });
        }
        return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected.join(" "), containers === null]);

    const running = all.filter(c => c.State?.Status === "running").map(c => c.key);

    const download = () => {
        const text = view.current?.text() ?? "";
        const stamp = new Date().toISOString()
                .replace(/[:.]/g, "-");
        const blob = new Blob([text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `podman-logs-${stamp}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    return (
        <Modal isOpen position="top" variant="large" className="podman-pod-logs-modal podman-all-logs-modal" onClose={Dialogs.close}>
            <ModalHeader title={_("Container logs")}
                         description={_("Live output of the selected containers, merged by time and prefixed with the container or compose service name.")} />
            <ModalBody>
                <Toolbar inset={{ default: "insetNone" }} className="podman-all-logs-toolbar">
                    <ToolbarContent>
                        <ToolbarItem className="podman-all-logs-select">
                            <MultiTypeaheadSelect id="all-logs-containers"
                                                  placeholder={_("Select containers")}
                                                  options={options}
                                                  selected={selected}
                                                  onAdd={value => setSelected(prev => [...prev, String(value)])}
                                                  onRemove={value => setSelected(prev => prev.filter(k => k !== String(value)))}
                                                  noOptionsFoundMessage={_("No container matches")} />
                        </ToolbarItem>
                        <ToolbarGroup variant="action-group-plain">
                            <ToolbarItem>
                                <Button variant="link" isInline isDisabled={running.length === 0 || running.every(k => selected.includes(k))}
                                        onClick={() => setSelected(running.slice(0, INITIAL_LIMIT))}>
                                    {_("All running")}
                                </Button>
                            </ToolbarItem>
                            <ToolbarItem>
                                <Button variant="link" isInline isDisabled={selected.length === 0} onClick={() => setSelected([])}>
                                    {_("None")}
                                </Button>
                            </ToolbarItem>
                        </ToolbarGroup>
                    </ToolbarContent>
                    <ToolbarContent>
                        <ToolbarItem className="podman-all-logs-filter">
                            <SearchInput id="all-logs-filter" placeholder={_("Filter lines…")} value={filter}
                                         onChange={(_ev, value) => setFilter(value)}
                                         onClear={() => setFilter("")} />
                        </ToolbarItem>
                        <ToolbarItem>
                            <Button variant="secondary" icon={paused ? <PlayIcon /> : <PauseIcon />} onClick={() => setPaused(p => !p)}>
                                {paused ? _("Resume") : _("Pause")}
                            </Button>
                        </ToolbarItem>
                        <ToolbarItem>
                            <Button variant="secondary" icon={<DownloadIcon />} isDisabled={sources.length === 0} onClick={download}>
                                {_("Save as file")}
                            </Button>
                        </ToolbarItem>
                    </ToolbarContent>
                </Toolbar>
                {errors.length > 0 &&
                    <Alert variant="warning" isInline title={_("Some logs could not be read")}>
                        {errors.map(err => <div key={err}>{err}</div>)}
                    </Alert>}
                <LogView ref={view} sources={sources} filter={filter} paused={paused} reserve={360} onErrors={setErrors} />
            </ModalBody>
            <ModalFooter>
                <Button variant="secondary" onClick={Dialogs.close}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
};
