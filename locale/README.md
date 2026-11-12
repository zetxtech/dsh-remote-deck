# 英文界面词条表（`locale/en-ui.json`）

Remote Deck 客户端（`client.js`）的中文界面文案 → 英文。运行时以**中文原文作为 key** 查表：命中显示英文，未命中回退中文原文。因此本文件只做"查表"用途，不改变任何代码行为。

- 词条数：**443** 条（完整字符串 339 条 + 参数化模板 104 条）
- 数据来源：`client.js` 的字符串字面量（生成时的快照；若之后代码新增中文文案，需要补词条）

## 1. 格式

- 扁平 JSON 对象，`{ "中文原文": "English" }`，不嵌套、不带注释。
- UTF-8（无 BOM），2 空格缩进，末尾换行；key 按 Unicode 码点排序（JS `Array#sort` 的默认顺序），保证每次生成 diff 稳定。
- key 必须与 `client.js` 里的中文字符串**逐字符一致**，包括：全角标点（`（）：，。？！…`）、`·`、`「」`、数字区间里的 `–`、以及**首尾空格**。
- 少数 key 以空格开头/结尾（代码拼接时真实存在的形态），**不要 trim**：

  | key | 说明 |
  | --- | --- |
  | `" 等"` | 列表后缀，如 `A、B、C` + `" 等"` |
  | `" · 只读（编码无法无损写回）"` | 编辑器状态栏后缀，保留前导 ` · ` |
  | `"已检测到 {n} 个密钥：{keys} · "` | 末尾 ` · ` 是分隔符 |

- 只收录含汉字的字符串；纯英文、技术标识、注释、正则表达式不在表内（见 §4）。插件元数据（`locale/en.json`、`locale/zh.json`）与本表无关，未改动。

```json
{
  "上传到此处": "Upload here",
  "已上传 {n} 个文件": "Uploaded {n} files",
  "保存中…": "Saving…"
}
```

## 2. 占位符规则

- 语法：`{name}`。名字以小写字母开头，只含字母/数字，语义化命名；不支持嵌套、默认值、转义或表达式。
- 同一个 key 中可以出现多个占位符；占位符之间可以夹中文标点或空格，这些字符原样保留在译文里。
- 运行时做一次全局替换即可（示意实现）：

```js
const t = (key, params) =>
  (dict[key] ?? key).replace(/\{([a-z][A-Za-z0-9]*)\}/g, (m, name) => params?.[name] ?? m)
```

- 参数名约定（同义场景保持同名）：

  | 占位符 | 含义 | 示例 |
  | --- | --- | --- |
  | `{n}` | 通用数量 | `已上传 {n}` / `{n} 个会话` |
  | `{name}` | 文件名、主机名、对象名 | `{name} 上传失败` |
  | `{path}` | 完整远端路径 | `已保存到 {path}` |
  | `{dirname}` | 目录名/当前目录（较短） | `上传文件到 {dirname}` |
  | `{size}` | 已格式化体积文本（如 `1.5 MiB`） | `超过 {size} 的文件…` |
  | `{sent}` / `{total}` | 已传字节数 / 总字节数（已格式化） | `已传 {sent} / {total}` |
  | `{percent}` | 百分比数值（不带 `%`） | `（已传 {percent}%，…）` |
  | `{time}` | 时间文本（`clockOf()` 的输出） | `更新于 {time}` |
  | `{host}` | 远端主机名 | `打开 {host} 的端口转发` |
  | `{port}` | 端口号 | `已转发到 {port}` |
  | `{limit}` | 上限的展示文本（如 `512 MB`） | `超过远端 {limit} 上限` |
  | `{count}` / `{index}` | 次数 / 序号 | `连续 {count} 次上传失败` |
  | `{message}` / `{reason}` | 错误详情文本 | `文件面板出错：{message}` |
  | `{done}` / `{failed}` | 成功数 / 失败数 | `成功 {done} / 失败 {failed}` |
  | `{files}` / `{dirs}` | 文件数 / 目录数 | `{files} 个文件、{dirs} 个目录` |
  | `{keys}` | 密钥文件名列表（已 join） | `已检测到 {n} 个密钥：{keys}` |
  | `{connected}` / `{workspaces}` | 在线主机数 / 工作区数 | `{connected} 台在线 · {workspaces} 个工作区` |
  | `{lines}` | 行数 | `{lines} 行 · …` |
  | `{status}` | 状态词（本身也是词条） | `{lines} 行 · {size} · {status}` |
  | `{encoding}` | 编码名（`UTF-8`、`GBK` 等） | `按 {encoding} 打开` |
  | `{section}` | 监控指标名（CPU / Memory / Disk 的词条） | `{section} 告警阈值` |
  | `{value}` / `{threshold}` | 指标值 / 阈值 | `{section} {value} 超过 {threshold}%` |
  | `{mount}` / `{available}` | 挂载点 / 可用空间 | `{mount} · {available} 可用 / {total}` |
  | `{items}` | 已 join 的并列项 | `其中 {items} 将被跳过。` |
  | `{state}` | 开关状态词（`开`/`关` 的词条） | `自动连接：{state}` |

