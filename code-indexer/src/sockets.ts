import * as ts from "typescript";
import { createSource, readScript, stringValue } from "./ast";
import type { SocketInfo } from "./channel-types";
import { toRepoRel } from "./ignore";
import { createLiteralResolver } from "./literals";

/**
 * WebSocket / SSE 连接点。
 *
 * **实测全 12 仓只有 3 处**，且都是 `hooks/use-socket` 包装式 —— 按计划「先数再建」，
 * 这里只做「定位 + 消息 type 清单」，不做完整的生命周期/重连抽取器。
 */

const CTORS = new Set(["WebSocket", "SockJS", "EventSource"]);

/** socket.io 的 `io(url)` —— 裸标识符调用，单独认 */
const SOCKET_IO_CALL = "io";

/**
 * 库组合式建连（@vueuse/core 的 `useWebSocket` 之类）。
 * 这些函数内部才 `new WebSocket`，直接找构造会漏。
 */
const SOCKET_COMPOSABLE_RE = /^(use)?(web)?socket|^useSocket|^createSocket/i;

export function buildSockets(repoRoot: string, filesAbs: string[]): SocketInfo[] {
  const out: SocketInfo[] = [];

  for (const absFile of filesAbs) {
    const script = readScript(absFile);
    if (!script) continue;
    // 快速跳过：文件里没有连接构造就不必建 AST
    if (!/WebSocket|SockJS|EventSource|\bio\s*\(/.test(script.code)) continue;

    const rel = toRepoRel(repoRoot, absFile);
    const sf = createSource(script.code, absFile);
    const literals = createLiteralResolver(absFile, repoRoot, null);
    const lineOf = (n: ts.Node): number =>
      sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 + script.lineOffset;

    /** 连接变量名 → 该连接的信息 */
    const byVar = new Map<string, SocketInfo>();
    const infos: SocketInfo[] = [];

    const visit = (node: ts.Node): void => {
      // new WebSocket("wss://...") / new SockJS(...) / new EventSource(...)
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const ctor = node.expression.text;
        if (CTORS.has(ctor)) {
          const info: SocketInfo = {
            file: rel,
            line: lineOf(node),
            ctor,
            url: literals.resolveString(node.arguments?.[0]),
            messagesHandled: [],
            messagesSent: [],
            dispatchFields: [],
            wrapper: null,
          };
          infos.push(info);
          const parent = node.parent;
          if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            byVar.set(parent.name.text, info);
          }
        }
      }

      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;

        // socket.io: io("url")
        // 库组合式: useWebSocket("wss://...") —— 内部才 new WebSocket，只找构造会漏
        const isSocketIo = name === SOCKET_IO_CALL;
        const isComposable = SOCKET_COMPOSABLE_RE.test(name) && name !== "io";

        if (isSocketIo || isComposable) {
          const info: SocketInfo = {
            file: rel,
            line: lineOf(node),
            ctor: isSocketIo ? "socket.io" : name,
            url: literals.resolveString(node.arguments[0]),
            messagesHandled: [],
            messagesSent: [],
            dispatchFields: [],
            wrapper: null,
          };
          infos.push(info);
          const parent = node.parent;
          if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            byVar.set(parent.name.text, info);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
    if (infos.length === 0) continue;

    // 消息 type 清单：`msg.type === "x"` / `.on("event")` / `.emit("x")`
    const messagesHandled = new Set<string>();
    const messagesSent = new Set<string>();
    /** handler 里按字段存在性分发的载荷字段 */
    const dispatchFields = new Set<string>();
    /** `.onmessage = handleMessage` 这类命名引用，要跟进它的函数体 */
    const handlerRefs = new Set<string>();

    const collect = (node: ts.Node): void => {
      // if (msg.type === "order_update")
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        const left = node.left;
        if (
          ts.isPropertyAccessExpression(left) &&
          ["type", "cmd", "action", "event", "code", "messageType"].includes(left.name.text)
        ) {
          const v = literals.resolveString(node.right);
          if (v) messagesHandled.add(v);
        }
      }

      // 按字段存在性分发：if (msg.monitor) / msg.respiratory && …
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const obj = node.expression.text;
        if (/^(msg|message|data|res|payload|rawData)$/i.test(obj)) dispatchFields.add(node.name.text);
      }

      // ws.onmessage = handleMessage —— handler 是命名引用，消息解析在它里面
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        ["onmessage", "onopen", "onclose"].includes(node.left.name.text) &&
        ts.isIdentifier(node.right)
      ) {
        handlerRefs.add(node.right.text);
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const m = node.expression.name.text;
        if (m === "emit" || m === "send" || m === "on" || m === "addEventListener") {
          const first = literals.resolveString(node.arguments[0]);
          if (first) {
            if (m === "emit") messagesSent.add(first);
            else if (m === "on") messagesHandled.add(first);
          }
        }
        // addEventListener("message", handleMessage)
        if (m === "addEventListener") {
          const fn = node.arguments[1];
          if (fn && ts.isIdentifier(fn)) handlerRefs.add(fn.text);
        }
      }

      ts.forEachChild(node, collect);
    };
    collect(sf);

    // 一跳跟进：扫 handler 引用的函数体
    for (const ref of handlerRefs) {
      const findDecl = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === ref && node.body) {
          collect(node.body);
          return;
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === ref) {
          const init = node.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            collect(init.body);
            return;
          }
        }
        ts.forEachChild(node, findDecl);
      };
      findDecl(sf);
    }

    for (const info of infos) {
      info.messagesHandled = [...messagesHandled].sort();
      info.messagesSent = [...messagesSent].sort();
      info.dispatchFields = [...dispatchFields].sort();
      // 封装层：连接构造落在导出函数体内
      info.wrapper = /\bexport\b/.test(script.code) ? rel : null;
    }

    out.push(...infos);
  }

  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
