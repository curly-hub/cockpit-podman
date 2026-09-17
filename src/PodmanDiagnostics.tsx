/* SPDX-License-Identifier: LGPL-2.1-or-later */
import React, { useState } from 'react';

import { ActionList, ActionListItem } from "@patternfly/react-core/dist/esm/components/ActionList";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content";
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState";
import { Icon } from "@patternfly/react-core/dist/esm/components/Icon";
import { Label } from "@patternfly/react-core/dist/esm/components/Label";
import { Page, PageSection } from "@patternfly/react-core/dist/esm/components/Page";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack";
import {
    CheckCircleIcon, ExclamationCircleIcon, ExclamationTriangleIcon, MinusCircleIcon, ServerIcon, UserIcon,
} from '@patternfly/react-icons';

import cockpit from 'cockpit';

import { type Diagnosis, type DiagStep, enableLinger, journalUrl, servicesUrl, systemctl } from './diagnostics.ts';
import type { Uid } from './rest.js';
import './PodmanDiagnostics.scss';

const _ = cockpit.gettext;

interface Notification {
    type: string;
    error: string;
    errorDetail?: string;
}

export interface PodmanDiagnosticsProps {
    diagnoses: Diagnosis[];
    pending: boolean;
    lingering: boolean | null;
    variant: "page" | "inline";
    onRetry: (uid: Uid, username: string) => void;
    onAddNotification: (n: Notification) => void;
}

const stepIcon = (status: DiagStep["status"]) => {
    switch (status) {
    case "ok":
        return <Icon status="success"><CheckCircleIcon /></Icon>;
    case "fail":
        return <Icon status="danger"><ExclamationCircleIcon /></Icon>;
    case "warn":
        return <Icon status="warning"><ExclamationTriangleIcon /></Icon>;
    default:
        return <Icon><MinusCircleIcon /></Icon>;
    }
};

const stepWord = (status: DiagStep["status"]) => {
    switch (status) {
    case "ok":
        return _("passed");
    case "fail":
        return _("failed");
    case "warn":
        return _("warning");
    default:
        return _("skipped");
    }
};

interface CardProps {
    diagnosis: Diagnosis;
    lingering: boolean | null;
    onRetry: (uid: Uid, username: string) => void;
    onAddNotification: (n: Notification) => void;
}

