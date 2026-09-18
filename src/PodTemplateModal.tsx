/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Create a pod from a template: pick one from the catalog, fill in the ports, values and
 * directories it asks for, and watch the pod being created. The filled-in form can be saved
 * as a template of its own. */
import React, { useEffect, useState } from 'react';

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { DataList, DataListCell, DataListItem, DataListItemCells, DataListItemRow } from "@patternfly/react-core/dist/esm/components/DataList";
import { Form, FormGroup, FormSection } from "@patternfly/react-core/dist/esm/components/Form";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect";
import { Label } from "@patternfly/react-core/dist/esm/components/Label";
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal';
import { ProgressStep, ProgressStepper } from "@patternfly/react-core/dist/esm/components/ProgressStepper";
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { Grid, GridItem } from "@patternfly/react-core/dist/esm/layouts/Grid";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack";
import { FileAutoComplete } from 'cockpit-components-file-autocomplete.jsx';
import { FormHelper } from 'cockpit-components-form-helper.jsx';
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';

import { ConfirmModal } from './ConfirmModal.tsx';
import type { Connection, Uid } from './rest.js';
import {
    BUILTIN_TEMPLATES, TEMPLATE_ID_RE, createFromTemplate, defaultValues, loadCustomTemplates, saveCustomTemplates,
    templateFromValues, validateValues,
} from './templates.ts';
import type { PodTemplate, TemplateValues } from './templates.ts';

import './ComposeDeployModal.scss';
import './PodTemplateModal.scss';

const _ = cockpit.gettext;

interface User {
    con: unknown;
    uid: Uid;
    name: string;
}

interface Pod {
    uid: Uid;
    Name: string;
}

export interface PodTemplateModalProps {
    users: User[];
    pods: Record<string, Pod> | null;
    onAddNotification: (n: { type: string; error: string; errorDetail?: string }) => void;
}

type StepState = "pending" | "running" | "done" | "failed";
type StepId = "pod" | "pull" | "container" | "start";

const STEP_LABELS: Record<StepId, string> = {
    pod: _("Create pod"),
    pull: _("Pull image"),
    container: _("Create container"),
    start: _("Start pod"),
};

const stepVariant = (state: StepState) => {
    switch (state) {
    case "done": return "success";
    case "failed": return "danger";
    case "running": return "info";
    default: return "pending";
    }
};

const MB = 1000 * 1000;

