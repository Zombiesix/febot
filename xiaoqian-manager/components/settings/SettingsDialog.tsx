"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  RepositoryEntry,
  RepositoryProject,
  SanitizedSettings,
  SwaggerService,
} from "@/lib/domain/settings";
import type { TaskSourceSummary } from "@/lib/domain/task-source";

// 工作区设置：仓库登记表、任务来源、开发环境。首期无登录，写接口仅本机可用。
// 项目输入格式：每行一个；需要标题消歧时写 `项目名|关键词1,关键词2`。

function projectsToText(projects: RepositoryProject[]): string {
  return projects
    .map((p) => (p.keywords?.length ? `${p.name}|${p.keywords.join(",")}` : p.name))
    .join("\n");
}

function textToProjects(text: string): RepositoryProject[] {
  const out: RepositoryProject[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [namePart, keywordPart = ""] = line.split("|");
    const name = namePart.trim();
    if (!name) continue;
    const keywords = keywordPart
      .split(/[,，]/)
      .map((k) => k.trim())
      .filter(Boolean);
    out.push(keywords.length ? { name, keywords } : { name });
  }
  return out;
}

// swagger 输入格式与 services.conf 一致：每行 `服务名=api-docs 地址`。
// 按第一个 = 切分，URL 里的 ?group=... 不会被截断。
function swaggerToText(swagger?: SwaggerService[]): string {
  return (swagger ?? []).map((s) => `${s.name}=${s.url}`).join("\n");
}

function textToSwagger(text: string): SwaggerService[] {
  const seen = new Set<string>();
  const out: SwaggerService[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    const url = line.slice(eq + 1).trim();
    if (!name || !url || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, url });
  }
  return out;
}

interface ScanResult {
  name: string;
  currentBranch: string;
  isGit: boolean;
}