const DiagnosisCard = ({ diagnosis: d, lingering, onRetry, onAddNotification }: CardProps) => {
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const run = async (id: string, label: string, action: () => Promise<unknown>) => {
        setBusy(id);
        setError(null);
        try {
            await action();
            onRetry(d.uid, d.username);
        } catch (ex) {
            const message = (ex as { message?: string }).message || String(ex);
            setError(cockpit.format(_("$0 failed: $1"), label, message));
            onAddNotification({ type: "danger", error: cockpit.format(_("$0 failed"), label), errorDetail: message });
        } finally {
            setBusy(null);
        }
    };

    const canManageUnit = ["inactive", "no-socket", "api", "unknown", "masked"].includes(d.problem);
    const actions: React.ReactNode[] = [];

    if (d.problem === "masked") {
        actions.push(
            <Button key="unmask" variant="primary" isLoading={busy === "unmask"} isDisabled={busy !== null}
                    onClick={() => run("unmask", _("Unmask and start socket"), async () => {
                        await systemctl(d.uid, d.username, ["unmask", "podman.socket"]);
                        await systemctl(d.uid, d.username, ["start", "podman.socket"]);
                    })}>
                {_("Unmask and start socket")}
            </Button>
        );
    } else if (canManageUnit) {
        actions.push(
            <Button key="start" variant="primary" isLoading={busy === "start"} isDisabled={busy !== null}
                    onClick={() => run("start", _("Start socket"), () => systemctl(d.uid, d.username, ["restart", "podman.socket"]))}>
                {d.problem === "inactive" ? _("Start socket") : _("Restart socket")}
            </Button>
        );
        if (d.unit && d.unit.UnitFileState !== "enabled") {
            actions.push(
                <Button key="enable" variant="secondary" isLoading={busy === "enable"} isDisabled={busy !== null}
                        onClick={() => run("enable", _("Enable socket"), () => systemctl(d.uid, d.username, ["enable", "--now", "podman.socket"]))}>
                    {_("Enable and start socket")}
                </Button>
            );
        }
    }

    if (d.problem === "no-runtime-dir" && d.uid !== 0 && lingering === false) {
        actions.push(
            <Button key="linger" variant="primary" isLoading={busy === "linger"} isDisabled={busy !== null}
                    onClick={() => run("linger", _("Enable lingering"), () => enableLinger(d.username))}>
                {_("Enable lingering")}
            </Button>
        );
    }

    actions.push(
        <Button key="retry" variant="secondary" isLoading={busy === "retry"} isDisabled={busy !== null}
                onClick={() => { setBusy("retry"); onRetry(d.uid, d.username); setBusy(null) }}>
            {_("Retry")}
        </Button>,
        <Button key="journal" variant="link" onClick={() => cockpit.jump(journalUrl(d.uid))}>
            {_("View journal")}
        </Button>,
        <Button key="services" variant="link" onClick={() => cockpit.jump(servicesUrl(d.uid))}>
            {_("Service page")}
        </Button>,
    );

    return (
        <Card className="podman-diagnosis" id={`podman-diagnosis-${d.uid === null ? "user" : d.uid}`}>
            <CardHeader actions={{
                actions: (
                    <Label icon={d.system ? <ServerIcon /> : <UserIcon />} color={d.system ? "blue" : "teal"}>
                        {d.scope}
                    </Label>
                ),
            }}>
                <CardTitle>
                    <Content component={ContentVariants.h2}>{d.title}</Content>
                </CardTitle>
            </CardHeader>
            <CardBody className="podman-diagnosis-body">
                <Content component={ContentVariants.p}>{d.hint}</Content>
                <ol className="podman-diagnosis-steps" aria-label={_("Connection checks")}>
                    {d.steps.map(step => (
                        <li key={step.id} className={`podman-diagnosis-step podman-diagnosis-step-${step.status}`}>
                            {stepIcon(step.status)}
                            <span className="podman-diagnosis-step-title">
                                {step.title}
                                <span className="pf-v6-screen-reader">: {stepWord(step.status)}</span>
                            </span>
                            <span className="podman-diagnosis-step-detail">{step.detail}</span>
                        </li>
                    ))}
                </ol>
                {error && <Alert variant="danger" isInline title={error} />}
                <ActionList>
                    {actions.map((a, i) => <ActionListItem key={i}>{a}</ActionListItem>)}
                </ActionList>
            </CardBody>
        </Card>
    );
};

export const PodmanDiagnostics = ({ diagnoses, pending, lingering, variant, onRetry, onAddNotification }: PodmanDiagnosticsProps) => {
    const cards = diagnoses.map(d => (
        <DiagnosisCard key={d.uid === null ? "user" : String(d.uid)} diagnosis={d} lingering={lingering}
                       onRetry={onRetry} onAddNotification={onAddNotification} />
    ));

    if (variant === "inline")
        return <Stack hasGutter>{cards}</Stack>;

    let content;
    if (diagnoses.length === 0) {
        content = (
            <EmptyState headingLevel="h2" icon={pending ? Spinner : ExclamationCircleIcon}
                        titleText={pending ? _("Checking Podman…") : _("Podman service failed")}>
                <EmptyStateBody>
                    {pending
                        ? _("Looking for the reason Podman could not be reached.")
                        : _("Podman could not be reached and no diagnosis is available.")}
                </EmptyStateBody>
            </EmptyState>
        );
    } else {
        content = <Stack hasGutter>{cards}</Stack>;
    }

    return (
        <Page className="pf-m-no-sidebar" id="podman-diagnostics-page">
            <PageSection hasBodyWrapper={false}>
                {content}
            </PageSection>
        </Page>
    );
};
