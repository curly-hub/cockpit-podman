/* SPDX-License-Identifier: LGPL-2.1-or-later */
import React from 'react';

import { Badge } from "@patternfly/react-core/dist/esm/components/Badge";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider";
import { DropdownItem } from '@patternfly/react-core/dist/esm/components/Dropdown/index.js';
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect";
import { LabelGroup } from "@patternfly/react-core/dist/esm/components/Label";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { cellWidth, SortByDirection } from '@patternfly/react-table';
import { KebabDropdown } from "cockpit-components-dropdown.jsx";
import { useDialogs, DialogsContext } from "dialogs.jsx";

import cockpit from 'cockpit';
import { EmptyStatePanel } from "cockpit-components-empty-state.tsx";
import { ListingPanel } from 'cockpit-components-listing-panel';
import { ListingTable } from "cockpit-components-table";
import * as machine_info from 'machine-info';

import ContainerCheckpointModal from './ContainerCheckpointModal.jsx';
import ContainerCommitModal from './ContainerCommitModal.jsx';
import ContainerDeleteModal from './ContainerDeleteModal.jsx';
import ContainerDetails from './ContainerDetails.jsx';
import ContainerHealthLogs from './ContainerHealthLogs.jsx';
import ContainerIntegration from './ContainerIntegration.jsx';
import ContainerLogs from './ContainerLogs.jsx';
import ContainerRenameModal from './ContainerRenameModal.jsx';
import ContainerRestoreModal from './ContainerRestoreModal.jsx';
import ContainerTerminal from './ContainerTerminal.jsx';
import ForceRemoveModal from './ForceRemoveModal.jsx';
import { ImageRunModal } from './ImageRunModal.jsx';
import { PodCreateModal } from './PodCreateModal.jsx';
import PruneUnusedContainersModal from './PruneUnusedContainersModal.jsx';
import * as client from './client.js';
import * as utils from './util.js';

import './Containers.scss';
import '@patternfly/patternfly/utilities/Accessibility/accessibility.css';

const _ = cockpit.gettext;

