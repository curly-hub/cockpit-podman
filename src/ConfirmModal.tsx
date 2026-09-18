/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* A small confirmation dialog for destructive actions; shows the error inline when the action fails. */
import React, { useState } from 'react';

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal';
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface ConfirmModalProps {
    title: string;
    body: React.ReactNode;
    actionLabel: string;
    variant?: "danger" | "primary";
    onConfirm: () => Promise<unknown>;
}

export const ConfirmModal = ({ title, body, actionLabel, variant = "danger", onConfirm }: ConfirmModalProps) => {
    const Dialogs = useDialogs();
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const confirm = () => {
        setBusy(true);
        setError(null);
        onConfirm()
                .then(() => Dialogs.close())
                .catch(ex => {
                    setError((ex as { message?: string }).message || String(ex));
                    setBusy(false);
                });
    };

    return (
        <Modal isOpen position="top" variant="small" onClose={Dialogs.close}>
            <ModalHeader title={title} {...(variant === "danger" ? { titleIconVariant: "warning" as const } : {})} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={_("An error occurred")}>{error}</Alert>}
                {body}
            </ModalBody>
            <ModalFooter>
                <Button variant={variant} onClick={confirm} isLoading={busy} isDisabled={busy}>{actionLabel}</Button>
                <Button variant="link" onClick={Dialogs.close}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
