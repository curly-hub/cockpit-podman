/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* Helpers over the container stats history that app.jsx records from the podman stats stream. */

export interface Sample {
    t: number; // ms since epoch
    cpu?: number; // percent of the host
    mem?: number; // bytes
    rx: number; // cumulative bytes received on all interfaces
    tx: number;
    bi: number; // cumulative bytes read from block devices
    bo: number;
    pids?: number;
}

export type StatsHistory = Record<string, Sample[]>;

export interface Rates {
    rx: number; // bytes per second
    tx: number;
    bi: number;
    bo: number;
    span: number; // seconds the rates were measured over, 0 when there is no rate yet
}

const ZERO: Rates = { rx: 0, tx: 0, bi: 0, bo: 0, span: 0 };

/* Per-second rates between two samples; counters that went backwards (restart) count as zero. */
export function rateBetween(a: Sample, b: Sample): Rates {
    const span = (b.t - a.t) / 1000;
    if (span <= 0)
        return ZERO;
    const delta = (x: number, y: number) => Math.max(0, y - x) / span;
    return { rx: delta(a.rx, b.rx), tx: delta(a.tx, b.tx), bi: delta(a.bi, b.bi), bo: delta(a.bo, b.bo), span };
}

/* Current rates of one container: the newest sample against the oldest one within `windowMs`. */
export function currentRates(history: Sample[] | undefined, windowMs = 30000): Rates {
    if (!history || history.length < 2)
        return ZERO;
    const last = history[history.length - 1];
    let first = history[history.length - 2];
    for (let i = history.length - 2; i >= 0 && last.t - history[i].t <= windowMs; i--)
        first = history[i];
    return rateBetween(first, last);
}

/* Sum of the current rates of several containers. */
export function sumRates(histories: (Sample[] | undefined)[]): Rates {
    const total = { ...ZERO };
    for (const h of histories) {
        const r = currentRates(h);
        total.rx += r.rx;
        total.tx += r.tx;
        total.bi += r.bi;
        total.bo += r.bo;
        total.span = Math.max(total.span, r.span);
    }
    return total;
}

/* Rate series (one value per sample interval) for charts. */
export function rateSeries(history: Sample[] | undefined, pick: (r: Rates) => number): number[] {
    if (!history || history.length < 2)
        return [];
    const out: number[] = [];
    for (let i = 1; i < history.length; i++)
        out.push(pick(rateBetween(history[i - 1], history[i])));
    return out;
}
