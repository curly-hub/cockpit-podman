/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Podman secrets: which exist, which containers mount them, and a dialog to create one.
 * Podman never returns a secret's value, so the card only ever shows metadata. */
import React, { useState } from 'react';

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content";
import { DropdownItem } from '@patternfly/react-core/dist/esm/components/Dropdown/index.js';
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form";
import { Label, LabelGroup } from "@patternfly/react-core/dist/esm/components/Label";
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal';
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { KeyIcon } from '@patternfly/react-icons';
import { KebabDropdown } from "cockpit-components-dropdown.jsx";
import { FileAutoComplete } from 'cockpit-components-file-autocomplete.jsx';
import { FormHelper } from 'cockpit-components-form-helper.jsx';
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';
import { ListingTable } from "cockpit-components-table";

import { ConfirmModal } from './ConfirmModal.tsx';
import * as client from './client.js';
import type { Connection, Uid } from './rest.js';
import { RelativeTime, makeKey, matchesOwner } from './util.js';

const _ = cockpit.gettext;

export interface Secret {
    key: string;
    uid: Uid;
    ID: string;
    CreatedAt?: string;
    UpdatedAt?: string;
    Spec?: {
        Name?: string;
        Driver?: { Name?: string; Options?: Record<string, string> | null };
        Labels?: Record<string, string> | null;
    };
}

interface Container {
    key: string;
    uid: Uid;
    Id: string;
    Name: string;
    State?: { Status?: string };
    Config?: { Secrets?: { Name?: string; ID?: string }[] | null };
}

interface User {
    con: Connection | null;
    uid: Uid;
    name: string;
}

export interface SecretsProps {
    secrets: Record<string, Secret> | null;
    containers: Record<string, Container> | null;
    users: User[];
    ownerFilter: string | number;
    textFilter: string;
    onAddNotification: (n: { type: string; error: string; errorDetail?: string }) => void;
    onFilterChanged: (text: string) => void;
    onContainerFilterChanged: (value: string) => void;
}

export const secretName = (secret: Secret) => secret.Spec?.Name ?? secret.ID;

// podman: "secret name must match [a-zA-Z0-9][a-zA-Z0-9_.-]*"
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/* secret key → containers that have it mounted */
function secretUsers(containers: Record<string, Container> | null): Record<string, Container[]> {
    const result: Record<string, Container[]> = {};
    for (const c of Object.values(containers ?? {})) {
        for (const s of c.Config?.Secrets ?? []) {
            if (s.ID)
                (result[makeKey(c.uid, s.ID)] ??= []).push(c);
        }
    }
    for (const list of Object.values(result))
        list.sort((a, b) => a.Name.localeCompare(b.Name));
    return result;
}

interface CreateProps {
    users: User[];
    existing: Secret[];
    onAddNotification: SecretsProps["onAddNotification"];
}

