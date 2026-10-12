import { looksLikeRepo } from "./detect";
import type { ProjectMap } from "./types";
export declare function scanRepo(repoPath: string): ProjectMap;
export { looksLikeRepo };
export { getScan, clearScanCache } from "./cache";
