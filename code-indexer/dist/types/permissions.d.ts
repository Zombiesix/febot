import type { GuardInfo, PermissionModel } from "./channel-types";
import type { RouteInfo } from "./types";
export declare function buildPermissions(repoRoot: string, filesAbs: string[], routes: RouteInfo[]): PermissionModel;
/** 路由守卫：如实抽取，不假装它是权限主机制 */
export declare function buildGuards(repoRoot: string, filesAbs: string[]): GuardInfo[];
