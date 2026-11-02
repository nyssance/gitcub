# upstream/

逐行照搬自 [GitHub Desktop](https://github.com/desktop/desktop)（MIT）的代码。

## 唯一的规矩：这里的文件一行都不改

改了就意味着每次同步上游都要处理冲突。需要适配时，用下面三种方式之一，
**都在 upstream/ 之外**：

| 缺什么 | 怎么补 |
|---|---|
| 全局变量（如 `log`）、被移除的全局类型（如 `JSX`） | `upstream/globals.d.ts` 里 `declare` |
| 编译规则冲突（未使用参数等） | 根 `tsconfig.json` 放宽，我们自己的代码靠 linter 管 |
| 要接 Tauri / 改行为 | 在 `src/lib/` 写适配层，调用这里的函数 |

## 同步上游

```sh
fab vendor-status   # 只看哪些文件有变化、落后多少 commit
fab vendor-sync     # 覆盖并更新 .source-commit
fab check           # 行为由测试兜底
```

文件清单在 `fabfile.py` 的 `_VENDOR_RECIPES`，当前同步点在 `.source-commit`。
加文件就在配方里加一条路径。
