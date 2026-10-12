import path from "node:path";
import * as ts from "typescript";
import { createSource, readScript, readSfcParts } from "./ast";
import type { ComponentEmits, EventEdge } from "./channel-types";
import { toRepoRel } from "./ignore";
import { createLiteralResolver } from "./literals";
import { resolveModuleFile } from "./resolve";
import type { ComponentGraph, ProjectMap } from "./types";

/**
 * 组件 emit 事件链。
 *
 * 渲染树是**父 → 子**；emit 是**子 → 父**的反向通道，过去完全没有。
 *
 * 三个实测反直觉点（不处理会大面积漏）：
 * 1. **emit 的局部变量名要绑定** —— 仓里写的是 `const emits = defineEmits(...)` 然后
 *    `emits("update", v)`，只找 `emit(` 会漏
 * 2. **两种声明形态** —— `defineEmits<IEmits>()`（类型，要解析本地或 import 的 interface）
 *    与 `defineEmits(["listComplete"])`（字面量数组）
 * 3. **`v-model` 是隐式事件** —— 等价于 `@update:modelValue`，不展开的话这些组件
 *    看着"没有任何事件"
 */

/** `my-event` → `myEvent`；`update:model-value` → `update:modelValue` */
export function normalizeEvent(name: string): string {
  const camel = (s: string): string => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  return name.split(":").map(camel).join(":");
}

/** 从类型字面量里取事件名：`{ change: [id: number] }` 与 `{ (e: "change"): void }` 两种 */
function emitNamesFromTypeLiteral(node: ts.TypeLiteralNode): string[] {
  const out: string[] = [];

  for (const m of node.members) {
    // 属性式：change: [id: number]
    if ((ts.isPropertySignature(m) || ts.isMethodSignature(m)) && m.name) {
      if (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) out.push(m.name.text);
      continue;
    }
    // 调用签名式：(e: "change", id: number) => void
    if (ts.isCallSignatureDeclaration(m)) {
      const first = m.parameters[0];
      const t = first?.type;
      if (t && ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) out.push(t.literal.text);
    }
  }

  return out;
}

/** 解析 `defineEmits<T>()` 里的 T：内联类型字面量 / 本地 interface / import 过来的 */
function resolveEmitType(
  typeNode: ts.Node | undefined,
  absFile: string,
  repoRoot: string,
  srcDirRel: string | null,
  depth = 0,
): string[] {
  if (!typeNode || depth > 2) return [];

  if (ts.isTypeLiteralNode(typeNode)) return emitNamesFromTypeLiteral(typeNode);

  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const name = typeNode.typeName.text;
    const sf = loadSource(absFile);
    if (!sf) return [];

    // 本地 interface / type
    for (const stmt of sf.statements) {
      if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) {
        // 直接按成员解析，不绕 TypeLiteralNode 的构造
        return emitNamesFromTypeLiteral({ members: stmt.members } as ts.TypeLiteralNode);
      }
      if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name) {
        return resolveEmitType(stmt.type, absFile, repoRoot, srcDirRel, depth + 1);
      }
      // `interface X extends Y` 之类不追 —— 够用，不硬猜
    }

    // import { X } from "..."
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const spec = stmt.moduleSpecifier;
      if (!ts.isStringLiteral(spec)) continue;
      const bindings = stmt.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const hit = bindings.elements.find(el => el.name.text === name);
      if (!hit) continue;

      const target = resolveModuleFile(spec.text, absFile, repoRoot, srcDirRel);
      if (!target) return [];
      return resolveEmitType(
        ts.factory.createTypeReferenceNode(name),
        path.join(repoRoot, target),
        repoRoot,
        srcDirRel,
        depth + 1,
      );
    }
  }

  return [];
}

/** 子组件是不是「靠 $attrs 转发事件的纯包装」 */
function isAttrsPassthrough(repoRoot: string, childRel: string): boolean {
  const parts = readSfcParts(path.join(repoRoot, childRel));
  return !!parts.template && /\$attrs/.test(parts.template);
}