const ContainerActions = ({ con, container, onAddNotification, localImages, updateContainer, isSystemdService, isDownloading }) => {
    const Dialogs = useDialogs();
    const isRunning = container.State.Status == "running";
    const isPaused = container.State.Status === "paused";

    const deleteContainer = () => {
        if (container.State.Status == "running") {
            const handleForceRemoveContainer = () => {
                const id = container ? container.Id : "";

                return client.delContainer(con, id, true)
                        .catch(ex => {
                            const error = cockpit.format(_("Failed to force remove container $0"), container.Name); // not-covered: OS error
                            onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                        })
                        .finally(() => {
                            Dialogs.close();
                        });
            };

            Dialogs.show(<ForceRemoveModal name={container.Name}
                                           handleForceRemove={handleForceRemoveContainer}
                                           reason={_("Deleting a running container will erase all data in it.")} />);
        } else {
            Dialogs.show(<ContainerDeleteModal con={con}
                                               containerWillDelete={container}
                                               onAddNotification={onAddNotification} />);
        }
    };

    const stopContainer = (force) => {
        const args = {};

        if (force)
            args.t = 0;
        client.postContainer(con, "stop", container.Id, args)
                .catch(ex => {
                    const error = cockpit.format(_("Failed to stop container $0"), container.Name); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                });
    };

    const stopQuadletContainer = () => {
        utils.systemctl_spawn(["stop", container.Config.Labels.PODMAN_SYSTEMD_UNIT], container.uid === 0)

                .catch(ex => {
                    const error = cockpit.format(_("Failed to stop quadlet $0"), container.Name); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                });
    };

    const startContainer = () => {
        if (isSystemdService) {
            utils.systemctl_spawn(["start", container.Config.Labels.PODMAN_SYSTEMD_UNIT], container.uid === 0)
                    .catch(ex => {
                        const error = cockpit.format(_("Failed to start quadlet $0"), container.Name); // not-covered: OS error
                        onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                    });
        } else {
            client.postContainer(con, "start", container.Id, {})
                    .catch(ex => {
                        const error = cockpit.format(_("Failed to start container $0"), container.Name); // not-covered: OS error
                        onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                    });
        }
    };

    const resumeContainer = () => {
        client.postContainer(con, "unpause", container.Id, {})
                .catch(ex => {
                    const error = cockpit.format(_("Failed to resume container $0"), container.Name); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                });
    };

    const pauseContainer = () => {
        client.postContainer(con, "pause", container.Id, {})
                .catch(ex => {
                    const error = cockpit.format(_("Failed to pause container $0"), container.Name); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                });
    };

    const commitContainer = () => {
        Dialogs.show(<ContainerCommitModal con={con}
                                           container={container}
                                           localImages={localImages} />);
    };

    const restartContainer = (force) => {
        const args = {};

        if (force)
            args.t = 0;
        client.postContainer(con, "restart", container.Id, args)
                .catch(ex => {
                    const error = cockpit.format(_("Failed to restart container $0"), container.Name); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                });
    };

    const restartQuadletContainer = () => {
        utils.systemctl_spawn(["restart", container.Config.Labels.PODMAN_SYSTEMD_UNIT], container.uid === 0)
                .catch(ex => {
                    const error = cockpit.format(_("Failed to restart quadlet $0"), container.Name); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                });
    };

    const renameContainer = () => {
        if (container.State.Status !== "running") {
            Dialogs.show(<ContainerRenameModal con={con}
                                               container={container} />);
        }
    };

    const checkpointContainer = () => {
        Dialogs.show(<ContainerCheckpointModal con={con}
                                               containerWillCheckpoint={container}
                                               onAddNotification={onAddNotification} />);
    };

    const restoreContainer = () => {
        Dialogs.show(<ContainerRestoreModal con={con}
                                            containerWillRestore={container}
                                            onAddNotification={onAddNotification} />);
    };

    const addRenameAction = () => {
        actions.push(
            <DropdownItem key="rename"
                        onClick={() => renameContainer()}>
                {_("Rename")}
            </DropdownItem>
        );
    };

    const actions = [];
    if (isRunning || isPaused) {
        // Allow restarting quadlets from the logged in user and superuser
        if (isSystemdService && [0, null].includes(container.uid)) {
            actions.push(
                <DropdownItem key="stop"
                          onClick={() => stopQuadletContainer()}>
                    {_("Stop")}
                </DropdownItem>,
                <DropdownItem key="restart"
                          onClick={() => restartQuadletContainer()}>
                    {_("Restart")}
                </DropdownItem>,
            );
        } else if (!isSystemdService) {
            actions.push(
                <DropdownItem key="stop"
                          onClick={() => stopContainer()}>
                    {_("Stop")}
                </DropdownItem>,
                <DropdownItem key="force-stop"
                          onClick={() => stopContainer(true)}>
                    {_("Force stop")}
                </DropdownItem>,
                <DropdownItem key="restart"
                          onClick={() => restartContainer()}>
                    {_("Restart")}
                </DropdownItem>,
                <DropdownItem key="force-restart"
                          onClick={() => restartContainer(true)}>
                    {_("Force restart")}
                </DropdownItem>
            );

            if (!isPaused) {
                actions.push(
                    <DropdownItem key="pause"
                          onClick={() => pauseContainer()}>
                        {_("Pause")}
                    </DropdownItem>
                );
            } else {
                actions.push(
                    <DropdownItem key="resume"
                          onClick={() => resumeContainer()}>
                        {_("Resume")}
                    </DropdownItem>
                );
            }
        }

        if (container.uid == 0 && !isPaused && !isSystemdService) {
            if (actions.length > 0)
                actions.push(<Divider key="separator-0" />);

            actions.push(
                <DropdownItem key="checkpoint"
                              onClick={() => checkpointContainer()}>
                    {_("Checkpoint")}
                </DropdownItem>
            );
        }
    }

    if (!isRunning && !isPaused) {
        actions.push(
            <DropdownItem key="start"
                          onClick={() => startContainer()}>
                {_("Start")}
            </DropdownItem>
        );
        if (!isSystemdService) {
            addRenameAction();
        }
        if (container.uid == 0 && container.State?.CheckpointPath) {
            actions.push(
                <Divider key="separator-0" />,
                <DropdownItem key="restore"
                              onClick={() => restoreContainer()}>
                    {_("Restore")}
                </DropdownItem>
            );
        }
    } else { // running or paused
        if (!isSystemdService) {
            addRenameAction();
        }
    }

    if (!isSystemdService) {
        actions.push(<Divider key="separator-1" />);
        actions.push(
            <DropdownItem key="commit"
                          onClick={() => commitContainer()}>
                {_("Commit")}
            </DropdownItem>
        );

        actions.push(<Divider key="separator-2" />);
        actions.push(
            <DropdownItem key="delete"
                      className="pf-m-danger"
                      onClick={deleteContainer}>
                {_("Delete")}
            </DropdownItem>
        );
    }

    return <KebabDropdown position="right" dropdownItems={actions} isDisabled={isDownloading || actions.length === 0} />;
};