- **参数值本身也要走同一张表**：`{state}` 传 `t('开')`，`{section}` 传 `t('内存')`，`{status}` 传 `t('已保存')`，`{reason}` / `{message}` 传已经翻译过的错误文本。否则英文句子里夹中文。
- 英文不做复数、时态、格的变化：模板按常见数量写（如 `{n} files`）。需要严格的单复数/`Moved` vs `Move` 时，在调用侧拆成两条 key 或单独处理。
- 参数缺失时，示例实现会保留 `{name}` 原样，便于暴露漏传。
- **模板 key 在 `client.js` 里不是整串字面量**，这是正常的。可验证性规则：去掉所有 `{…}` 后，剩下的每个中文字段都必须能在 `client.js` 的字符串字面量里找到；本文件即按此规则校验。

## 3. 提取与过滤规则（本次生成方式）

1. 对 `client.js` 做词法扫描：跳过 `//`、`/* */` 注释、正则字面量、模板字符串；收集单引号/双引号字符串字面量。
2. 只保留含汉字的字符串（`[\u4e00-\u9fff]`），按**运行时值**（去转义后）去重。
3. 对 `+` 拼接：只出现在拼接里的 **127** 个片段不单独立条，而是合并成 **104** 条带 `{占位符}` 的模板；完整字符串直接成条。
4. 过滤掉：注释里的中文、正则里的中文、技术标识、纯英文/专有名词、无汉字的中文标点（详见 §4）。
5. 生成后自检：JSON 可解析、无重复 key、无空值；每条 key 都能在 `client.js` 找到（完整字面量逐字匹配；模板按片段匹配）；127 个拼接片段全部被模板覆盖。

## 4. 有意不翻译的清单

1. **代码注释**——不进入 UI。例如 `// The built-in 工作区文件 page offers an action slot…`、`// … offers 放弃修改并关闭 instead.`。
2. **用于匹配后端错误文本的正则**——`/timeout|超时/`、`/transfer_too_large|too large|超过.*上限|512mb/`：必须保留中文才能命中，翻译会导致错误映射失效。
3. **技术标识与协议字段**——`rd-*` / `remote-deck-*` 类名与 id、`data-*`（如 `data-rd-theme`）、`remote_forward`（工具名，出现在译文句子里时保留原样）、`dsh-resource://…`、`x-dsh-remote-token`、错误码（`EXISTS`、`OFFSET_MISMATCH`、`TRANSFER_TOO_LARGE` 等）、CodeMirror mode 名（`javascript`、`htmlmixed` 等）、文件扩展名列表。
4. **专有名词与单位**——Remote Deck、DSH、SSH、SFTP、CodeMirror、CPU、Memory、Disk、MiB、MB、ms、%；以及 `~/.ssh/config`、`/etc/hosts`、`known_hosts`、`sshd` 等路径/命令名。这些在英文句子里原样保留，不改成"兆字节"之类的意译。
5. **无汉字的中文标点连接符**——`'，'`（`parts.join('，')`）、`'、'`（列表 join）、`'。'`（打包摘要末尾句号）。它们不在词条表里，需要实现方在拼接处按语言替换（例如英文用 `", "`、`"."`）。`'（'` / `'）'` / `'「'` / `'」'` 大多已随模板 key 成对收录，只有独立拼接的括号需要单独处理。
6. `aria-*` / `title` 中的中文是**用户可见**的提示与无障碍标签，**已收录翻译**；只有纯技术标识（如 `rd-set-field-…`）不收录。

## 5. 运行时拼接 → 建议 key（40 条常见形式）

