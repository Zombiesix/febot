import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  dialog,
  shell,
  session,
} from "electron";
import type {
  Bootstrap,
  DesktopSettings,
  DoctorReport,
  RuntimeSyncResult,
  ServiceStatus,
  SetupPayload,
  WorkspaceCheck,
} from "../shared/types";
import { APP_ID, DEFAULT_APP_PORT, DEFAULT_RUNNER_PORT, IPC } from "../shared/constants";
import { initLogging, log } from "./logging";
import { loadSettings, patchSettings } from "./settings";
import {
  appDataDir,
  logsDir,
  packagedManifest,
  packagedNextRoot,
  packagedNextServer,
  packagedNodeExe,
  packagedRunner,
  packagedRuntime,
  resourcesRoot,
  workspaceConfigFile,
} from "./paths";
import { allocatePorts } from "./ports";
import { Supervisor } from "./supervisor";
import { buildMenu } from "./menu";
import { createTray, type TrayHandle } from "./tray";
import { checkForUpdatesNow, initUpdater } from "./updater";
import { countActiveRuns, markInterruptedRuns, watchRuns } from "./runs";
import { notifyRunStatus, notifySimple } from "./notifications";
import {
  applySetupConfig,
  checkTakeoverWorkspace,
  createWorkspace,
  ensureTakeoverBaseline,
  ensureWorkspaceDirs,
  removeDesktopLock,
  syncRuntime,
  validateWorkspace as validateWorkspaceImpl,
  writeDesktopLock,
} from "./workspace";
import { readManifest } from "./manifest";
import { readJson } from "./filesystem";
import { runDoctor } from "./doctor";
import { broadcast, openConfigFile, registerIpc } from "./ipc";
import { enrichedPath } from "./env";

const execFileAsync = promisify(execFile);

const useResources =
  process.env.FEBOT_DESKTOP_USE_RESOURCES === "1" || app.isPackaged;
const sourceRoot = process.env.FEBOT_SOURCE_ROOT?.trim() || "D:\\febot";

let settings: DesktopSettings = loadSettings();
let supervisor: Supervisor | null = null;
let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let errorWindow: BrowserWindow | null = null;
let tray: TrayHandle | null = null;
let stopRunWatcher: (() => void) | null = null;
let quitting = false;
let starting = false;

function rendererUrl(page: string): string | null {
  const base = process.env.ELECTRON_RENDERER_URL;
  return base ? `${base}/${page}` : null;
}

function preloadPath(): string {
  return path.join(__dirname, "../preload/index.js");
}

function runtimeVersion(): string {
  const manifest = readManifest(packagedManifest());
  return manifest?.version || app.getVersion();
}

function isLocalAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsed.port === String(supervisor?.appPort ?? DEFAULT_APP_PORT)
    );
  } catch {
    return false;
  }
}

function navigationHosts(workspace: string): Set<string> {
  const hosts = new Set<string>();
  for (const entry of settings.navigationAllowlist) {
    const clean = entry.trim().toLowerCase();
    if (clean) hosts.add(clean);
  }
  const config = readJson<Record<string, unknown>>(workspaceConfigFile(workspace));
  const teamwork = config?.teamwork as { base?: unknown } | undefined;
  if (typeof teamwork?.base === "string") {
    try {
      hosts.add(new URL(teamwork.base).host.toLowerCase());
    } catch {
      // ignore
    }
  }
  const desktop = config?.desktop as { navigationAllowlist?: unknown } | undefined;
  if (Array.isArray(desktop?.navigationAllowlist)) {
    for (const item of desktop.navigationAllowlist) {
      if (typeof item === "string" && item.trim()) hosts.add(item.trim().toLowerCase());
    }
  }
  return hosts;
}

function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  const bounds = settings.lastWindow;
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: Math.max(1024, bounds.width),
    height: Math.max(700, bounds.height),
    minWidth: 1024,
    minHeight: 700,
    title: `febot · ${path.basename(settings.workspace)}`,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const allowed = navigationHosts(settings.workspace);
  const guard = (event: Electron.Event, url: string): void => {
    if (isLocalAppUrl(url)) return;
    try {
      const host = new URL(url).host.toLowerCase();
      if (allowed.has(host)) return;
    } catch {
      // fallthrough
    }
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  win.webContents.on("will-navigate", guard);
  win.webContents.on("will-redirect", guard);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = 用户/系统主动中断
    showErrorWindow(`加载 ${url} 失败（${code} ${description}）`);
  });

  win.once("ready-to-show", () => win.show());

  let saveTimer: NodeJS.Timeout | null = null;
  const saveBounds = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      settings = patchSettings(settings, {
        lastWindow: { x: b.x, y: b.y, width: b.width, height: b.height },
      });
    }, 600);
  };
  win.on("move", saveBounds);
  win.on("resize", saveBounds);

  win.on("close", (event) => {
    if (quitting) {
      saveBounds();
      return;
    }
    if (settings.minimizeToTray) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    mainWindow = null;
  });

  mainWindow = win;
  return win;
}