const sourceCache = new Map<string, ts.SourceFile | null>();

function loadSource(absFile: string): ts.SourceFile | null {
  if (sourceCache.has(absFile)) return sourceCache.get(absFile) ?? null;
  const script = readScript(absFile);
  const sf = script ? createSource(script.code, absFile) : null;
  sourceCache.set(absFile, sf);
  return sf;
}

export function buildComponentEmits(repoRoot: string, filesAbs: string[]): ComponentEmits[] {
  const out: ComponentEmits[] = [];

  for (const absFile of filesAbs) {
    if (!absFile.toLowerCase().endsWith(".vue")) continue;

    const script = readScript(absFile);
    if (!script) continue;
    // 四种写法都要放进来：defineEmits / this.$emit / Options API 的 emits 选项 / setup 的 emit 解构
    if (!/emit/i.test(script.code)) continue;

    const rel = toRepoRel(repoRoot, absFile);
    const sf = createSource(script.code, absFile);
    const literals = createLiteralResolver(absFile, repoRoot, null);
    const lineOf = (n: ts.Node): number =>
      sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 + script.lineOffset;

    let declared: string[] = [];
    let style: ComponentEmits["style"] = "none";
    /** 直接可调用的 emit 名：defineEmits 的返回值、setup(props,{ emit }) 的解构 */
    const bindings = new Set<string>();
    /** `setup(props, ctx)` 里的 ctx 名，后面用 ctx.emit(...) */
    const ctxNames = new Set<string>();

    for (const stmt of sf.statements) {
      // --- 形态一/二：const emit = defineEmits<T>() / defineEmits([...]) ---
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          const init = d.initializer;
          if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) continue;
          if (init.expression.text !== "defineEmits") continue;

          bindings.add(d.name.text);

          const a0 = init.arguments[0];
          if (a0 && ts.isArrayLiteralExpression(a0)) {
            style = "array";
            for (const el of a0.elements) {
              const v = literals.resolveString(el);
              if (v) declared.push(v);
            }
            continue;
          }

          const typeArgs = init.typeArguments;
          if (typeArgs && typeArgs.length > 0) {
            style = "type";
            declared = resolveEmitType(typeArgs[0], absFile, repoRoot, null);
          }
        }
      }

      // --- 形态三/四：Options API 的 `emits: [...]` 与 `setup(props, { emit })` ---
      const visitOptions = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "emits") {
          const init = node.initializer;
          if (ts.isArrayLiteralExpression(init)) {
            style = "array";
            for (const el of init.elements) {
              const v = literals.resolveString(el);
              if (v) declared.push(v);
            }
          } else if (ts.isObjectLiteralExpression(init)) {
            // `emits: { save: null, cancel: (v) => true }`
            style = "type";
            for (const p of init.properties) {
              const nm = (p as ts.PropertyAssignment).name;
              if (nm && (ts.isIdentifier(nm) || ts.isStringLiteral(nm))) declared.push(nm.text);
            }
          }
        }

        if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "setup") {
          const second = node.parameters[1];
          if (second && ts.isObjectBindingPattern(second.name)) {
            for (const el of second.name.elements) {
              if (ts.isIdentifier(el.name)) bindings.add(el.name.text);
            }
          } else if (second && ts.isIdentifier(second.name)) {
            ctxNames.add(second.name.text);
          }
        }

        ts.forEachChild(node, visitOptions);
      };
      visitOptions(stmt);
    }

    // emit 调用点：X("event", ...)、this.$emit("event")、useVModel(props, "state", emits)
    const calls: ComponentEmits["calls"] = [];
    {
      const pushCall = (event: string, line: number, binding: string): void => {
        calls.push({ line, event: normalizeEvent(event), binding });
      };

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;

          if (ts.isIdentifier(callee)) {
            const name = callee.text;

            if (bindings.has(name)) {
              const event = literals.resolveString(node.arguments[0]);
              if (event) pushCall(event, lineOf(node), name);
            }

            // @vueuse/core 的 useVModel(props, "state", emits) —— 等价于声明并发出
            // `update:state`。不识别的话这类双向绑定组件看着"没有事件"。
            if (name === "useVModel") {
              const key = literals.resolveString(node.arguments[1]);
              if (key) {
                pushCall(`update:${key}`, lineOf(node), name);
                declared.push(`update:${key}`);
                if (style === "none") style = "type";
              }
            }
          }

          if (ts.isPropertyAccessExpression(callee)) {
            // Options API：this.$emit("event", ...)
            if (callee.name.text === "$emit") {
              const event = literals.resolveString(node.arguments[0]);
              if (event) pushCall(event, lineOf(node), "$emit");
            }
            // setup(props, ctx) → ctx.emit("event", ...)
            if (
              callee.name.text === "emit" &&
              ts.isIdentifier(callee.expression) &&
              ctxNames.has(callee.expression.text)
            ) {
              const event = literals.resolveString(node.arguments[0]);
              if (event) pushCall(event, lineOf(node), `${callee.expression.text}.emit`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    if (declared.length === 0 && calls.length === 0) continue;

    out.push({
      file: rel,
      declared: [...new Set(declared.map(normalizeEvent))].sort(),
      calls,
      style,
    });
  }

  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * handler 里调了什么（api / store action / router 都在这）。
 *
 * 必须**全树查找**声明：repo-e 的 `executCompletedSave` 声明在嵌套作用域里
 * （`const executCompletedSave = async () => {...}`，后面还被塞进某个 `return {}`），
 * 只扫顶层语句会漏。
 */
function handlerEffects(absFile: string, handler: string): string[] {
  const sf = loadSource(absFile);
  if (!sf) return [];

  const effects = new Set<string>();

  const collectFrom = (body: ts.Node): void => {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        if (ts.isIdentifier(n.expression)) effects.add(n.expression.text);
        else if (ts.isPropertyAccessExpression(n.expression)) effects.add(n.expression.name.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
  };

  const findDecl = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === handler && node.body) {
      collectFrom(node.body);
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === handler) {
      const init = node.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        collectFrom(init.body);
        return;
      }
    }
    ts.forEachChild(node, findDecl);
  };

  findDecl(sf);
  return [...effects].sort();
}

/**
 * 子 → 父的事件边。
 * `from` = 子组件（emit 方），`to` = 父组件（监听方），与渲染树方向相反。
 */
export function buildEventEdges(map: ProjectMap): EventEdge[] {
  const graph: ComponentGraph = map.components;
  const emitsByFile = new Map(map.componentEmits.map(e => [e.file, e]));
  const edges: EventEdge[] = [];

  for (const [parentRel, bindings] of Object.entries(graph.eventBindings ?? {})) {
    const parentAbs = path.join(map.repo.path, parentRel);

    for (const b of bindings) {
      const event = normalizeEvent(b.event);
      const child = emitsByFile.get(b.child);

      // 子组件没声明也没 emit 过这个事件 —— 可能是透传或动态 emit，仍然记边但标注
      const declared = child?.declared.includes(event) ?? false;
      const emitted = child?.calls.some(c => c.event === event) ?? false;

      const matched = declared || emitted;
      // 透传包装：子组件自己不发事件，靠 `v-bind="$attrs"` 转给内部组件。
      // 这类「找不到 emit」是正常的，标出来免得当成缺陷。
      const passthrough = !matched && isAttrsPassthrough(map.repo.path, b.child);

      edges.push({
        from: b.child,
        to: parentRel,
        event,
        handler: b.handler,
        handlerAt: `${parentRel}:${b.line}`,
        via: b.via,
        effects: b.handler && !b.handler.includes(".") ? handlerEffects(parentAbs, b.handler) : [],
        ...(matched ? {} : { unmatched: true }),
        ...(passthrough ? { passthrough: true } : {}),
      });
    }
  }

  return edges.sort(
    (a, b) => a.from.localeCompare(b.from) || a.event.localeCompare(b.event) || a.to.localeCompare(b.to),
  );
}
