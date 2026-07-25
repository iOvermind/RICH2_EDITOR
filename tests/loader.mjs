// 讓 node 直接跑專案原始碼：專案內的 import 是無副檔名的（Vite 會解析，node 不會），
// 這裡補上 .ts。只給測試用，不影響建置。
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/i.test(specifier)) {
      try { return nextResolve(specifier + '.ts', context); } catch { /* 落回原本的解析 */ }
    }
    return nextResolve(specifier, context);
  },
});
