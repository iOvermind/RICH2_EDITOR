// 測試用的 module hooks（由 loader.mjs 掛上，跑在 loader 執行緒）。
// 1. resolve：專案內的 import 是無副檔名的（Vite 會解析，node 不會），這裡補上 .ts
// 2. load：Node 22.18 以前不會自己剝型別，用專案已有的 typescript 現場轉譯。
//    tsconfig 有 erasableSyntaxOnly，所以「純剝型別」保證等價，不需要型別檢查。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const TS = /\.[cm]?ts$/i;
const ANY_EXT = /\.[cm]?[jt]s$/i;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !ANY_EXT.test(specifier)) {
    try { return await nextResolve(specifier + '.ts', context); } catch { /* 落回原本的解析 */ }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !TS.test(url)) return nextLoad(url, context);
  const fileName = fileURLToPath(url);
  const { outputText } = ts.transpileModule(await readFile(fileName, 'utf8'), {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  });
  return { format: 'module', shortCircuit: true, source: outputText };
}