export const PodTemplateModal = ({ users, pods, onAddNotification }: PodTemplateModalProps) => {
    const Dialogs = useDialogs();
    const owners = users.filter(u => u.con);
    const [owner, setOwner] = useState<User>(owners.find(u => u.uid === null) ?? owners[0]);
    const [home, setHome] = useState("");
    const [custom, setCustom] = useState<PodTemplate[]>([]);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [template, setTemplate] = useState<PodTemplate>(BUILTIN_TEMPLATES[0]);
    const [values, setValues] = useState<TemplateValues>(() => defaultValues(BUILTIN_TEMPLATES[0]));
    const [error, setError] = useState<string | null>(null);
    const [steps, setSteps] = useState<Record<StepId, StepState> | null>(null);
    const [creating, setCreating] = useState(false);
    // "save as template" form
    const [saving, setSaving] = useState(false);
    const [saveId, setSaveId] = useState("");
    const [saveName, setSaveName] = useState("");
    const [saveDescription, setSaveDescription] = useState("");
    const [saveBusy, setSaveBusy] = useState(false);

    useEffect(() => {
        cockpit.user().then(u => {
            setHome(u.home);
            return loadCustomTemplates(u.home).then(setCustom);
        })
                .catch(ex => setLoadError((ex as { message?: string }).message || String(ex)));
    }, []);

    const templates = [...BUILTIN_TEMPLATES, ...custom];

    const choose = (t: PodTemplate) => {
        setTemplate(t);
        setValues(defaultValues(t));
        setError(null);
        setSteps(null);
        setSaving(false);
    };

    const update = (patch: Partial<TemplateValues>) => {
        setValues(prev => ({ ...prev, ...patch }));
        setError(null);
    };

    const podNameTaken = Object.values(pods ?? {}).some(p => p.uid === owner?.uid && p.Name === values.podName);
    const validation = validateValues(template, values) ?? (podNameTaken ? cockpit.format(_("A pod named $0 already exists."), values.podName) : null);
    const busy = creating || saveBusy;

    const create = async () => {
        if (!owner?.con || validation)
            return;
        setError(null);
        setCreating(true);
        setSteps({ pod: "pending", pull: "pending", container: "pending", start: "pending" });
        try {
            await createFromTemplate(owner.con as Connection, template, values, (step, state) =>
                setSteps(prev => prev ? { ...prev, [step]: state } : prev));
            onAddNotification({ type: "success", error: cockpit.format(_("Pod $0 created from template $1"), values.podName, template.name) });
            Dialogs.close();
        } catch (ex) {
            setSteps(prev => {
                if (!prev)
                    return prev;
                const next = { ...prev };
                for (const id of Object.keys(next) as StepId[]) {
                    if (next[id] === "running")
                        next[id] = "failed";
                }
                return next;
            });
            const err = ex as { message?: string; reason?: string };
            setError(err.message || err.reason || String(ex));
        } finally {
            setCreating(false);
        }
    };

    const startSaving = () => {
        setSaveId(template.builtin ? `${template.id}-custom` : template.id);
        setSaveName(template.builtin ? cockpit.format(_("$0 (custom)"), template.name) : template.name);
        setSaveDescription(template.description);
        setSaving(true);
    };

    const saveIdError = saveId && !TEMPLATE_ID_RE.test(saveId) ? _("Use lowercase letters, digits, hyphens and underscores.") : null;
    const saveIdBuiltin = BUILTIN_TEMPLATES.some(t => t.id === saveId);

    const save = async () => {
        setSaveBusy(true);
        setError(null);
        try {
            const saved = templateFromValues(template, values, saveId, saveName || saveId, saveDescription);
            const next = [...custom.filter(t => t.id !== saveId), saved];
            await saveCustomTemplates(home, next);
            setCustom(next);
            setSaving(false);
            choose(saved);
            onAddNotification({ type: "success", error: cockpit.format(_("Template $0 saved"), saved.name) });
        } catch (ex) {
            setError((ex as { message?: string }).message || String(ex));
        } finally {
            setSaveBusy(false);
        }
    };

    const remove = (t: PodTemplate) => {
        Dialogs.show(
            <ConfirmModal title={cockpit.format(_("Delete template $0?"), t.name)}
                          body={<p>{_("Pods created from it are not affected.")}</p>}
                          actionLabel={_("Delete")}
                          onConfirm={async () => {
                              const next = custom.filter(c => c.id !== t.id);
                              await saveCustomTemplates(home, next);
                              setCustom(next);
                              if (template.id === t.id)
                                  choose(BUILTIN_TEMPLATES[0]);
                          }} />
        );
    };

    const catalog = (
        <DataList aria-label={_("Templates")} isCompact selectedDataListItemId={template.id}
                  onSelectDataListItem={(_ev, id) => {
                      const t = templates.find(x => x.id === id);
                      if (t && !busy)
                          choose(t);
                  }}>
            {templates.map(t => (
                <DataListItem key={t.id} id={t.id} aria-labelledby={`template-${t.id}`}>
                    <DataListItemRow>
                        <DataListItemCells dataListCells={[
                            <DataListCell key="main">
                                <div className="podman-template-name" id={`template-${t.id}`}>
                                    {t.name}
                                    {!t.builtin && <> <Label isCompact color="blue">{_("Saved")}</Label></>}
                                </div>
                                <div className="podman-template-description ct-grey-text">{t.description}</div>
                                <div className="podman-template-image ct-grey-text">{t.image}</div>
                            </DataListCell>,
                        ]} />
                    </DataListItemRow>
                </DataListItem>
            ))}
        </DataList>
    );

    const form = (
        <Form isHorizontal onSubmit={e => e.preventDefault()} className="podman-template-form">
            {owners.length > 1 &&
                <FormGroup label={_("Owner")} isInline fieldId="template-owner">
                    {owners.map(u => (
                        <Radio key={String(u.uid)} id={`template-owner-${u.uid ?? "user"}`} name="template-owner"
                               label={u.uid === 0 ? _("System") : u.name}
                               isChecked={owner === u}
                               isDisabled={busy}
                               onChange={() => setOwner(u)} />
                    ))}
                </FormGroup>}

            <FormGroup label={_("Pod name")} fieldId="template-pod-name" isRequired>
                <TextInput id="template-pod-name" value={values.podName} isDisabled={busy}
                           validated={podNameTaken ? "error" : "default"}
                           onChange={(_ev, v) => update({ podName: v })} />
                <FormHelper fieldId="template-pod-name"
                            helperTextInvalid={podNameTaken ? _("A pod with this name already exists.") : null}
                            helperText={cockpit.format(_("The container is named $0."), `${values.podName || "<pod>"}-${template.id}`)} />
            </FormGroup>

            {template.ports.length > 0 &&
                <FormSection title={_("Ports")} titleElement="h3">
                    {template.ports.map(p => {
                        const host = values.hostPorts[p.container];
                        return (
                            <FormGroup key={p.container} label={cockpit.format(_("Container port $0"), `${p.container}${p.protocol === "udp" ? "/udp" : ""}`)}
                                       fieldId={`template-port-${p.container}`}>
                                <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                                    <FlexItem>
                                        <TextInput id={`template-port-${p.container}`} type="number" value={host ?? ""} isDisabled={busy}
                                                   placeholder={_("not published")} className="podman-template-port"
                                                   onChange={(_ev, v) => update({ hostPorts: { ...values.hostPorts, [p.container]: v === "" ? null : Number(v) } })} />
                                    </FlexItem>
                                    <FlexItem className="ct-grey-text">{_("host port")}</FlexItem>
                                </Flex>
                            </FormGroup>
                        );
                    })}
                </FormSection>}

            {template.env.length > 0 &&
                <FormSection title={_("Environment")} titleElement="h3">
                    {template.env.map(e => (
                        <FormGroup key={e.key} label={e.key} fieldId={`template-env-${e.key}`} isRequired={!!e.required}>
                            <TextInput id={`template-env-${e.key}`} type={e.secret ? "password" : "text"} value={values.env[e.key] ?? ""} isDisabled={busy}
                                       onChange={(_ev, v) => update({ env: { ...values.env, [e.key]: v } })} />
                            {e.description && <FormHelper fieldId={`template-env-${e.key}`} helperText={e.description} />}
                        </FormGroup>
                    ))}
                </FormSection>}

            {template.volumes.length > 0 &&
                <FormSection title={_("Storage")} titleElement="h3">
                    {template.volumes.map(v => (
                        <FormGroup key={v.container} label={v.container} fieldId={`template-volume-${v.container}`} isRequired={v.host !== undefined}>
                            {v.host !== undefined
                                ? (
                                    <>
                                        <FileAutoComplete id={`template-volume-${v.container}`}
                                                          placeholder={_("Host directory")}
                                                          superuser={owner?.uid === 0 ? "require" : undefined}
                                                          isOptionCreatable
                                                          onlyDirectories
                                                          value={values.hostPaths[v.container] ?? ""}
                                                          onChange={(path: string) => update({ hostPaths: { ...values.hostPaths, [v.container]: path } })} />
                                        <FormHelper fieldId={`template-volume-${v.container}`}
                                                    helperText={[v.description, v.readOnly ? _("mounted read-only") : null].filter(Boolean).join(" · ")} />
                                    </>
                                )
                                : (
                                    <>
                                        <TextInput id={`template-volume-${v.container}`} isDisabled readOnlyVariant="plain"
                                                   value={cockpit.format(_("named volume $0"), `${values.podName || "<pod>"}-${v.name ?? "data"}`)} />
                                        {v.description && <FormHelper fieldId={`template-volume-${v.container}`} helperText={v.description} />}
                                    </>
                                )}
                        </FormGroup>
                    ))}
                </FormSection>}

            <FormSection title={_("Limits")} titleElement="h3">
                <FormGroup label={_("Memory limit")} fieldId="template-memory">
                    <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                        <FlexItem>
                            <TextInput id="template-memory" type="number" className="podman-template-port" isDisabled={busy}
                                       value={values.memoryLimit ? Math.round(values.memoryLimit / MB) : ""}
                                       placeholder={_("unlimited")}
                                       onChange={(_ev, v) => update({ memoryLimit: v === "" ? null : Number(v) * MB })} />
                        </FlexItem>
                        <FlexItem className="ct-grey-text">MB</FlexItem>
                    </Flex>
                </FormGroup>
                <FormGroup label={_("Restart policy")} fieldId="template-restart">
                    <FormSelect id="template-restart" value={values.restartPolicy} isDisabled={busy}
                                onChange={(_ev, v) => update({ restartPolicy: v as TemplateValues["restartPolicy"] })}>
                        <FormSelectOption value="no" label={_("No")} />
                        <FormSelectOption value="on-failure" label={_("On failure")} />
                        <FormSelectOption value="always" label={_("Always")} />
                    </FormSelect>
                </FormGroup>
            </FormSection>

            {(template.command || template.healthcheck || template.notes) &&
                <FormSection title={_("Details")} titleElement="h3">
                    {template.command &&
                        <FormGroup label={_("Command")} fieldId="template-command">
                            <code id="template-command">{template.command.join(" ")}</code>
                        </FormGroup>}
                    {template.healthcheck &&
                        <FormGroup label={_("Health check")} fieldId="template-healthcheck">
                            <code id="template-healthcheck">{template.healthcheck.command.filter(w => w !== "CMD-SHELL" && w !== "CMD").join(" ")}</code>
                        </FormGroup>}
                    {template.notes &&
                        <FormGroup label={_("Notes")} fieldId="template-notes">
                            <span id="template-notes">{template.notes}</span>
                        </FormGroup>}
                </FormSection>}
        </Form>
    );

    const saveForm = saving && (
        <Alert variant="info" isInline title={_("Save the values above as a template")} className="podman-template-save">
            <Form isHorizontal onSubmit={e => e.preventDefault()}>
                <FormGroup label={_("ID")} fieldId="template-save-id" isRequired>
                    <TextInput id="template-save-id" value={saveId} validated={saveIdError || saveIdBuiltin ? "error" : "default"}
                               onChange={(_ev, v) => setSaveId(v)} />
                    <FormHelper fieldId="template-save-id" helperTextInvalid={saveIdError ?? (saveIdBuiltin ? _("This ID belongs to a built-in template.") : null)} />
                </FormGroup>
                <FormGroup label={_("Name")} fieldId="template-save-name">
                    <TextInput id="template-save-name" value={saveName} onChange={(_ev, v) => setSaveName(v)} />
                </FormGroup>
                <FormGroup label={_("Description")} fieldId="template-save-description">
                    <TextInput id="template-save-description" value={saveDescription} onChange={(_ev, v) => setSaveDescription(v)} />
                </FormGroup>
                <Flex spaceItems={{ default: "spaceItemsSm" }}>
                    <Button variant="primary" size="sm" onClick={save} isDisabled={!saveId || !!saveIdError || saveIdBuiltin || saveBusy} isLoading={saveBusy}>
                        {custom.some(t => t.id === saveId) ? _("Overwrite template") : _("Save template")}
                    </Button>
                    <Button variant="link" size="sm" onClick={() => setSaving(false)}>{_("Cancel")}</Button>
                </Flex>
                <span className="ct-grey-text">{_("Password values are not stored in the template.")}</span>
            </Form>
        </Alert>
    );

    return (
        <Modal isOpen position="top" variant="large" onClose={Dialogs.close} className="podman-template-modal">
            <ModalHeader title={_("Create pod from template")}
                         description={_("A template describes one service: its image, ports, settings and storage. Pick one and adjust what it asks for.")} />
            <ModalBody>
                {loadError &&
                    <Alert variant="warning" isInline title={_("Saved templates could not be read")}>{loadError}</Alert>}
                <Grid hasGutter>
                    <GridItem span={12} md={4}>
                        <Stack hasGutter>
                            {catalog}
                            {!template.builtin &&
                                <Button variant="link" isInline isDanger size="sm" onClick={() => remove(template)} isDisabled={busy}>
                                    {cockpit.format(_("Delete template $0"), template.name)}
                                </Button>}
                        </Stack>
                    </GridItem>
                    <GridItem span={12} md={8}>
                        <Stack hasGutter>
                            {form}
                            {saveForm}
                            {error &&
                                <Alert variant="danger" isInline title={_("Creating the pod failed")}>
                                    <pre className="podman-compose-error">{error}</pre>
                                </Alert>}
                            {steps &&
                                <ProgressStepper isCompact aria-label={_("Progress")}>
                                    {(Object.keys(STEP_LABELS) as StepId[]).map(id => (
                                        <ProgressStep key={id} id={`template-step-${id}`} titleId={`template-step-${id}-title`}
                                                      variant={stepVariant(steps[id])} isCurrent={steps[id] === "running"}>
                                            {STEP_LABELS[id]}
                                        </ProgressStep>
                                    ))}
                                </ProgressStepper>}
                        </Stack>
                    </GridItem>
                </Grid>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={create} isDisabled={!!validation || busy || !owner?.con} isLoading={creating}>
                    {_("Create and start pod")}
                </Button>
                <Button variant="secondary" onClick={startSaving} isDisabled={busy || saving}>
                    {_("Save as template")}
                </Button>
                {validation && !creating && <span className="ct-grey-text podman-template-validation">{validation}</span>}
                <Button variant="link" onClick={Dialogs.close} isDisabled={creating}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
