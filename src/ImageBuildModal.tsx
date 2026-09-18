/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Build an image from a Containerfile: either one written in the dialog, which is saved into a
 * build directory, or one that already exists on the host. The build output streams live. */
import React, { useEffect, useState } from 'react';

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form";
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal';
import { ProgressStep, ProgressStepper } from "@patternfly/react-core/dist/esm/components/ProgressStepper";
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack";
import { FileAutoComplete } from 'cockpit-components-file-autocomplete.jsx';
import { FormHelper } from 'cockpit-components-form-helper.jsx';
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';

import { reviewContainerfile } from './containerfile.ts';
import type { ContainerfileReview } from './containerfile.ts';
import type { Uid } from './rest.js';

import './ComposeDeployModal.scss';

const _ = cockpit.gettext;

interface User {
    con: unknown;
    uid: Uid;
    name: string;
}

export interface ImageBuildModalProps {
    users: User[];
    onAddNotification: (n: { type: string; error: string; errorDetail?: string }) => void;
}

type StepState = "pending" | "running" | "done" | "failed";

interface Step {
    id: string;
    label: string;
    state: StepState;
}

// podman accepts "name[:tag]" with an optional registry/namespace path; keep tags and names simple
const IMAGE_NAME_RE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/;

const stepVariant = (state: StepState) => {
    switch (state) {
    case "done": return "success";
    case "failed": return "danger";
    case "running": return "info";
    default: return "pending";
    }
};

