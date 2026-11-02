/** 给 upstream/ 下照搬的文件补齐它们在原版环境里依赖的全局声明。
 *
 * 原则：**upstream/ 下的文件一行都不改**，这样每次同步上游都是机械覆盖，
 * 不会有冲突。它们缺什么，就在这里补，或在 tsconfig 里放宽规则。 */

/** 原版由 Electron 主进程注入的全局 logger。 */
declare const log: {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

/** React 19 移除了全局 JSX 命名空间，而原版（React 16）的代码还在用
 *  `JSX.Element` 这种写法。补一个指向 React 的别名。 */
declare namespace JSX {
  type Element = import("react").JSX.Element;
  type ElementClass = import("react").JSX.ElementClass;
  type IntrinsicElements = import("react").JSX.IntrinsicElements;
}
