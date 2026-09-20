/**
 * 仓储用户作用域的机器判定（IAM-004）。
 *
 * ## 这条断言在防什么
 *
 * 「每一次查询都带 `user_id`」在本地单用户模式下**永远看不出问题**：只有一个
 * 用户时，全表读与按用户读返回一样的结果。等到进入多用户（或本地库里恰好有
 * 两条测试数据），它才变成数据泄漏——而那时它已经上线很久了。
 *
 * 所以这里做静态判定：模块基础设施层的仓储实现里，**每一个 `.where(...)` 都必须
 * 提到 `userId`**，并且 `.from/.update/.delete` 的次数不得多于 `.where` 的次数
 * （后者是前者的粗粒度补充：漏写 `where` 时连判定的对象都没有）。
 *
 * ## 为什么用文本判定而不是执行
 *
 * 真机执行只能覆盖被测试命中的那些查询；这条断言要覆盖的是"**没写出来的**
 * 那个查询"——将来某次改动里漏掉作用域的那一行。静态判定能覆盖它的全集，
 * 代价是可能误报，所以规则刻意写得很宽（只要出现 `userId` 就算带作用域）。
 *
 * ## 豁免机制（存在，但必须付代价）
 *
 * 有的查询**按设计**就不带用户作用域——例如"读取唯一的本地用户"：那条查询的
 * 判据是 `mode = 'local'`，因为此刻还没有 userId 可用（会话本身就是它要建立的）。
 * 这类例外用源码里的标记声明：
 *
 * ```text
 * // @user-scope-exempt: 读取唯一本地用户，此刻还没有 userId 可用
 * ```
 *
 * 标记必须出现在**该调用点之前、上一个调用点之后**的那段文本里，并且冒号后面
 * 必须写出理由（至少 8 个字符）。没写理由的标记**不生效**——豁免必须有成本，
 * 否则它会变成"顺手加一行让红变绿"的开关。
 */
import { extractWhereArguments } from './sql-arguments.ts';

/** 待判定的源文件。 */
export interface ScopedSourceFile {
  /** 相对项目根的 POSIX 路径。 */
  readonly relativePath: string;
  readonly content: string;
}

/** 一条违规。 */
export interface UnscopedQuery {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly reason: string;
}

/** 判定结果。 */
export interface UserScopeReport {
  readonly violations: readonly UnscopedQuery[];
  /** 扫到的 `.where(` 总数（用于证明"确实扫到了东西"）。 */
  readonly whereCount: number;
  /** 其中带用户作用域的数量。 */
  readonly scopedCount: number;
  /** 其中被显式豁免的数量。 */
  readonly exemptCount: number;
}

const SCOPE_HINT = 'userId';
const EXEMPTION_MARKER = '@user-scope-exempt:';
const MIN_EXEMPTION_REASON_LENGTH = 8;

/** 统计出现次数。 */
function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

/** 读取一段前置文本里的豁免标记。 */
function readExemption(region: string): {
  readonly exempted: boolean;
  readonly hasMarker: boolean;
} {
  const markerIndex = region.lastIndexOf(EXEMPTION_MARKER);
  if (markerIndex < 0) {
    return { exempted: false, hasMarker: false };
  }

  // 理由只取标记所在的那段注释：到注释结束（`*/`）或到该行末尾为止，
  // **不**把后续代码算进来——否则一段代码就能把"理由只有两个字"喂饱。
  const afterMarker = region.slice(markerIndex + EXEMPTION_MARKER.length);
  const commentEnd = afterMarker.indexOf('*/');
  const rawReason = commentEnd >= 0 ? afterMarker.slice(0, commentEnd) : afterMarker.split('\n')[0];

  const reason = (rawReason ?? '')
    .replace(/[*/\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { exempted: reason.length >= MIN_EXEMPTION_REASON_LENGTH, hasMarker: true };
}

/**
 * 找出所有缺少用户作用域的查询。
 *
 * @param files 模块基础设施层的仓储实现文件。
 * @returns 判定结果。
 */
export function findUnscopedQueries(files: readonly ScopedSourceFile[]): UserScopeReport {
  const violations: UnscopedQuery[] = [];
  let whereCount = 0;
  let scopedCount = 0;
  let exemptCount = 0;

  for (const file of files) {
    const calls = extractWhereArguments(file.content);
    let previousEnd = 0;

    for (const call of calls) {
      whereCount += 1;
      const region = file.content.slice(previousEnd, call.markerIndex);
      previousEnd = call.endIndex;

      if (call.text.includes(SCOPE_HINT)) {
        scopedCount += 1;
        continue;
      }

      const exemption = readExemption(region);
      if (exemption.exempted) {
        exemptCount += 1;
        continue;
      }

      violations.push({
        file: file.relativePath,
        line: call.line,
        snippet: call.text.replace(/\s+/g, ' ').trim().slice(0, 120),
        reason: exemption.hasMarker
          ? `豁免标记 ${EXEMPTION_MARKER} 的理由太短（至少 ${String(MIN_EXEMPTION_REASON_LENGTH)} 个字符）`
          : `where 条件里没有 ${SCOPE_HINT}，这条查询可能越过用户作用域`,
      });
    }

    // 粗粒度补充：查询点数不应少于 where 数。漏写整个 `.where(` 时，
    // 上面的循环根本看不到那个查询，这条能把那种情况抓住。
    const querySites =
      countOccurrences(file.content, '.from(') +
      countOccurrences(file.content, '.update(') +
      countOccurrences(file.content, '.delete(');

    if (querySites > calls.length) {
      violations.push({
        file: file.relativePath,
        line: 1,
        snippet: `from/update/delete 共 ${String(querySites)} 处，where 只有 ${String(calls.length)} 处`,
        reason: '存在没有 where 的查询点，按定义它不带用户作用域',
      });
    }
  }

  return { violations, whereCount, scopedCount, exemptCount };
}

/** 渲染成可读文本（失败信息用）。 */
export function formatUnscopedQueries(report: UserScopeReport): string {
  if (report.violations.length === 0) {
    return `未发现越域查询（已检查 ${String(report.whereCount)} 处 where）。`;
  }

  return report.violations
    .map(
      (violation) =>
        `${violation.file}:${String(violation.line)} ${violation.reason}\n    ${violation.snippet}`,
    )
    .join('\n');
}