| 源码写法（示意） | 建议 key | English |
| --- | --- | --- |
| `'已上传 ' + done + ' 个文件'` | `已上传 {n} 个文件` | Uploaded {n} files |
| `'已上传 ' + done` | `已上传 {n}` | Uploaded {n} |
| `name + ' 上传失败'` | `{name} 上传失败` | {name} failed to upload |
| `'删除 ' + targets.length + ' 项'` | `删除 {n} 项` | Delete {n} items |
| `'已永久删除 ' + done + ' 项'` | `已永久删除 {n} 项` | Deleted {n} items permanently |
| `'已永久删除 ' + list[0].name` | `已永久删除 {name}` | Deleted {name} permanently |
| `'永久删除 ' + single.path` | `永久删除 {path}` | Permanently delete {path} |
| `'永久删除选中的 ' + targets.length + ' 项'` | `永久删除选中的 {n} 项` | Permanently delete the {n} selected items |
| `'永久删除 ' + targets.length + ' 项？'` | `永久删除 {n} 项？` | Permanently delete {n} items? |
| `'将永久删除 ' + targets.length + ' 项（含目录递归），不可恢复。'` | `将永久删除 {n} 项（含目录递归），不可恢复。` | This permanently deletes {n} items, including folders and everything inside them. It can't be undone. |
| `'已保存到 ' + result.localPath` | `已保存到 {path}` | Saved to {path} |
| `'已开始下载 ' + entry.name` | `已开始下载 {name}` | Downloading {name} |
| `'下载 ' + targets.length + ' 项（打包）'` | `下载 {n} 项（打包）` | Download {n} items (tar.gz) |
| `'已重命名为 ' + parsed.name` | `已重命名为 {name}` | Renamed to {name} |
| `'已新建文件夹 ' + parsed.name` | `已新建文件夹 {name}` | Created folder {name} |
| `'已新建文件 ' + parsed.name` | `已新建文件 {name}` | Created file {name} |
| `'上传中 ' + (done + failed + skipped) + '/' + list.length` | `上传中 {current}/{total}` | Uploading {current}/{total} |
| `'上传中 0/' + list.length` | `上传中 0/{total}` | Uploading 0/{total} |
| `'第 ' + (index + 1) + '/' + list.length + ' 个文件。可跳过此文件、跳过该目录，或停止本次上传。'` | `第 {index}/{total} 个文件。可跳过此文件、跳过该目录，或停止本次上传。` | File {index}/{total}. Skip this file, skip its folder, or stop the upload. |
| `'「' + name + '」超过远端 ' + uploadLimitLabel(...) + ' 上限，未上传。'` | `「{name}」超过远端 {limit} 上限，未上传。` | {name} exceeds the remote {limit} limit; not uploaded. |
| `'创建目录失败：' + message` | `创建目录失败：{message}` | Couldn't create folder: {message} |
| `'文件面板出错：' + friendlyText(error)` | `文件面板出错：{message}` | File panel error: {message} |
| `'其中 ' + skipped.join('、') + '将被跳过。'` | `其中 {items} 将被跳过。` | {items} will be skipped. |
| `'将打包 ' + countOf(scan.files) + ' 个文件' + (size ? '（约 ' + size + '）' : '') + '。'` | `将打包 {files} 个文件（约 {size}）。` 或 `将打包 {files} 个文件。` | Archive {files} files (about {size}). |
| `'超过 ' + formatBytes(EDIT_MAX_BYTES) + ' 的文件不在编辑器里打开：只载入一部分会让保存截断原文件。'` | `超过 {size} 的文件不在编辑器里打开：只载入一部分会让保存截断原文件。` | Files larger than {size} don't open in the editor: loading only part of one would truncate it on save. |
| `'按 ' + guessedEncoding.toUpperCase() + ' 打开'` | `按 {encoding} 打开` | Open as {encoding} |
| `'检测到未保存的草稿（' + clockOf(draftOffer.savedAt) + '）'` | `检测到未保存的草稿（{time}）` | Found an unsaved draft ({time}) |
| `'在远端文件中打开 ' + (absolutePath \|\| remote.path)` | `在远端文件中打开 {path}` | Open in remote files: {path} |
| `'把 ' + entry.path + ' 添加为 DSH 工作区'` | `把 {path} 添加为 DSH 工作区` | Add {path} as a DSH workspace |
| `'上传文件到 ' + currentDir` | `上传文件到 {dirname}` | Upload files to {dirname} |
| `'打包下载 ' + currentDir + '（tar.gz）'` | `打包下载 {dirname}（tar.gz）` | Download {dirname} (tar.gz) |
| `'在 ' + currentDir + ' 下新建文件夹'` | `在 {dirname} 下新建文件夹` | New folder in {dirname} |
| `'正在打包 ' + paths.length + ' 项…'` | `正在打包 {n} 项…` | Archiving {n} items… |
| `'已选 ' + selection.length + ' 项'` | `已选 {n} 项` | {n} selected |
| `'已传 ' + formatBytes(task.sent) + ' / ' + formatBytes(task.total)` | `已传 {sent} / {total}` | {sent} of {total} uploaded |
| `job.name + '（已传 ' + percent + '%，请重新选择该文件继续）'` | `{name}（已传 {percent}%，请重新选择该文件继续）` | {name} ({percent}% uploaded; choose the same file to continue) |
| `name + ' 连续 ' + UPLOAD_RETRY_LIMIT + ' 次上传失败：' + reason` | `{name} 连续 {count} 次上传失败：{reason}` | {name} failed to upload {count} times in a row: {reason} |
| `'已' + verb + ' ' + ok + ' 项'`（verb 为 `'移动'` / `'复制'`） | `已移动 {n} 项` / `已复制 {n} 项` | Moved {n} items / Copied {n} items |
| `'重命名 ' + single.path + '（F2）'` | `重命名 {path}（F2）` | Rename {path} (F2) |
| `'已检测到 ' + config.keys.length + ' 个密钥：' + keys.join('、') + ' · '` | `已检测到 {n} 个密钥：{keys} · ` | Found {n} keys: {keys} ·  |

