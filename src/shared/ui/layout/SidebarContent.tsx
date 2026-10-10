'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { clientEnv } from '@/shared/validation/env.client';

import { NavItem } from './NavItem';
import { PRIMARY_NAV_ITEMS, SETTINGS_NAV_ITEM } from './nav-items';
import { useDayCard } from './use-day-card';

import styles from './SidebarContent.module.css';

/** 时间尺的范围与刻度（与今日页时间骨架同口径：08–22 基线、4 小时一笔）。 */
const RULER_START_HOUR = 8;
const RULER_END_HOUR = 22;
const RULER_TICK_HOURS = [8, 12, 16, 20] as const;

/** 尺上位置（0–100 的布局比例）：把当天分钟映射到 08–22 窗口，窗口外钳到端点。 */
function rulerAt(minutes: number): number {
  const start = RULER_START_HOUR * 60;
  const end = RULER_END_HOUR * 60;
  const clamped = Math.min(end, Math.max(start, minutes));
  return ((clamped - start) / (end - start)) * 100;
}

/**
 * 侧栏今日时间尺（UI-012，《UI 页面规范》v0.29 §3.2）。
 *
 * 形态语言与主区时间线一致（横尺 + 已过段 + 现在的竖线，**不用圆形**）：
 * 强调色在这条尺上表达「当前时刻」，正是 §2.1 强调色（当前状态）的本义。
 * 入场时已过段与现在线一起**一次性展开**（宽度/位移过渡，零循环），
 * reduce 下由 tokens.css 单点归零自动收敛。整把尺是视觉辅助，对读屏隐藏
 * （`aria-hidden`），语义由下方 note 文字承担——同一句话不读两遍。
 *
 * 位置是**内联百分比**（0–100 的布局比例，非设计取值，与主区时间骨架同例）；
 * 宽度初值 0，下一帧写入目标值，过渡据此播一次展开。
 */
function DayRuler({ minutes }: { readonly minutes: number }) {
  const [position, setPosition] = useState<number | null>(null);

  useEffect(() => {
    const handle = requestAnimationFrame(() => {
      setPosition(rulerAt(minutes));
    });
    return () => {
      cancelAnimationFrame(handle);
    };
  }, [minutes]);

  const at = (hour: number): { readonly left: string } => ({
    left: `${String(rulerAt(hour * 60))}%`,
  });

  return (
    <div className={styles.dayRuler} aria-hidden="true">
      <span className={styles.rulerTrack}>
        <span className={styles.rulerFill} style={{ width: `${String(position ?? 0)}%` }} />
        <span className={styles.rulerNow} style={{ left: `${String(position ?? 0)}%` }} />
      </span>
      <span className={styles.rulerTicks}>
        {RULER_TICK_HOURS.map((hour) => (
          <span key={hour} className={styles.rulerTick} style={at(hour)} />
        ))}
      </span>
      <span className={styles.rulerAxis}>
        {RULER_TICK_HOURS.map((hour) => (
          <span key={hour} className={styles.rulerLabel} style={at(hour)}>
            {String(hour).padStart(2, '0')}
          </span>
        ))}
      </span>
    </div>
  );
}

export type SidebarContentProps = {
  /**
   * 导航发生后通知调用方。**只有移动端抽屉会传**（接到它自己的 `onClose`）。
   *
   * 抽屉是浮层，路由切换不会自动关掉它；不接这条线的话新页面会被抽屉与遮罩
   * 盖着、滚动还锁着。流式侧栏不传——桌面/平板切换路由后侧栏本就该留着。
   *
   * 注意这里**所有**指向站内的链接都要接上，不只是导航项：品牌链接同样会
   * 切到 `/today`，漏掉它就等于留下同一个缺陷的另一条入口。
   */
  readonly onNavigate?: (() => void) | undefined;
};

