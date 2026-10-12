import { type ScriptSource } from "./ast";
import type { Endpoint, UnresolvedFn } from "./endpoint-types";
export interface EndpointExtraction {
    endpoints: Endpoint[];
    /**
     * 有导出但没解析出端点的函数，**带原因**。
     * 实测多数是纯工具函数（reason=no-client-usage），少数走了二次封装，
     * 值得人工看一眼 —— 但看哪一类取决于 reason，所以原因不能丢。
     */
    unresolvedFns: UnresolvedFn[];
}
export declare function extractEndpoints(script: ScriptSource, absFile: string, repoRoot: string, srcDirRel: string | null, clientFiles: Set<string>): EndpointExtraction;
