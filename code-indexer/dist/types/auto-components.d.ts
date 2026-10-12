export interface AutoComponentIndex {
    /** 组件名 → repo 相对路径 */
    byName: Map<string, string>;
    /** 同名冲突，无法确定是哪个 */
    ambiguous: Map<string, string[]>;
    /** dts = 读 unplugin 生成的声明；basename = 按约定目录兜底；none = 没有 */
    source: "dts" | "basename" | "none";
    dtsFile: string | null;
}
export declare function loadAutoComponents(repoRoot: string, sfcFilesAbs: string[], allFilesAbs: string[]): AutoComponentIndex;