/**
 * 侧栏内容（UI-003）。
 *
 * ## 为什么内容单独成一个组件
 *
 * 同一套导航出现在**两个**渲染位置：桌面/平板的流式侧栏，和移动端由汉堡
 * 唤出的抽屉。原型的做法是「同一个 `.sidebar` 元素，窄屏改成 fixed 位移」，
 * 但那要求导航内容始终留在 DOM 里——而本批的移动端抽屉是**浮层**（关闭时
 * 整个卸载，见 `MobileNavDrawer`），两者不能共用同一个 DOM 节点。
 *
 * 于是把"内容"与"容器"分开：本组件是内容，`Sidebar` 与 `MobileNavDrawer`
 * 各自提供容器（网格列 / 门户面板）。这样导航结构只有一份实现。
 *
 * ## 账户区为什么是静态的
 *
 * 「我的生活 / 本地模式 / 头像」是原型里的账户区，真实语义属 IAM（Phase 2）。
 * 这里照原型渲染形态但**不接行为**——它不是链接、点击无响应，也就不会
 * 造出一个指向不存在页面的死链，或假装账户体系已经存在。
 *
 * 副标题取「本地模式」而不是原型的「云端账号」：第一阶段是本地单用户批次，
 * 云端账号整体挂账（决策 T-006），设置页顶部也写着「本地模式 · 数据仅保存在
 * 本环境」。照原型写「云端账号」等于在导航里承诺一个并不存在的能力。
 */
export function SidebarContent({ onNavigate }: SidebarContentProps) {
  const dayCard = useDayCard();

  // 同 `NavItem` 里的说明：`exactOptionalPropertyTypes` 下不能把 `undefined`
  // 显式传给 `Link` 的 `onClick`，所以按需展开。
  const navProps = onNavigate === undefined ? {} : { onClick: onNavigate };

  return (
    <>
      <Link href="/today" className={styles.brand} {...navProps}>
        {/* 品牌首字取自产品名而不是写死字母：产品改名时这里不会漂移。
            标记本身对读屏无信息量（品牌名就在旁边），所以标记为装饰。 */}
        <span className={styles.brandMark} aria-hidden="true">
          {clientEnv.appName.slice(0, 1)}
        </span>
        <span className={styles.brandName}>{clientEnv.appName}</span>
      </Link>

      {/* 日期升格（UI-011）→ **今日时间尺**（UI-012，v0.29 §3.2）：日期 +
          星期·第 N 周 + 08–22 横向时间尺 + 「今天已过 X%」。水合期间
          `dayCard` 为 null，本块渲染空骨架（与服务端产出一致），水合完成后
          填入真值并一次性展开。 */}
      <div className={styles.dateCard}>
        <p className={styles.date}>{dayCard?.date ?? ''}</p>
        <p className={styles.week}>{dayCard?.week ?? ''}</p>
        {dayCard === null ? null : <DayRuler minutes={dayCard.minutes} />}
        {dayCard === null ? null : (
          <span className={styles.dayNote}>今天已过 {String(dayCard.pct)}%</span>
        )}
      </div>

      <nav className={styles.list} aria-label="主导航">
        {/* 分组眉标（UI-011，v0.27 §3.2）：业务五项归入「工作台」组，
            结构靠眉标与组间距建立——不加边框、不加底色。
            底部设置 + 账户组由既有 .bottom 结构分组承载，不加第二枚眉标。 */}
        <p className={styles.groupLabel}>工作台</p>
        {PRIMARY_NAV_ITEMS.map((item) => (
          <NavItem key={item.href} href={item.href} label={item.label} onClick={onNavigate} />
        ))}
      </nav>

      <div className={styles.bottom}>
        <NavItem
          href={SETTINGS_NAV_ITEM.href}
          label={SETTINGS_NAV_ITEM.label}
          onClick={onNavigate}
        />

        {/* 账户区（IAM / Phase 2 接线）。刻意不是 `<button>`：没有可执行的行为
            就不给交互语义，否则键盘用户会遇到一个"按下去什么也不发生"的控件。 */}
        <div className={styles.profile}>
          <span className={styles.avatar} aria-hidden="true">
            你
          </span>
          <span className={styles.profileText}>
            <strong className={styles.profileName}>我的生活</strong>
            <small className={styles.profileMeta}>本地模式</small>
          </span>
        </div>
      </div>
    </>
  );
}
