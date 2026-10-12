import type { ApiDomainInfo, ApiUsage } from "./types";
export interface ApiIndex {
    /** repo 相对的 api 根目录，如 src/service/api */
    root: string | null;
    /** 直接放在根下的代码文件（如 $http.ts），属于共享层而非某个域 */
    sharedFiles: string[];
    domains: ApiDomainInfo[];
}
export declare function buildApiIndex(repoRoot: string, serviceDirRel: string | null, srcDirRel: string | null): ApiIndex;
/** 从一组文件里找出它们引用了哪些 API 域，链接关系完全由 import 推导，不靠猜名字 */
export declare function collectApiUsage(repoRoot: string, srcDirRel: string | null, api: ApiIndex, filesAbs: string[], moduleDirRel?: string | null): ApiUsage[];
