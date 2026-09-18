/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Deploy a compose project: paste YAML or pick an existing compose file, validate it, pull the
 * images and bring the stack up with podman-compose, watching the command output live. */
import React, { useEffect, useState } from 'react';

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form";
import { Label, LabelGroup } from "@patternfly/react-core/dist/esm/components/Label";
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal';
import { ProgressStep, ProgressStepper } from "@patternfly/react-core/dist/esm/components/ProgressStepper";
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack";
import { CheckCircleIcon, ExclamationTriangleIcon } from '@patternfly/react-icons';
import { FileAutoComplete } from 'cockpit-components-file-autocomplete.jsx';
import { FormHelper } from 'cockpit-components-form-helper.jsx';
import { useDialogs } from "dialogs.jsx";
import { load as loadYaml } from 'js-yaml';

import cockpit from 'cockpit';

import { composeProcess } from './compose.ts';
import type { Uid } from './rest.js';
import { makeKey } from './util.js';

import './ComposeDeployModal.scss';

const _ = cockpit.gettext;

interface User {
    con: unknown;
    uid: Uid;
    name: string;
}

interface Container {
    key: string;
    uid: Uid;
    Name: string;
    State?: { Status?: string };
    HostConfig?: { PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null };
}

export interface ComposeDeployModalProps {
    users: User[];
    containers: Record<string, Container> | null;
    onAddNotification: (n: { type: string; error: string; errorDetail?: string }) => void;
}

interface Service {
    name: string;
    image: string | null;
    build: boolean;
    hostPorts: number[];
}

interface Validation {
    services: Service[];
    portConflicts: { port: number; container: string }[];
    normalized: string;
}

type StepState = "pending" | "running" | "done" | "failed";

interface Step {
    id: string;
    label: string;
    state: StepState;
}

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/* host ports published by a compose `ports:` entry; short syntax "[ip:]host:container[/proto]" or long syntax */
function publishedPorts(entry: unknown): number[] {
    if (typeof entry === "number")
        return [];
    if (typeof entry === "string") {
        const parts = entry.split("/")[0].split(":");
        if (parts.length < 2)
            return [];
        const host = parts[parts.length - 2];
        const range = host.split("-").map(Number);
        if (range.some(Number.isNaN))
            return [];
        if (range.length === 2 && range[1] >= range[0] && range[1] - range[0] < 1024) {
            const ports = [];
            for (let p = range[0]; p <= range[1]; p++)
                ports.push(p);
            return ports;
        }
        return [range[0]];
    }
    if (entry && typeof entry === "object") {
        const published = (entry as { published?: unknown }).published;
        const n = Number(published);
        return published !== undefined && !Number.isNaN(n) ? [n] : [];
    }
    return [];
}

/* Structural checks that podman-compose itself does not make: every service needs an image or a build. */
function inspectCompose(text: string): { services: Service[]; error?: string } {
    let doc: unknown;
    try {
        doc = loadYaml(text);
    } catch (ex) {
        return { services: [], error: cockpit.format(_("Not valid YAML: $0"), (ex as { message?: string }).message ?? String(ex)) };
    }
    if (!doc || typeof doc !== "object")
        return { services: [], error: _("The file does not contain a compose document.") };
    const services = (doc as { services?: unknown }).services;
    if (!services || typeof services !== "object" || Object.keys(services).length === 0)
        return { services: [], error: _("The compose file defines no services.") };

    const result: Service[] = [];
    for (const [name, spec] of Object.entries(services as Record<string, unknown>)) {
        const s = (spec && typeof spec === "object") ? spec as { image?: unknown; build?: unknown; ports?: unknown[] } : {};
        const image = typeof s.image === "string" ? s.image : null;
        const build = s.build !== undefined && s.build !== null;
        if (!image && !build)
            return { services: [], error: cockpit.format(_("Service \"$0\" has neither an image nor a build section."), name) };
        result.push({ name, image, build, hostPorts: (Array.isArray(s.ports) ? s.ports : []).flatMap(publishedPorts) });
    }
    return { services: result };
}

