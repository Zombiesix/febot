"use client";

import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import type { Terminal } from "@xterm/xterm";

// xterm 封装：只负责渲染与输入，不持有 WS。
// 会话页把 output 事件写进来，把 onData / onResize 转发给 runner。
// xterm 在 effect 内动态 import，避免 SSR 阶段触碰 DOM。

export interface TerminalApi {
  write: (data: string) => void;
  reset: () => void;
  focus: () => void;
}

export default function TerminalPane({
  onData,
  onResize,
  onReady,
}: {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onReady: (api: TerminalApi) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<{ fit: () => void } | null>(null);
  const dataRef = useRef(onData);
  const resizeRef = useRef(onResize);
  // 回调写 ref 只在渲染提交后同步，避免在 render 期间改 ref（React 19 lint）
  useEffect(() => {
    dataRef.current = onData;
  }, [onData]);
  useEffect(() => {
    resizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;

      const term = new Terminal({
        convertEol: false,
        cursorBlink: true,
        fontSize: 13,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei", monospace',
        scrollback: 8000,
        allowProposedApi: true,
        theme: {
          background: "#0f1115",
          foreground: "#e6edf3",
          cursor: "#7aa2f7",
          selectionBackground: "#334155",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      try {
        fit.fit();
      } catch {
        // 容器尚未有尺寸
      }
      termRef.current = term;
      fitRef.current = fit;

      const emitResize = () => {
        try {
          fit.fit();
        } catch {
          // ignore
        }
        resizeRef.current(term.cols, term.rows);
      };
      emitResize();

      const sub = term.onData((data) => dataRef.current(data));
      const ro = new ResizeObserver(() => emitResize());
      ro.observe(hostRef.current);
      term.focus();

      onReady({
        write: (data: string) => {
          try {
            term.write(data);
          } catch {
            // ignore
          }
        },
        reset: () => {
          try {
            term.reset();
          } catch {
            // ignore
          }
        },
        focus: () => term.focus(),
      });

      cleanup = () => {
        sub.dispose();
        ro.disconnect();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
    // onReady 只用于交出 API，生命周期与组件一致
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative h-full min-h-[320px] w-full overflow-hidden rounded-lg bg-[#0f1115]">
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
