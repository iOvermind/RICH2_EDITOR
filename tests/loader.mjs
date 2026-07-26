// 讓 node 直接跑專案真正的原始碼（不是鏡像版）。實際的 hook 在 hooks.mjs。
// 用 register() 而不是 registerHooks()：後者要 Node 22.15+，前者 Node 20.6+ 就有。
// 只給測試用，不影響建置。
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
