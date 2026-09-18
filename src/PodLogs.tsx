/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Combined, live log view for every container of a pod.
 *
 * Each container's log is read through the Podman REST API and every line is prefixed with a
 * coloured service or container name, like `podman-compose logs`. The recent history of all
 * members is merged by timestamp first; after that each stream is followed live from the last
 * line it delivered, so nothing is lost or shown twice at the hand-over. */
import React, { useEffect, useState } from 'react';

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from "@xterm/xterm";
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';

import * as client from './client.js';
import rest from './rest.js';
import type { Uid } from './rest.js';

import "./ContainerTerminal.css";
import './PodLogs.scss';

const _ = cockpit.gettext;

export interface PodLogSource {
    id: string;
    name: string;
}

// lines of history per container; the merged view keeps up to SCROLLBACK lines
const TAIL = 300;
const SCROLLBACK = 5000;
// ANSI foreground colours for the name prefixes, cycled per container
const COLORS = [36, 32, 33, 35, 34, 96, 92, 93, 95, 94];

interface LogLine {
    key: string; // sortable time key, "" when the line carries no timestamp
    stamp: string; // the raw RFC3339Nano timestamp, "" when absent
    text: string; // line without the timestamp and without the line ending
}

/* RFC3339Nano → "<ms since epoch, padded>.<nanoseconds, padded>" so plain string comparison orders
 * lines correctly across containers even when Podman trims trailing zeros of the fraction. */
function timeKey(stamp: string): string {
    const ms = Date.parse(stamp);
    if (Number.isNaN(ms))
        return "";
    const frac = /\.(\d+)/.exec(stamp)?.[1] ?? "";
    return String(ms).padStart(15, "0") + "." + frac.padEnd(9, "0");
}

/* Split a log frame body ("<timestamp> <text>\n") into its parts. */
function parseLine(body: Uint8Array): LogLine {
    let text = new TextDecoder().decode(body);
    text = text.replace(/\r?\n$/, "").replace(/\r$/, "");
    const space = text.indexOf(" ");
    if (space > 0) {
        const stamp = text.slice(0, space);
        const key = timeKey(stamp);
        if (key)
            return { key, stamp, text: text.slice(space + 1) };
    }
    return { key: "", stamp: "", text };
}

/* Podman multiplexes stdout/stderr as frames: 8 header bytes (type, 0, 0, 0, size as big-endian
 * uint32) followed by the payload. A frame may be split over several channel messages. */
class FrameReader {
    private pending: Uint8Array = new Uint8Array();
    private readonly onFrame: (body: Uint8Array) => void;

    constructor(onFrame: (body: Uint8Array) => void) {
        this.onFrame = onFrame;
    }

    push(data: Uint8Array) {
        let buf = this.pending.byteLength ? new Uint8Array([...this.pending, ...data]) : data;
        while (buf.byteLength >= 8) {
            const size = buf[7] + buf[6] * 0x100 + buf[5] * 0x10000 + buf[4] * 0x1000000;
            if (buf.byteLength < 8 + size)
                break;
            this.onFrame(buf.slice(8, 8 + size));
            buf = buf.slice(8 + size);
        }
        this.pending = buf;
    }
}

const logsPath = (id: string) => `${client.VERSION}libpod/containers/${id}/logs`;
const logsQuery = (query: Record<string, string>) => ({ stdout: "true", stderr: "true", timestamps: "true", ...query });