/* directory name derived from an image name: "quay.io/me/app:1.2" → "app-1.2" */
function buildDirName(image: string): string {
    const last = image.split("/").pop() ?? "";
    return last.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

export const ImageBuildModal = ({ users, onAddNotification }: ImageBuildModalProps) => {
    const Dialogs = useDialogs();
    // podman build runs as the session user or, with privileges, as root
    const owners = users.filter(u => u.con && (u.uid === null || u.uid === 0));
    const [owner, setOwner] = useState<User>(owners.find(u => u.uid === null) ?? owners[0]);
    const [source, setSource] = useState<"paste" | "directory">("paste");
    const [text, setText] = useState("");
    const [contextDir, setContextDir] = useState("");
    const [image, setImage] = useState("");
    const [directory, setDirectory] = useState("");
    const [directoryTouched, setDirectoryTouched] = useState(false);
    const [home, setHome] = useState("");
    const [pull, setPull] = useState(true);
    const [noCache, setNoCache] = useState(false);
    const [review, setReview] = useState<ContainerfileReview | null>(null);
    const [steps, setSteps] = useState<Step[]>([]);
    const [output, setOutput] = useState("");
    const [buildError, setBuildError] = useState<string | null>(null);
    const [building, setBuilding] = useState(false);

    useEffect(() => {
        cockpit.user().then(u => setHome(u.home))
                .catch(() => setHome(""));
    }, []);

    const ownerHome = owner?.uid === 0 ? "/root" : (home || "~");
    useEffect(() => {
        if (!directoryTouched)
            setDirectory(image ? `${ownerHome}/containers/builds/${buildDirName(image)}` : "");
    }, [image, ownerHome, directoryTouched]);

    const superuser = owner?.uid === 0 ? "require" as const : undefined;
    const imageError = image && !IMAGE_NAME_RE.test(image) ? _("Use lowercase letters, digits, dots, hyphens and slashes, with an optional :tag.") : null;
    const canReview = !!image && !imageError && (source === "paste" ? !!text.trim() && !!directory : !!contextDir);
    const busy = building;

    const invalidate = () => setReview(null);

    const doReview = async () => {
        try {
            let content = text;
            if (source === "directory") {
                const dir = contextDir.replace(/\/+$/, "");
                let found: string | null = null;
                for (const name of ["Containerfile", "Dockerfile"]) {
                    found = await cockpit.file(`${dir}/${name}`, { superuser }).read();
                    if (found !== null)
                        break;
                }
                if (found === null)
                    throw new Error(cockpit.format(_("$0 contains neither a Containerfile nor a Dockerfile."), dir));
                content = found;
            }
            setReview(reviewContainerfile(content));
        } catch (ex) {
            setReview({ error: (ex as { message?: string }).message || String(ex), baseImages: [], warnings: [] });
        }
    };

    const setStep = (id: string, state: StepState) =>
        setSteps(prev => prev.map(s => s.id === id ? { ...s, state } : s));

    const build = async () => {
        const plan: Step[] = [
            ...(source === "paste" ? [{ id: "write", label: _("Write Containerfile"), state: "pending" as const }] : []),
            { id: "build", label: _("Build image"), state: "pending" },
        ];
        setSteps(plan);
        setOutput("");
        setBuildError(null);
        setBuilding(true);
        try {
            let context = source === "paste" ? directory : contextDir.replace(/\/+$/, "") || "/";
            if (source === "paste") {
                setStep("write", "running");
                await cockpit.spawn(["mkdir", "-p", directory], { superuser, err: "message" });
                await cockpit.file(`${directory}/Containerfile`, { superuser }).replace(text.endsWith("\n") ? text : text + "\n");
                setOutput(prev => prev + cockpit.format(_("Wrote $0\n"), `${directory}/Containerfile`));
                setStep("write", "done");
                context = directory;
            }
            const args = ["podman", "build", "--tag", image, ...(pull ? ["--pull=newer"] : []), ...(noCache ? ["--no-cache"] : []), context];
            setStep("build", "running");
            setOutput(prev => prev + "$ " + args.join(" ") + "\n");
            await cockpit.spawn(args, { superuser, err: "out", environ: ["LC_ALL=C.UTF-8"], pty: false })
                    .stream(data => setOutput(prev => prev + data));
            setStep("build", "done");
            onAddNotification({ type: "success", error: cockpit.format(_("Image $0 built"), image) });
            Dialogs.close();
        } catch (ex) {
            setSteps(prev => prev.map(s => s.state === "running" ? { ...s, state: "failed" } : s));
            const err = ex as { message?: string; exit_status?: number };
            setBuildError(err.exit_status !== undefined
                ? cockpit.format(_("podman build exited with status $0"), err.exit_status)
                : (err.message || String(ex)));
        } finally {
            setBuilding(false);
        }
    };

    return (
        <Modal isOpen position="top" variant="large" onClose={Dialogs.close} className="podman-compose-deploy">
            <ModalHeader title={_("Build image")}
                         description={_("Runs podman build on this host. The new image shows up in the Images list when the build finishes.")} />
            <ModalBody>
                <Form isHorizontal onSubmit={e => e.preventDefault()}>
                    {owners.length > 1 &&
                        <FormGroup label={_("Owner")} isInline fieldId="build-owner">
                            {owners.map(u => (
                                <Radio key={String(u.uid)} id={`build-owner-${u.uid ?? "user"}`} name="build-owner"
                                       label={u.uid === 0 ? _("System") : u.name}
                                       isChecked={owner === u}
                                       isDisabled={busy}
                                       onChange={() => { setOwner(u); invalidate() }} />
                            ))}
                        </FormGroup>}

                    <FormGroup label={_("Image name")} fieldId="build-image" isRequired>
                        <TextInput id="build-image" value={image} isDisabled={busy} placeholder="myapp:latest"
                                   validated={imageError ? "error" : "default"}
                                   onChange={(_ev, value) => { setImage(value); invalidate() }} />
                        <FormHelper fieldId="build-image" helperTextInvalid={imageError}
                                    helperText={_("Without a registry the image is stored as localhost/<name>.")} />
                    </FormGroup>

                    <FormGroup label={_("Source")} isInline fieldId="build-source">
                        <Radio id="build-source-paste" name="build-source" label={_("Write a Containerfile")}
                               isChecked={source === "paste"} isDisabled={busy}
                               onChange={() => { setSource("paste"); invalidate() }} />
                        <Radio id="build-source-directory" name="build-source" label={_("Existing directory on this host")}
                               isChecked={source === "directory"} isDisabled={busy}
                               onChange={() => { setSource("directory"); invalidate() }} />
                    </FormGroup>

                    {source === "paste"
                        ? (
                            <>
                                <FormGroup label={_("Containerfile")} fieldId="build-text">
                                    <TextArea id="build-text" value={text} rows={12} resizeOrientation="vertical"
                                              className="podman-compose-text"
                                              placeholder={"FROM docker.io/library/alpine:3.20\nRUN apk add --no-cache python3\nUSER 1000\nCMD [\"python3\", \"-m\", \"http.server\", \"8000\"]"}
                                              isDisabled={busy}
                                              onChange={(_ev, value) => { setText(value); invalidate() }} />
                                </FormGroup>
                                <FormGroup label={_("Build directory")} fieldId="build-directory">
                                    <TextInput id="build-directory" value={directory} isDisabled={busy}
                                               onChange={(_ev, value) => { setDirectory(value); setDirectoryTouched(true); invalidate() }} />
                                    <FormHelper fieldId="build-directory"
                                                helperText={_("The Containerfile is saved there and the directory is the build context, so COPY and ADD can reference files you put next to it.")} />
                                </FormGroup>
                            </>
                        )
                        : (
                            <FormGroup label={_("Directory")} fieldId="build-context">
                                <FileAutoComplete id="build-context"
                                                  placeholder={_("Directory containing a Containerfile or Dockerfile")}
                                                  superuser={superuser}
                                                  isOptionCreatable
                                                  onlyDirectories
                                                  value={contextDir}
                                                  onChange={(value: string) => { setContextDir(value); invalidate() }} />
                            </FormGroup>
                        )}

                    <FormGroup label={_("Options")} fieldId="build-options" role="group">
                        <Checkbox id="build-pull" label={_("Pull newer base images")} isChecked={pull} isDisabled={busy}
                                  description={_("Check the registry for a newer version of every FROM image.")}
                                  onChange={(_ev, checked) => setPull(checked)} />
                        <Checkbox id="build-no-cache" label={_("Do not use cached layers")} isChecked={noCache} isDisabled={busy}
                                  onChange={(_ev, checked) => setNoCache(checked)} />
                    </FormGroup>
                </Form>

                <Stack hasGutter className="podman-compose-status">
                    {review?.error &&
                        <Alert variant="danger" isInline title={_("The Containerfile cannot be built")}>
                            <pre className="podman-compose-error">{review.error}</pre>
                        </Alert>}

                    {review && !review.error &&
                        <Alert variant={review.warnings.length ? "warning" : "success"} isInline
                               title={review.warnings.length
                                   ? cockpit.format(cockpit.ngettext("Ready to build, with $0 note", "Ready to build, with $0 notes", review.warnings.length), review.warnings.length)
                                   : _("Ready to build")}>
                            <div>{cockpit.format(_("Based on: $0"), review.baseImages.join(", "))}</div>
                            {review.warnings.map((w, i) => (
                                <div key={i} className="podman-compose-conflict">
                                    {w.line ? cockpit.format(_("Line $0: $1"), w.line, w.text) : w.text}
                                </div>
                            ))}
                        </Alert>}

                    {steps.length > 0 &&
                        <ProgressStepper isCompact aria-label={_("Build progress")}>
                            {steps.map(s => (
                                <ProgressStep key={s.id} id={`build-step-${s.id}`} titleId={`build-step-${s.id}-title`}
                                              variant={stepVariant(s.state)} isCurrent={s.state === "running"}>
                                    {s.label}
                                </ProgressStep>
                            ))}
                        </ProgressStepper>}

                    {buildError &&
                        <Alert variant="danger" isInline title={_("Build failed")}>
                            <pre className="podman-compose-error">{buildError}</pre>
                        </Alert>}

                    {output && <pre className="podman-compose-output">{output}</pre>}
                </Stack>
            </ModalBody>
            <ModalFooter>
                <Button variant="secondary" onClick={doReview} isDisabled={!canReview || busy}>
                    {_("Review")}
                </Button>
                <Button variant="primary" onClick={build} isDisabled={!review || !!review.error || busy} isLoading={building}>
                    {_("Build")}
                </Button>
                <Button variant="link" onClick={Dialogs.close} isDisabled={building}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
