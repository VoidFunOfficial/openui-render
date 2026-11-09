# AGENT.md：OpenUI 出图 Agent

本文件写给在服务器上工作的云端 Agent。你的任务是：按需求写一段 OpenUI 程序，用本仓库把它渲染成 PNG，亲自检查图片，合格后交付。

渲染使用 LearnGPT 聊天里的同一个页面（`/render`）和同一套组件，图片和用户在聊天里看到的一致。应用内的 `render2img` 工具也走这条渲染链路。

## 1. 环境

第一次使用时，在仓库根目录运行：

```bash
bash install.sh
```

脚本会安装 npm 依赖、创建 `.env.local`、准备无头浏览器（没有 Chrome 或 Chromium 时下载 Playwright 的 chromium-headless-shell）、在 Linux 上安装中文字体、构建生产版本，最后渲染 `.learnev/install-check.png` 自检。浏览器依赖的系统库和字体需要 root 或免密码 sudo，没有权限时脚本只给出警告。

只出图不需要 `OPENAI_API_KEY`，也不需要手动启动服务。

- 渲染页面来自 `.next` 中的生产构建。仓库代码更新后先运行 `npm run build`，否则图片还是旧组件的样子。
- 不要为了出图修改 `src/` 下的代码。你只写 `.oui` 文件。

## 2. 渲染命令

```bash
npm run render -- <文件.oui ...> [选项]
```

| 选项 | 说明 |
| --- | --- |
| `-o, --out <路径>` | 输出的 PNG，只能配合单个输入。默认和输入同名，扩展名换成 `.png` |
| `-w, --width <px>` | 视口宽度 320 到 1200，默认 480 |
| `--theme light\|dark` | 主题，默认 `light` |
| `--origin <地址>` | 使用已运行的 LearnGPT。默认读 `LEARNEV_RENDER_ORIGIN`，再试 `http://127.0.0.1:3000` |
| `--json` | 以 JSON 输出结果 |
| `-` | 代替文件名，从标准输入读程序 |

```bash
npm run render -- .learnev/out/card.oui                        # 生成 .learnev/out/card.png
npm run render -- report.oui -o .learnev/out/report.png -w 780
npm run render -- a.oui b.oui c.oui --json                      # 一条命令渲染多张，共用一个浏览器
cat page.oui | npm run render -- - -o page.png
```

- 路径相对于运行命令的目录。任务没有指定位置时，把文件放在 `.learnev/out/`，这个目录不进 git。
- 没有运行中的服务时，命令会用生产构建临时启动一个，渲染完自动关闭，每次约 3 秒。要连续出很多图，把多个文件放进一条命令，或者先另开终端运行 `npm start`。

### 读结果

每张图输出一行，有问题时下面逐条列出：

```text
card.png  480×822  light  没有问题（8 条语句）
bad.png  600×154  dark  1 个问题
  - x: Unknown component "Nope" — not found in catalog or builtins. Available components: ...
```

- `480×822` 是 CSS 像素。PNG 实际是 2 倍（960×1644）；页面高于 4000 px 时倍数会降低，6000 px 时约 1.3 倍。
- 高于 6000 px 的部分会被截掉，输出里会提示 `页面高 … px，图片只保留了前 6000 px`。截断不改变退出码，要自己留意。
- 退出码：`0` 全部成功且没有问题；`2` 已出图，但程序有问题；`1` 渲染失败，通常是环境问题或文件读不到。
- `--json` 输出一个数组。成功的项是 `{input, output, width, height, fullHeight, theme, statementCount, problems}`，`fullHeight` 大于 `height` 表示被截断；失败的项是 `{input, error}`。

| 问题 | 原因和改法 |
| --- | --- |
| `No OpenUI program found` | 没有以 `root =` 开头的行 |
| `Unknown component "X"` | 组件名写错或不存在。只能用参考中列出的组件 |
| `Referenced but never defined` | 引用了没有定义的名字。补上定义，或改正拼写 |
| `Defined but not reachable from root` | 定义了，但没有放进 root 的子树，不会显示 |
| `Skipped by the parser because they are outside quotes` | 引号外出现了中文或全角符号，见第 4 节 |
| `The program is truncated` | 括号或引号没有闭合 |
| `The view crashed while rendering` | 某个参数类型不对，例如在要数组的位置传了字符串 |
| `<语句名>: …` | 这条语句的参数有错，按提示修改 |

只有退出码为 0，并且图片本身合格，才算完成。

## 3. 工作流程

