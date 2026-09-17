import type { Metadata } from 'next';

import {
  Badge,
  Button,
  IconButton,
  Input,
  Progress,
  Select,
  Textarea,
} from '@/shared/ui/components';

import { OverlayDemo } from './OverlayDemo';
import { TabsDemo } from './TabsDemo';
import styles from './styleguide.module.css';

/**
 * 组件展示夹具（UI-002）。
 *
 * ## 它是什么
 *
 * **Playwright 的测试夹具**——浏览器端用例需要一个「构建后真实可达的路由」才能
 * 验证组件的五态与几何量（触控高度、窄屏换行、时长归零）。它不是一个展示项目。
 *
 * ## 为什么不能用环境变量把它藏起来
 *
 * CI 的 webServer 是 `npm run build && next start` 的**全新生产构建**，
 * 被 env 条件排除掉的页面在 CI 里会直接 404——测试反而在最该跑的地方失败。
 * 所以它始终存在，靠**不进导航**与 `noindex` 控制可见性。
 *
 * ## 它同样受纪律约束
 *
 * 本页在 `app/` 下，因此和其它应用代码一样会被「令牌文件之外禁止颜色字面量」、
 * 「禁止时长字面量」、「禁止数字 z-index」等扫描覆盖。
 *
 * ## 去留
 *
 * 按任务清单要求，UI-002 收尾时会复审它的去留并给出明确结论，不口头挂账。
 */
export const metadata: Metadata = {
  title: '组件展示（测试夹具）',
  description: 'UI-002 浏览器端用例的挂载点',
  // 不进搜索索引：这不是产品页面。
  robots: { index: false, follow: false },
};

export default function StyleguidePage() {
  return (
    <main className={styles.page}>
      <h1 className={styles.heading}>组件展示（测试夹具）</h1>
      <p className={styles.note}>
        本页供浏览器端用例验证组件状态与几何量，不进入产品导航，也不对搜索引擎开放。
        每批交付在同一页追加一个分区。
      </p>

      <section className={styles.section} id="button">
        <h2 className={styles.sectionTitle}>Button</h2>
        <div className={styles.row}>
          <Button variant="primary" data-variant="primary">
            保存
          </Button>
          <Button variant="secondary" data-variant="secondary">
            编辑
          </Button>
          <Button variant="ghost" data-variant="ghost">
            稍后处理
          </Button>
          <Button variant="danger" data-variant="danger">
            删除
          </Button>
        </div>
        <div className={styles.row}>
          <Button variant="primary" disabled data-variant="primary-disabled">
            保存
          </Button>
          <Button variant="primary" loading data-variant="primary-loading">
            保存
          </Button>
        </div>
      </section>

      <section className={styles.section} id="icon-button">
        <h2 className={styles.sectionTitle}>IconButton</h2>
        <div className={styles.row}>
          <IconButton label="关闭" data-variant="icon-ghost">
            ×
          </IconButton>
          <IconButton label="删除" variant="danger" data-variant="icon-danger">
            ×
          </IconButton>
          <IconButton label="关闭" disabled data-variant="icon-disabled">
            ×
          </IconButton>
          <IconButton label="关闭" loading data-variant="icon-loading">
            ×
          </IconButton>
        </div>
      </section>

      <section className={styles.section} id="input">
        <h2 className={styles.sectionTitle}>Input</h2>
        <div className={styles.fieldGrid}>
          <Input label="任务名称" placeholder="例如：整理本周开销" data-variant="input-default" />
          <Input label="预计时长" hint="单位分钟" placeholder="30" data-variant="input-hint" />
          <Input
            label="金额"
            error="请输入大于 0 的金额"
            defaultValue="0"
            data-variant="input-error"
          />
          <Input label="已归档" defaultValue="不可编辑" disabled data-variant="input-disabled" />
        </div>
      </section>

      <section className={styles.section} id="select">
        <h2 className={styles.sectionTitle}>Select</h2>
        <div className={styles.fieldGrid}>
          <Select label="所属领域" defaultValue="work" data-variant="select-default">
            <option value="work">工作</option>
            <option value="life">生活</option>
            <option value="health">健康</option>
          </Select>
          <Select label="分类" error="请选择分类" defaultValue="" data-variant="select-error">
            <option value="">请选择</option>
            <option value="food">餐饮</option>
            <option value="transport">交通</option>
          </Select>
          <Select label="已归档" defaultValue="work" disabled data-variant="select-disabled">
            <option value="work">工作</option>
          </Select>
        </div>
      </section>

      <section className={styles.section} id="textarea">
        <h2 className={styles.sectionTitle}>Textarea</h2>
        <div className={styles.fieldGrid}>
          <Textarea
            label="复盘备注"
            placeholder="今天哪里偏离了计划？"
            data-variant="textarea-default"
          />
          <Textarea
            label="阻碍"
            error="请至少写 10 个字"
            defaultValue="太短"
            data-variant="textarea-error"
          />
          <Textarea
            label="已归档"
            defaultValue="不可编辑"
            disabled
            data-variant="textarea-disabled"
          />
        </div>
      </section>

      <section className={styles.section} id="badge">
        <h2 className={styles.sectionTitle}>Badge</h2>
        <div className={styles.row}>
          <Badge variant="neutral">待整理</Badge>
          <Badge variant="success">已完成</Badge>
          <Badge variant="warning">已延期</Badge>
          <Badge variant="danger">冲突</Badge>
        </div>
        <div className={styles.row}>
          {/* 长内容不该撑破容器或折行（原型 `.tag` 的 nowrap）。 */}
          <Badge variant="neutral">2026-09-17 到期</Badge>
          <Badge variant="warning">与「晨间例程」时间冲突</Badge>
        </div>
      </section>

      <section className={styles.section} id="progress">
        <h2 className={styles.sectionTitle}>Progress</h2>
        <div className={styles.progressList}>
          <Progress value={0} label="今日完成度" showValue />
          <Progress value={58} label="目标进度" showValue />
          <Progress value={100} label="本周预算使用" showValue />
          {/* 不带可见数值的形态：由配套文字承担说明职责（§5）。 */}
          <Progress value={35} label="行动完成进度" />
        </div>
      </section>

      <section className={styles.section} id="tabs">
        <h2 className={styles.sectionTitle}>Tabs</h2>
        <TabsDemo />
      </section>

      <section className={styles.section} id="overlay">
        <h2 className={styles.sectionTitle}>Modal / ConfirmDialog</h2>
        <p className={styles.note}>
          浮层默认不渲染——打开的弹窗会盖住整页，静态展示没有意义。 点按钮打开；滚动锁、焦点陷阱、ESC
          语义与嵌套关闭由浏览器端用例验证。
        </p>
        <OverlayDemo />
      </section>
    </main>
  );
}