function loadMainWindow(): void {
  const win = createMainWindow();
  const port = supervisor?.appPort ?? settings.appPort ?? DEFAULT_APP_PORT;
  void win.loadURL(`http://127.0.0.1:${port}`);
  win.show();
  win.focus();
}

function createSetupWindow(): BrowserWindow {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return setupWindow;
  }
  const win = new BrowserWindow({
    width: 980,
    height: 780,
    minWidth: 820,
    minHeight: 640,
    title: "febot 首次运行向导",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const url = rendererUrl("setup/index.html");
  if (url) void win.loadURL(url);
  else void win.loadFile(path.join(__dirname, "../renderer/setup/index.html"));
  win.on("closed", () => {
    setupWindow = null;
  });
  setupWindow = win;
  return win;
}

function showErrorWindow(message: string): void {
  log.error(`[main] 显示错误页：${message}`);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  if (errorWindow && !errorWindow.isDestroyed()) {
    errorWindow.close();
  }
  const win = new BrowserWindow({
    width: 760,
    height: 560,
    title: "febot 启动失败",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const query = `?message=${encodeURIComponent(message)}`;
  const url = rendererUrl(`error/index.html${query}`);
  if (url) void win.loadURL(url);
  else void win.loadFile(path.join(__dirname, "../renderer/error/index.html"), { search: query });
  win.on("closed", () => {
    errorWindow = null;
  });
  errorWindow = win;
}

function resolveResources(): {
  nextRoot: string;
  nextServer: string;
  runnerServer: string;
  nodeExe: string;
} {
  if (!useResources) {
    return {
      nextRoot: "",
      nextServer: "",
      runnerServer: "",
      nodeExe: "",
    };
  }
  const paths = {
    nextRoot: packagedNextRoot(),
    nextServer: packagedNextServer(),
    runnerServer: packagedRunner(),
    nodeExe: packagedNodeExe(),
  };
  const missing = Object.entries(paths)
    .filter(([key, value]) => key !== "nextRoot" && !fs.existsSync(value))
    .map(([key, value]) => `${key}=${value}`);
  if (missing.length) {
    throw new Error(
      `运行时资产缺失（请先执行 yarn prepare-runtime）：\n${missing.join("\n")}`
    );
  }
  return paths;
}

function prepareRuntime(workspace: string, skipSync: boolean): RuntimeSyncResult | null {
  const runtimeDir = packagedRuntime();
  const manifestFile = packagedManifest();
  if (!fs.existsSync(runtimeDir)) {
    log.warn(`[main] 未找到运行时资产 ${runtimeDir}，跳过同步（开发模式正常）`);
    return null;
  }
  const version = runtimeVersion();
  if (skipSync) {
    // 接管模式首次启动要扫描工作区生成基线；放到服务启动后做，避免拖慢启动。
    setTimeout(() => {
      try {
        ensureTakeoverBaseline(workspace, runtimeDir, version);
      } catch (e) {
        log.warn("[main] 生成接管基线失败", e);
      }
    }, 3_000).unref();
    return null;
  }
  const result = syncRuntime(workspace, runtimeDir, manifestFile, version);
  if (result.error) log.error(`[main] 运行时同步失败：${result.error}`);
  if (result.conflicts.length) {
    notifySimple(
      "运行时同步有冲突",
      `${result.conflicts.length} 个文件用户改动过，已生成 .febot-new，未覆盖原文件`
    );
  }
  if (!result.error) settings = patchSettings(settings, { runtimeVersion: result.version });
  return result;
}

async function startApp(
  workspace: string,
  options: { reload?: boolean } = {}
): Promise<boolean> {
  if (starting) return false;
  starting = true;
  const startedAt = Date.now();
  const stage = (label: string): void =>
    log.info(`[main] ${label}（${Date.now() - startedAt}ms）`);
  try {
    const check = validateWorkspaceImpl(workspace, { mode: "takeover" });
    if (!check.ok) {
      showErrorWindow(check.errors.join("\n"));
      return false;
    }
    if (!fs.existsSync(workspaceConfigFile(workspace)) && settings.workspaceMode === "takeover") {
      showErrorWindow("工作区缺少 febot.config.json，请重新运行向导。");
      return false;
    }
    stage("工作区校验完成");

    ensureWorkspaceDirs(workspace);
    prepareRuntime(workspace, settings.workspaceMode === "takeover");
    stage("运行时准备完成");

    const ports = await allocatePorts(
      settings.appPort ?? DEFAULT_APP_PORT,
      settings.runnerPort ?? DEFAULT_RUNNER_PORT
    );
    settings = patchSettings(settings, {
      appPort: ports.appPort,
      runnerPort: ports.runnerPort,
    });
    stage(`端口分配完成 next=${ports.appPort} runner=${ports.runnerPort}`);

    if (useResources) {
      const missing = ["next", "runner", "node"].filter(
        (dir) => !fs.existsSync(path.join(resourcesRoot(), dir))
      );
      if (missing.length) {
        throw new Error(`resources 下缺少目录：${missing.join(", ")}`);
      }
    } else {
      const xqPackage = path.join(sourceRoot, "xiaoqian-manager", "package.json");
      if (!fs.existsSync(xqPackage)) {
        throw new Error(`开发模式找不到源码仓库：${sourceRoot}（可用 FEBOT_SOURCE_ROOT 指定）`);
      }
    }

    supervisor = new Supervisor({
      workspace,
      appPort: ports.appPort,
      runnerPort: ports.runnerPort,
      sourceRoot,
      packaged: useResources,
      resources: resolveResources(),
      onStatus: handleServiceStatus,
      onRunnerCrash: () => {
        const count = markInterruptedRuns(
          workspace,
          "runner 异常退出（现场保留，可恢复会话）"
        );
        if (count > 0) {
          notifySimple(
            "runner 异常退出",
            `${count} 个任务已标记为「已中断」，下次启动可恢复会话`
          );
        }
      },
    });

    writeDesktopLock(workspace);
    stopRunWatcher?.();
    stopRunWatcher = watchRuns(workspace, ({ run, to }) => {
      notifyRunStatus(run, to, () => {
        loadMainWindow();
        const port = supervisor?.appPort ?? settings.appPort;
        if (port) void mainWindow?.loadURL(`http://127.0.0.1:${port}/runs/${run.id}`);
      });
    });

    broadcast(IPC.setupProgress, "正在启动 Next 服务…");
    await supervisor.start();
    stage("服务启动完成");
    broadcast(IPC.setupProgress, "服务已就绪，正在打开主界面…");

    if (options.reload || !mainWindow) loadMainWindow();
    else {
      const port = supervisor.appPort;
      void mainWindow.loadURL(`http://127.0.0.1:${port}`);
      mainWindow.show();
    }
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("[main] 启动失败", e);
    if (supervisor) {
      await supervisor.stop().catch((err) => log.error("[main] stop after failure", err));
      supervisor = null;
    }
    showErrorWindow(message);
    return false;
  } finally {
    starting = false;
  }
}

function handleServiceStatus(statuses: ServiceStatus[]): void {
  tray?.update(statuses);
  broadcast(IPC.serviceStatus, statuses);
}

async function restartServices(): Promise<void> {
  if (supervisor) {
    await supervisor.stop().catch((e) => log.error("[main] stop failed", e));
    supervisor = null;
  }
  removeDesktopLock(settings.workspace);
  await startApp(settings.workspace, { reload: true });
}

async function finishSetup(payload: SetupPayload): Promise<RuntimeSyncResult> {
  const workspace = path.resolve(payload.workspace);
  const version = runtimeVersion();
  broadcast(IPC.setupProgress, "正在校验工作区…");

  if (payload.mode === "new") {
    const check = validateWorkspaceImpl(workspace, { mode: "new" });
    if (!check.ok) throw new Error(check.errors.join("\n"));
    if (fs.existsSync(workspace) && fs.readdirSync(workspace).length > 0) {
      throw new Error("新建模式要求目录为空；如要接管已有目录请选择「接管现有目录」");
    }
    if (!fs.existsSync(packagedRuntime())) {
      throw new Error(
        "运行时资产不存在，无法新建工作区。请先执行 yarn prepare-runtime（或选择接管现有目录 D:\\febot）"
      );
    }
    broadcast(IPC.setupProgress, "正在复制运行时资产…");
    const created = createWorkspace(workspace, packagedRuntime(), packagedManifest(), version);
    broadcast(IPC.setupProgress, `已复制 ${created.runtime.copied} 个运行时文件`);
    if (payload.config) applySetupConfig(workspace, payload.config);
    settings = patchSettings(settings, {
      workspace,
      workspaceMode: "new",
      runtimeVersion: version,
      appPort: null,
      runnerPort: null,
    });
    const started = await startApp(workspace, { reload: true });
    if (started) closeSetupWindowSoon();
    return created.runtime;
  }

  const check = checkTakeoverWorkspace(workspace);
  if (!check.ok) throw new Error(check.errors.join("\n"));
  ensureWorkspaceDirs(workspace);
  ensureTakeoverBaseline(workspace, packagedRuntime(), version);
  if (payload.config) applySetupConfig(workspace, payload.config);
  settings = patchSettings(settings, {
    workspace,
    workspaceMode: "takeover",
    runtimeVersion: version,
    appPort: null,
    runnerPort: null,
  });
  const started = await startApp(workspace, { reload: true });
  if (started) closeSetupWindowSoon();
  return {
    version,
    copied: 0,
    skipped: 0,
    conflicts: [],
    backupPath: null,
    error: null,
  };
}

function closeSetupWindowSoon(): void {
  // 等 IPC 响应发回渲染进程后再关窗，避免 invoke 被中断
  setTimeout(() => {
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
  }, 300);
}

function bootstrap(): Bootstrap {
  return {
    workspace: settings.workspace,
    appPort: supervisor?.appPort ?? settings.appPort ?? 0,
    runnerPort: supervisor?.runnerPort ?? settings.runnerPort ?? 0,
    version: app.getVersion(),
    runtimeVersion: settings.runtimeVersion,
    isPackaged: app.isPackaged,
  };
}

function saveSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  settings = patchSettings(settings, patch);
  if ("autoLaunchAtLogin" in patch) {
    app.setLoginItemSettings({ openAtLogin: settings.autoLaunchAtLogin });
  }
  return settings;
}

async function registerSwaggerMcp(): Promise<void> {
  const script = path.join(settings.workspace, "scripts", "sync-swagger.mjs");
  if (!fs.existsSync(script)) {
    await dialog.showMessageBox({
      type: "warning",
      title: "配置 Swagger MCP",
      message: "工作区里没有 scripts/sync-swagger.mjs",
    });
    return;
  }
  const nodeCmd = fs.existsSync(packagedNodeExe()) ? packagedNodeExe() : "node";
  try {
    const { stdout } = await execFileAsync(nodeCmd, [script], {
      cwd: settings.workspace,
      env: { ...process.env, PATH: enrichedPath(), NODE_CMD: nodeCmd },
      windowsHide: true,
      timeout: 120_000,
    });
    await dialog.showMessageBox({
      type: "info",
      title: "配置 Swagger MCP",
      message: "执行完成",
      detail: stdout.slice(-2000) || "（无输出）",
    });
  } catch (e) {
    const err = e as { message?: string; stdout?: string; stderr?: string };
    const detail = [err.stderr, err.stdout].filter(Boolean).join("\n").trim().slice(-4000);
    await dialog.showMessageBox({
      type: "error",
      title: "配置 Swagger MCP 失败",
      message: err.message ?? String(e),
      detail: detail || "（无更多输出）",
    });
  }
}

async function runDoctorReport(): Promise<DoctorReport> {
  return runDoctor(settings.claudePath);
}

async function quitFlow(): Promise<void> {
  const active = settings.workspace ? countActiveRuns(settings.workspace) : 0;
  if (active > 0) {
    const result = dialog.showMessageBoxSync({
      type: "warning",
      title: "有任务进行中",
      message: `有 ${active} 个任务进行中`,
      detail: "退出将中断会话（下次启动可恢复现场），确定退出？",
      buttons: ["取消", "退出并中断"],
      defaultId: 0,
      cancelId: 0,
    });
    if (result !== 1) return;
  }

  quitting = true;
  try {
    await supervisor?.stop();
  } catch (e) {
    log.error("[main] supervisor stop failed", e);
  }
  removeDesktopLock(settings.workspace);
  log.info("[main] bye");
  app.exit(0);
}

async function openWorkspaceFolder(): Promise<void> {
  if (!settings.workspace) return;
  const result = await shell.openPath(settings.workspace);
  if (result) log.warn(`[main] openPath: ${result}`);
}

// ---------------- app lifecycle ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  initLogging();

  app.on("second-instance", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else if (settings.workspace) {
      loadMainWindow();
    }
  });

  void app
    .whenReady()
    .then(async () => {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.mkdirSync(appDataDir(), { recursive: true });
    log.info(`[main] febot-desktop ${app.getVersion()} starting (packaged=${app.isPackaged})`);

    // 仅允许本地回环 + 必要的外部打开；关掉远程调试与危险权限
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false)
    );

    registerIpc({
      bootstrap,
      settings: () => settings,
      saveSettings,
      validateWorkspace: (dir, mode): WorkspaceCheck => validateWorkspaceImpl(dir, { mode }),
      finishSetup,
      restartServices,
      runDoctor: runDoctorReport,
      openWorkspace: openWorkspaceFolder,
      showMainWindow: async () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else if (settings.workspace) {
          await startApp(settings.workspace);
        }
      },
    });

    buildMenu({
      openWorkspace: () => void openWorkspaceFolder(),
      openConfig: () => {
        if (settings.workspace) void openConfigFile(settings.workspace);
      },
      openLogs: () => void shell.openPath(logsDir()),
      restartNext: () => {
        if (supervisor) {
          void supervisor.restart("next").then(loadMainWindow).catch((e) =>
            showErrorWindow(e instanceof Error ? e.message : String(e))
          );
        }
      },
      restartRunner: () => {
        void supervisor?.restart("runner").catch((e) =>
          showErrorWindow(e instanceof Error ? e.message : String(e))
        );
      },
      runDoctor: () => {
        void runDoctorReport().then((report) => {
          const lines = report.items.map(
            (i) => `${i.ok ? "✓" : "✗"} ${i.label}：${i.detail}`
          );
          void dialog.showMessageBox({
            type: report.ok ? "info" : "warning",
            title: "环境自检",
            message: report.ok ? "硬依赖齐全" : "存在缺失的硬依赖",
            detail: lines.join("\n"),
          });
        });
      },
      registerSwaggerMcp: () => void registerSwaggerMcp(),
      checkUpdate: () => void checkForUpdatesNow(),
      quit: () => void quitFlow(),
    });

    tray = createTray({
      showMain: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else if (settings.workspace) {
          loadMainWindow();
        }
      },
      restartServices: () => void restartServices(),
      openWorkspace: () => void openWorkspaceFolder(),
      openLogs: () => void shell.openPath(logsDir()),
      quit: () => void quitFlow(),
    });

    initUpdater({
      workspace: () => settings.workspace,
      canRestart: () => countActiveRuns(settings.workspace) === 0,
    });
    log.info("[main] 托盘 / 菜单 / 更新器就绪");

    if (settings.workspace) {
      if (settings.workspaceMode === "takeover" && !fs.existsSync(settings.workspace)) {
        createSetupWindow();
      } else {
        await startApp(settings.workspace);
      }
    } else {
      createSetupWindow();
    }

    // 冒烟测试用：开发模式下 N 秒后走正常退出流程（验证 runner shutdown + 进程树清理）
    const smokeQuitMs = Number(process.env.FEBOT_DESKTOP_SMOKE_QUIT_MS ?? 0);
    if (!app.isPackaged && smokeQuitMs > 0) {
      log.info(`[main] 冒烟退出已安排：${smokeQuitMs}ms 后执行正常退出流程`);
      setTimeout(() => void quitFlow(), smokeQuitMs);
    }
    })
    .catch((e) => {
      log.error("[main] whenReady failed", e);
      showErrorWindow(e instanceof Error ? e.message : String(e));
    });

  app.on("activate", () => {
    if (mainWindow) mainWindow.show();
    else if (settings.workspace) void startApp(settings.workspace);
    else createSetupWindow();
  });

  app.on("window-all-closed", () => {
    // 托盘常驻：关闭窗口不退出应用（显式监听即可覆盖 Electron 的默认退出）
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    void quitFlow();
  });
}