export const PodLogsModal = ({ uid, podName, sources }: { uid: Uid; podName: string; sources: PodLogSource[] }) => {
    const Dialogs = useDialogs();
    // the modal renders its content through a portal, so the div only exists after the first
    // render; a state-backed ref re-runs the effect once it is there
    const [element, setElement] = useState<HTMLDivElement | null>(null);
    const [errors, setErrors] = useState<string[]>([]);

    useEffect(() => {
        if (!element)
            return;

        const view = new Terminal({
            cols: 120,
            rows: 30,
            convertEol: true,
            cursorBlink: false,
            disableStdin: true,
            fontSize: 12,
            fontFamily: 'Menlo, Monaco, Consolas, monospace',
            screenReaderMode: true,
            scrollback: SCROLLBACK,
        });
        view.open(element);
        try {
            view.loadAddon(new WebglAddon());
        } catch (ex) {
            console.warn("PodLogs: WebGL renderer unavailable, using DOM renderer:", String(ex));
        }
        // reading the tail of a journald-backed container takes Podman a few seconds
        view.write(_("Loading logs..."));

        // missing API: https://github.com/xtermjs/xterm.js/issues/702
        const core = (view as unknown as { _core: { cursorHidden: boolean; _renderService?: { dimensions: { css: { cell: { width: number; height: number } } } } } })._core;
        core.cursorHidden = true;
        const fit = () => {
            const cell = core._renderService?.dimensions.css.cell;
            if (!cell || !cell.width || !cell.height)
                return;
            // 21 inner padding of xterm.js, 20 scrollbar
            const cols = Math.max(20, Math.floor((element.clientWidth - 21 - 20) / cell.width));
            // leave room for the modal header, footer and margins
            const rows = Math.min(60, Math.max(10, Math.floor((window.innerHeight - 260) / cell.height)));
            if (cols !== view.cols || rows !== view.rows)
                view.resize(cols, rows);
        };
        fit();
        const observer = new ResizeObserver(fit);
        observer.observe(element);

        const width = Math.max(...sources.map(s => s.name.length));
        const prefix = (i: number) => `\x1b[${COLORS[i % COLORS.length]}m${sources[i].name.padEnd(width)} |\x1b[0m `;
        const connections = sources.map(() => rest.connect(uid));
        let closed = false;
        let firstLine = true;
        const failed = (source: PodLogSource, ex: unknown) => {
            if (closed)
                return;
            const message = (ex as { message?: string }).message ?? String(ex);
            setErrors(prev => [...prev, cockpit.format(_("$0: $1"), source.name, message)]);
        };
        const writeLine = (i: number, line: LogLine) => {
            if (firstLine) {
                view.reset();
                core.cursorHidden = true;
                firstLine = false;
            }
            view.writeln(prefix(i) + line.text);
        };

        const run = async () => {
            // history of every member, merged by time
            const started = new Date().toISOString();
            // newest history line of every member
            const last: LogLine[] = sources.map(() => ({ key: "", stamp: "", text: "" }));
            const history: { i: number; line: LogLine }[] = [];
            // Podman keeps the connection open after a non-follow response, so a streaming read
            // would never finish; a plain request ends with the chunked body instead
            await Promise.all(sources.map((source, i) => {
                const reader = new FrameReader(body => {
                    const line = parseLine(body);
                    history.push({ i, line });
                    if (line.key > last[i].key)
                        last[i] = line;
                });
                return connections[i].callRaw({ method: "GET", path: logsPath(source.id), body: "", params: logsQuery({ tail: String(TAIL) }) })
                        .then(data => reader.push(data))
                        .catch(ex => failed(source, ex));
            }));
            if (closed)
                return;
            history.sort((a, b) => (a.line.key < b.line.key ? -1 : (a.line.key > b.line.key ? 1 : 0)));
            for (const entry of history)
                writeLine(entry.i, entry.line);
            if (firstLine) {
                view.reset();
                core.cursorHidden = true;
                view.writeln(_("No log output yet."));
                firstLine = false;
            }

            // follow each member from its last delivered line; skip the line itself when it
            // comes again, since Podman includes lines whose time equals `since`
            sources.forEach((source, i) => {
                const since = last[i].stamp || started;
                const reader = new FrameReader(body => {
                    const line = parseLine(body);
                    if (line.key && line.key <= last[i].key)
                        return;
                    if (line.key)
                        last[i] = line;
                    writeLine(i, line);
                });
                const params = new URLSearchParams(logsQuery({ follow: "true", since }));
                connections[i].monitor(`${logsPath(source.id)}?${params.toString()}`, (data: Uint8Array) => reader.push(data), true)
                        .then(() => {
                            if (!closed)
                                view.writeln(prefix(i) + `\x1b[2m${_("log stream ended")}\x1b[0m`);
                        })
                        .catch(ex => failed(source, ex));
            });
        };
        run();

        return () => {
            closed = true;
            observer.disconnect();
            connections.forEach(con => con.close());
            view.dispose();
        };
    }, [element, uid, sources]);

    return (
        <Modal isOpen position="top" variant="large" className="podman-pod-logs-modal" onClose={Dialogs.close}>
            <ModalHeader title={cockpit.format(_("Logs of pod $0"), podName)}
                         description={cockpit.format(cockpit.ngettext("Live output of $0 container, prefixed with its name.",
                                                                      "Live output of $0 containers, merged and prefixed with their names.",
                                                                      sources.length), sources.length)} />
            <ModalBody>
                {errors.length > 0 &&
                    <Alert variant="warning" isInline title={_("Some logs could not be read")}>
                        {errors.map(err => <div key={err}>{err}</div>)}
                    </Alert>}
                <div className="podman-pod-logs" ref={setElement} />
            </ModalBody>
            <ModalFooter>
                <Button variant="secondary" onClick={Dialogs.close}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
};