> 其余模板可直接在 `en-ui.json` 中搜索 `{` 查看；完整 104 条都已入表。

## 6. 待确认 / 需要实现方留意的条目

以下条目在源码里缺少完整上下文或依赖布局，译文按最合理理解给出，落地时建议复查：

- `{n} 个` → `{n}`：用作"工作区"标题旁的数量（`工作区 3 个` → `Workspaces 3`）。若英文布局需要单位，可改为 `{n} total`。
- `已在 {host} 的工作区 · {n}` → `In {host}'s workspaces · {n}`：中文省略了动词，指"该主机上已有 N 个工作区"，英文措辞可再调整。
- `已转发` → `Active forwards`：作为列表小标题（原文直译是 "Forwarded"），按 UI 语境取了更自然的小标题。
- `确认移除` → `Remove`：原文带"确认"语气，但按钮在行内空间有限，按按钮惯例取 `Remove`。
- `开` / `关` → `On` / `Off`：只作为 `{state}` 参数使用。
- `" 等"` → `" and more"`：只作为 `A、B、C` 之后的后缀；英文保留前导空格，由调用方拼在前面。
- `正在加载 host…` → `Loading hosts…`：源码本身中英混排（`host` 是开发用词），译成自然英文。
- `未加载到编辑器组件` → `Editor component not loaded`：指 CodeMirror 引擎加载失败，如果更想强调引擎可改为 `Editor engine not loaded`。
- `远端工作台` → `Remote Deck`：这里指产品/设置分区名，不是字面的 "remote workbench"。
- `已移动 {n} 项` / `已复制 {n} 项`：源码是 `'已' + verb + ' ' + ok + ' 项'`，`verb` 由调用方传中文；建议把两个调用点直接改成这两条 key，不要保留动态中文动词（否则英文语序会错）。

## 7. 维护方式

1. 改 `client.js` 中文文案时同步改 key；新增"中文 + 变量 + 中文"的拼接时，补一条带 `{占位符}` 的模板，而不是把片段单独成条。
2. 生成/校验步骤（可写成脚本）：词法提取字符串字面量 → 过滤来源行是注释/正则的内容 → 去掉 `{…}` 后校验剩余片段都在 `client.js` 中 → 校验 127 个拼接片段全覆盖 → JSON 序列化（2 空格、排序、末尾换行）。
3. 词条表与代码是**同一次提交**的关系：本表基于 `client.js` 的某一版快照生成；之后的 UI 文案变更需要重新跑一遍校验，否则会出现"新增中文没有英文"的回退显示（功能上安全，只是英文界面会露出中文）。