export default function SettingsDialog({
  open,
  onOpenChange,
  initialSettings,
  initialized,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSettings?: SanitizedSettings | null;
  initialized?: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [isInit, setIsInit] = useState(false);
  const [repoRoot, setRepoRoot] = useState("");
  const [jenkinsBase, setJenkinsBase] = useState("");
  const [devBranch, setDevBranch] = useState("dev");
  const [mergeBranch, setMergeBranch] = useState("dev");
  const [repositories, setRepositories] = useState<RepositoryEntry[]>([]);
  const [nextDevOrigins, setNextDevOrigins] = useState("");
  const [hindsight, setHindsight] = useState(false);
  const [teamworkConfigured, setTeamworkConfigured] = useState(false);
  const [sources, setSources] = useState<TaskSourceSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadingCompleteFor, setUploadingCompleteFor] = useState("");

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch("/api/task-sources", { cache: "no-store" });
      const json = (await res.json()) as { sources?: TaskSourceSummary[] };
      if (res.ok) setSources(json.sources ?? []);
    } catch {
      // 来源列表失败不影响设置保存
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const json = (await res.json()) as {
        settings?: SanitizedSettings;
        initialized?: boolean;
        error?: string;
      };
      if (!res.ok || !json.settings) {
        toast.error(json.error ?? "读取设置失败");
        return;
      }
      const s = json.settings;
      setRepoRoot(s.repoRoot);
      setJenkinsBase(s.jenkinsBase);
      setDevBranch(s.defaults.devBranch || "dev");
      setMergeBranch(s.defaults.mergeBranch || "dev");
      setRepositories(s.repositories);
      setNextDevOrigins(s.nextDevOrigins.join("\n"));
      setHindsight(s.features.hindsight);
      setTeamworkConfigured(s.teamwork.hasCredentials);
      setIsInit(!(json.initialized ?? true));
      await loadSources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "读取设置失败");
    } finally {
      setLoading(false);
    }
  }, [loadSources]);

  useEffect(() => {
    if (!open) return;
    if (initialSettings) {
      // 首屏已有脱敏设置，直接填充，避免弹窗闪空
      /* eslint-disable react-hooks/set-state-in-effect */
      setRepoRoot(initialSettings.repoRoot);
      setJenkinsBase(initialSettings.jenkinsBase);
      setDevBranch(initialSettings.defaults.devBranch || "dev");
      setMergeBranch(initialSettings.defaults.mergeBranch || "dev");
      setRepositories(initialSettings.repositories);
      setNextDevOrigins(initialSettings.nextDevOrigins.join("\n"));
      setHindsight(initialSettings.features.hindsight);
      setTeamworkConfigured(initialSettings.teamwork.hasCredentials);
      setIsInit(!initialized);
      /* eslint-enable react-hooks/set-state-in-effect */
      void loadSources();
    } else {
      void load();
    }
  }, [open, initialSettings, initialized, load, loadSources]);

  const updateRepo = (index: number, patch: Partial<RepositoryEntry>) => {
    setRepositories((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const scan = async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/settings/repos/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: repoRoot }),
      });
      const json = (await res.json()) as { repos?: ScanResult[]; error?: string };
      if (!res.ok) {
        toast.error(json.error ?? "扫描仓库失败");
        return;
      }
      const found = json.repos ?? [];
      setRepositories((prev) => {
        const byName = new Map(prev.map((r) => [r.name, r]));
        const merged = found.map((s) => {
          const existing = byName.get(s.name);
          if (existing) return existing;
          return {
            name: s.name,
            ...(s.currentBranch ? { devBranch: s.currentBranch } : {}),
            projects: [],
          };
        });
        // 保留扫描目录里已经没有的配置，避免误删用户手填内容
        for (const r of prev) {
          if (!merged.some((m) => m.name === r.name)) merged.push(r);
        }
        return merged;
      });
      toast.success(`发现 ${found.length} 个 git 仓库`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "扫描仓库失败");
    } finally {
      setScanning(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoRoot,
          jenkinsBase,
          defaults: { devBranch, mergeBranch },
          repositories,
          features: { hindsight },
          nextDevOrigins: nextDevOrigins
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      const json = (await res.json()) as { error?: string; issues?: unknown };
      if (!res.ok) {
        toast.error(json.error ?? "保存失败");
        return;
      }
      toast.success("设置已保存");
      setIsInit(false);
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const uploadSource = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const form = new FormData();
      for (const file of Array.from(files)) {
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        form.append("files", new File([file], rel));
      }
      const res = await fetch("/api/task-sources", { method: "POST", body: form });
      const json = (await res.json()) as { error?: string; name?: string };
      if (!res.ok) {
        toast.error(json.error ?? "上传失败");
        return;
      }
      toast.success(`已上传来源：${json.name ?? ""}`);
      await loadSources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  // 给已有来源补一个完成脚本（manifest 里只合并 complete 段）
  const uploadCompleteScript = async (sourceId: string, files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadingCompleteFor(sourceId);
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append("files", file);
      const res = await fetch(
        `/api/task-sources/${encodeURIComponent(sourceId)}/complete-script`,
        { method: "POST", body: form },
      );
      const json = (await res.json()) as { error?: string; completeEntry?: string };
      if (!res.ok) {
        toast.error(json.error ?? "上传完成脚本失败");
        return;
      }
      toast.success(
        json.completeEntry
          ? `已配置完成脚本：${json.completeEntry}`
          : "完成脚本已更新",
      );
      await loadSources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "上传完成脚本失败");
    } finally {
      setUploadingCompleteFor("");
    }
  };

  const removeSource = async (id: string) => {
    if (!window.confirm("删除该来源？已同步的任务会保留。")) return;
    try {
      const res = await fetch(`/api/task-sources/${encodeURIComponent(id)}`, { method: "DELETE" });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(json.error ?? "删除失败");
        return;
      }
      toast.success("来源已删除");
      await loadSources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <DialogContent className="max-h-[88vh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            工作区设置
            {isInit && (
              <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning">
                首次初始化
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            配置保存在 febot.config.json。首期为本机单用户模式，写操作仅限 localhost。
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="repos" className="min-h-0">
          <TabsList>
            <TabsTrigger value="repos">仓库与分支</TabsTrigger>
            <TabsTrigger value="sources">任务来源</TabsTrigger>
            <TabsTrigger value="dev">开发环境</TabsTrigger>
          </TabsList>

          <TabsContent value="repos" className="max-h-[58vh] overflow-y-auto pr-1">
            {loading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> 正在读取配置…
              </div>
            ) : (
              <div className="space-y-4 py-2">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="repoRoot">仓库根目录</Label>
                    <div className="flex gap-2">
                      <Input
                        id="repoRoot"
                        value={repoRoot}
                        onChange={(e) => setRepoRoot(e.target.value)}
                        placeholder="D:/febot/gitlab"
                      />
                      <Button variant="outline" onClick={() => void scan()} disabled={scanning}>
                        {scanning ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        获取仓库
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="devBranch">默认开发分支</Label>
                    <Input id="devBranch" value={devBranch} onChange={(e) => setDevBranch(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="mergeBranch">默认合并分支</Label>
                    <Input id="mergeBranch" value={mergeBranch} onChange={(e) => setMergeBranch(e.target.value)} />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="jenkinsBase">Jenkins 地址（可选）</Label>
                    <Input
                      id="jenkinsBase"
                      value={jenkinsBase}
                      onChange={(e) => setJenkinsBase(e.target.value)}
                      placeholder="http://host:9990/jenkins/job"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>仓库登记表</Label>
                    <span className="text-xs text-muted-foreground">
                      {repositories.length} 个仓库 · 分支留空表示用默认值
                    </span>
                  </div>
                  {repositories.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                      填写仓库根目录后点「获取仓库」，或手动添加。
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {repositories.map((repo, index) => (
                        <div key={repo.name} className="rounded-lg border bg-muted/20 p-3">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="font-mono text-sm font-medium">{repo.name}</span>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title="移除该仓库"
                              onClick={() => setRepositories((prev) => prev.filter((_, i) => i !== index))}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-3">
                            <Input
                              value={repo.devBranch ?? ""}
                              placeholder={`开发分支（默认 ${devBranch}）`}
                              onChange={(e) => updateRepo(index, { devBranch: e.target.value })}
                            />
                            <Input
                              value={repo.mergeBranch ?? ""}
                              placeholder={`合并分支（默认 ${mergeBranch}）`}
                              onChange={(e) => updateRepo(index, { mergeBranch: e.target.value })}
                            />
                            <Input
                              value={repo.jenkinsJob ?? ""}
                              placeholder="Jenkins Job（可选）"
                              onChange={(e) => updateRepo(index, { jenkinsJob: e.target.value })}
                            />
                          </div>
                          <textarea
                            className="mt-2 min-h-16 w-full resize-y rounded-md border bg-background p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            value={projectsToText(repo.projects)}
                            placeholder={"项目名（每行一个）\n同名项目消歧：项目名|关键词1,关键词2"}
                            onChange={(e) => updateRepo(index, { projects: textToProjects(e.target.value) })}
                          />
                          <textarea
                            className="mt-2 min-h-16 w-full resize-y rounded-md border bg-background p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            value={swaggerToText(repo.swagger)}
                            placeholder={"Swagger 服务（每行 服务名=api-docs 地址）\ncssd-default=http://your-swagger-host:9080/cssdSwagger/v2/api-docs?group=defaultGroup"}
                            onChange={(e) => updateRepo(index, { swagger: textToSwagger(e.target.value) })}
                          />
                          <p className="mt-1 text-xs text-muted-foreground">
                            本仓可用的 swagger 服务；保存后运行 <code>yarn swagger</code> 同步到项目级 MCP。
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="sources" className="max-h-[58vh] overflow-y-auto pr-1">
            <div className="space-y-4 py-2">
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">协作平台（内置）</p>
                    <p className="text-xs text-muted-foreground">
                      {teamworkConfigured ? "账号已配置" : "未配置账号：请在 febot.config.json 填写 teamwork 段"}
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>自定义来源</Label>
                  <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted">
                    {uploading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                    上传文件夹
                    <input
                      type="file"
                      className="hidden"
                      multiple
                      // @ts-expect-error webkitdirectory 是 Chromium 扩展属性
                      webkitdirectory=""
                      onChange={(e) => void uploadSource(e.target.files)}
                    />
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  文件夹内需要 febot.source.json 与拉取脚本。脚本以当前用户权限在本机执行，请只上传你自己信任的代码。
                </p>
                {sources.filter((s) => s.kind === "script").length === 0 ? (
                  <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                    还没有自定义来源。
                  </p>
                ) : (
                  <div className="space-y-2">
                    {sources
                      .filter((s) => s.kind === "script")
                      .map((s) => (
                        <div key={s.id} className="rounded-lg border p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{s.name}</p>
                              <p className="text-xs text-muted-foreground">
                                拉取：{s.fetchEntry ?? "-"}
                              </p>
                              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                                {s.completeEntry ? (
                                  <span className="rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-success">
                                    已配置完成脚本：{s.completeEntry}
                                  </span>
                                ) : s.completeMode === "required" ? (
                                  <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-destructive">
                                    缺少必填完成脚本
                                  </span>
                                ) : (
                                  <span className="rounded-full border px-2 py-0.5 text-muted-foreground">
                                    未配置完成脚本（仅本地完成）
                                  </span>
                                )}
                                {s.completeMode === "required" && (
                                  <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning">
                                    强制模式
                                  </span>
                                )}
                              </p>
                              {s.lastRun && (
                                <p className={s.lastRun.ok ? "text-xs text-success" : "text-xs text-destructive"}>
                                  最近运行：{s.lastRun.ok ? "成功" : "失败"}
                                  {s.lastRun.message ? ` · ${s.lastRun.message}` : ""}
                                </p>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <label
                                className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                                title="上传完成同步脚本（.js / .mjs / .cjs）"
                              >
                                {uploadingCompleteFor === s.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Upload className="h-3.5 w-3.5" />
                                )}
                                {s.completeEntry ? "替换完成脚本" : "上传完成脚本"}
                                <input
                                  type="file"
                                  className="hidden"
                                  accept=".js,.mjs,.cjs"
                                  onChange={(e) => {
                                    void uploadCompleteScript(s.id, e.target.files);
                                    e.target.value = "";
                                  }}
                                />
                              </label>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                title="删除来源"
                                onClick={() => void removeSource(s.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="dev" className="max-h-[58vh] overflow-y-auto pr-1">
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="origins">next dev 允许来源（每行一个）</Label>
                <textarea
                  id="origins"
                  className="min-h-24 w-full resize-y rounded-md border bg-background p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={nextDevOrigins}
                  onChange={(e) => setNextDevOrigins(e.target.value)}
                  placeholder="http://192.168.1.10:3000"
                />
                <p className="text-xs text-muted-foreground">
                  修改后需重启 <code className="font-mono">yarn dev</code> 才会生效。
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={hindsight} onChange={(e) => setHindsight(e.target.checked)} />
                启用 Hindsight 记忆
              </label>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving || loading}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}