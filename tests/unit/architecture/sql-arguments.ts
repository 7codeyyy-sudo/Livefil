/**
 * SQL 调用点的参数提取（IAM-004 的架构判定用）。
 *
 * 为什么需要它：判断"这条查询是否带用户作用域"必须看 `.where(...)` 的**参数文本**，
 * 而参数里可能嵌套括号（`and(eq(a, b), ne(c, d))`）。用正则截到第一个 `)` 会截断成
 * `and(eq(a, b`，于是"提到了 userId"这件事可能被误判。所以这里做括号配对扫描。
 *
 * 同时给出**行号**与**位置区间**：前者让违规信息可读（给字节偏移毫无帮助），
 * 后者让调用方能看到"上一个调用点结束到本次调用开始"之间的那段文本——豁免
 * 标记就写在那里。
 */

/** 一个 `.where(...)` 调用点。 */
export interface WhereCall {
  /** 括号内的原始文本（含嵌套）。 */
  readonly text: string;
  /** 1 起的行号。 */
  readonly line: number;
  /** `.where(` 中 `where` 之前那个点的位置（供调用方截取前置文本）。 */
  readonly markerIndex: number;
  /** 匹配的 `)` 的位置。 */
  readonly endIndex: number;
}

const WHERE_MARKER = '.where(';

/**
 * 提取源码里全部 `.where(...)` 的参数文本。
 *
 * 会跳过注释与字符串里的假阳性吗？——**不会**，这是刻意的：本函数只服务于
 * "仓储实现文件"这一小类输入，那里不会出现 `.where(` 的注释示例。为通用性引入
 * 一个简化版词法分析器，反而会让"它到底漏了多少"变得不可知。
 *
 * @param content 源文件全文。
 * @returns 按出现顺序排列的调用点。
 */
export function extractWhereArguments(content: string): readonly WhereCall[] {
  const calls: WhereCall[] = [];
  let searchFrom = 0;

  for (;;) {
    const markerIndex = content.indexOf(WHERE_MARKER, searchFrom);
    if (markerIndex < 0) {
      break;
    }

    const openIndex = markerIndex + WHERE_MARKER.length - 1;
    let depth = 0;
    let closeIndex = -1;

    for (let index = openIndex; index < content.length; index += 1) {
      const char = content[index];
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          closeIndex = index;
          break;
        }
      }
    }

    // 括号不配对（被截断的代码）时到此为止，不猜测后半段。
    if (closeIndex < 0) {
      break;
    }

    calls.push({
      text: content.slice(openIndex + 1, closeIndex),
      line: content.slice(0, markerIndex).split('\n').length,
      markerIndex,
      endIndex: closeIndex,
    });

    searchFrom = closeIndex + 1;
  }

  return calls;
}