export let onDownloadContainer = function funcOnDownloadContainer(container) {
    this.setState(prevState => ({
        downloadingContainers: [...prevState.downloadingContainers, container]
    }));
};

export let onDownloadContainerFinished = function funcOnDownloadContainerFinished(container) {
    this.setState(prevState => ({
        downloadingContainers: prevState.downloadingContainers.filter(entry => entry.name !== container.name),
    }));
};

const localize_health = (state) => {
    if (state === "healthy")
        return _("Healthy");
    else if (state === "unhealthy")
        return _("Unhealthy");
    else if (state === "starting")
        return _("Checking health");
    else
        console.error("Unexpected health check status", state);
    return null;
};

const ContainerOverActions = ({ handlePruneUnusedContainers, unusedContainers }) => {
    const actions = [
        <DropdownItem key="prune-unused-containers"
                            id="prune-unused-containers-button"
                            component="button"
                            className="pf-m-danger btn-delete"
                            onClick={() => handlePruneUnusedContainers()}
                            isDisabled={unusedContainers.length === 0}>
            {_("Prune unused containers")}
        </DropdownItem>,
    ];

    return <KebabDropdown toggleButtonId="containers-actions-dropdown" position="right" dropdownItems={actions} />;
};

const ContainerTerminalWrapper = ({ webglAvailable, child, service_button = false, ...props }) => {
    const ChildComponent = child;
    const { systemd_unit, uid } = props;

    return (
        <>
            {webglAvailable
                ? <ChildComponent {...props} />
                : <EmptyStatePanel title={_("Terminal not available")} paragraph={_("This browser does not support WebGL2.")} />}

            {service_button && uid === 0 && systemd_unit &&
                <Button variant="link" isInline className="pf-v6-u-mt-sm" onClick={
                    () => cockpit.jump(`/system/logs/#/?priority=info&_SYSTEMD_UNIT=${systemd_unit}`)}>
                    {cockpit.format(_("View $0 logs"), systemd_unit)}
                </Button>}
        </>
    );
};

class Containers extends React.Component {
    static contextType = DialogsContext;

    constructor(props) {
        super(props);
        this.state = {
            width: 0,
            memTotal: 0,
            downloadingContainers: [],
            showPruneUnusedContainersModal: false,
        };
        this.renderRow = this.renderRow.bind(this);
        this.onWindowResize = this.onWindowResize.bind(this);
        this.filterContainers = this.filterContainers.bind(this);

        this.cardRef = React.createRef();

        // Check if WebGL2 is available
        // Only checking if WebGL2RenderingContext is defined is not sufficient, in Firefox tests it is defined
        // as WebGL is enabled but it is not available in headless mode.
        this.webglAvailable = !!document.createElement("canvas").getContext("webgl2");

        onDownloadContainer = onDownloadContainer.bind(this);
        onDownloadContainerFinished = onDownloadContainerFinished.bind(this);

        machine_info.cpu_ram_info()
                .then(info => this.setState({ memTotal: info.memory }));

        window.addEventListener('resize', this.onWindowResize);
    }

    componentDidMount() {
        this.onWindowResize();
    }

    componentWillUnmount() {
        window.removeEventListener('resize', this.onWindowResize);
    }

    createPod() {
        const Dialogs = this.context;
        Dialogs.show(<PodCreateModal
            users={this.props.users}
            onAddNotification={this.props.onAddNotification} />);
    }