1. 开工前读完 `src/openui/system-prompt.txt`。它是 OpenUI 语言的完整参考：语法、每个组件的参数顺序和全部 `@` 函数。只能使用其中列出的组件和函数。教学类内容还要读 `src/openui/teaching-guide.md`。
2. 定下这张图的主题、读者和宽度（见第 6 节）。一张图只讲一件事，内容多就拆成几张。
3. 写 `.oui` 文件。文件里只放程序，不要 Markdown 代码围栏，也不要说明文字。
4. 渲染。退出码为 2 时按问题列表逐条修改；退出码为 1 时看第 9 节。
5. 打开 PNG 亲自看，按第 7 节逐条检查。退出码为 0 只说明程序能解析，不说明图片好看。
6. 修改后重新渲染，直到没有问题、图片合格。通常两三轮就够；五轮后还有问题，就简化设计。
7. 交付 PNG 的路径，同时保留 `.oui` 源文件，方便以后修改。

## 4. 语法要点

完整规则见 `src/openui/system-prompt.txt`。下面是最常出错的地方。

- 第一行是 `root = Col([...])`。每行一条 `名字 = 表达式`。
- 参数按位置传，不支持 `name: value` 的写法。末尾的参数可以省略；要跳过中间的参数，写 `null`。
- 名字、`$` 状态、`@` 函数和 `.字段` 只能用 ASCII。中文只能出现在双引号字符串里。引号外的括号、逗号、冒号和引号都必须是半角。解析器会悄悄丢掉引号外的非 ASCII 字符，渲染结果里会报 `Skipped by the parser`。
- 对象的键需要显示出来时（例如图表的系列名），写成带引号的中文键：`{"日期": "周一", "分钟": 45}`。其他键用 ASCII：`{label: "总时长"}`。
- 每个定义的名字都要能从 root 到达，每个引用的名字都要有定义。
- `@Each(list, "x", 模板)` 的模板必须写在调用里面，不能拆成单独的语句。
- `$` 变量的默认值只能是字面量。
- 能算出来的数字用表达式算（`@Sum`、`@Round`、`@Format` 等），不要手算后写死，避免图里的数据互相矛盾。

## 5. 静态图规则

图片只记录页面加载完成后的样子，没有点击、输入和动画。

| 组件 | 图片里的样子 | 出图时的做法 |
| --- | --- | --- |
| `$` 变量和 `@Set` | 只显示默认值 | 把默认值设成要展示的状态，或者把几个状态并排画出来 |
| `Button`、`Form`、`@ToAssistant` | 一个不能点的按钮 | 不要放 |
| `Input`、`TextArea`、`Select`、`DatePicker` | 空框和占位文字 | 不要放，把内容直接写成文字 |
| `Slider`、`SegmentedControl`、`RadioGroup`、`Checkbox` | 默认值 | 只在展示选项本身时使用 |
| `Flashcard` | 只有正面和翻面提示 | 改用 `Card`，把问题和答案都写出来 |
| `Carousel` | 横向裁切，只露出两张多 | 改用 `Grid` |
| `Popover` | 只有触发器 | 把内容写成 `Caption` 或 `Quote` |
| `Timer` | 一个开始按钮 | 不要放 |
| `Celebration` | 看不见 | 不要放 |
| `HtmlView` | 第一帧 | 尽量改用 `Svg` |
| `YouTube` | 播放器外框 | 不要放 |

适合出图的组件：`Title`、`Text`、`Caption`、`Badge`、`List`、`Markdown`、`Quote`、`Math`、`Code`、`Table`、`Chart`、`Svg`、`Icon`、`Card`、`Grid`、`Row`、`Col`、`Box`、`Divider`。

`SearchImage` 从英文维基百科和 Wikimedia Commons 找图，`Map` 使用 OpenFreeMap 的地图瓦片，两者都需要服务器能访问外网，访问不了时会出现空白或占位块，这时改用 `Svg` 或 `Icon`。`SearchImage` 的查询词用英文，写具体的事物（`"Mount Fuji"`、`"Monarch butterfly"`），不要写抽象概念。

## 6. 尺寸和版式

| 用途 | 宽度 |
| --- | --- |
| 手机、聊天卡片（默认） | 480 |
| 窄长竖图 | 360 到 420 |
| 桌面、横版报告、海报 | 780 |
| 最宽 | 1200 |

- 高度由内容决定。手机上分享的图最好不超过约 2000 px；超过 6000 px 会被截断。
- 从上到下：`Title`，一两句要点，主体（图、表或公式），最后用 `Quote` 或 `Card(..., "soft")` 做小结。
- 并排的内容用 `Grid(children, 列数, minChildWidth)`，minChildWidth 约 150。
- 480 宽时，`Table` 最多 4 列，每格文字要短；`Chart` 高度 200 到 260；`Svg` 的 viewBox 宽 240 到 320，并把 viewBox 收紧到图形周围，避免大片空白。
- 颜色用主题色名：`ink`、`muted`、`faint`、`surface`、`success`、`warning`、`danger`、`purple`、`pink`、`chart1` 到 `chart6`。`info` 是中性灰，要蓝色用 `chart1`。主题色名在深色主题下会自动换色，写死的十六进制颜色不会。
- 浅色色块用主题色加透明度，例如 `Polygon(points, "chart1", null, null, 0.15)`。

