/**
 * 提交前检查的任务表（FND-007）。
 *
 * 为什么用 `.mjs` 而不是 `.js`：package.json 没有 `"type": "module"`，
 * `.js` 会被当作 CommonJS 解析，而本文件用的是 ESM 语法。
 *
 * ## 边界（改动前请先读完这一段）
 *
 * 1. **只做「格式化 + 自动修复」，不跑 typecheck / test / build。**
 *    完整门禁由 CI 的 `ci-gate` 负责。提交前检查必须秒级返回，否则会被
 *    `--no-verify` 绕过，规范反而失效。
 *
 * 2. **ESLint 只拦 error，刻意不带 `--max-warnings=0`。**
 *    零警告政策的唯一权威闸门是 CI 的全仓 `eslint . --max-warnings=0`。
 *    单文件子集与全仓结果不保证等价（部分规则依赖跨文件视角），在子集上开
 *    零容忍会制造「本地错拦 / 漏拦」的困惑。⇒ **请勿在此处补 `--max-warnings=0`。**
 *
 * 3. **`--no-warn-ignored` 是为消除一条误导性警告。**
 *    `prototype/` 这类「已提交但被 ESLint 全局忽略」的文件一旦进入暂存区，
 *    ESLint 会打印 `File ignored because of a matching ignore pattern`。
 *    它不是错误，但会让人误以为检查没跑。该参数仅在 flat config 下可用，
 *    而本项目正是 flat config。
 *
 * 4. **顺序固定为 `eslint --fix` 在前、`prettier --write` 在后。**
 *    排版以 Prettier 为最终准绳，与 `eslint-config-prettier` 的分工一致。
 *
 * ## 两个由 lint-staged 默认保证、不需要额外配置的机制
 *
 * - 文件集完全由 git 暂存区决定；未暂存改动会被 stash 保护，任务结束后还原。
 * - 任务产生的修改只要没有错误，就会被自动重新加入暂存区，无需手写 `git add`。
 *
 * ## `doc/` 的豁免不在本文件里维护
 *
 * `.prettierignore` 已忽略整个 `doc/`，且 Prettier 对「已忽略但被显式传入」的
 * 文件静默跳过（实测退出码 0）。单一来源优于两处清单——两处清单必然漂移。
 */

/**
 * 需要 ESLint 参与的文件类型。
 * 无斜杠的 glob 走 picomatch 的 `matchBase`，按 basename 匹配，子目录同样命中。
 */
const LINTABLE_CODE = '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

/**
 * 只需格式化的文件类型。
 * ESLint 本来也不处理这些，交给 Prettier 即可。
 */
const FORMAT_ONLY = '*.{json,css,scss,yml,yaml,md,html}';

/**
 * 提交前检查的任务表。
 *
 * 刻意赋给具名常量后再导出（而不是直接 `export default {...}`）：匿名默认导出会让
 * `import/no-anonymous-default-export` 报警，且调试与堆栈信息会失去可读的标识。
 * 与 `eslint.config.mjs` 保持同一写法。
 */
const config = {
  [LINTABLE_CODE]: ['eslint --fix --no-warn-ignored', 'prettier --write'],
  [FORMAT_ONLY]: 'prettier --write',
};

export default config;
