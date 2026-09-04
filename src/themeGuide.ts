/**
 * The format description handed to the agent before it writes a theme.
 *
 * It lives here, next to nothing else, for one reason: it describes the Theme
 * type in theme.ts, and a description of a type belongs beside the type. It is
 * written to `themes/GUIDE.md` in the app config directory on every use (see
 * themes_guide_write in Rust), so the copy the CLI reads can never be one
 * version behind the interface.
 *
 * Written in Chinese: its two readers are the user's CLI and the user.
 */

import { classicTheme, themes } from './theme';

/** Preset ids, listed for the agent as the set of legal `base` values */
const BASES = themes.map((t) => `\`${t.id}\`（${t.name}：${t.description}）`).join('\n  - ');

/** A real preset, pretty-printed — worth more than any amount of prose about
 *  what a plausible value looks like */
const EXAMPLE = JSON.stringify(
  { ...classicTheme, codePalette: { '…': '见下文' } },
  null,
  2,
);

export const THEME_GUIDE = `# VinsEditor · 主题文件格式

这个目录里每一个 \`.json\` 文件就是一个自定义主题，文件名必须等于主题的 \`id\`
（比如 \`celadon.json\` 里的 id 就是 \`celadon\`）。编辑器在监听这个目录：文件一存，
预览立刻就变，不用重启，也不用让用户点什么。

主题决定的是**文章在公众号里长什么样**——它最终会被编译成一堆内联 style 贴进
微信编辑器（微信只认内联样式，class 和 <style> 都会被丢掉）。所以这里的每个值
都是一段 CSS 值，不是 CSS 规则：写 \`"16px"\`、\`"#2b2b2b"\`、\`"4px solid #d97757"\`，
不要写选择器、不要写 \`{}\`、不要写 \`!important\`。

## 一份主题文件长这样

\`\`\`json
{
  "id": "celadon",
  "name": "青瓷",
  "description": "编号小节 + 「」引文 + 短分隔线，安静的技术长文",
  "base": "minimal",
  "appearance": "light",
  "accent": "#6b8f7a",
  "body": { "bg": "#f4f7f3", "color": "#2c332e", "fontSize": "16px", "lineHeight": "1.85" },
  "heading": { "color": "#1e2a24", "decor": "numbered" },
  "quote": { "style": "bracket", "markGlyph": "「」", "color": "#4a5a4e" },
  "list": { "bullet": "▸", "ordered": "accent" },
  "hr": { "style": "line", "width": "20%", "color": "#c7d3ca" },
  "table": { "style": "minimal", "borderColor": "#d8e2da" },
  "codeBlock": { "chrome": "lang", "background": "#eef3ef" }
}
\`\`\`

### base：先继承，再改

\`base\` 指一个内置主题，没写就是 \`classic\`。文件里没写到的字段，全部从它那里继承。
所以**不必把下面所有字段都写一遍**——挑真正要改的写就行，一个二三十行的文件
通常就够做出一个气质完全不同的主题了。挑 base 的时候优先看结构像不像
（编号小节？居中标题？终端窗口？），颜色反正总要改。

可选的 base：
  - ${BASES}

### 必填

- \`id\`：只能是小写字母、数字、\`-\`、\`_\`，且不能和内置主题重名。
- \`name\`：中文短名，两到四个字最好看（主题卡片上就显示这个）。
- \`description\`：一句话说清它的性格，鼠标悬停时给用户看。
- \`appearance\`：\`"light"\` 或 \`"dark"\`。这只决定它被分到主题列表的哪一组，
  必须和 \`body.bg\` 的明暗一致，否则用户会在深色区看到一张白纸。

## 结构：一个主题真正的性格

先挑结构，再挑颜色。只换颜色的主题，读者一眼看不出区别；换了结构的主题，
第一屏就认得出来。下面这些字段决定的是形状，不是色相。

### 标题 \`heading.decor\`

一篇公众号文章，读者最先看见的就是标题的样子。十选一：

| 值 | 长什么样 |
| --- | --- |
| \`none\` | 只有字号和字重，什么也不画 |
| \`underline\` | 通栏细下划线 |
| \`band\` | 标题坐在一条圆角色带里（吃 \`accentSoft\`） |
| \`accent-bar\` | 标题**上方**一条粗线，用来切分版面 |
| \`rule\` | 只在文字宽度下画一条杂志粗线 |
| \`left-bar\` | 左侧竖条，公众号最常见的那种 |
| \`boxed\` | 文字外面一圈描边框 |
| \`marker\` | 文字前面一个符号，符号由 \`heading.markerGlyph\` 定（如 \`▍\` \`#\` \`$\` \`❁\`） |
| \`numbered\` | 每个 h2 前面自动编号 01 / 02 / 03（只给 h2，其他层级不编） |
| \`center-rule\` | 标题居中，文字底下一条短线 |

另外 \`heading.align: "center"\` 可以单独把标题居中而不画任何东西。

### 引用 \`quote.style\`

| 值 | 长什么样 |
| --- | --- |
| \`bar\` | 底色 + 左侧竖线（默认，也是以前唯一的样子） |
| \`card\` | 只有底色和圆角，没有竖线，像一张浮起来的卡片 |
| \`bracket\` | 没有底色，用一对放大的引号包住，引号由 \`quote.markGlyph\` 定（\`「」\` \`『』\` \`“”\`） |
| \`pull\` | 杂志式引言：居中、放大一号、上下各一条线，别的都不要 |

\`card\` / \`bracket\` / \`pull\` 会忽略 \`borderLeft\`，后两个连 \`background\` 也忽略。
\`quote.bigMark: true\` 则是在引用开头画一个大引号（\`bar\` 和 \`card\` 上用）。

### 分隔线 \`hr.style\`

\`line\`（默认）/ \`dashed\` / \`dotted\` / \`double\` / \`glyph\`。
\`glyph\` 画的不是线，而是一个居中的小花饰，字符由 \`hr.glyph\` 定：\`❋\` \`✦\` \`◈\` \`✿\` \`· · ·\`。
\`hr.width\` 可以让线短一些（如 \`"15%"\`），小于 100% 会自动居中——极简主题很吃这一招。

### 列表 \`list\`

不写就用浏览器自带的圆点和数字，也就是**所有主题的列表长得一模一样**。
写了就由我们自己画，带悬挂缩进，第二行会对齐第一行的文字：

- \`list.bullet\`：无序列表的符号，如 \`•\` \`▸\` \`—\` \`◇\` \`○\` \`❀\` \`*\` \`›\` \`◆\`
- \`list.bulletColor\`：符号颜色，不写就用 \`accent\`
- \`list.ordered\`：\`plain\`（原样）/ \`accent\`（数字染成强调色）/ \`pill\`（数字装进实心小圆牌）

### 代码块 \`codeBlock.chrome\`

\`none\`（默认）/ \`dots\`（顶上三个红黄绿圆点，终端窗口那种）/
\`lang\`（右上角标出语言，只在代码块写了语言时出现）。

### 表格 \`table.style\`

\`grid\`（默认，每格都有框）/ \`minimal\`（只留横线，表头去掉底色）/ \`striped\`（隔行底色，
颜色由 \`table.stripeBg\` 定，不写就用 \`headBg\`）。

### 正文 \`body\`

- \`body.indent: true\`：每段首行缩进两个字，中文书的排法。整篇文章的气质会立刻不一样
- \`body.align: "justify"\`：两端对齐。配合 \`indent\` 用才好看，单用会显得手机上字距忽宽忽窄

### 图片 \`img\`

- \`img.caption: true\`：把图片的 alt 文字排成图注，居中放在图下面
- \`img.frame\`：给图片加一圈边框，如 \`"3px solid #f0e6d2"\`

## 全部字段

顶层：

| 字段 | 说明 |
| --- | --- |
| \`mono\` | 等宽字体族（代码用） |
| \`accent\` | 强调色。标题装饰、引用条、链接、列表符号、脚注都吃它，是一个主题的性格所在 |
| \`accentSoft\` | 强调色的淡版本，用来铺大面积（标题色带、徽章底） |
| \`pMargin\` | 段间距，如 \`"16px"\` |
| \`listPaddingLeft\` / \`listItemMargin\` | 列表缩进与条目间距 |
| \`strongColor\` | 加粗的颜色，\`"inherit"\` 表示跟正文 |
| \`delColor\` | 删除线的颜色 |
| \`codePaletteMode\` | \`"light"\` 或 \`"dark"\`，跟 \`codeBlock.background\` 的明暗一致 |

对象字段（每个都可以只写其中几个键，其余继承 base）：

- \`body\`：\`font\`、\`fontSize\`、\`lineHeight\`（无单位数字字符串，如 \`"1.75"\`）、
  \`color\`、\`bg\`（整篇文章的纸色；深色主题必须设）、\`indent\`、\`align\`
- \`heading\`：\`font\`、\`fontWeight\`、\`color\`、\`lineHeight\`、\`letterSpacing\`、
  \`marginTop\`、\`marginBottom\`、\`decor\`、\`markerGlyph\`、\`align\`
- \`headingSizes\`：\`h1\`~\`h6\`，都是 px。公众号正文里 h1 很少用，h2/h3 才是主力
- \`quote\`（引用）：\`background\`、\`color\`、\`borderLeft\`、\`borderRadius\`、\`padding\`、
  \`margin\`、\`fontStyle\`、\`style\`、\`markGlyph\`、\`bigMark\`、\`extra\`
- \`callout\`（\`> [!tip]\` 提示块）：\`background\`、\`color\`、\`borderLeft\`、\`borderRadius\`、
  \`padding\`、\`margin\`、\`badgeBg\`、\`badgeColor\`、\`extra\`
- \`code\`（行内代码）：\`background\`、\`color\`、\`borderRadius\`、\`padding\`、\`fontSize\`、\`extra\`
- \`codeBlock\`（代码块）：同上，另有 \`lineHeight\`、\`chrome\`
- \`link\`：\`color\`、\`textDecoration\`
- \`list\`：\`bullet\`、\`bulletColor\`、\`ordered\`
- \`table\`：\`borderColor\`、\`headBg\`、\`headColor\`、\`fontSize\`、\`cellPadding\`、\`style\`、\`stripeBg\`
- \`hr\`：\`color\`、\`margin\`、\`style\`、\`glyph\`、\`width\`
- \`img\`：\`borderRadius\`、\`margin\`（\`"16px auto"\` 让图片居中）、\`caption\`、\`frame\`
- \`mark\`（\`==高亮==\`）：\`background\`、\`color\`、\`borderRadius\`、\`padding\`
- \`footnote\`（脚注）：\`refColor\`、\`blockBorder\`、\`textColor\`、\`numColor\`、\`textSize\`
- \`codePalette\`：highlight.js 的配色表，键是 hljs 类名，值是颜色，例如
  \`{ "hljs-keyword": "#9a3d9e", "hljs-string": "#b4552f", "hljs-comment": "#a39c90" }\`。
  只写想改的几条，其余继承 base 的整张表。常用的键：\`hljs-keyword\`、\`hljs-string\`、
  \`hljs-title\`、\`hljs-number\`、\`hljs-built_in\`、\`hljs-attr\`、\`hljs-comment\`、
  \`hljs-meta\`、\`hljs-variable\`、\`hljs-tag\`、\`hljs-name\`、\`hljs-operator\`
- \`extra\`（quote / callout / code / codeBlock 上都有）：一张自由的 CSS 键值表，
  用来加上面没列出的属性，如 \`{ "border-top": "3px solid #6b8f7a" }\`。
  键用 CSS 的写法（连字符），不要用驼峰

## 做主题时注意

1. **对比度**。正文色和纸色之间要够得开，公众号大部分人在手机上、在阳光下读。
   正文别用纯黑 \`#000\`，也别让灰度低于 \`#666\` 撑起整篇。
4. **强调色只用在小面积**。标题条、引用边、链接、脚注号——铺满一屏的强调色会累。
5. **字号**。正文 15–17px 是公众号的舒适区，小于 14px 在手机上就吃力了。
6. **深色主题**必须同时设 \`body.bg\`、\`body.color\`、\`heading.color\`、
   \`quote.background\`、\`code.background\`、\`codeBlock.background\`、\`table\`、\`hr.color\`，
   漏一个就会在深色纸上留一块刺眼的浅色。深色主题请把 \`codePaletteMode\` 设成 \`"dark"\`，
   并且 \`base\` 直接选一个内置的深色主题（\`dark\` / \`midnight\` / \`graphite\` / \`night-sakura\`），
   继承来的配色会省掉大半工作。
7. **字体族**写成完整的 fallback 链，并且带上中文字体，例如
   \`"Georgia, 'Songti SC', 'SimSun', serif"\`。用户机器上没有的字体，微信那边更没有。
8. 值里不要出现 \`<\`、\`>\`、\`"\`——它们会被塞进 HTML 的 style 属性里，编辑器会把
   带这些字符的值直接丢掉。

## 一个完整的内置主题（classic），供比对

\`\`\`json
${EXAMPLE}
\`\`\`

写完存盘就行。用户会在编辑器里立刻看到效果，然后大概率会让你再调——
"再暖一点"、"标题小一号"，直接改同一个文件即可。
`;