## 7. 检查清单

每次渲染后看图，逐条确认：

- 输出里没有截断提示，内容全部在图里。
- 中文正常显示，没有方块。出现方块说明缺中文字体，见第 9 节。
- 文字没有被截断、重叠或挤出容器，表格没有难看的折行。
- 没有空白区域、破图或灰色占位块。
- 数字、单位和图表数据正确，和文字描述一致。
- `Svg` 的标签都在画布内，不压在线条上，图形大小合适。
- 层次清楚，主次分明，留白均匀。
- 使用深色主题时，所有文字都看得清。

## 8. 示例

下面两个示例都已实际渲染，退出码为 0。

知识卡片，宽 480（`npm run render -- card.oui`）：

```text
root = Col([head, formula, figure, examples, tip])
head = Col([Title("勾股定理", "2xl"), Text("直角三角形两条直角边的平方和，等于斜边的平方。", "md", "muted"), Row([Badge("初中数学", "info"), Badge("几何"), Badge("必考", "warning")], 2)], 2)
formula = Card([Math("a^2 + b^2 = c^2")], "soft")
figure = Svg([Polygon(tri, "chart1", null, null, 0.15), Polygon(tri, "none", "ink", 2), Rect(60, 154, 16, 16, "none", "ink", 1.5), SvgText("a = 3", 52, 110, 14, "ink", "end"), SvgText("b = 4", 150, 192, 14, "ink", "middle"), SvgText("c = 5", 160, 98, 14, "danger", "start", "semibold")], "0 28 300 176")
tri = "60,170 240,170 60,40"
examples = Table(["a", "b", "c", "验证"], @Each(triples, "t", [t.a, t.b, t.c, t.a * t.a + " + " + t.b * t.b + " = " + t.c * t.c]))
tip = Quote("记住最常见的勾股数：3-4-5、5-12-13、8-15-17。", "考前速记")
triples = [{a: 3, b: 4, c: 5}, {a: 5, b: 12, c: 13}, {a: 8, b: 15, c: 17}]
```

学习报告，宽 780（`npm run render -- report.oui -w 780`）：

```text
root = Col([head, stats, chart, plan])
head = Row([Col([Title("本周学习报告", "xl"), Caption("11 月 3 日至 11 月 9 日")], 1), Spacer(), Badge("连续打卡 6 天", "success")], 3)
stats = Grid(@Each(kpis, "k", Card([Caption(k.label), Title(k.value, "2xl", k.color)], "soft", 4, 1)), 3, 150, 3)
chart = Card([Title("每日学习时长（分钟）", "sm"), Chart("bar", days, "日期", ["分钟"], "number", null, false, 220)])
plan = Card([Title("下周重点", "sm"), List(["复习二次函数图像", "完成 2 套英语阅读", "整理物理错题本"], "number")])
kpis = [{label: "总时长", value: "6.5 小时", color: "chart1"}, {label: "完成练习", value: "42 题", color: "success"}, {label: "正确率", value: "86%", color: "purple"}]
days = [{"日期": "周一", "分钟": 45}, {"日期": "周二", "分钟": 60}, {"日期": "周三", "分钟": 30}, {"日期": "周四", "分钟": 75}, {"日期": "周五", "分钟": 50}, {"日期": "周六", "分钟": 90}, {"日期": "周日", "分钟": 40}]
```

## 9. 排障

| 输出 | 处理 |
| --- | --- |
| `没有运行中的 LearnGPT，也没有生产构建` | 运行 `npm run build` |
| `临时服务启动失败` 或 `临时服务 60 秒内没有就绪` | 按输出里的日志处理。通常是构建不完整，重新运行 `npm run build` |
| `打不开 …/render` | `--origin` 或 `LEARNEV_RENDER_ORIGIN` 指向的服务没有运行，或版本太旧。去掉这个设置，让命令自己启动服务 |
| `No Chrome or Chromium found` | 运行 `npx playwright install chromium-headless-shell`，或用 `LEARNEV_CHROME` 指定浏览器路径 |
| `Chrome could not start` | Linux 上多半缺系统库，运行 `sudo npx playwright install-deps chromium`。容器里不能使用沙箱时，设置 `LEARNEV_CHROME_NO_SANDBOX=1`；以 root 运行时会自动关闭沙箱 |
| `The render page did not load` | 页面 30 秒内没有加载完成。重试一次；仍然失败就重新构建 |
| 中文显示成方块 | 安装中文字体，例如 Debian 或 Ubuntu：`sudo apt-get install -y fonts-noto-cjk`，再运行 `fc-cache -f` |
| 图片的位置是灰块或空白 | 服务器访问不了维基百科，删掉 `SearchImage` |