    createContainer(nonIntermediateImages, inPod) {
        const Dialogs = this.context;
        if (nonIntermediateImages)
            Dialogs.show(
                <utils.PodmanInfoContext.Consumer>
                    {(podmanInfo) => (
                        <DialogsContext.Consumer>
                            {(Dialogs) => (
                                <ImageRunModal users={this.props.users}
                                               localImages={nonIntermediateImages}
                                               pod={inPod}
                                               onAddNotification={this.props.onAddNotification}
                                               podmanInfo={podmanInfo}
                                               dialogs={Dialogs} />
                            )}
                        </DialogsContext.Consumer>
                    )}
                </utils.PodmanInfoContext.Consumer>);
    }

    renderRow(containersStats, container, localImages, podLookup) {
        const containerStats = containersStats[container.key];
        const image = container.ImageName;
        const isToolboxContainer = container.Config?.Labels?.["com.github.containers.toolbox"] === "true";
        const isDistroboxContainer = container.Config?.Labels?.manager === "distrobox";
        const isSystemdService = utils.is_systemd_service(container.Config);
        let localized_health = null;

        // this needs to get along with stub containers from image run dialog, where most properties don't exist yet
        // HACK: Podman renamed `Healthcheck` to `Health` randomly
        // https://github.com/containers/podman/commit/119973375
        const healthcheck = container.State?.Health?.Status ?? container.State?.Healthcheck?.Status; // not-covered: only on old version
        const status = container.State?.Status ?? ""; // not-covered: race condition

        let proc = "";
        let mem = "";
        if (this.props.cgroupVersion == 'v1' && container.uid !== 0 && status == 'running') { // not-covered: only on old version
            proc = <div><abbr title={_("not available")}>{_("n/a")}</abbr></div>;
            mem = <div><abbr title={_("not available")}>{_("n/a")}</abbr></div>;
        }
        if (containerStats && status === "running") {
            // container.HostConfig.Memory (0 by default), containerStats.MemUsage
            if (containerStats.CPU != undefined)
                proc = <div className="ct-numeric-column">{`${containerStats.CPU.toFixed(2)}%`}</div>;
            if (Number.isInteger(containerStats.MemUsage) && this.state.memTotal) {
                // the primary view is how much of the host's memory a container uses, for comparability
                const mem_pct = Math.round(containerStats.MemUsage / this.state.memTotal * 100);
                const mem_items = [
                    <span key="pct">{cockpit.format("$0%", mem_pct)}</span>,
                    <small key="abs">{cockpit.format_bytes(containerStats.MemUsage)}</small>
                ];

                // is there a configured limit?
                if (container.HostConfig?.Memory) {
                    const limit_pct = Math.round(containerStats.MemUsage / container.HostConfig.Memory * 100);
                    mem_items.push(
                        <small key="limit">
                            { cockpit.format(
                                _("$0% of $1 limit"),
                                limit_pct,
                                cockpit.format_bytes(container.HostConfig.Memory)) }
                        </small>
                    );
                }

                mem = <div className="container-block ct-numeric-column">{mem_items}</div>;
            }
        }
        const info_block = (
            <div className="container-block">
                <Flex alignItems={{ default: 'alignItemsCenter' }}>
                    <span className="container-name">{container.Name}</span>
                    {isToolboxContainer && <Badge className='ct-badge-toolbox'>toolbox</Badge>}
                    {isDistroboxContainer && <Badge className='ct-badge-distrobox'>distrobox</Badge>}
                    {isSystemdService && <Badge className='ct-badge-service'>{_("service")}</Badge>}
                </Flex>
                <small>{image}</small>
                <small>{utils.quote_cmdline(container.Config?.Cmd)}</small>
            </div>
        );

        let containerStateClass = `ct-badge-container-${status.toLowerCase()}`;
        if (container.isDownloading)
            containerStateClass += " downloading";

        const containerState = status.charAt(0).toUpperCase() + status.slice(1);

        const state = [<Badge key={containerState} isRead className={containerStateClass}>{_(containerState)}</Badge>]; // States are defined in util.js
        if (healthcheck) {
            localized_health = localize_health(healthcheck);
            if (localized_health)
                state.push(<Badge key={healthcheck} isRead className={`ct-badge-container-${healthcheck}`}>{localized_health}</Badge>);
        }

        const user = this.props.users.find(user => user.uid === container.uid);
        cockpit.assert(user, `User not found for container uid ${container.uid}`);

        let podCell = <span className="ct-grey-text">{_("none")}</span>;
        let podName = "";
        if (container.Pod) {
            const pod = podLookup?.[utils.makeKey(container.uid, container.Pod)];
            if (pod) {
                podName = pod.Name;
                podCell = (
                    <Button variant="link" isInline className="container-pod-link"
                            onClick={() => document.getElementById(`podman-pod-${pod.Id.slice(0, 12)}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
                        {pod.Name}
                    </Button>
                );
            }
        }

        const columns = [
            { title: info_block, sortKey: container.Name ?? container.Id },
            { title: podCell, props: { modifier: "nowrap" }, sortKey: podName },
            {
                title: (container.uid === 0) ? _("system") : <div><span className="ct-grey-text">{_("user:")} </span>{user.name}</div>,
                props: { modifier: "nowrap" },
                sortKey: container.key,
            },
            { title: proc, props: { modifier: "nowrap" }, sortKey: containerState === "Running" ? containerStats?.CPU ?? -1 : -1 },
            { title: mem, props: { modifier: "nowrap" }, sortKey: containerStats?.MemUsage ?? -1 },
            { title: <LabelGroup isVertical>{state}</LabelGroup>, sortKey: containerState },
        ];

        columns.push({
            title: <ContainerActions con={user.con}
                                     container={container}
                                     onAddNotification={this.props.onAddNotification}
                                     localImages={localImages}
                                     updateContainer={this.props.updateContainer}
                                     isSystemdService={isSystemdService}
                                     isDownloading={container.isDownloading} />,
            props: { className: "pf-v6-c-table__action" }
        });

        const tty = !!container.Config?.Tty;

        const tabs = [];
        if (container.State && user.con !== null) {
            tabs.push({
                name: _("Details"),
                renderer: ContainerDetails,
                data: { container }
            });

            if (!container.isDownloading) {
                tabs.push({
                    name: _("Integration"),
                    renderer: ContainerIntegration,
                    data: { container, localImages }
                });
                tabs.push({
                    name: _("Logs"),
                    renderer: ContainerTerminalWrapper,
                    data: {
                        containerId: container.Id,
                        containerStatus: container.State.Status,
                        width: this.state.width,
                        uid: container.uid,
                        systemd_unit: container.Config?.Labels?.PODMAN_SYSTEMD_UNIT,
                        webglAvailable: this.webglAvailable,
                        child: ContainerLogs,
                        service_button: true,
                    }
                });
                tabs.push({
                    name: _("Console"),
                    renderer: ContainerTerminalWrapper,
                    data: {
                        con: user.con,
                        containerId: container.Id,
                        containerStatus: container.State.Status,
                        width: this.state.width,
                        uid: container.uid,
                        tty,
                        webglAvailable: this.webglAvailable,
                        child: ContainerTerminal,
                    }
                });
            }
        }

        if (healthcheck) {
            tabs.push({
                name: _("Health check"),
                renderer: ContainerHealthLogs,
                data: { con: user.con, container, onAddNotification: this.props.onAddNotification, state: localized_health }
            });
        }

        return {
            expandedContent: <ListingPanel colSpan='4' tabRenderers={tabs} />,
            columns,
            initiallyExpanded: document.location.hash.substring(2) === container.Id,
            props: {
                key: container.key,
                "data-row-id": container.key,
                "data-started-at": container.State?.StartedAt,
                "data-row-name": `${container.uid === null ? 'user' : container.uid}-${container.Name}`
            },
        };
    }

    onWindowResize() {
        this.setState({ width: this.cardRef.current.clientWidth });
    }

    onOpenPruneUnusedContainersDialog = () => {
        this.setState({ showPruneUnusedContainersModal: true });
    };

    filterContainers = (containers) => {
        let filtered = [];
        filtered = Object.keys(containers).filter(id => !(this.props.filter == "running") || ["running", "restarting"].includes(this.props.containers[id]?.State?.Status));

        const filter_by_text = (lcf, id) => {
            const container = containers[id];
            const systemd_unit_match = container.Config?.Labels?.PODMAN_SYSTEMD_UNIT?.toLowerCase().indexOf(lcf) >= 0;
            const name_match = container.Name.toLowerCase().indexOf(lcf) >= 0;
            const image_match = container.ImageName.toLowerCase().indexOf(lcf) >= 0;

            if (container.Pod) {
                const podKey = utils.makeKey(container.uid, container.Pod);
                const pod = this.props.pods[podKey] || this.props.quadletPods[podKey];
                const pod_match = pod.Name.toLowerCase().indexOf(lcf) >= 0 || pod.Labels?.PODMAN_SYSTEMD_UNIT?.toLowerCase().indexOf(lcf) >= 0;
                return name_match || systemd_unit_match || image_match || pod_match;
            } else {
                return name_match || systemd_unit_match || image_match;
            }
        };

        if (this.props.ownerFilter !== "all") {
            filtered = filtered.filter(id => {
                if (this.props.ownerFilter === "user")
                    return containers[id].uid === null;
                return containers[id].uid === this.props.ownerFilter;
            });
        }

        if (this.props.textFilter.length > 0) {
            const lcf = this.props.textFilter.toLowerCase();
            filtered = filtered.filter(id => filter_by_text(lcf, id));
        }

        // Remove infra and service containers
        filtered = filtered.filter(id => !containers[id].IsInfra && !containers[id].IsService);

        const getHealth = id => {
            const state = containers[id]?.State;
            return state?.Health?.Status || state?.Healthcheck?.Status;
        };

        filtered.sort((a, b) => {
            // Show unhealthy containers first
            const a_health = getHealth(a);
            const b_health = getHealth(b);
            if (a_health !== b_health) {
                if (a_health === "unhealthy")
                    return -1;
                if (b_health === "unhealthy")
                    return 1;
            }
            // User containers are in front of system ones
            if (containers[a].uid !== containers[b].uid)
                return (containers[a].uid === 0) ? 1 : -1;
            return containers[a].Name > containers[b].Name ? 1 : -1;
        });

        return filtered;
    };

    render() {
        const columnTitles = [
            { title: _("Container"), transforms: [cellWidth(20)], sortable: true },
            { title: _("Pod"), sortable: true },
            { title: _("Owner"), sortable: true },
            { title: _("CPU"), sortable: true, props: { className: 'ct-numeric-column' } },
            { title: _("Memory"), sortable: true, props: { className: 'ct-numeric-column' } },
            { title: _("State"), sortable: true },
            { title: "", sortable: false, props: { screenReaderText: _("Actions") } },
        ];
        const listContainers = [];
        const unusedContainers = [];
        const isLoaded = this.props.containers !== null && this.props.pods !== null && this.props.quadletContainers !== null && this.props.quadletPods !== null;
        // pod key (podman ID or quadlet unit name) → pod, for the "Pod" column
        const podLookup = {};

        let emptyCaption = _("No containers");
        if (!isLoaded)
            emptyCaption = _("Loading...");
        else if (this.props.textFilter.length > 0)
            emptyCaption = _("No containers that match the current filter");
        else if (this.props.filter == "running")
            emptyCaption = _("No running containers");

        if (isLoaded) {
            Object.values(this.props.pods).forEach(pod => {
                podLookup[pod.key] = pod;
                const service_name = pod?.Labels?.PODMAN_SYSTEMD_UNIT;
                if (service_name)
                    podLookup[utils.makeKey(pod.uid, service_name)] = pod;
            });
            Object.values(this.props.quadletPods).forEach(pod => {
                if (!(pod.key in podLookup))
                    podLookup[pod.key] = pod;
            });

            // Set of running quadlets ($id-$name.service)
            const running_quadlets = new Set();
            this.filterContainers(this.props.containers).forEach(id => {
                const container = this.props.containers[id];
                if (container) {
                    listContainers.push(container);
                    const service_name = container?.Config?.Labels?.PODMAN_SYSTEMD_UNIT;
                    if (service_name)
                        running_quadlets.add(utils.makeKey(container.uid, service_name));
                }
            });

            // Inactive quadlets; active ones already have a running container
            this.filterContainers(this.props.quadletContainers).forEach(id => {
                if (!running_quadlets.has(id))
                    listContainers.push(this.props.quadletContainers[id]);
            });

            // Append downloading containers
            this.state.downloadingContainers.forEach(cont => listContainers.push(cont));

            const prune_states = ["created", "configured", "stopped", "exited"];
            for (const containerid of Object.keys(this.props.containers)) {
                const container = this.props.containers[containerid];
                // Ignore pods and running containers
                if (!prune_states.includes(container?.State?.Status) || container.Pod)
                    continue;

                unusedContainers.push({
                    id: container.Id,
                    name: container.Name,
                    key: container.key,
                    created: container.Created,
                    uid: container.uid,
                });
            }
        }

        // Convert to the search result output
        let localImages = null;
        let nonIntermediateImages = null;
        if (this.props.images) {
            localImages = Object.keys(this.props.images).map(id => {
                const img = this.props.images[id];
                img.Index = img.RepoTags?.[0] ? img.RepoTags[0].split('/')[0] : "";
                img.Name = utils.image_name(img);
                img.toString = function imgToString() { return this.Name };
                return img;
            }, []);
            nonIntermediateImages = localImages.filter(img => img.Index !== "");
        }

        const filterRunning = (
            <Toolbar>
                <ToolbarContent className="containers-containers-toolbarcontent">
                    <ToolbarItem alignSelf="center" variant="label" htmlFor="containers-containers-filter">
                        {_("Show")}
                    </ToolbarItem>
                    <ToolbarItem>
                        <FormSelect id="containers-containers-filter" value={this.props.filter} onChange={(_, value) => this.props.handleFilterChange(value)}>
                            <FormSelectOption value='all' label={_("All")} />
                            <FormSelectOption value='running' label={_("Only running")} />
                        </FormSelect>
                    </ToolbarItem>
                    <Divider orientation={{ default: "vertical" }} />
                    <ToolbarItem>
                        <Button variant="secondary" key="create-new-pod-action"
                                id="containers-containers-create-pod-btn"
                                onClick={() => this.createPod()}>
                            {_("Create pod")}
                        </Button>
                    </ToolbarItem>
                    <ToolbarItem>
                        <Button variant="primary" key="get-new-image-action"
                                id="containers-containers-create-container-btn"
                                isDisabled={nonIntermediateImages === null}
                                onClick={() => this.createContainer(nonIntermediateImages, null)}>
                            {_("Create container")}
                        </Button>
                    </ToolbarItem>
                    <ToolbarItem>
                        <ContainerOverActions unusedContainers={unusedContainers} handlePruneUnusedContainers={this.onOpenPruneUnusedContainersDialog} />
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>
        );

        const sortRows = (rows, direction, idx) => {
            // CPU / Memory / State
            const isNumeric = idx == 3 || idx == 4 || idx == 5;
            const stateOrderMapping = {};
            utils.states.forEach((elem, index) => {
                stateOrderMapping[elem] = index;
            });
            const sortedRows = rows.sort((a, b) => {
                let aitem = a.columns[idx].sortKey ?? a.columns[idx].title;
                let bitem = b.columns[idx].sortKey ?? b.columns[idx].title;
                // Sort the states based on the order defined in utils. so Running first.
                if (idx === 5) {
                    aitem = stateOrderMapping[aitem];
                    bitem = stateOrderMapping[bitem];
                }
                if (isNumeric) {
                    return bitem - aitem;
                } else {
                    return aitem.localeCompare(bitem);
                }
            });
            return direction === SortByDirection.asc ? sortedRows : sortedRows.reverse();
        };

        const card = (
            <Card ref={this.cardRef} id="containers-containers" className="containers-containers">
                <CardHeader actions={{ actions: filterRunning }}>
                    <CardTitle><Content component={ContentVariants.h1}>{_("Containers")}</Content></CardTitle>
                </CardHeader>
                <CardBody>
                    <ListingTable variant='compact'
                                  aria-label={_("Containers")}
                                  emptyCaption={emptyCaption}
                                  columns={columnTitles}
                                  sortMethod={sortRows}
                                  rows={isLoaded
                                      ? listContainers.map(container => this.renderRow(this.props.containersStats, container, localImages, podLookup))
                                      : []}
                                  sortBy={{ index: 0, direction: SortByDirection.asc }} />
                    {this.state.showPruneUnusedContainersModal &&
                    <PruneUnusedContainersModal
                      close={() => this.setState({ showPruneUnusedContainersModal: false })}
                      unusedContainers={unusedContainers}
                      onAddNotification={this.props.onAddNotification}
                      users={this.props.users} /> }
                </CardBody>
            </Card>
        );

        return card;
    }
}

export default Containers;
