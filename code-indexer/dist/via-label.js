/** 引用方式的展示名，CLI 与 UI 共用，避免两边漂移 */
export const VIA_LABEL = {
    import: "标签引用",
    auto: "自动导入",
    async: "动态",
    indirect: "间接",
};
export function viaLabel(via) {
    return via ? VIA_LABEL[via] : null;
}
