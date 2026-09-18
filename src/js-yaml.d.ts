/* SPDX-License-Identifier: LGPL-2.1-or-later */
// minimal typing for the parts of js-yaml this project uses
declare module 'js-yaml' {
    export function load(text: string): unknown;
}