/* host ports currently bound by running containers, port → container name */
function boundPorts(containers: Record<string, Container> | null, uid: Uid): Record<number, string> {
    const result: Record<number, string> = {};
    for (const c of Object.values(containers ?? {})) {
        if (c.uid !== uid || c.State?.Status !== "running")
            continue;
        for (const bindings of Object.values(c.HostConfig?.PortBindings ?? {})) {
            for (const b of bindings ?? []) {
                const port = Number(b.HostPort);
                if (port)
                    result[port] = c.Name;
            }
        }
    }
    return result;
}

const stepVariant = (state: StepState) => {
    switch (state) {
    case "done": return "success";
    case "failed": return "danger";
    case "running": return "info";
    default: return "pending";
    }
};

export const ComposeDeployModal = ({ users, containers, onAddNotification }: ComposeDeployModalProps) => {
    const Dialogs = useDialogs();
    // podman-compose can only run as the session user or, with privileges, as root
    const owners = users.filter(u => u.con && (u.uid === null || u.uid === 0));
    const [owner, setOwner] = useState<User>(owners.find(u => u.uid === null) ?? owners[0]);
    const [source, setSource] = useState<"paste" | "file">("paste");
    const [text, setText] = useState("");
    const [filePath, setFilePath] = useState("");
    const [project, setProject] = useState("");
    const [directory, setDirectory] = useState("");
    const [directoryTouched, setDirectoryTouched] = useState(false);
    const [home, setHome] = useState("");
    const [validation, setValidation] = useState<Validation | null>(null);
    const [validationError, setValidationError] = useState<string | null>(null);
    const [validating, setValidating] = useState(false);
    const [steps, setSteps] = useState<Step[]>([]);
    const [output, setOutput] = useState("");
    const [deployError, setDeployError] = useState<string | null>(null);
    const [deploying, setDeploying] = useState(false);

    useEffect(() => {
        cockpit.user().then(u => setHome(u.home))
                .catch(() => setHome(""));
    }, []);

    const ownerHome = owner?.uid === 0 ? "/root" : (home || "~");
    // the project directory follows the project name until the user edits it
    useEffect(() => {
        if (!directoryTouched)
            setDirectory(project ? `${ownerHome}/containers/${project}` : "");
    }, [project, ownerHome, directoryTouched]);

    // an existing file takes its project name from its directory, as compose does
    const onFileChange = (value: string) => {
        setFilePath(value);
        setValidation(null);
        const dir = value.replace(/\/[^/]*$/, "");
        const base = dir.split("/").filter(Boolean)
                .pop() ?? "";
        if (!project && PROJECT_NAME_RE.test(base))
            setProject(base);
    };

    const invalidate = () => {
        setValidation(null);
        setValidationError(null);
    };

    const composeFile = source === "file" ? filePath : `${directory}/compose.yaml`;
    const workingDir = source === "file" ? filePath.replace(/\/[^/]*$/, "") || "/" : directory;
    const projectError = project && !PROJECT_NAME_RE.test(project) ? _("Use lowercase letters, digits, hyphens and underscores.") : null;
    const canValidate = !!project && !projectError && (source === "paste" ? !!text.trim() && !!directory : !!filePath);

    const validate = async () => {
        setValidating(true);
        setValidationError(null);
        setValidation(null);
        try {
            let content = text;
            if (source === "file")
                content = await cockpit.file(filePath, { superuser: owner.uid === 0 ? "require" : undefined }).read() ?? "";
            const inspected = inspectCompose(content);
            if (inspected.error)
                throw new Error(inspected.error);

            // podman-compose's own view of it, mostly to catch what it cannot parse
            let normalized: string;
            if (source === "file") {
                normalized = await composeProcess(owner.uid, { workingDir, configFiles: [filePath], project }, ["config"]);
            } else {
                normalized = await composeProcess(owner.uid, { workingDir: "/", configFiles: ["/dev/stdin"], project }, ["config"])
                        .input(content, false);
            }

            const bound = boundPorts(containers, owner.uid);
            const portConflicts = inspected.services
                    .flatMap(s => s.hostPorts)
                    .filter((port, i, all) => all.indexOf(port) === i && bound[port])
                    .map(port => ({ port, container: bound[port] }));
            setValidation({ services: inspected.services, portConflicts, normalized });
        } catch (ex) {
            const err = ex as { problem?: string; message?: string };
            if (err.problem === "not-found")
                setValidationError(_("podman-compose is not installed. Install the podman-compose package and try again."));
            else
                setValidationError(err.message || String(ex));
        } finally {
            setValidating(false);
        }
    };

    const setStep = (id: string, state: StepState) =>
        setSteps(prev => prev.map(s => s.id === id ? { ...s, state } : s));

    const run = (id: string, args: string[]) => {
        setStep(id, "running");
        setOutput(prev => prev + `$ podman-compose -p ${project} -f ${composeFile} ${args.join(" ")}\n`);
        return composeProcess(owner.uid, { workingDir, configFiles: [composeFile], project }, args, "out")
                .stream(data => setOutput(prev => prev + data))
                .then(() => setStep(id, "done"))
                .catch(ex => {
                    setStep(id, "failed");
                    throw ex;
                });
    };

    const deploy = async () => {
        const plan: Step[] = [
            ...(source === "paste" ? [{ id: "write", label: _("Write compose file"), state: "pending" as const }] : []),
            { id: "pull", label: _("Pull images"), state: "pending" },
            { id: "up", label: _("Start stack"), state: "pending" },
        ];
        setSteps(plan);
        setOutput("");
        setDeployError(null);
        setDeploying(true);
        try {
            if (source === "paste") {
                setStep("write", "running");
                const superuser = owner.uid === 0 ? "require" : undefined;
                await cockpit.spawn(["mkdir", "-p", directory], { superuser, err: "message" });
                await cockpit.file(composeFile, { superuser }).replace(text);
                setOutput(prev => prev + cockpit.format(_("Wrote $0\n"), composeFile));
                setStep("write", "done");
            }
            await run("pull", ["pull"]);
            await run("up", ["up", "-d"]);
            onAddNotification({ type: "success", error: cockpit.format(_("Stack $0 deployed"), project) });
            Dialogs.close();
        } catch (ex) {
            setDeployError((ex as { message?: string }).message || String(ex));
        } finally {
            setDeploying(false);
        }
    };

    const busy = validating || deploying;

    return (
        <Modal isOpen position="top" variant="large" onClose={Dialogs.close} className="podman-compose-deploy">
            <ModalHeader title={_("Deploy compose stack")}
                         description={_("Runs the project with podman-compose. Its containers show up as a pod on this page.")} />
            <ModalBody>
                <Form isHorizontal onSubmit={e => e.preventDefault()}>
                    {owners.length > 1 &&
                        <FormGroup label={_("Owner")} isInline fieldId="compose-owner">
                            {owners.map(u => (
                                <Radio key={String(u.uid)} id={`compose-owner-${u.uid ?? "user"}`} name="compose-owner"
                                       label={u.uid === 0 ? _("System") : u.name}
                                       isChecked={owner === u}
                                       isDisabled={busy}
                                       onChange={() => { setOwner(u); invalidate() }} />
                            ))}
                        </FormGroup>}

                    <FormGroup label={_("Source")} isInline fieldId="compose-source">
                        <Radio id="compose-source-paste" name="compose-source" label={_("Paste compose YAML")}
                               isChecked={source === "paste"} isDisabled={busy}
                               onChange={() => { setSource("paste"); invalidate() }} />
                        <Radio id="compose-source-file" name="compose-source" label={_("Existing file on this host")}
                               isChecked={source === "file"} isDisabled={busy}
                               onChange={() => { setSource("file"); invalidate() }} />
                    </FormGroup>

                    {source === "paste"
                        ? (
                            <FormGroup label={_("Compose file")} fieldId="compose-text">
                                <TextArea id="compose-text" value={text} rows={12} resizeOrientation="vertical"
                                          className="podman-compose-text"
                                          placeholder={"services:\n  web:\n    image: docker.io/library/nginx:alpine\n    ports:\n      - \"8080:80\""}
                                          isDisabled={busy}
                                          onChange={(_ev, value) => { setText(value); invalidate() }} />
                            </FormGroup>
                        )
                        : (
                            <FormGroup label={_("Compose file")} fieldId="compose-file">
                                <FileAutoComplete id="compose-file"
                                                  placeholder={_("Path to compose.yaml")}
                                                  superuser={owner.uid === 0 ? "require" : undefined}
                                                  isOptionCreatable
                                                  onlyDirectories={false}
                                                  value={filePath}
                                                  onChange={onFileChange} />
                            </FormGroup>
                        )}

                    <FormGroup label={_("Project name")} fieldId="compose-project">
                        <TextInput id="compose-project" value={project} isDisabled={busy}
                                   validated={projectError ? "error" : "default"}
                                   onChange={(_ev, value) => { setProject(value); invalidate() }} />
                        <FormHelper fieldId="compose-project" helperTextInvalid={projectError}
                                    helperText={_("Names the pod and prefixes the containers, networks and volumes.")} />
                    </FormGroup>

                    {source === "paste" &&
                        <FormGroup label={_("Directory")} fieldId="compose-directory">
                            <TextInput id="compose-directory" value={directory} isDisabled={busy}
                                       onChange={(_ev, value) => { setDirectory(value); setDirectoryTouched(true); invalidate() }} />
                            <FormHelper fieldId="compose-directory"
                                        helperText={_("The YAML is saved there as compose.yaml, so the stack can be recreated and updated later.")} />
                        </FormGroup>}
                </Form>

                <Stack hasGutter className="podman-compose-status">
                    {validationError &&
                        <Alert variant="danger" isInline title={_("The compose file is not valid")}>
                            <pre className="podman-compose-error">{validationError}</pre>
                        </Alert>}

                    {validation &&
                        <Alert variant={validation.portConflicts.length ? "warning" : "success"} isInline
                               title={validation.portConflicts.length
                                   ? _("Valid, but some ports are already in use")
                                   : cockpit.format(cockpit.ngettext("Valid: $0 service", "Valid: $0 services", validation.services.length), validation.services.length)}>
                            <LabelGroup numLabels={12}>
                                {validation.services.map(s => (
                                    <Label key={s.name} icon={<CheckCircleIcon />} color="green" variant="outline">
                                        {s.name}
                                        <span className="ct-grey-text"> · {s.image ?? _("built from source")}</span>
                                    </Label>
                                ))}
                            </LabelGroup>
                            {validation.portConflicts.map(c => (
                                <div key={c.port} className="podman-compose-conflict">
                                    <ExclamationTriangleIcon /> {cockpit.format(_("Host port $0 is already used by container $1"), c.port, c.container)}
                                </div>
                            ))}
                        </Alert>}

                    {steps.length > 0 &&
                        <ProgressStepper isCompact aria-label={_("Deployment progress")}>
                            {steps.map(s => (
                                <ProgressStep key={s.id} id={`compose-step-${s.id}`} titleId={`compose-step-${s.id}-title`}
                                              variant={stepVariant(s.state)} isCurrent={s.state === "running"}>
                                    {s.label}
                                </ProgressStep>
                            ))}
                        </ProgressStepper>}

                    {deployError &&
                        <Alert variant="danger" isInline title={_("Deployment failed")}>
                            <pre className="podman-compose-error">{deployError}</pre>
                        </Alert>}

                    {output && <pre className="podman-compose-output">{output}</pre>}
                </Stack>
            </ModalBody>
            <ModalFooter>
                <Button variant="secondary" onClick={validate} isDisabled={!canValidate || busy} isLoading={validating}>
                    {_("Validate")}
                </Button>
                <Button variant="primary" onClick={deploy} isDisabled={!validation || busy} isLoading={deploying}>
                    {_("Pull and deploy")}
                </Button>
                <Button variant="link" onClick={Dialogs.close} isDisabled={deploying}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

export const composeStackKey = (uid: Uid, project: string) => makeKey(uid, `pod_${project}`);