const SecretCreateModal = ({ users, existing, onAddNotification }: CreateProps) => {
    const Dialogs = useDialogs();
    const owners = users.filter(u => u.con);
    const [owner, setOwner] = useState<User>(owners.find(u => u.uid === null) ?? owners[0]);
    const [name, setName] = useState("");
    const [source, setSource] = useState<"value" | "file">("value");
    const [value, setValue] = useState("");
    const [filePath, setFilePath] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const taken = existing.some(s => s.uid === owner?.uid && secretName(s) === name);
    const nameError = !name
        ? null
        : (!NAME_RE.test(name)
            ? _("Use letters, digits, underscores, dots and hyphens; start with a letter or digit.")
            : (taken ? _("A secret with this name already exists.") : null));
    const canCreate = !!owner?.con && !!name && !nameError && (source === "value" ? value.length > 0 : !!filePath);

    const create = async () => {
        if (!owner?.con)
            return;
        setBusy(true);
        setError(null);
        try {
            let data = value;
            if (source === "file") {
                const content = await cockpit.file(filePath, { superuser: owner.uid === 0 ? "require" : undefined }).read();
                if (content === null)
                    throw new Error(cockpit.format(_("$0 does not exist"), filePath));
                data = content;
            }
            await client.createSecret(owner.con, name, data);
            onAddNotification({ type: "success", error: cockpit.format(_("Secret $0 created"), name) });
            Dialogs.close();
        } catch (ex) {
            setError((ex as { message?: string }).message || String(ex));
            setBusy(false);
        }
    };

    return (
        <Modal isOpen position="top" variant="medium" onClose={Dialogs.close}>
            <ModalHeader title={_("Create secret")}
                         description={_("The value is stored by Podman and mounted into containers as a file under /run/secrets. It cannot be read back afterwards.")} />
            <ModalBody>
                <Form isHorizontal onSubmit={e => { e.preventDefault(); if (canCreate && !busy) create(); }}>
                    {error && <Alert variant="danger" isInline title={_("Creating the secret failed")}>{error}</Alert>}

                    {owners.length > 1 &&
                        <FormGroup label={_("Owner")} isInline fieldId="secret-owner">
                            {owners.map(u => (
                                <Radio key={String(u.uid)} id={`secret-owner-${u.uid ?? "user"}`} name="secret-owner"
                                       label={u.uid === 0 ? _("System") : u.name}
                                       isChecked={owner === u}
                                       isDisabled={busy}
                                       onChange={() => setOwner(u)} />
                            ))}
                        </FormGroup>}

                    <FormGroup label={_("Name")} fieldId="secret-name" isRequired>
                        <TextInput id="secret-name" value={name} isDisabled={busy}
                                   validated={nameError ? "error" : "default"}
                                   onChange={(_ev, v) => setName(v)} />
                        <FormHelper fieldId="secret-name" helperTextInvalid={nameError} />
                    </FormGroup>

                    <FormGroup label={_("Value")} isInline fieldId="secret-source">
                        <Radio id="secret-source-value" name="secret-source" label={_("Enter value")}
                               isChecked={source === "value"} isDisabled={busy}
                               onChange={() => setSource("value")} />
                        <Radio id="secret-source-file" name="secret-source" label={_("Read from a file on this host")}
                               isChecked={source === "file"} isDisabled={busy}
                               onChange={() => setSource("file")} />
                    </FormGroup>

                    {source === "value"
                        ? (
                            <FormGroup fieldId="secret-value">
                                <TextArea id="secret-value" value={value} rows={4} resizeOrientation="vertical"
                                          aria-label={_("Secret value")}
                                          isDisabled={busy}
                                          onChange={(_ev, v) => setValue(v)} />
                                <FormHelper fieldId="secret-value"
                                            helperText={_("Stored exactly as typed, including a trailing newline if you add one.")} />
                            </FormGroup>
                        )
                        : (
                            <FormGroup fieldId="secret-file">
                                <FileAutoComplete id="secret-file"
                                                  placeholder={_("Path to the file")}
                                                  superuser={owner?.uid === 0 ? "require" : undefined}
                                                  isOptionCreatable
                                                  onlyDirectories={false}
                                                  value={filePath}
                                                  onChange={setFilePath} />
                                <FormHelper fieldId="secret-file"
                                            helperText={_("The file content becomes the secret; the file itself is left untouched.")} />
                            </FormGroup>
                        )}
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={create} isDisabled={!canCreate || busy} isLoading={busy}>{_("Create")}</Button>
                <Button variant="link" onClick={Dialogs.close} isDisabled={busy}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

export const Secrets = ({
    secrets, containers, users, ownerFilter, textFilter, onAddNotification, onFilterChanged, onContainerFilterChanged,
}: SecretsProps) => {
    const Dialogs = useDialogs();
    const loading = secrets === null || containers === null;
    const lcf = textFilter.toLowerCase();
    const multiUser = users.filter(u => u.con).length > 1;

    const usage = secretUsers(containers);
    const all = Object.values(secrets ?? {}).filter(s => matchesOwner(s.uid, ownerFilter));
    const list = all
            .filter(s => {
                if (!lcf)
                    return true;
                const name = secretName(s).toLowerCase();
                return name.includes(lcf) || (usage[s.key] ?? []).some(c => c.Name.toLowerCase().includes(lcf));
            })
            .sort((a, b) => secretName(a).localeCompare(secretName(b)));
    const unused = all.filter(s => !(usage[s.key] ?? []).length).length;

    const showContainer = (name: string, running: boolean) => {
        onFilterChanged(name);
        if (!running)
            onContainerFilterChanged("all");
        document.getElementById("containers-containers")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    const deleteSecret = (secret: Secret, con: Connection) => {
        const name = secretName(secret);
        Dialogs.show(
            <ConfirmModal title={cockpit.format(_("Delete secret $0?"), name)}
                          body={<p>{_("Containers created later cannot use it any more. Containers that already mount it keep their copy until they are recreated.")}</p>}
                          actionLabel={_("Delete")}
                          onConfirm={() => client.delSecret(con, name)
                                  .catch(ex => {
                                      onAddNotification({ type: "danger", error: cockpit.format(_("Failed to delete secret $0"), name), errorDetail: ex.message });
                                      throw ex;
                                  })} />
        );
    };

    const columns = [
        { title: _("Name"), header: true },
        { title: _("Driver") },
        { title: _("Used by") },
        ...(multiUser ? [{ title: _("Owner") }] : []),
        { title: _("Created") },
        { title: "", props: { "aria-label": _("Actions") } },
    ];

    const rows = list.map(secret => {
        const user = users.find(u => u.uid === secret.uid);
        const mounts = usage[secret.key] ?? [];
        const name = secretName(secret);

        const dropdownItems: React.ReactNode[] = [];
        if (user?.con) {
            dropdownItems.push(
                <DropdownItem key="delete" className="pf-m-danger" component="button"
                              onClick={() => deleteSecret(secret, user.con as Connection)}>
                    {_("Delete")}
                </DropdownItem>
            );
        }

        return {
            columns: [
                {
                    title: <><KeyIcon className="ct-grey-text" /> {name}</>,
                    sortKey: name,
                    props: { modifier: "breakWord" as const },
                },
                { title: secret.Spec?.Driver?.Name ?? "file", props: { modifier: "nowrap" as const } },
                {
                    title: mounts.length
                        ? (
                            <LabelGroup numLabels={6}>
                                {mounts.map(c => {
                                    const running = c.State?.Status === "running";
                                    return (
                                        <Label key={c.key} variant="outline" color={running ? "green" : "grey"}
                                               onClick={() => showContainer(c.Name, running)}>
                                            {c.Name}
                                        </Label>
                                    );
                                })}
                            </LabelGroup>
                        )
                        : <span className="ct-grey-text">{_("No container")}</span>,
                    sortKey: String(mounts.length),
                },
                ...(multiUser
                    ? [{ title: secret.uid === 0 ? _("system") : <><span className="ct-grey-text">{_("user:")} </span>{user?.name}</>, props: { modifier: "nowrap" as const } }]
                    : []),
                {
                    title: secret.CreatedAt
                        ? (
                            <Tooltip content={cockpit.format(_("ID $0"), secret.ID)}>
                                <span><RelativeTime time={secret.CreatedAt} /></span>
                            </Tooltip>
                        )
                        : <span className="ct-grey-text">—</span>,
                    sortKey: secret.CreatedAt ?? "",
                },
                {
                    title: dropdownItems.length
                        ? <KebabDropdown toggleButtonId={`secret-${secret.key}-actions`} position="right" dropdownItems={dropdownItems} />
                        : null,
                    props: { className: "pf-v6-c-table__action content-action" },
                },
            ],
            props: { key: secret.key, "data-row-id": secret.key },
        };
    });

    const actions = (
        <Button variant="secondary" id="secrets-create" isDisabled={!users.some(u => u.con)}
                onClick={() => Dialogs.show(<SecretCreateModal users={users} existing={Object.values(secrets ?? {})} onAddNotification={onAddNotification} />)}>
            {_("Create secret")}
        </Button>
    );

    return (
        <Card id="containers-secrets" className="containers-secrets">
            <CardHeader actions={{ actions }}>
                <Flex alignItems={{ default: "alignItemsBaseline" }}>
                    <CardTitle>
                        <Content component={ContentVariants.h1}>{_("Secrets")}</Content>
                    </CardTitle>
                    {!loading && all.length > 0 &&
                        <Content component={ContentVariants.p} className="ignore-pixels">
                            {cockpit.format(cockpit.ngettext("$0 secret", "$0 secrets", all.length), all.length)}
                            {unused > 0 && ` · ${cockpit.format(_("$0 unused"), unused)}`}
                        </Content>}
                </Flex>
            </CardHeader>
            <CardBody>
                <ListingTable aria-label={_("Secrets")}
                              variant="compact"
                              loading={loading ? _("Loading secrets...") : ""}
                              emptyCaption={textFilter ? _("No secrets match the current filter") : _("No secrets")}
                              emptyCaptionDetail={textFilter
                                  ? <Button variant="link" isInline onClick={() => onFilterChanged("")}>{_("Clear filter")}</Button>
                                  : _("Secrets hold passwords and keys outside of images and environment variables. Containers get them as files under /run/secrets.")}
                              columns={columns}
                              rows={rows} />
            </CardBody>
        </Card>
    );
};
