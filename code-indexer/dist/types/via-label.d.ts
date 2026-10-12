import type { EdgeVia } from "./types";
/** 引用方式的展示名，CLI 与 UI 共用，避免两边漂移 */
export declare const VIA_LABEL: Record<EdgeVia, string>;
export declare function viaLabel(via: EdgeVia | undefined): string | null;
