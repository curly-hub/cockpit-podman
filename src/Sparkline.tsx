/* SPDX-License-Identifier: LGPL-2.1-or-later */
/* A small inline SVG line chart with a filled area, drawn in the current text colour. */
import React from 'react';

export interface SparklineProps {
    values: number[];
    max?: number; // top of the scale; defaults to the largest value
    width?: number;
    height?: number;
    className?: string;
    ariaLabel?: string;
}

export const Sparkline = ({ values, max, width = 160, height = 40, className, ariaLabel }: SparklineProps) => {
    const top = Math.max(max ?? 0, ...values, Number.EPSILON);
    const n = values.length;
    const x = (i: number) => n > 1 ? (i / (n - 1)) * width : width;
    const y = (v: number) => height - (Math.min(v, top) / top) * (height - 2) - 1;

    if (n < 2) {
        return (
            <svg className={"podman-sparkline " + (className ?? "")} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
                 role="img" aria-label={ariaLabel ?? ""}>
                <line x1={0} y1={height - 1} x2={width} y2={height - 1} className="podman-sparkline-baseline" />
            </svg>
        );
    }

    const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const area = `M0,${height} L${points.replace(/ /g, " L")} L${width},${height} Z`;
    return (
        <svg className={"podman-sparkline " + (className ?? "")} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
             preserveAspectRatio="none" role="img" aria-label={ariaLabel ?? ""}>
            <path d={area} className="podman-sparkline-area" />
            <polyline points={points} className="podman-sparkline-line" />
        </svg>
    );
};
